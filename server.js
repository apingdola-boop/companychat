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
const SEED_PROJECTS_FILE = path.join(ROOT, 'data', 'seed-projects.json');
const PUBLIC_URL_FILE = path.join(DATA_DIR, 'public-base-url.txt');

const APP_STATE_TABLE = 'company_chat_app_state';
const APP_STATE_ID = 'main';
/** 올리면 서버·클라이언트가 예전 교통비 제출을 폐기하고, 구버전 동기화로 복구되지 않음 */
const TRAFFIC_SCHEMA_VERSION = 2;

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
    /** 교통비 제출 표시 전역 초기화 시각(ms). 이 시각 이전 기록은 무시 */
    trafficExpenseResetAt: 0,
    /** 교통비 저장 스키마(버전 낮은 클라이언트의 교통비 필드는 merge에서 무시) */
    trafficExpenseDataVersion: TRAFFIC_SCHEMA_VERSION,
  };
}

function mergeTrafficExpenseMaps(base, incoming, resetAt) {
  const gate = typeof resetAt === 'number' && Number.isFinite(resetAt) ? resetAt : 0;
  const out = {};
  if (base && typeof base === 'object') {
    for (const k of Object.keys(base)) {
      const va = base[k];
      const ta = va && typeof va === 'object' ? Number(va.at) || 0 : 0;
      if (gate > 0 && ta > 0 && ta < gate) continue;
      out[k] = va;
    }
  }
  if (!incoming || typeof incoming !== 'object') return out;
  for (const k of Object.keys(incoming)) {
    const vb = incoming[k];
    const va = out[k];
    const tb = vb && typeof vb === 'object' ? Number(vb.at) || 0 : 0;
    const ta = va && typeof va === 'object' ? Number(va.at) || 0 : 0;
    const cb = vb && typeof vb === 'object' ? !!vb.cleared : false;
    const ca = va && typeof va === 'object' ? !!va.cleared : false;
    if (gate > 0 && tb > 0 && tb < gate) continue;
    if (cb && !ca && tb > 0 && ta > 0 && ta - tb <= 10 * 60 * 1000) {
      out[k] = vb;
      continue;
    }
    if (tb >= ta || (gate > 0 && ta > 0 && ta < gate && tb > 0)) out[k] = vb;
  }
  return out;
}

function mergeTrafficExpenseProjectMaps(base, incoming, resetAt) {
  const out = {};
  const b = base && typeof base === 'object' ? base : {};
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(inc)]);
  for (const ivId of keys) {
    const cur = b[ivId] && typeof b[ivId] === 'object' ? b[ivId] : {};
    const incIv = inc[ivId] && typeof inc[ivId] === 'object' ? inc[ivId] : {};
    const merged = mergeTrafficExpenseMaps(cur, incIv, resetAt);
    if (Object.keys(merged).length > 0) out[ivId] = merged;
  }
  return out;
}

function trafficYmFromAtMsServer(atMs) {
  const t = Number(atMs) || Date.now();
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function trafficCompositeProjectKeyServer(ym, pk) {
  return String(ym || '').trim() + '|' + String(pk || '').trim();
}

function normalizeTrafficFlatInnerForIvServer(inner) {
  if (!inner || typeof inner !== 'object') return {};
  const keys = Object.keys(inner);
  if (keys.some((k) => /^\d{4}-\d{2}$/.test(k))) {
    const out = {};
    for (const k of keys) {
      if (/^\d{4}-\d{2}$/.test(k) && inner[k] && typeof inner[k] === 'object') out[k] = inner[k];
    }
    return out;
  }
  if (typeof inner.at === 'number' && Number.isFinite(inner.at)) {
    const ym = trafficYmFromAtMsServer(inner.at);
    return { [ym]: { ...inner } };
  }
  return {};
}

function normalizeTrafficProjectInnerForIvServer(inner) {
  if (!inner || typeof inner !== 'object') return {};
  const out = {};
  for (const k of Object.keys(inner)) {
    const rec = inner[k];
    if (!rec || typeof rec !== 'object') continue;
    if (k.indexOf('|') === -1) {
      const ym = trafficYmFromAtMsServer(rec.at || Date.now());
      out[trafficCompositeProjectKeyServer(ym, k)] = rec;
    } else {
      out[k] = rec;
    }
  }
  return out;
}

function migrateTrafficMonthlyShapeOnRootServer(root, kind) {
  if (!root || typeof root !== 'object') return;
  for (const ivId of Object.keys(root)) {
    const inner = root[ivId];
    if (!inner || typeof inner !== 'object') continue;
    root[ivId] =
      kind === 'flat' ? normalizeTrafficFlatInnerForIvServer(inner) : normalizeTrafficProjectInnerForIvServer(inner);
    if (Object.keys(root[ivId]).length === 0) delete root[ivId];
  }
}

function mergeTrafficExpenseIvNestedMapServer(base, incoming, resetAt) {
  const b = base && typeof base === 'object' ? base : {};
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(inc)]);
  const out = {};
  for (const ivId of keys) {
    const bIn = normalizeTrafficFlatInnerForIvServer(b[ivId] && typeof b[ivId] === 'object' ? b[ivId] : {});
    const iIn = normalizeTrafficFlatInnerForIvServer(inc[ivId] && typeof inc[ivId] === 'object' ? inc[ivId] : {});
    const merged = mergeTrafficExpenseMaps(bIn, iIn, resetAt);
    if (Object.keys(merged).length > 0) out[ivId] = merged;
  }
  return out;
}

