/**
 * chat2.xlsx → data/seed-accounts.json (passHash = SHA-256 hex, server.js 와 동일)
 * 실행: npm run build:seed
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function sha256Hex(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

function normalizeInterviewerTeam(value) {
  const raw = String(value ?? '').trim();
  const c = raw.replace(/\s/g, '');
  const t = c.toLowerCase();
  if (raw === '부산팀' || c === '부산' || t === 'busan' || t === 'busan team') return 'busan';
  if (raw === '대전팀' || c === '대전' || t === 'daejeon' || t === 'daejeonteam') return 'daejeon';
  if (raw === '대구팀' || c === '대구' || t === 'daegu' || t === 'daeguteam') return 'daegu';
  if (raw === '광주팀' || c === '광주' || t === 'gwangju' || t === 'gwangjuteam') return 'gwangju';
  if (raw === '정량조사부 1팀' || c === '정량조사부1팀' || t === 'quant1') return 'quant1';
  if (raw === '정량조사부 2팀' || c === '정량조사부2팀' || t === 'quant2') return 'quant2';
  if (raw === '서울팀' || c === '서울' || t === 'seoul' || t === 'seoulteam') return 'quant1';
  return null;
}

function normalizeAccountRole(value) {
  const raw = String(value ?? '').trim();
  const compact = raw.replace(/\s/g, '');
  const t = compact.toLowerCase();
  if (raw === '연구원' || t === 'researcher' || t === 'r') return 'researcher';
  if (raw === '슈퍼바이저' || raw === '수퍼바이저' || t === 'supervisor' || t === 's') return 'supervisor';
  if (raw === '면접원' || t === 'interviewer' || t === 'i') return 'interviewer';
  return null;
}

const xlsxPath = path.join(ROOT, 'chat2.xlsx');
if (!fs.existsSync(xlsxPath)) {
  console.error('chat2.xlsx 가 프로젝트 루트에 없습니다.');
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sn = wb.SheetNames[0];
const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });

let start = 0;
if (matrix.length && matrix[0] && String(matrix[0][0] ?? '').trim() === '아이디') start = 1;

const accounts = [];
const errors = [];

for (let i = start; i < matrix.length; i++) {
  const row = matrix[i];
  if (!row) continue;
  const loginId = String(row[0] ?? '').trim();
  const password = row[1] != null ? String(row[1]) : '';
  const name = String(row[2] ?? '').trim();
  const roleCell = row[3];
  const teamCell = row.length > 4 ? row[4] : '';
  if (!loginId && !String(password).trim() && !name) continue;
  const pwTrim = String(password).trim();
  if (!loginId || !pwTrim || pwTrim.length < 4 || !name) {
    errors.push({ row: i + 1, loginId, reason: '필수값 누락' });
    continue;
  }
  const role = normalizeAccountRole(roleCell);
  if (!role) {
    errors.push({ row: i + 1, loginId, reason: '역할 불명' });
    continue;
  }
  let team = null;
  if (role === 'interviewer') {
    team = normalizeInterviewerTeam(teamCell);
    if (!team) {
      errors.push({ row: i + 1, loginId, reason: `팀 매핑 실패: ${teamCell}` });
      continue;
    }
  }
  const id = `seed-${loginId}`;
  const acc = {
    id,
    loginId,
    passHash: sha256Hex(pwTrim),
    name: name.replace(/\s+/g, ' ').trim(),
    role,
  };
  if (team) acc.team = team;
  accounts.push(acc);
}

if (errors.length) {
  console.warn('건너뜀', errors.length, '건 (처음 5개):', errors.slice(0, 5));
}

const outDir = path.join(ROOT, 'data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'seed-accounts.json');
fs.writeFileSync(
  outPath,
  JSON.stringify({ accounts, builtFrom: 'chat2.xlsx', count: accounts.length }, null, 0),
  'utf8'
);
console.log('Wrote', outPath, 'accounts:', accounts.length);
