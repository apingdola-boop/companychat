#!/usr/bin/env node
/**
 * H-채팅 — 정적 파일 + Socket.IO + (선택) Supabase Postgres 에 JSON 스냅샷 저장
 *
 * ■ Supabase 사용 시 Render 디스크 없이도 재배포 후 데이터 유지
 *   환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (대시보드 → Project Settings → API)
 *   SQL: supabase/migrations/001_company_chat_app_state.sql 실행
 *
 * ■ Supabase 미설정 시: DATA_DIR/shared-state.json (로컬·Render 디스크)
 *
 * ■ 기본 계정 대량 등록: data/seed-accounts.json (npm run build:seed 로 chat2.xlsx 에서 생성)
 *   계정이 비어 있을 때 이 파일이 있으면 데모 5명 대신 시드 목록을 씁니다. (/data/seed-accounts.json 은 외부에 노출되지 않음)
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { networkInterfaces } = require('os');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'shared-state.json');
const SEED_ACCOUNTS_FILE = path.join(ROOT, 'data', 'seed-accounts.json');
const PUBLIC_URL_FILE = path.join(DATA_DIR, 'public-base-url.txt');

const APP_STATE_TABLE = 'company_chat_app_state';
const APP_STATE_ID = 'main';

function useSupabase() {
  const u = process.env.SUPABASE_URL && String(process.env.SUPABASE_URL).trim();
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY && String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim();
  return !!(u && k);
}

function sha256Hex(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

function emptyShared() {
  return {
    accounts: [],
    /** 프로젝트 카탈로그: { number, name } */
    projects: [],
    rooms: [],
    messages: {},
    feedbackThreads: [],
    pinnedChatsByUser: {},
    lastReadByUser: {},
    chatNotifyMutedByUser: {},
    chatNotifyMutedRoomsByUser: {},
    staffPresenceByUser: {},
    /** 면접원 account id → { at, source?, manual? } 교통비 제출 표시 */
    trafficExpenseSubmittedByIvId: {},
    /** 면접원 account id → (프로젝트 key → { at, source?, manual?, cleared?, files?, summary? }) */
    trafficExpenseSubmittedByIvProjectKey: {},
  };
}

function mergeTrafficExpenseMaps(base, incoming) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  if (!incoming || typeof incoming !== 'object') return out;
  for (const k of Object.keys(incoming)) {
    const vb = incoming[k];
    const va = out[k];
    const tb = vb && typeof vb === 'object' ? Number(vb.at) || 0 : 0;
    const ta = va && typeof va === 'object' ? Number(va.at) || 0 : 0;
    if (tb >= ta) out[k] = vb;
  }
  return out;
}

function mergeTrafficExpenseProjectMaps(base, incoming) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  if (!incoming || typeof incoming !== 'object') return out;
  for (const ivId of Object.keys(incoming)) {
    const cur = out[ivId] && typeof out[ivId] === 'object' ? out[ivId] : {};
    const inc = incoming[ivId] && typeof incoming[ivId] === 'object' ? incoming[ivId] : {};
    out[ivId] = mergeTrafficExpenseMaps(cur, inc);
  }
  return out;
}

function seedDemoAccounts() {
  const rows = [
    { id: 'demo-admin', loginId: 'admin', password: 'hrc7766', name: '관리자', role: 'supervisor' },
    { id: 'demo-r1', loginId: 'researcher1', password: 'demo1234', name: '김연구', role: 'researcher' },
    { id: 'demo-r2', loginId: 'researcher2', password: 'demo1234', name: '이실험', role: 'researcher' },
    { id: 'demo-s1', loginId: 'supervisor1', password: 'demo1234', name: '박슈퍼', role: 'supervisor' },
    { id: 'demo-i1', loginId: 'interviewer1', password: 'demo1234', name: '최면접', role: 'interviewer', team: 'busan' },
    { id: 'demo-i2', loginId: 'interviewer2', password: 'demo1234', name: '정리서치', role: 'interviewer', team: 'quant2' },
  ];
  const accounts = [];
  for (const r of rows) {
    const acc = {
      id: r.id,
      loginId: r.loginId,
      passHash: sha256Hex(r.password),
      name: r.name,
      role: r.role,
    };
    if (r.team) acc.team = r.team;
    accounts.push(acc);
  }
  return accounts;
}