/** 디스크/DB에 리셋 시각만 맞고 맵이 남아 있던 과거 버그 복구 */
function trafficExpenseRecordActiveForGate(rec, gate) {
  if (!rec || typeof rec !== 'object' || rec.cleared) return false;
  const at = Number(rec.at) || 0;
  if (at <= 0) return false;
  const g = typeof gate === 'number' && Number.isFinite(gate) ? gate : 0;
  if (g > 0 && at < g) return false;
  return true;
}

function migrateTrafficExpenseSchemaIfNeeded(shared) {
  if (!shared || typeof shared !== 'object') return;
  const v = Number(shared.trafficExpenseDataVersion) || 0;
  if (v >= TRAFFIC_SCHEMA_VERSION) return;
  shared.trafficExpenseSubmittedByIvId = {};
  shared.trafficExpenseSubmittedByIvProjectKey = {};
  shared.trafficExpenseResetAt = Date.now();
  shared.trafficExpenseDataVersion = TRAFFIC_SCHEMA_VERSION;
  console.log('[H-채팅] 교통비 데이터 스키마 v' + TRAFFIC_SCHEMA_VERSION + ' 적용(기존 제출 일괄 삭제)');
}

function pruneTrafficMapsOnShared(shared) {
  if (!shared || typeof shared !== 'object') return;
  const gate =
    typeof shared.trafficExpenseResetAt === 'number' && Number.isFinite(shared.trafficExpenseResetAt)
      ? shared.trafficExpenseResetAt
      : 0;
  const flat = shared.trafficExpenseSubmittedByIvId;
  if (flat && typeof flat === 'object') {
    for (const id of Object.keys(flat)) {
      const inner = flat[id];
      if (!inner || typeof inner !== 'object') {
        delete flat[id];
        continue;
      }
      for (const ym of Object.keys(inner)) {
        if (!trafficExpenseRecordActiveForGate(inner[ym], gate)) delete inner[ym];
      }
      if (Object.keys(inner).length === 0) delete flat[id];
    }
  }
  const proj = shared.trafficExpenseSubmittedByIvProjectKey;
  if (proj && typeof proj === 'object') {
    for (const ivId of Object.keys(proj)) {
      const mp = proj[ivId];
      if (!mp || typeof mp !== 'object') continue;
      for (const pk of Object.keys(mp)) {
        if (!trafficExpenseRecordActiveForGate(mp[pk], gate)) delete mp[pk];
      }
      if (Object.keys(mp).length === 0) delete proj[ivId];
    }
  }
}

