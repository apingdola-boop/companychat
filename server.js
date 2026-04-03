#!/usr/bin/env node
/**
 * 회사채팅 — 정적 파일 + Socket.IO 실시간 공유 상태
 * npm install && npm start → http://0.0.0.0:8787
 *
 * Netlify 등 정적 호스팅만으로는 Socket.IO를 쓸 수 없습니다.
 * Railway / Render / Fly.io / 자체 VPS 등 Node가 돌아가는 곳에 배포하세요.
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { networkInterfaces } = require('os');
const { Server } = require('socket.io');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
/** Fly·Render 디스크 마운트 등: 환경변수 DATA_DIR 로 변경 가능 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'shared-state.json');
const PUBLIC_URL_FILE = path.join(DATA_DIR, 'public-base-url.txt');

function sha256Hex(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

function emptyShared() {
  return {
    accounts: [],
    rooms: [],
    messages: {},
    feedbackThreads: [],
    pinnedChatsByUser: {},
    lastReadByUser: {},
    chatNotifyMutedByUser: {},
    chatNotifyMutedRoomsByUser: {},
    staffPresenceByUser: {},
  };
}

function seedDemoAccounts() {
  const rows = [
    { id: 'demo-r1', loginId: 'researcher1', password: 'demo1234', name: '김연구', role: 'researcher' },
    { id: 'demo-r2', loginId: 'researcher2', password: 'demo1234', name: '이실험', role: 'researcher' },
    { id: 'demo-s1', loginId: 'supervisor1', password: 'demo1234', name: '박슈퍼', role: 'supervisor' },
    { id: 'demo-i1', loginId: 'interviewer1', password: 'demo1234', name: '최면접', role: 'interviewer', team: 'busan' },
    { id: 'demo-i2', loginId: 'interviewer2', password: 'demo1234', name: '정리서치', role: 'interviewer', team: 'seoul' },
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

function loadShared() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    return { ...emptyShared(), ...j };
  } catch {
    return emptyShared();
  }
}

function saveSharedToDisk(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 0), 'utf8');
}

let shared = loadShared();
if (!Array.isArray(shared.accounts) || shared.accounts.length === 0) {
  shared = { ...emptyShared(), accounts: seedDemoAccounts() };
  saveSharedToDisk(shared);
}

let saveTimer = null;
function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      saveSharedToDisk(shared);
    } catch (e) {
      console.error('저장 실패', e.message);
    }
  }, 120);
}

function mergeSharedUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  shared = {
    ...shared,
    accounts: Array.isArray(payload.accounts) ? payload.accounts : shared.accounts,
    rooms: Array.isArray(payload.rooms) ? payload.rooms : shared.rooms,
    messages: payload.messages && typeof payload.messages === 'object' ? payload.messages : shared.messages,
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
  };
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
  const s = String(raw || '').trim().replace(/\/+$/, '');
  return s;
}

/**
 * 인터넷에서 접속하는 공개 주소 (고정 도메인·배포 URL)
 * 우선순위: PUBLIC_BASE_URL(커스텀 도메인) → Render/Railway/Fly 자동 변수 → 로컬 저장 파일
 */
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
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: io.engine.clientsCount });
});

/** 같은 Wi-Fi의 휴대폰·다른 PC 접속용 (로그인 화면에서 표시) */
app.get('/api/lan-urls', (_req, res) => {
  const urls = localIPv4s().map((ip) => `http://${ip}:${PORT}/`);
  const pub = getPublicBaseUrl();
  res.json({ port: PORT, urls, publicUrl: pub || null });
});

app.use(express.json({ limit: '4kb' }));

/** 공개(터널) 주소 저장 — 반드시 서버 PC에서 http://127.0.0.1 로 열었을 때만 허용 */
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

server.listen(PORT, HOST, () => {
  const ips = localIPv4s();
  console.log('');
  console.log('회사채팅 — 실시간 서버 (Socket.IO)');
  console.log(`  이 PC에서   http://127.0.0.1:${PORT}/`);
  ips.forEach((ip) => console.log(`  같은 네트워크 http://${ip}:${PORT}/`));
  console.log(`  상태 파일     ${DATA_FILE}`);
  console.log('  (휴대폰 등에서 안 열리면 Windows 방화벽에서 이 포트/Node 허용)');
  const pub = getPublicBaseUrl();
  if (pub)
    console.log(
      `  인터넷(고정·배포) ${pub}/  — Render·Fly·Railway 배포 시 자동, 커스텀 도메인은 PUBLIC_BASE_URL`
    );
  else
    console.log(
      '  인터넷 공개 주소  Render/Fly 배포(저장소 루트 render.yaml 참고) 또는 npm run tunnel + 로그인 화면 저장'
    );
  console.log('');
});