/** chat2.xlsx 기반 등 — 있으면 빈 계정 시 이 목록을 우선 사용 */
function loadSeedAccountsFile() {
  try {
    const raw = fs.readFileSync(SEED_ACCOUNTS_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.accounts) || !j.accounts.length) return null;
    const accounts = [];
    for (const a of j.accounts) {
      if (!a || !a.id || !a.loginId || !a.passHash || !a.name || !a.role) continue;
      const acc = {
        id: String(a.id),
        loginId: String(a.loginId),
        passHash: String(a.passHash),
        name: String(a.name),
        role: a.role,
      };
      if (a.team) acc.team = String(a.team);
      accounts.push(acc);
    }
    return accounts.length ? accounts : null;
  } catch (_) {
    return null;
  }
}

function saveSharedToDisk(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 0), 'utf8');
}

/** @type {ReturnType<typeof createClient> | null} */
let supabase = null;
let shared = emptyShared();
let saveTimer = null;

async function loadSharedFromSupabase() {
  const { data, error } = await supabase
    .from(APP_STATE_TABLE)
    .select('data')
    .eq('id', APP_STATE_ID)
    .maybeSingle();
  if (error) {
    console.error('[H-채팅] Supabase 조회 오류:', error.message);
    return null;
  }
  if (!data || data.data == null || typeof data.data !== 'object') return null;
  return data.data;
}

async function saveSharedToSupabase() {
  let payload;
  try {
    payload = JSON.parse(JSON.stringify(shared));
  } catch (e) {
    console.error('[H-채팅] 상태 직렬화 실패:', e.message);
    return;
  }
  const { error } = await supabase.from(APP_STATE_TABLE).upsert(
    {
      id: APP_STATE_ID,
      data: payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);
}

async function flushPersistToStorage() {
  if (useSupabase()) {
    await saveSharedToSupabase();
  } else {
    saveSharedToDisk(shared);
  }
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushPersistToStorage().catch((e) => console.error('[H-채팅] 저장 실패', e.message));
  }, 120);
}

function mergeMessageMaps(serverMsgs, clientMsgs) {
  const base = serverMsgs && typeof serverMsgs === 'object' ? serverMsgs : {};
  if (!clientMsgs || typeof clientMsgs !== 'object') return base;
  const out = { ...base };
  for (const roomId of Object.keys(clientMsgs)) {
    const incoming = clientMsgs[roomId];
    if (!Array.isArray(incoming)) continue;
    const cur = Array.isArray(out[roomId]) ? out[roomId] : [];
    const byId = new Map();
    for (const m of cur) {
      if (m && typeof m === 'object' && m.id) byId.set(m.id, m);
    }
    for (const m of incoming) {
      if (m && typeof m === 'object' && m.id) byId.set(m.id, m);
    }
    out[roomId] = Array.from(byId.values()).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  }
  return out;
}

function mergeSharedUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  shared = {
    ...shared,
    accounts: Array.isArray(payload.accounts) ? payload.accounts : shared.accounts,
    projects: Array.isArray(payload.projects) ? payload.projects : shared.projects,
    rooms: Array.isArray(payload.rooms) ? payload.rooms : shared.rooms,
    messages:
      payload.messages && typeof payload.messages === 'object'
        ? mergeMessageMaps(shared.messages, payload.messages)
        : shared.messages,
    feedbackThreads: Array.isArray(payload.feedbackThreads) ? payload.feedbackThreads : shared.feedbackThreads,
    pinnedChatsByUser:
      payload.pinnedChatsByUser && typeof payload.pinnedChatsByUser === 'object'
        ? payload.pinnedChatsByUser
        : shared.pinnedChatsByUser,
    lastReadByUser:
      payload.lastReadByUser && typeof payload.lastReadByUser === 'object' ? payload.lastReadByUser : shared.lastReadByUser,
    chatNotifyMutedByUser:
      payload.chatNotifyMutedByUser && typeof payload.chatNotifyMutedByUser === 'object'
        ? payload.chatNotifyMutedByUser
        : shared.chatNotifyMutedByUser,
    chatNotifyMutedRoomsByUser:
      payload.chatNotifyMutedRoomsByUser && typeof payload.chatNotifyMutedRoomsByUser === 'object'
        ? payload.chatNotifyMutedRoomsByUser
        : shared.chatNotifyMutedRoomsByUser,
    staffPresenceByUser:
      payload.staffPresenceByUser && typeof payload.staffPresenceByUser === 'object'
        ? payload.staffPresenceByUser
        : shared.staffPresenceByUser,
    trafficExpenseSubmittedByIvId:
      payload.trafficExpenseSubmittedByIvId && typeof payload.trafficExpenseSubmittedByIvId === 'object'
        ? mergeTrafficExpenseMaps(shared.trafficExpenseSubmittedByIvId, payload.trafficExpenseSubmittedByIvId)
        : shared.trafficExpenseSubmittedByIvId,
    trafficExpenseSubmittedByIvProjectKey:
      payload.trafficExpenseSubmittedByIvProjectKey && typeof payload.trafficExpenseSubmittedByIvProjectKey === 'object'
        ? mergeTrafficExpenseProjectMaps(
            shared.trafficExpenseSubmittedByIvProjectKey,
            payload.trafficExpenseSubmittedByIvProjectKey
          )
        : shared.trafficExpenseSubmittedByIvProjectKey,
  };
}