function sanitizeTrafficMapsForResetGate(shared) {
  if (!shared || typeof shared !== 'object') return;
  const gate =
    typeof shared.trafficExpenseResetAt === 'number' && Number.isFinite(shared.trafficExpenseResetAt)
      ? shared.trafficExpenseResetAt
      : 0;
  if (gate > 0) {
    shared.trafficExpenseSubmittedByIvId = mergeTrafficExpenseIvNestedMapServer(
      shared.trafficExpenseSubmittedByIvId || {},
      {},
      gate
    );
    shared.trafficExpenseSubmittedByIvProjectKey = mergeTrafficExpenseProjectMaps(
      shared.trafficExpenseSubmittedByIvProjectKey || {},
      {},
      gate
    );
  }
  pruneTrafficMapsOnShared(shared);
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

function loadSeedProjectsFile() {
  try {
    const raw = fs.readFileSync(SEED_PROJECTS_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.projects) || !j.projects.length) return null;
    const out = [];
    for (const p of j.projects) {
      if (!p || !p.number) continue;
      out.push({ number: String(p.number).trim(), name: p.name != null ? String(p.name).trim() : '' });
    }
    return out.length ? out : null;
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

function cloneJsonObject(o) {
  try {
    return JSON.parse(JSON.stringify(o && typeof o === 'object' ? o : {}));
  } catch (_) {
    return {};
  }
}

function mergeSharedUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  const incomingResetAt =
    typeof payload.trafficExpenseResetAt === 'number' && Number.isFinite(payload.trafficExpenseResetAt)
      ? payload.trafficExpenseResetAt
      : 0;
  const curResetAt = typeof shared.trafficExpenseResetAt === 'number' && Number.isFinite(shared.trafficExpenseResetAt) ? shared.trafficExpenseResetAt : 0;
  const nextResetAt = Math.max(curResetAt, incomingResetAt);
  const incVer = Number(payload.trafficExpenseDataVersion) || 0;
  const curVer = Number(shared.trafficExpenseDataVersion) || 0;

  let trafficFlat;
  let trafficProj;
  let nextTrafficVer;
  if (incVer < curVer) {
    trafficFlat = shared.trafficExpenseSubmittedByIvId;
    trafficProj = shared.trafficExpenseSubmittedByIvProjectKey;
    nextTrafficVer = curVer;
  } else if (incVer > curVer) {
    trafficFlat = cloneJsonObject(payload.trafficExpenseSubmittedByIvId);
    trafficProj = cloneJsonObject(payload.trafficExpenseSubmittedByIvProjectKey);
    migrateTrafficMonthlyShapeOnRootServer(trafficFlat, 'flat');
    migrateTrafficMonthlyShapeOnRootServer(trafficProj, 'project');
    nextTrafficVer = incVer;
  } else {
    nextTrafficVer = curVer;
    trafficFlat =
      payload.trafficExpenseSubmittedByIvId && typeof payload.trafficExpenseSubmittedByIvId === 'object'
        ? mergeTrafficExpenseIvNestedMapServer(
            shared.trafficExpenseSubmittedByIvId,
            payload.trafficExpenseSubmittedByIvId,
            nextResetAt
          )
        : shared.trafficExpenseSubmittedByIvId;
    trafficProj =
      payload.trafficExpenseSubmittedByIvProjectKey && typeof payload.trafficExpenseSubmittedByIvProjectKey === 'object'
        ? mergeTrafficExpenseProjectMaps(shared.trafficExpenseSubmittedByIvProjectKey, payload.trafficExpenseSubmittedByIvProjectKey, nextResetAt)
        : shared.trafficExpenseSubmittedByIvProjectKey;
  }

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
    trafficExpenseResetAt: nextResetAt,
    trafficExpenseDataVersion: nextTrafficVer,
    trafficExpenseSubmittedByIvId: trafficFlat,
    trafficExpenseSubmittedByIvProjectKey: trafficProj,
  };
  pruneTrafficMapsOnShared(shared);
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

function ensureProjectsSeededIfEmpty() {
  if (Array.isArray(shared.projects) && shared.projects.length > 0) return;
  const seeded = loadSeedProjectsFile();
  if (seeded && seeded.length) {
    console.log('[H-채팅] 프로젝트 비어 있음 → data/seed-projects.json 로드 (' + seeded.length + '개)');
    shared.projects = seeded;
  }
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
  ensureProjectsSeededIfEmpty();
  migrateTrafficExpenseSchemaIfNeeded(shared);
  migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvId, 'flat');
  migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvProjectKey, 'project');
  sanitizeTrafficMapsForResetGate(shared);
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
      migrateTrafficExpenseSchemaIfNeeded(shared);
      migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvId, 'flat');
      migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvProjectKey, 'project');
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
  if (!Array.isArray(shared.projects)) shared.projects = [];
  ensureAccountsNonEmpty();
  ensureProjectsSeededIfEmpty();
  migrateTrafficExpenseSchemaIfNeeded(shared);
  migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvId, 'flat');
  migrateTrafficMonthlyShapeOnRootServer(shared.trafficExpenseSubmittedByIvProjectKey, 'project');
  sanitizeTrafficMapsForResetGate(shared);
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