function migrateInterviewerChatRoomDefault() {
  if (shared.__ivChatGeneralDefaultFix) return;
  if (Array.isArray(shared.rooms)) {
    for (const r of shared.rooms) {
      if (r.type === 'group' && !r.isAnnounceFeed && r.interviewerChatAllowed === false) {
        r.interviewerChatAllowed = true;
      }
    }
  }
  shared.__ivChatGeneralDefaultFix = true;
}

function ensureAccountsNonEmpty() {
  if (Array.isArray(shared.accounts) && shared.accounts.length > 0) return;
  const seeded = loadSeedAccountsFile();
  if (seeded && seeded.length) {
    console.log('[H-채팅] 계정 비어 있음 → data/seed-accounts.json 로드 (' + seeded.length + '명)');
    shared.accounts = seeded;
    return;
  }
  console.warn('[H-채팅] 계정 목록이 비어 있어 데모 계정을 채웁니다.');
  shared.accounts = seedDemoAccounts();
}

function initFromFile() {
  const dataFileExists = fs.existsSync(DATA_FILE);
  if (!dataFileExists) {
    const seeded = loadSeedAccountsFile();
    if (seeded && seeded.length) {
      shared = { ...emptyShared(), accounts: seeded };
    } else {
      shared = { ...emptyShared(), accounts: seedDemoAccounts() };
    }
    saveSharedToDisk(shared);
    return;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    shared = { ...emptyShared(), ...j };
    if (!Array.isArray(shared.accounts)) shared.accounts = [];
  } catch (e) {
    console.error('[H-채팅] shared-state.json 손상, 빈 DB로 복구합니다.', e.message);
    shared = { ...emptyShared(), accounts: [] };
    saveSharedToDisk(shared);
  }
  ensureAccountsNonEmpty();
  saveSharedToDisk(shared);
}

async function initFromSupabase() {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let row = await loadSharedFromSupabase();

  if (!row && fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const j = JSON.parse(raw);
      const migrated = { ...emptyShared(), ...j };
      if (!Array.isArray(migrated.accounts)) migrated.accounts = [];
      if (!migrated.accounts.length) migrated.accounts = seedDemoAccounts();
      shared = migrated;
      await saveSharedToSupabase();
      console.log('[H-채팅] 로컬 shared-state.json 을 Supabase 로 복사했습니다.');
      row = await loadSharedFromSupabase();
    } catch (e) {
      console.warn('[H-채팅] 로컬 파일 → Supabase 이전 실패:', e.message);
    }
  }

  if (!row) {
    const seeded = loadSeedAccountsFile();
    if (seeded && seeded.length) {
      shared = { ...emptyShared(), accounts: seeded };
    } else {
      shared = { ...emptyShared(), accounts: seedDemoAccounts() };
    }
    return;
  }

  shared = { ...emptyShared(), ...row };
  if (!Array.isArray(shared.accounts)) shared.accounts = [];
  ensureAccountsNonEmpty();
}

function localIPv4s() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function normalizePublicBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getPublicBaseUrl() {
  const envPub = process.env.PUBLIC_BASE_URL && String(process.env.PUBLIC_BASE_URL).trim();
  if (envPub) return normalizePublicBaseUrl(envPub);

  const render = process.env.RENDER_EXTERNAL_URL && String(process.env.RENDER_EXTERNAL_URL).trim();
  if (render) return normalizePublicBaseUrl(render);

  const railStatic = process.env.RAILWAY_STATIC_URL && String(process.env.RAILWAY_STATIC_URL).trim();
  if (railStatic) return normalizePublicBaseUrl(railStatic);

  const railDom = process.env.RAILWAY_PUBLIC_DOMAIN && String(process.env.RAILWAY_PUBLIC_DOMAIN).trim();
  if (railDom) {
    if (/^https?:\/\//i.test(railDom)) return normalizePublicBaseUrl(railDom);
    return normalizePublicBaseUrl(`https://${railDom}`);
  }

  const flyApp = process.env.FLY_APP_NAME && String(process.env.FLY_APP_NAME).trim();
  if (flyApp) return normalizePublicBaseUrl(`https://${flyApp}.fly.dev`);

  try {
    const line = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim().split(/\r?\n/)[0].trim();
    if (line) return normalizePublicBaseUrl(line);
  } catch (_) {}
  return '';
}

function isLocalAdminRequest(req) {
  const ip = String(req.socket.remoteAddress || req.ip || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const app = express();
const server = http.createServer(app);
/** 기본 1MB면 모바일 고화질 사진·짧은 동영상(base64) 동기화가 잘리므로 여유 있게 허용 */
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 50 * 1024 * 1024,
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    clients: io.engine.clientsCount,
    storage: useSupabase() ? 'supabase' : 'file',
  });
});

app.get('/api/lan-urls', (_req, res) => {
  const urls = localIPv4s().map((ip) => `http://${ip}:${PORT}/`);
  const pub = getPublicBaseUrl();
  res.json({ port: PORT, urls, publicUrl: pub || null });
});

app.use(express.json({ limit: '4kb' }));

app.use((req, res, next) => {
  const p = req.path.replace(/\\/g, '/');
  if (p === '/data/seed-accounts.json' || p.endsWith('/seed-accounts.json')) {
    return res.status(404).end();
  }
  next();
});

app.post('/api/admin/public-url', (req, res) => {
  if (!isLocalAdminRequest(req)) {
    return res.status(403).json({ ok: false, error: '이 PC의 127.0.0.1 로 접속한 브라우저에서만 저장할 수 있습니다.' });
  }
  const raw = req.body && req.body.url != null ? String(req.body.url).trim() : '';
  if (!raw) {
    try {
      fs.unlinkSync(PUBLIC_URL_FILE);
    } catch (_) {}
    return res.json({ ok: true, publicUrl: null });
  }
  if (!/^https?:\/\//i.test(raw)) {
    return res.status(400).json({ ok: false, error: 'http:// 또는 https:// 로 시작하는 주소만 저장할 수 있습니다.' });
  }
  const normalized = normalizePublicBaseUrl(raw);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PUBLIC_URL_FILE, normalized + '\n', 'utf8');
  return res.json({ ok: true, publicUrl: normalized });
});

app.use(express.static(ROOT));

io.on('connection', (socket) => {
  socket.emit('shared:state', shared);
  socket.on('shared:update', (payload) => {
    mergeSharedUpdate(payload);
    schedulePersist();
    io.emit('shared:state', shared);
  });
});

async function bootstrap() {
  if (useSupabase()) {
    console.log('[H-채팅] 저장소: Supabase (Postgres JSONB)');
    await initFromSupabase();
  } else {
    console.log('[H-채팅] 저장소: 로컬 파일', DATA_FILE);
    initFromFile();
  }

  migrateInterviewerChatRoomDefault();
  ensureAccountsNonEmpty();
  await flushPersistToStorage();

  server.listen(PORT, HOST, () => {
    const ips = localIPv4s();
    console.log('');
    console.log('H-채팅 — 실시간 서버 (Socket.IO)');
    console.log(`  이 PC에서   http://127.0.0.1:${PORT}/`);
    ips.forEach((ip) => console.log(`  같은 네트워크 http://${ip}:${PORT}/`));
    console.log(
      useSupabase() ? `  앱 상태 DB     Supabase (${APP_STATE_TABLE})` : `  상태 파일     ${DATA_FILE}`
    );
    console.log('  (휴대폰 등에서 안 열리면 Windows 방화벽에서 이 포트/Node 허용)');
    const pub = getPublicBaseUrl();
    if (pub) console.log(`  인터넷(고정·배포) ${pub}/`);
    else console.log('  인터넷 공개 주소  PUBLIC_BASE_URL 또는 Render 배포 URL');
    console.log('');
  });
}

bootstrap().catch((e) => {
  console.error('[H-채팅] 시작 실패:', e);
  process.exit(1);
});
