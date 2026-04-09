(function () {
  'use strict';

  const STORAGE_V2 = 'company-chat-draft-v2';
  const STORAGE_V1 = 'company-chat-draft-v1';
  const LS_THEME = 'company-chat-theme';
  /** 메인 상단에서 「더보기」로 펼친 질문/의견·교통비 탭 유지 */
  const LS_EXTRA_MAIN_TABS = 'company-chat-extra-main-tabs';
  /** 유류비 단독 탭 → Supabase `traffic_submission_signals` 처리 완료 row id */
  const LS_TRAFFIC_BRIDGE_IDS = 'company-chat-traffic-bridge-done-ids';

  function getExtraMainTabsOpen() {
    try {
      return localStorage.getItem(LS_EXTRA_MAIN_TABS) === '1';
    } catch (_) {
      return false;
    }
  }

  function setExtraMainTabsOpen(open) {
    try {
      if (open) localStorage.setItem(LS_EXTRA_MAIN_TABS, '1');
      else localStorage.removeItem(LS_EXTRA_MAIN_TABS);
    } catch (_) {}
  }

  /** Socket 페이로드·메모리 보호 — 서버 maxHttpBufferSize(50MB)와 base64 팽창을 감안 */
  const MAX_CHAT_MEDIA_BYTES = 36 * 1024 * 1024;
  /** 압축 전 원본 허용(카메라 고해상도) — 동영상은 아래 한도만 적용 */
  const MAX_CHAT_IMAGE_SOURCE_BYTES = 80 * 1024 * 1024;

  function dataUrlByteSize(dataUrl) {
    const s = String(dataUrl || '');
    const i = s.indexOf('base64,');
    if (i < 0) return s.length;
    const b64 = s.slice(i + 7);
    return Math.floor((b64.length * 3) / 4);
  }

  /**
   * 고화질 사진은 Base64만으로도 한도 초과하기 쉬움 — 긴 변 기준 리사이즈 + JPEG 로 채팅에 맞게 축소.
   * GIF·로드 실패 시 null → 호출부에서 원본(FileReader) 폴백.
   */
  function compressImageFileToDataUrl(file) {
    return new Promise((resolve) => {
      if (!file || !fileLooksImage(file)) {
        resolve(null);
        return;
      }
      const t = (file.type || '').toLowerCase();
      if (t === 'image/gif') {
        resolve(null);
        return;
      }
      const blobUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(blobUrl);
        try {
          const iw = img.naturalWidth || img.width;
          const ih = img.naturalHeight || img.height;
          if (!iw || !ih) {
            resolve(null);
            return;
          }
          const passes = [
            { edge: 2560, q: 0.88 },
            { edge: 1920, q: 0.82 },
            { edge: 1600, q: 0.76 },
            { edge: 1280, q: 0.72 },
            { edge: 1024, q: 0.68 },
          ];
          let last = null;
          for (const { edge, q } of passes) {
            let w = iw;
            let h = ih;
            if (w > edge || h > edge) {
              if (w >= h) {
                h = Math.max(1, Math.round((h * edge) / w));
                w = edge;
              } else {
                w = Math.max(1, Math.round((w * edge) / h));
                h = edge;
              }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(null);
              return;
            }
            ctx.drawImage(img, 0, 0, w, h);
            last = canvas.toDataURL('image/jpeg', q);
            if (dataUrlByteSize(last) <= MAX_CHAT_MEDIA_BYTES) {
              resolve(last);
              return;
            }
          }
          resolve(last && dataUrlByteSize(last) <= MAX_CHAT_MEDIA_BYTES ? last : null);
        } catch (_) {
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        resolve(null);
      };
      img.src = blobUrl;
    });
  }

  function fileLooksImage(f) {
    if (!f) return false;
    const t = (f.type || '').toLowerCase();
    if (t.startsWith('image/')) return true;
    return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.name || '');
  }

  function fileLooksVideo(f) {
    if (!f) return false;
    const t = (f.type || '').toLowerCase();
    if (t.startsWith('video/')) return true;
    return /\.(mp4|webm|mov|m4v|mkv|3gp|ogg)$/i.test(f.name || '');
  }

  function escapeDataUrlForAttr(url) {
    return String(url)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function getTheme() {
    try {
      return localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  /** DOM·localStorage·theme-color 메타를 한데 맞춤 (첫 페인트는 index.html 인라인 스크립트가 담당) */
  function applyTheme(mode) {
    const t = mode === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(LS_THEME, t);
    } catch (_) {}
    const meta = document.getElementById('meta-theme-color');
    if (meta) {
      meta.setAttribute('content', t === 'light' ? '#3d5afe' : '#1a1d23');
    }
  }

  function themeToggleButtonHtml(extraClass) {
    const extra = extraClass ? ' ' + extraClass : '';
    const dark = getTheme() === 'dark';
    const label = dark ? '☀ 밝게' : '🌙 어둡게';
    const title = dark ? '어두운 화면입니다. 탭하면 밝은 모드로 바꿉니다.' : '밝은 화면입니다. 탭하면 어두운 모드로 바꿉니다.';
    return `<button type="button" class="btn btn-ghost btn-theme${extra}" id="btn-theme" title="${title}">${label}</button>`;
  }

  function bindThemeToggle() {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const sync = () => {
      const dark = getTheme() === 'dark';
      btn.textContent = dark ? '☀ 밝게' : '🌙 어둡게';
      btn.title = dark ? '어두운 화면입니다. 탭하면 밝은 모드로 바꿉니다.' : '밝은 화면입니다. 탭하면 어두운 모드로 바꿉니다.';
    };
    sync();
    btn.addEventListener('click', () => {
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
      sync();
    });
  }

  const ROLES = {
    researcher: { label: '연구원', className: 'researcher' },
    supervisor: { label: '슈퍼바이저', className: 'supervisor' },
    interviewer: { label: '면접원', className: 'interviewer' },
  };

  /** 슈퍼바이저·면접원 — 교통비·거리 계산 외부 도구 (ROUTE CALC, GitHub Pages) */
  const TRAFFIC_TOOL_URL = 'https://apingdola-boop.github.io/trafficservice.github.io/';
  /** iframe postMessage 출처 검증 (경로만 다를 뿐 origin 동일) */
  const TRAFFIC_TOOL_ORIGIN = 'https://apingdola-boop.github.io';

  function trafficToolPageOrigin() {
    try {
      return new URL(TRAFFIC_TOOL_URL).origin;
    } catch (_) {
      return TRAFFIC_TOOL_ORIGIN;
    }
  }

  /** 유류비 도구(iframe)에서 온 postMessage만 허용. 로컬에서 도구를 띄운 경우 localhost도 허용. */
  function trafficPostMessageOriginAllowed(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (origin === TRAFFIC_TOOL_ORIGIN || origin === trafficToolPageOrigin()) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
    try {
      const extra = String(localStorage.getItem('company-chat-traffic-tool-origins') || '')
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (extra.includes(origin)) return true;
    } catch (_) {}
    return false;
  }

  /** 유류비 postMessage에서 이름·아이디 비교용 (공백 정리·소문자) */
  function normalizeTrafficLookupKey(s) {
    return String(s ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /** postMessage 페이로드로 면접원 계정 찾기 (로그인 아이디·표시 이름·내부 id·사번 형식 번호 등) */
  function findInterviewerForTrafficMessage(data) {
    if (!data || typeof data !== 'object') return null;
    const accounts = state.accounts.filter((a) => a.role === 'interviewer');
    if (!accounts.length) return null;

    function matchByLoginIdString(raw) {
      const t = raw != null ? String(raw).trim() : '';
      if (!t) return null;
      const folded = t.toLowerCase().replace(/\s/g, '');
      let acc = accounts.find((a) => String(a.loginId).trim() === t);
      if (!acc) acc = accounts.find((a) => String(a.loginId).trim().toLowerCase().replace(/\s/g, '') === folded);
      return acc || null;
    }

    /** companychat 내부 id 또는 로그인 아이디(숫자 사번 등) */
    function matchByAnyId(raw) {
      const t = raw != null ? String(raw).trim() : '';
      if (!t) return null;
      let acc = accounts.find((a) => String(a.id).trim() === t);
      if (!acc) acc = matchByLoginIdString(t);
      return acc || null;
    }

    /** 동일 표시 이름이 한 명일 때만 (동명이인이면 매칭 안 함) */
    function matchByDisplayName(raw) {
      const nk = normalizeTrafficLookupKey(raw);
      if (!nk) return null;
      const hits = accounts.filter((a) => normalizeTrafficLookupKey(a.name) === nk);
      if (hits.length === 1) return hits[0];
      return null;
    }

    const nameCandidates = [
      data.name,
      data.ivName,
      data.interviewerName,
      data.userName,
      data.displayName,
    ];
    for (const nc of nameCandidates) {
      const hit = matchByDisplayName(nc);
      if (hit) return hit;
    }

    const idCandidates = [
      data.ivId,
      data.accountId,
      data.interviewerId,
      data.memberId,
      data.staffId,
      data.employeeId,
    ];
    for (const ic of idCandidates) {
      if (ic == null || ic === '') continue;
      const hit = matchByAnyId(ic);
      if (hit) return hit;
    }

    const lidRaw = data.loginId != null ? String(data.loginId).trim() : '';
    if (lidRaw) {
      const byLogin = matchByLoginIdString(lidRaw);
      if (byLogin) return byLogin;
      const byName = matchByDisplayName(lidRaw);
      if (byName) return byName;
    }

    return null;
  }

  function mergeTrafficExpenseMaps(base, incoming, resetAt) {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    if (!incoming || typeof incoming !== 'object') return out;
    const gate = typeof resetAt === 'number' && Number.isFinite(resetAt) ? resetAt : 0;
    for (const k of Object.keys(incoming)) {
      const vb = incoming[k];
      const va = out[k];
      const tb = vb && typeof vb === 'object' ? Number(vb.at) || 0 : 0;
      const ta = va && typeof va === 'object' ? Number(va.at) || 0 : 0;
      const cb = vb && typeof vb === 'object' ? !!vb.cleared : false;
      const ca = va && typeof va === 'object' ? !!va.cleared : false;
      if (gate > 0 && tb > 0 && tb < gate) continue;
      if (gate > 0 && ta > 0 && ta < gate) {
        // 리셋 이전 값은 더 이상 의미가 없으므로 비교를 쉽게 하기 위해 ta를 0처럼 취급
        // (out[k]는 아래 조건에서 vb로 덮어쓰기 될 수 있음)
      }
      // 기기 시간차로 취소가 더 "과거"로 찍혀도, 근접한 경우(10분)는 취소 우선
      if (cb && !ca && tb > 0 && ta > 0 && ta - tb <= 10 * 60 * 1000) {
        out[k] = vb;
        continue;
      }
      if (tb >= ta || (gate > 0 && ta > 0 && ta < gate && tb > 0)) out[k] = vb;
    }
    return out;
  }

  const TEAM_ORDER = ['quant1', 'quant2', 'busan', 'daegu', 'daejeon', 'gwangju'];
  const TEAMS = {
    quant1: '정량조사부 1팀',
    quant2: '정량조사부 2팀',
    busan: '부산팀',
    daegu: '대구팀',
    daejeon: '대전팀',
    gwangju: '광주팀',
  };

  /** 연구원·슈퍼바이저 업무 상태(면접원 미사용): 초록 업무·주황 자리비움·빨강 휴가 */
  const STAFF_PRESENCE_CYCLE = ['available', 'away', 'vacation'];
  const STAFF_PRESENCE_META = {
    available: { label: '업무 중' },
    away: { label: '자리비움' },
    vacation: { label: '휴가' },
  };

  /** 면접원이 메시지를 보낼 때, 방 안 직원이 자리비움·휴가이면 이후 자동 안내 말풍선 */
  const AUTO_ABSENCE_REPLY_TEXT =
    '휴가 또는 자리비움 상태이니, 돌아오는 대로 최대한 빠르게 회신드리겠습니다.';

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

  function teamLabel(key) {
    return key && TEAMS[key] ? TEAMS[key] : '';
  }

  function accountMatchesSearch(u, rawQuery) {
    let needle = String(rawQuery || '')
      .trim()
      .toLowerCase();
    if (!needle) return true;
    if (needle.startsWith('@')) needle = needle.slice(1);
    if (!needle) return true;
    if (String(u.loginId || '')
      .toLowerCase()
      .includes(needle))
      return true;
    if (String(u.name || '')
      .toLowerCase()
      .includes(needle))
      return true;
    if (ROLES[u.role].label.toLowerCase().includes(needle)) return true;
    const tl = teamLabel(u.team);
    if (tl && tl.toLowerCase().includes(needle)) return true;
    return false;
  }

  /** 「계정」탭·등록/추가/엑셀 업로드: 연구원·슈퍼바이저만. (면접원은 계정을 직접 등록하지 않음) */
  function canManageAccounts() {
    return !!(state.me && (state.me.role === 'researcher' || state.me.role === 'supervisor'));
  }

  /** 단체방에서 면접원보내기: 연구원·슈퍼바이저만 */
  function canKickInterviewersFromRoom() {
    return !!(state.me && (state.me.role === 'researcher' || state.me.role === 'supervisor'));
  }

  /** 방 공지·단체방 면접원 채팅 허용 토글: 연구원·슈퍼바이저만 */
  function canPostRoomModeration() {
    return !!(state.me && (state.me.role === 'researcher' || state.me.role === 'supervisor'));
  }

  /** 연구원·슈퍼바이저만: 푸시·브라우저 알림 전역 끔 (채팅 열람·목록과 무관) */
  function isChatNotifyMutedForUser(userId) {
    return !!(userId && state.chatNotifyMutedByUser && state.chatNotifyMutedByUser[userId]);
  }

  /** 연구원·슈퍼바이저만: 해당 방만 푸시·브라우저 알림 끔 */
  function isChatNotifyMutedForRoom(userId, roomId) {
    if (!userId || !roomId) return false;
    const inner = state.chatNotifyMutedRoomsByUser && state.chatNotifyMutedRoomsByUser[userId];
    return !!(inner && inner[roomId]);
  }

  /** 주소록·채팅 참가자 등: 연구원·슈퍼바이저 로그인 아이디는 누구에게도 표시하지 않음 */
  function shouldHidePublicLoginId(role) {
    return role === 'researcher' || role === 'supervisor';
  }

  /** 주소록 한 줄용: 면접원만 @아이디 줄 표시 */
  function publicLoginIdCaptionHtml(u) {
    if (!u || shouldHidePublicLoginId(u.role)) return '';
    return `<span class="caption" style="display:block;margin:0">@${escapeHtml(u.loginId)}</span>`;
  }

  /** 체크리스트·셀렉트 옵션용: ` · @id` 또는 빈 문자열 */
  function publicLoginIdListSuffixEscaped(u) {
    if (!u || shouldHidePublicLoginId(u.role)) return '';
    return ` · @${escapeHtml(u.loginId)}`;
  }

  function normalizeRoomModeration(room) {
    if (!room) return;
    /** 실시간 동기화·구버전 데이터에서 type 누락 시 2인 방은 1:1(dm)으로 간주 (면접원 단체방 잠금 오동작 방지) */
    if (
      !room.type &&
      Array.isArray(room.memberIds) &&
      room.memberIds.length === 2 &&
      !room.isAnnounceFeed
    ) {
      room.type = 'dm';
    }
    if (room.type === 'group' && typeof room.interviewerChatAllowed !== 'boolean') {
      room.interviewerChatAllowed = !room.isAnnounceFeed;
    }
    if (typeof room.roomNoticeTitle !== 'string') room.roomNoticeTitle = '';
    if (typeof room.roomNoticeBody !== 'string') room.roomNoticeBody = '';
    if (room.type === 'group' && typeof room.projectNumber !== 'string') room.projectNumber = '';
  }

  /** 단체방만: 면접원은 연구원·슈퍼바이저가 허용하기 전까지 메시지·사진 전송 불가. 직원은 허용 토글과 무관하게 항상 전송 가능 */
  function interviewerChatSendBlocked(room) {
    if (!state.me) return false;
    if (isStaffAccountRole(state.me.role)) return false;
    if (state.me.role !== 'interviewer' || !room || room.type !== 'group') return false;
    return !room.interviewerChatAllowed;
  }

  function findDmRoomWith(otherUserId) {
    return state.rooms.find(
      (r) =>
        r.type === 'dm' &&
        r.memberIds &&
        r.memberIds.includes(state.me.id) &&
        r.memberIds.includes(otherUserId)
    );
  }

  function deleteRoomAndMessages(roomId) {
    state.rooms = state.rooms.filter((r) => r.id !== roomId);
    delete state.messages[roomId];
    removeRoomIdFromAllPinnedLists(roomId);
    removeRoomIdFromAllLastReadMaps(roomId);
    removeRoomIdFromAllChatRoomNotifyMutes(roomId);
  }

  function removeRoomIdFromAllChatRoomNotifyMutes(roomId) {
    const map = state.chatNotifyMutedRoomsByUser;
    if (!map || typeof map !== 'object') return;
    for (const uid of Object.keys(map)) {
      const inner = map[uid];
      if (inner && typeof inner === 'object' && inner[roomId]) {
        delete inner[roomId];
        if (Object.keys(inner).length === 0) delete map[uid];
      }
    }
  }

  function removeRoomIdFromAllLastReadMaps(roomId) {
    const map = state.lastReadByUser;
    if (!map || typeof map !== 'object') return;
    for (const uid of Object.keys(map)) {
      const inner = map[uid];
      if (inner && typeof inner === 'object' && roomId in inner) delete inner[roomId];
    }
  }

  function removeRoomIdFromAllPinnedLists(roomId) {
    const map = state.pinnedChatsByUser;
    if (!map || typeof map !== 'object') return;
    for (const uid of Object.keys(map)) {
      const arr = map[uid];
      if (!Array.isArray(arr)) continue;
      map[uid] = arr.filter((id) => id !== roomId);
    }
  }

  function unpinRoomForUser(userId, roomId) {
    const map = state.pinnedChatsByUser;
    if (!map || !userId || !Array.isArray(map[userId])) return;
    map[userId] = map[userId].filter((id) => id !== roomId);
  }

  function isChatPinnedForUser(userId, roomId) {
    const arr = state.pinnedChatsByUser && state.pinnedChatsByUser[userId];
    return Array.isArray(arr) && arr.includes(roomId);
  }

  /** 고정한 순서대로 앞에 두고, 나머지는 최근 메시지 순 */
  function sortedChatsForUser(rooms, userId) {
    const rawOrder = (state.pinnedChatsByUser && state.pinnedChatsByUser[userId]) || [];
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const pinOrder = rawOrder.filter((id) => byId.has(id));
    const pinned = pinOrder.map((id) => byId.get(id));
    const pinSet = new Set(pinOrder);
    const unpinned = rooms
      .filter((r) => !pinSet.has(r.id))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return [...pinned, ...unpinned];
  }

  function togglePinChatRoom(roomId) {
    if (!state.me) return;
    const meId = state.me.id;
    if (!state.pinnedChatsByUser || typeof state.pinnedChatsByUser !== 'object') state.pinnedChatsByUser = {};
    if (!Array.isArray(state.pinnedChatsByUser[meId])) state.pinnedChatsByUser[meId] = [];
    const arr = state.pinnedChatsByUser[meId];
    const i = arr.indexOf(roomId);
    if (i >= 0) {
      arr.splice(i, 1);
      showToast('고정을 해제했습니다.');
    } else {
      arr.unshift(roomId);
      showToast('채팅을 맨 위에 고정했습니다.');
    }
    saveState();
  }

  /** 저장 데이터에 읽음 시각이 없을 때만: 그 시점까지 메시지는 읽은 것으로 간주(미읽음 폭주 방지) */
  function batchEnsureLastReadBaselineForRooms(userId, rooms) {
    if (!userId || !rooms || !rooms.length) return;
    if (!state.lastReadByUser) state.lastReadByUser = {};
    if (!state.lastReadByUser[userId]) state.lastReadByUser[userId] = {};
    const m = state.lastReadByUser[userId];
    let dirty = false;
    for (const r of rooms) {
      if (typeof m[r.id] === 'number') continue;
      const msgs = state.messages[r.id] || [];
      m[r.id] = msgs.length ? Math.max(...msgs.map((x) => x.ts)) : Date.now();
      dirty = true;
    }
    if (dirty) saveState();
  }

  /** 상대(다른 사람·공지 포함)가 보낸 메시지 수 */
  function unreadCountForRoom(roomId, userId) {
    const lastRead = state.lastReadByUser && state.lastReadByUser[userId] && state.lastReadByUser[userId][roomId];
    if (typeof lastRead !== 'number') return 0;
    const msgs = state.messages[roomId] || [];
    return msgs.filter((m) => m.ts > lastRead && m.senderId !== userId).length;
  }

  function markRoomAsRead(userId, roomId) {
    if (!userId || !roomId) return;
    const msgs = state.messages[roomId] || [];
    const lastTs = msgs.length ? Math.max(...msgs.map((m) => m.ts)) : Date.now();
    if (!state.lastReadByUser) state.lastReadByUser = {};
    if (!state.lastReadByUser[userId]) state.lastReadByUser[userId] = {};
    const prev = state.lastReadByUser[userId][roomId];
    if (prev === lastTs) return;
    state.lastReadByUser[userId][roomId] = lastTs;
    saveState();
  }

  function leaveChatRoom(roomId) {
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room || !room.memberIds) return false;
    if (state.me) {
      unpinRoomForUser(state.me.id, roomId);
      if (state.lastReadByUser && state.lastReadByUser[state.me.id])
        delete state.lastReadByUser[state.me.id][roomId];
      const rm = state.chatNotifyMutedRoomsByUser && state.chatNotifyMutedRoomsByUser[state.me.id];
      if (rm && typeof rm === 'object' && rm[roomId]) {
        delete rm[roomId];
        if (Object.keys(rm).length === 0) delete state.chatNotifyMutedRoomsByUser[state.me.id];
      }
    }
    room.memberIds = room.memberIds.filter((id) => id !== state.me.id);
    if (room.memberIds.length === 0) deleteRoomAndMessages(room.id);
    else room.updatedAt = Date.now();
    saveState();
    return true;
  }

  function kickInterviewerFromRoom(roomId, targetId) {
    if (!canKickInterviewersFromRoom()) return false;
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room || room.type !== 'group' || !room.memberIds) return false;
    const tu = userById(targetId);
    if (!tu || tu.role !== 'interviewer' || targetId === state.me.id) return false;
    if (!room.memberIds.includes(targetId)) return false;
    room.memberIds = room.memberIds.filter((id) => id !== targetId);
    room.updatedAt = Date.now();
    if (room.memberIds.length === 0) deleteRoomAndMessages(room.id);
    saveState();
    return true;
  }

  /** 수동·엑셀 공통: 등록할 수 있는 역할(연구원·슈퍼바이저·면접원) */
  function normalizeAccountRole(value) {
    const raw = String(value ?? '').trim();
    const compact = raw.replace(/\s/g, '');
    const t = compact.toLowerCase();
    if (raw === '연구원' || t === 'researcher' || t === 'r') return 'researcher';
    if (raw === '슈퍼바이저' || raw === '수퍼바이저' || t === 'supervisor' || t === 's') return 'supervisor';
    if (raw === '면접원' || t === 'interviewer' || t === 'i') return 'interviewer';
    return null;
  }

  function isValidAccountRoleKey(role) {
    return role === 'researcher' || role === 'supervisor' || role === 'interviewer';
  }

  /** 연구원·슈퍼바이저 표시 이름 비교용(앞뒤 공백·연속 공백 통일) */
  function normalizeStaffDisplayName(name) {
    return String(name ?? '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function isStaffAccountRole(role) {
    return role === 'researcher' || role === 'supervisor';
  }

  /** 이미 등록된 연구원·슈퍼바이저와 동일 표시 이름이 있는지 */
  function staffDisplayNameTakenByExisting(normalizedName, excludeAccountId) {
    if (!normalizedName) return false;
    return state.accounts.some(
      (a) =>
        isStaffAccountRole(a.role) &&
        (!excludeAccountId || a.id !== excludeAccountId) &&
        normalizeStaffDisplayName(a.name) === normalizedName
    );
  }

  function uid() {
    return 'u' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
  }

  async function hashPassword(plain) {
    const t = String(plain);
    if (!window.crypto || !crypto.subtle) {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h << 5) - h + t.charCodeAt(i);
      return 'legacy:' + h + ':' + t.length;
    }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function loadStateRaw() {
    try {
      const raw2 = localStorage.getItem(STORAGE_V2);
      if (raw2) return { data: JSON.parse(raw2), fromV1: false };
      const raw1 = localStorage.getItem(STORAGE_V1);
      if (raw1) return { data: JSON.parse(raw1), fromV1: true };
    } catch (_) {}
    return { data: null, fromV1: false };
  }

  function emptyState() {
    return {
      me: null,
      accounts: [],
      projects: [],
      rooms: [],
      messages: {},
      feedbackThreads: [],
      pinnedChatsByUser: {},
      lastReadByUser: {},
      chatNotifyMutedByUser: {},
      chatNotifyMutedRoomsByUser: {},
      staffPresenceByUser: {},
      trafficExpenseSubmittedByIvId: {},
      trafficExpenseSubmittedByIvProjectKey: {},
      /** 교통비 제출 표시 전역 초기화 시각(ms). 이 시각 이전 기록은 무시 */
      trafficExpenseResetAt: 0,
    };
  }

  function loadState() {
    const { data, fromV1 } = loadStateRaw();
    if (!data) return { ...emptyState(), _migrateV1: false };

    const base = {
      me: data.me && data.me.loginId ? data.me : null,
      accounts: Array.isArray(data.accounts)
        ? data.accounts.map((a) =>
            a && a.role === 'interviewer' && a.team === 'seoul' ? { ...a, team: 'quant1' } : a
          )
        : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      rooms: Array.isArray(data.rooms) ? data.rooms : [],
      messages: data.messages && typeof data.messages === 'object' ? data.messages : {},
      feedbackThreads: Array.isArray(data.feedbackThreads) ? data.feedbackThreads : [],
      pinnedChatsByUser:
        data.pinnedChatsByUser && typeof data.pinnedChatsByUser === 'object' && !Array.isArray(data.pinnedChatsByUser)
          ? data.pinnedChatsByUser
          : {},
      lastReadByUser:
        data.lastReadByUser && typeof data.lastReadByUser === 'object' && !Array.isArray(data.lastReadByUser)
          ? data.lastReadByUser
          : {},
      chatNotifyMutedByUser:
        data.chatNotifyMutedByUser &&
        typeof data.chatNotifyMutedByUser === 'object' &&
        !Array.isArray(data.chatNotifyMutedByUser)
          ? data.chatNotifyMutedByUser
          : {},
      chatNotifyMutedRoomsByUser:
        data.chatNotifyMutedRoomsByUser &&
        typeof data.chatNotifyMutedRoomsByUser === 'object' &&
        !Array.isArray(data.chatNotifyMutedRoomsByUser)
          ? data.chatNotifyMutedRoomsByUser
          : {},
      staffPresenceByUser:
        data.staffPresenceByUser &&
        typeof data.staffPresenceByUser === 'object' &&
        !Array.isArray(data.staffPresenceByUser)
          ? data.staffPresenceByUser
          : {},
      trafficExpenseSubmittedByIvId:
        data.trafficExpenseSubmittedByIvId &&
        typeof data.trafficExpenseSubmittedByIvId === 'object' &&
        !Array.isArray(data.trafficExpenseSubmittedByIvId)
          ? data.trafficExpenseSubmittedByIvId
          : {},
      trafficExpenseSubmittedByIvProjectKey:
        data.trafficExpenseSubmittedByIvProjectKey &&
        typeof data.trafficExpenseSubmittedByIvProjectKey === 'object' &&
        !Array.isArray(data.trafficExpenseSubmittedByIvProjectKey)
          ? data.trafficExpenseSubmittedByIvProjectKey
          : {},
      trafficExpenseResetAt:
        typeof data.trafficExpenseResetAt === 'number' && Number.isFinite(data.trafficExpenseResetAt)
          ? data.trafficExpenseResetAt
          : 0,
      _migrateV1: fromV1 || (!!data.directory && !data.accounts),
    };
    if (data.directory && !base.accounts.length) base._legacyDirectory = data.directory;
    return base;
  }

  let state = loadState();
  let view = {
    screen: 'login',
    tab: 'chats',
    roomId: null,
    modal: null,
    chatSideOpen: false,
    _lastOpenRoomId: null,
    /** 개발자 모드: 작업 표에 올린 면접원 id (검색·추가 순서 유지) */
    devBulkSelectedIds: [],
    /** 개발자 모드: 검색창 입력 유지용 */
    devBulkSearchDraft: '',
    /** 교통비 현황표: 검색·팀·프로젝트(단체방) 필터 */
    trafficListFilter: { q: '', team: '', roomId: '', ym: '' },
  };

  /** 개발자 모드: 면접원 계정 id → 첨부 예정 사진(data URL). 탭을 벗어나면 비움. */
  const devBulkPendingImageByIvId = Object.create(null);

  let trafficPostMessageListenerAttached = false;
  let trafficFileDlBinderAttached = false;
  let trafficCrossTabStorageAttached = false;
  let trafficBridgeSupabaseClient = null;
  let trafficBridgePollStarted = false;

  const el = {
    root: null,
  };

  let realtimeSocket = null;
  /** 서버에서 공유 스냅샷을 받은 뒤에는 로컬 데모 계정 시드를 건너뜀 */
  let realtimeSyncedFromServer = false;
  /** localStorage 키: 실시간 서버 베이스 URL (예: http://127.0.0.1:8787) */
  const LS_SOCKET_URL = 'company-chat-socket-url';
  const DEFAULT_SOCKET_PORT = '8787';
  let lastSocketConnectBase = '';
  let realtimeConnectError = '';
  /** 채팅 IME 조합 중 #msg-list innerHTML 갱신이 일부 환경에서 조합을 끊을 수 있어 패치를 늦춤 */
  let chatImeComposing = false;
  let chatInboxPatchPending = false;
  function normalizeSocketBaseUrl(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    s = s.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }

  /**
   * Render 등 공개 https 로 열었는데 예전에 저장된 127.0.0.1/사설 IP 소켓 주소가 남아 있으면
   * 연결이 계속 실패하고 connect마다 render()가 돌아 채팅 입력 DOM이 리셋되는 문제가 난다.
   * 이 경우 저장값은 무시하고(로컬스토리지는 삭제) 현재 페이지 origin 으로만 붙인다.
   */
  function isLoopbackOrPrivateSocketHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  }

  function shouldIgnoreSocketBaseForThisPage(normUrl) {
    if (!normUrl || window.location.protocol !== 'https:' || isLoopbackHost()) return false;
    try {
      const u = new URL(normUrl);
      return isLoopbackOrPrivateSocketHost(u.hostname);
    } catch (_) {
      return false;
    }
  }

  function getExplicitSocketBaseUrl() {
    try {
      const q =
        new URLSearchParams(window.location.search).get('socket') ||
        new URLSearchParams(window.location.search).get('chatSocket');
      if (q && q.trim()) {
        const n = normalizeSocketBaseUrl(q.trim());
        if (!shouldIgnoreSocketBaseForThisPage(n)) return n;
      }
    } catch (_) {}
    try {
      const s = localStorage.getItem(LS_SOCKET_URL);
      if (s && s.trim()) {
        const n = normalizeSocketBaseUrl(s.trim());
        if (shouldIgnoreSocketBaseForThisPage(n)) {
          try {
            localStorage.removeItem(LS_SOCKET_URL);
          } catch (_) {}
        } else return n;
      }
    } catch (_) {}
    const meta = document.querySelector('meta[name="company-chat-socket-url"]');
    const mc = meta && meta.getAttribute('content');
    if (mc && String(mc).trim()) {
      const n = normalizeSocketBaseUrl(String(mc).trim());
      if (!shouldIgnoreSocketBaseForThisPage(n)) return n;
    }
    return '';
  }

  /** Live Server·file:// 등에서는 현재 페이지 Origin이 아닌 Node 서버로 붙어야 함 */
  function inferSocketBaseUrl() {
    const p = window.location.protocol;
    const port = window.location.port;
    const host = window.location.hostname;
    if (p === 'file:') return normalizeSocketBaseUrl(`http://127.0.0.1:${DEFAULT_SOCKET_PORT}`);
    if (p !== 'http:' && p !== 'https:') return '';
    if (port === DEFAULT_SOCKET_PORT) return '';
    const proto = p === 'https:' ? 'https:' : 'http:';
    if (port === '' || port === '80' || port === '443') return '';
    return normalizeSocketBaseUrl(`${proto}//${host}:${DEFAULT_SOCKET_PORT}`);
  }

  function resolveSocketBaseUrl() {
    return getExplicitSocketBaseUrl() || inferSocketBaseUrl() || '';
  }

  function socketIoOptions() {
    return { transports: ['websocket', 'polling'], path: '/socket.io/' };
  }

  /** 서버 /api/lan-urls — 같은 Wi-Fi용 LAN 주소 */
  let lanUrlsFromServer = [];
  /** 서버에 저장된 인터넷 공개(터널) 주소 — 다른 Wi-Fi·LTE에서 접속 */
  let publicUrlFromServer = '';

  async function refreshLanAccessHint() {
    lanUrlsFromServer = [];
    publicUrlFromServer = '';
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
    try {
      const r = await fetch(`${window.location.origin}/api/lan-urls`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      lanUrlsFromServer = Array.isArray(j.urls) ? j.urls : [];
      publicUrlFromServer =
        typeof j.publicUrl === 'string' && j.publicUrl.trim() ? j.publicUrl.trim().replace(/\/+$/, '') : '';
    } catch (_) {}
  }

  function isLoopbackHost() {
    const h = window.location.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  }

  function buildLanOnlyBannerHtml() {
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return '';
    const portHint = window.location.port || DEFAULT_SOCKET_PORT;
    if (isLoopbackHost()) {
      if (!lanUrlsFromServer.length) {
        return `<div class="lan-access-banner">
          <p class="lan-access-title">같은 Wi-Fi 안에서만 (LAN 주소)</p>
          <p class="hint">이 PC에 <strong>Wi-Fi·유선 LAN</strong> IP가 있어야 합니다. 연결 후 새로 고침하거나, 터미널에 표시된 <code>http://(IP):${escapeHtml(portHint)}/</code> 주소를 직접 입력해 보세요.</p>
        </div>`;
      }
      const items = lanUrlsFromServer
        .map((u) => {
          const enc = encodeURIComponent(u);
          const vis = escapeHtml(u);
          return `<li><code>${vis}</code> <button type="button" class="btn btn-ghost btn-lan-copy" data-copy-lan="${enc}">복사</button></li>`;
        })
        .join('');
      return `<div class="lan-access-banner">
        <p class="lan-access-title">같은 Wi-Fi 안에서만 (LAN 주소)</p>
        <p class="hint">아래 주소는 <strong>같은 공유기 Wi-Fi</strong>에 있을 때만 됩니다. 다른 장소·LTE는 아래 <strong>다른 Wi-Fi에서도 쓰려면 (터널)</strong>을 설정하세요.</p>
        <ul class="lan-access-urls">${items}</ul>
        <p class="hint">안 열리면 Windows <strong>방화벽</strong>에서 TCP 포트 <strong>${escapeHtml(portHint)}</strong> 또는 Node.js 인바운드를 허용해 주세요.</p>
      </div>`;
    }
    const origin = `${window.location.origin}/`;
    const encO = encodeURIComponent(origin);
    const visO = escapeHtml(origin);
    return `<div class="lan-access-banner lan-access-banner--compact">
      <p class="hint"><strong>같은 Wi-Fi</strong>의 다른 기기에서는 이 주소를 입력하면 됩니다.</p>
      <p class="lan-access-row"><code>${visO}</code> <button type="button" class="btn btn-ghost btn-lan-copy" data-copy-lan="${encO}">복사</button></p>
    </div>`;
  }

  function buildLanAccessBannerHtml() {
    return buildLanOnlyBannerHtml();
  }

  /** 터널 URL 저장 — 서버 PC에서 127.0.0.1 로 접속했을 때만 표시 */
  function buildPublicTunnelAdminHtml() {
    if (!isLoopbackHost()) return '';
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return '';
    return `<div class="internet-tunnel-setup">
      <p class="lan-access-title">고정 주소(권장) — 클라우드에 배포</p>
      <p class="hint"><strong>같은 주소로 계속 쓰려면</strong> 이 프로젝트를 GitHub 등에 올리고 <strong>Render</strong> 또는 <strong>Fly.io</strong>에 웹 서비스로 배포하세요. 저장소 루트의 <code>render.yaml</code> / <code>company-chat/fly.toml</code>을 참고하면 <code>https://이름.onrender.com</code> · <code>https://앱이름.fly.dev</code> 같은 <strong>고정 호스트</strong>가 생기고, 서버가 자동으로 여기에 표시합니다. 커스텀 도메인은 호스팅 대시보드에서 연 뒤 환경변수 <code>PUBLIC_BASE_URL=https://내서브도메인.내사이트.com</code> 을 넣으면 됩니다.</p>
      <p class="lan-access-title" style="margin-top:1rem">로컬 PC에서만 임시로 (터널)</p>
      <p class="hint">LAN 주소(<code>192.168…</code>)는 다른 Wi-Fi에서는 안 됩니다. 개발용으로만 <code>localtunnel</code> 등 <strong>https 주소</strong>를 아래에 저장하세요.</p>
      <ol class="hint socket-setup-list">
        <li>터미널에 <code>npm start</code></li>
        <li>다른 터미널: <code>npm run tunnel</code> → <code>https://…</code> 복사 (포트 변경 시 <code>npx localtunnel --port (포트)</code>)</li>
        <li>붙여 넣고 <strong>공개 주소 저장</strong></li>
      </ol>
      <div class="field">
        <label for="public-url-input">공개 접속 주소</label>
        <input type="url" id="public-url-input" placeholder="https://xxxx.loca.lt" value="${escapeHtml(
          publicUrlFromServer
        )}" autocomplete="off" />
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="btn-save-public-url">공개 주소 저장</button>
        <button type="button" class="btn btn-ghost" id="btn-clear-public-url">지우기</button>
      </div>
      <p class="hint">저장·삭제는 <code>http://127.0.0.1</code> 로 이 PC에서 연 브라우저에서만 됩니다. 서버 시작 시 <code>set PUBLIC_BASE_URL=https://… && npm start</code> 로도 지정할 수 있습니다.</p>
    </div>`;
  }

  function bindLanCopyButtons(root) {
    if (!root) return;
    root.querySelectorAll('.btn-lan-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-copy-lan');
        const u = raw ? decodeURIComponent(raw) : '';
        if (!u) return;
        const ok = () => showToast('주소를 복사했습니다.');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(ok).catch(() => window.prompt('복사할 주소', u));
        } else window.prompt('복사할 주소', u);
      });
    });
  }

  function getSharedPayload() {
    return {
      accounts: state.accounts,
      projects: state.projects,
      rooms: state.rooms,
      messages: state.messages,
      feedbackThreads: state.feedbackThreads,
      pinnedChatsByUser: state.pinnedChatsByUser || {},
      lastReadByUser: state.lastReadByUser || {},
      chatNotifyMutedByUser: state.chatNotifyMutedByUser || {},
      chatNotifyMutedRoomsByUser: state.chatNotifyMutedRoomsByUser || {},
      staffPresenceByUser: state.staffPresenceByUser || {},
      trafficExpenseSubmittedByIvId: state.trafficExpenseSubmittedByIvId || {},
      trafficExpenseSubmittedByIvProjectKey: state.trafficExpenseSubmittedByIvProjectKey || {},
      trafficExpenseResetAt: typeof state.trafficExpenseResetAt === 'number' ? state.trafficExpenseResetAt : 0,
    };
  }

  function syncSessionMeWithAccounts() {
    if (!state.me) return;
    const acc = state.accounts.find((a) => a.id === state.me.id);
    if (acc) {
      state.me = {
        id: acc.id,
        loginId: acc.loginId,
        name: acc.name,
        role: acc.role,
        team: acc.team || null,
      };
    } else {
      state.me = null;
      view.screen = 'login';
      view.roomId = null;
    }
  }

  function applySharedPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const incomingResetAt =
      typeof payload.trafficExpenseResetAt === 'number' && Number.isFinite(payload.trafficExpenseResetAt)
        ? payload.trafficExpenseResetAt
        : 0;
    const curResetAt =
      typeof state.trafficExpenseResetAt === 'number' && Number.isFinite(state.trafficExpenseResetAt)
        ? state.trafficExpenseResetAt
        : 0;
    state.trafficExpenseResetAt = Math.max(curResetAt, incomingResetAt);
    state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    state.projects = Array.isArray(payload.projects) ? payload.projects : [];
    state.rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
    state.messages = payload.messages && typeof payload.messages === 'object' ? payload.messages : {};
    state.feedbackThreads = Array.isArray(payload.feedbackThreads) ? payload.feedbackThreads : [];
    state.pinnedChatsByUser =
      payload.pinnedChatsByUser && typeof payload.pinnedChatsByUser === 'object' ? payload.pinnedChatsByUser : {};
    state.lastReadByUser = payload.lastReadByUser && typeof payload.lastReadByUser === 'object' ? payload.lastReadByUser : {};
    state.chatNotifyMutedByUser =
      payload.chatNotifyMutedByUser && typeof payload.chatNotifyMutedByUser === 'object' ? payload.chatNotifyMutedByUser : {};
    state.chatNotifyMutedRoomsByUser =
      payload.chatNotifyMutedRoomsByUser && typeof payload.chatNotifyMutedRoomsByUser === 'object'
        ? payload.chatNotifyMutedRoomsByUser
        : {};
    state.staffPresenceByUser =
      payload.staffPresenceByUser && typeof payload.staffPresenceByUser === 'object' ? payload.staffPresenceByUser : {};
    if (payload.trafficExpenseSubmittedByIvId && typeof payload.trafficExpenseSubmittedByIvId === 'object') {
      state.trafficExpenseSubmittedByIvId = mergeTrafficExpenseMaps(
        state.trafficExpenseSubmittedByIvId,
        payload.trafficExpenseSubmittedByIvId,
        state.trafficExpenseResetAt
      );
    } else if (!state.trafficExpenseSubmittedByIvId) {
      state.trafficExpenseSubmittedByIvId = {};
    }
    if (payload.trafficExpenseSubmittedByIvProjectKey && typeof payload.trafficExpenseSubmittedByIvProjectKey === 'object') {
      if (!state.trafficExpenseSubmittedByIvProjectKey || typeof state.trafficExpenseSubmittedByIvProjectKey !== 'object')
        state.trafficExpenseSubmittedByIvProjectKey = {};
      for (const ivId of Object.keys(payload.trafficExpenseSubmittedByIvProjectKey)) {
        const cur = state.trafficExpenseSubmittedByIvProjectKey[ivId];
        const inc = payload.trafficExpenseSubmittedByIvProjectKey[ivId];
        state.trafficExpenseSubmittedByIvProjectKey[ivId] = mergeTrafficExpenseMaps(cur, inc, state.trafficExpenseResetAt);
      }
    } else if (!state.trafficExpenseSubmittedByIvProjectKey) {
      state.trafficExpenseSubmittedByIvProjectKey = {};
    }
    syncSessionMeWithAccounts();
  }

  function initRealtimeConnection() {
    return new Promise((resolve) => {
      if (typeof io === 'undefined') {
        realtimeConnectError = 'Socket.IO 스크립트가 없습니다. 네트워크·CDN을 확인해 주세요.';
        resolve(false);
        return;
      }
      if (realtimeSocket) {
        try {
          realtimeSocket.removeAllListeners();
          realtimeSocket.disconnect();
        } catch (_) {}
        realtimeSocket = null;
      }
      const base = resolveSocketBaseUrl();
      lastSocketConnectBase = base || `${window.location.protocol}//${window.location.host}`;
      realtimeConnectError = '';

      let settled = false;
      const done = (ok) => {
        if (!settled) {
          settled = true;
          resolve(!!ok);
        }
      };
      const t = setTimeout(() => {
        done(false);
        realtimeConnectError =
          realtimeConnectError ||
          `서버 응답 없음(시간 초과). 연결 시도 주소: ${lastSocketConnectBase}. PC에서 company-chat 폴더에서 npm start 했는지 확인하세요.`;
        try {
          render();
        } catch (_) {}
      }, 12000);
      try {
        realtimeSocket = base ? io(base, socketIoOptions()) : io(socketIoOptions());
      } catch (e) {
        clearTimeout(t);
        realtimeConnectError = e && e.message ? e.message : '소켓 초기화 실패';
        done(false);
        return;
      }
      realtimeSocket.on('shared:state', (payload) => {
        const hadMe = !!state.me;
        applySharedPayload(payload);
        realtimeSyncedFromServer = true;
        realtimeConnectError = '';
        syncSessionMeWithAccounts();
        const lostSession = hadMe && !state.me;
        try {
          if (lostSession) {
            render();
          } else if (shouldPatchLoginInsteadOfRender()) {
            patchLoginSocketUiOnly();
          } else if (tryPatchChatInboxOnlyAfterSharedState()) {
            /* 채팅 중: 말풍선만 갱신 — 입력 textarea DOM 유지 */
          } else {
            render();
          }
        } catch (_) {
          /* render 아직 정의 전일 수 있음 — 무시 */
        }
        clearTimeout(t);
        done(true);
      });
      realtimeSocket.on('connect', () => {
        realtimeConnectError = '';
        try {
          if (shouldPatchLoginInsteadOfRender()) {
            patchLoginSocketUiOnly();
          } else if (shouldSkipSocketDrivenRender()) {
            /* 채팅 입력 유지 — 곧 shared:state 로 동기화 */
          } else {
            render();
          }
        } catch (_) {}
      });
      realtimeSocket.on('disconnect', () => {
        try {
          if (shouldPatchLoginInsteadOfRender()) {
            patchLoginSocketUiOnly();
          } else if (shouldSkipSocketDrivenRender()) {
            /* 전체 render 생략 — 입력 유지 */
          } else {
            render();
          }
        } catch (_) {}
      });
      realtimeSocket.on('connect_error', (err) => {
        const msg = err && err.message ? err.message : 'connect_error';
        realtimeConnectError = `${msg} (시도: ${lastSocketConnectBase})`;
        try {
          if (shouldPatchLoginInsteadOfRender()) {
            patchLoginSocketUiOnly();
          } else if (shouldSkipSocketDrivenRender()) {
            /* 전체 render 생략 — 입력 유지 */
          } else {
            render();
          }
        } catch (_) {}
      });
    });
  }

  function saveState() {
    try {
      const persist = {
        me: state.me,
        accounts: state.accounts,
        projects: state.projects,
        rooms: state.rooms,
        messages: state.messages,
        feedbackThreads: state.feedbackThreads,
        pinnedChatsByUser: state.pinnedChatsByUser || {},
        lastReadByUser: state.lastReadByUser || {},
        chatNotifyMutedByUser: state.chatNotifyMutedByUser || {},
        chatNotifyMutedRoomsByUser: state.chatNotifyMutedRoomsByUser || {},
        staffPresenceByUser: state.staffPresenceByUser || {},
        trafficExpenseSubmittedByIvId: state.trafficExpenseSubmittedByIvId || {},
        trafficExpenseSubmittedByIvProjectKey: state.trafficExpenseSubmittedByIvProjectKey || {},
        trafficExpenseResetAt: typeof state.trafficExpenseResetAt === 'number' ? state.trafficExpenseResetAt : 0,
      };
      localStorage.setItem(STORAGE_V2, JSON.stringify(persist));
      if (localStorage.getItem(STORAGE_V1)) localStorage.removeItem(STORAGE_V1);
      if (realtimeSocket && realtimeSocket.connected) {
        realtimeSocket.emit('shared:update', getSharedPayload());
      }
    } catch (_) {}
  }

  function resetAllTrafficExpenseSubmissions() {
    state.trafficExpenseResetAt = Date.now();
    state.trafficExpenseSubmittedByIvId = {};
    state.trafficExpenseSubmittedByIvProjectKey = {};
    saveState();
    showToast('교통비 제출 표시를 전체 초기화했습니다.');
    if (view.screen === 'main' && view.tab === 'traffic') render();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function userById(id) {
    if (!id) return null;
    if (state.me && id === state.me.id) return state.me;
    const a = state.accounts.find((u) => u.id === id);
    if (!a) return null;
    return {
      id: a.id,
      loginId: a.loginId,
      name: a.name,
      role: a.role,
      team: a.team || null,
    };
  }

  function normalizeStaffPresenceKey(v) {
    if (v === 'vacation' || v === 'away' || v === 'available') return v;
    return 'available';
  }

  function staffPresenceForUser(userId) {
    if (!userId) return 'available';
    const raw = state.staffPresenceByUser && state.staffPresenceByUser[userId];
    return normalizeStaffPresenceKey(raw);
  }

  /** 이 방에 참여한 연구원·슈퍼바이저 중 자리비움 또는 휴가인 사람이 있는지 */
  function roomHasStaffAwayOrVacation(room) {
    if (!room || !Array.isArray(room.memberIds)) return false;
    for (const mid of room.memberIds) {
      const u = userById(mid);
      if (!u || !isStaffAccountRole(u.role)) continue;
      const p = staffPresenceForUser(u.id);
      if (p === 'away' || p === 'vacation') return true;
    }
    return false;
  }

  function cycleStaffPresence() {
    if (!state.me || !isStaffAccountRole(state.me.role)) return;
    if (!state.staffPresenceByUser || typeof state.staffPresenceByUser !== 'object') state.staffPresenceByUser = {};
    const cur = staffPresenceForUser(state.me.id);
    const i = STAFF_PRESENCE_CYCLE.indexOf(cur);
    const next = STAFF_PRESENCE_CYCLE[(i + 1) % STAFF_PRESENCE_CYCLE.length];
    state.staffPresenceByUser[state.me.id] = next;
    saveState();
    showToast('내 상태: ' + STAFF_PRESENCE_META[next].label);
    render();
  }

  function staffPresenceControlHtml(ctx) {
    if (!state.me || !isStaffAccountRole(state.me.role)) return '';
    const p = staffPresenceForUser(state.me.id);
    const meta = STAFF_PRESENCE_META[p];
    return `<button type="button" class="staff-presence-trigger presence--${p}" id="btn-staff-presence-${ctx}" title="내 상태: ${escapeHtml(
      meta.label
    )} (눌러서 바꾸기)" aria-label="내 상태 ${escapeHtml(meta.label)}">
      <span class="staff-presence-led" aria-hidden="true"></span>
      <span class="staff-presence-lbl">${escapeHtml(meta.label)}</span>
    </button>`;
  }

  /** 면접원 화면에서만 점 옆에 글자(업무 중·자리비움·휴가) */
  function staffPresenceInterviewerLabelHtml(meta) {
    if (!state.me || state.me.role !== 'interviewer' || !meta) return '';
    return `<span class="staff-presence-inline-label">${escapeHtml(meta.label)}</span>`;
  }

  /** 1:1에서 상대가 연구원·슈퍼바이저면 상태 점 표시(면접원·직원 공통) */
  function dmOtherStaffPresenceDotHtml(room) {
    if (!room || room.type !== 'dm' || !state.me) return '';
    const oid = room.memberIds.find((id) => id !== state.me.id);
    const ou = userById(oid);
    if (!ou || !isStaffAccountRole(ou.role)) return '';
    const p = staffPresenceForUser(oid);
    const meta = STAFF_PRESENCE_META[p];
    return `<span class="staff-presence-inline presence--${p}" title="${escapeHtml(ou.name)} · ${escapeHtml(meta.label)}" aria-label="상대 ${escapeHtml(
      ou.name
    )} 상태 ${escapeHtml(meta.label)}"><span class="staff-presence-led" aria-hidden="true"></span>${staffPresenceInterviewerLabelHtml(meta)}</span>`;
  }

  /** 주소록 등: 계정이 직원이면 상태 점 */
  function staffPresenceDotForAccountHtml(u) {
    if (!u || !isStaffAccountRole(u.role)) return '';
    const p = staffPresenceForUser(u.id);
    const meta = STAFF_PRESENCE_META[p];
    return `<span class="staff-presence-inline presence--${p}" title="${escapeHtml(u.name)} · ${escapeHtml(meta.label)}" aria-label="${escapeHtml(
      u.name
    )} ${escapeHtml(meta.label)}"><span class="staff-presence-led" aria-hidden="true"></span>${staffPresenceInterviewerLabelHtml(meta)}</span>`;
  }

  function roomTitle(room) {
    if (room.type === 'group') return room.name || '단체방';
    const other = room.memberIds.find((id) => id !== state.me.id);
    const u = userById(other);
    return u ? u.name : '알 수 없음';
  }

  /** 1:1 채팅 목록·헤더·확인창: 면접원은 이름·@아이디·팀, 연구원·슈퍼바이저는 이름·역할 */
  function roomDisplayTitlePlain(room) {
    if (!room) return '';
    if (room.type === 'group') {
      return (room.name || '단체방') + (room.isAnnounceFeed ? ' 📢' : '');
    }
    const other = room.memberIds.find((id) => id !== state.me.id);
    const u = userById(other);
    if (!u) return '알 수 없음';
    const parts = [u.name];
    if (u.role === 'interviewer') {
      if (u.loginId) parts.push('@' + u.loginId);
      const tl = teamLabel(u.team);
      if (tl) parts.push(tl);
    } else if (isStaffAccountRole(u.role)) {
      parts.push(ROLES[u.role].label);
    }
    return parts.join(' · ');
  }

  function roomDisplayTitleHtml(room) {
    if (!room) return '';
    if (room.type === 'group') {
      return escapeHtml(room.name || '단체방') + (room.isAnnounceFeed ? ' 📢' : '');
    }
    const other = room.memberIds.find((id) => id !== state.me.id);
    const u = userById(other);
    if (!u) return escapeHtml('알 수 없음');
    const parts = [escapeHtml(u.name)];
    if (u.role === 'interviewer') {
      if (u.loginId) parts.push('@' + escapeHtml(u.loginId));
      const tl = teamLabel(u.team);
      if (tl) parts.push(escapeHtml(tl));
    } else if (isStaffAccountRole(u.role)) {
      parts.push(escapeHtml(ROLES[u.role].label));
    }
    return parts.join(' · ');
  }

  /** Jitsi Meet 회의실 경로 (채팅방 id 기준, 참가자가 동일하면 같은 화상방) */
  function jitsiRoomSlugForRoom(room) {
    if (!room || !room.id) return 'CompanyChat-room';
    const safe = String(room.id).replace(/[^a-zA-Z0-9]/g, '');
    const core = safe.length >= 6 ? safe : 'x' + String(room.updatedAt || Date.now()).replace(/\D/g, '').slice(-10);
    return 'CompanyChat-' + core.slice(0, 40);
  }

  function jitsiMeetUrlForRoom(room) {
    const base =
      typeof window.__JITSI_BASE__ === 'string' && window.__JITSI_BASE__.trim()
        ? window.__JITSI_BASE__.trim().replace(/\/$/, '')
        : 'https://meet.jit.si';
    return `${base}/${jitsiRoomSlugForRoom(room)}`;
  }

  function openVideoCallOverlay(roomId) {
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const slug = jitsiRoomSlugForRoom(room);
    const url = jitsiMeetUrlForRoom(room);
    document.getElementById('video-call-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'video-call-overlay';
    overlay.className = 'video-call-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '화상 회의');
    const safeUrl = url.replace(/"/g, '&quot;');
    overlay.innerHTML = `
      <div class="video-call-shell">
        <div class="video-call-toolbar">
          <div class="video-call-toolbar-top">
            <span class="video-call-title">화상 회의</span>
            <button type="button" class="video-call-icon-btn" id="video-call-close" aria-label="닫기">✕</button>
          </div>
          <p class="video-call-hint">같은 채팅방 사람은 모두 이 회의실로 들어옵니다. 모바일은「새 탭」이 더 잘 될 수 있습니다.</p>
          <div class="video-call-toolbar-btns">
            <button type="button" class="btn btn-secondary video-call-btn" id="video-call-copy">링크 복사</button>
            <button type="button" class="btn btn-secondary video-call-btn" id="video-call-tab">새 탭</button>
          </div>
        </div>
        <iframe class="video-call-frame" src="${safeUrl}" allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write" title="Jitsi Meet 화상 회의"></iframe>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#video-call-close').addEventListener('click', close);
    overlay.querySelector('#video-call-tab').addEventListener('click', () => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    overlay.querySelector('#video-call-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        showToast('회의 링크를 복사했습니다.');
      } catch (_) {
        window.prompt('링크를 복사해 주세요:', url);
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  function ensureDmRoom(otherId) {
    let room = state.rooms.find(
      (r) => r.type === 'dm' && r.memberIds.includes(otherId) && r.memberIds.includes(state.me.id)
    );
    if (!room) {
      room = {
        id: uid(),
        type: 'dm',
        name: null,
        memberIds: [state.me.id, otherId],
        updatedAt: Date.now(),
        lastPreview: '',
        roomNoticeTitle: '',
        roomNoticeBody: '',
      };
      state.rooms.unshift(room);
      state.messages[room.id] = [];
    }
    return room;
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none', scope: './' })
      .then((reg) => reg.update())
      .catch(() => {});
  }

  function requestNotifyPermission() {
    if (!('Notification' in window)) {
      alert('이 브라우저는 알림을 지원하지 않습니다.');
      return;
    }
    Notification.requestPermission().then((p) => {
      if (p === 'granted') {
        showToast('이 기기 브라우저 알림이 켜졌습니다. 다른 사람 폰으로 자동 발송은 서버·알림톡 API가 필요합니다.');
      }
    });
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'app-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function devBulkImageExtFromDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:image\/(\w+);/i);
    if (!m) return 'jpg';
    const t = m[1].toLowerCase();
    return t === 'jpeg' ? 'jpg' : t;
  }

  function devBulkPreviewSlotHtml(ivId, displayName, dataUrl) {
    return (
      '<div class="devbulk-preview">' +
      '<img src="' +
      escapeDataUrlForAttr(dataUrl) +
      '" alt="" />' +
      '<div class="devbulk-preview-actions">' +
      '<button type="button" class="btn btn-ghost devbulk-img-download" data-devbulk-download="' +
      escapeHtml(ivId) +
      '" data-devbulk-dl-name="' +
      escapeHtml(displayName || '') +
      '">다운로드</button>' +
      '<button type="button" class="btn btn-ghost devbulk-img-clear" data-devbulk-clear="' +
      escapeHtml(ivId) +
      '">사진 지우기</button>' +
      '</div></div>'
    );
  }

  /** data URL 이미지를 파일로 저장 (브라우저 다운로드). 채팅·개발자 일괄 전송 등 공통. */
  function downloadImageDataUrlAsFile(dataUrl, filenameStemNoExt) {
    if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
      showToast('저장할 사진이 없습니다.');
      return;
    }
    const stem =
      String(filenameStemNoExt || 'image')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim()
        .slice(0, 100) || 'image';
    const ext = devBulkImageExtFromDataUrl(dataUrl);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${stem}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function triggerDevBulkImageDownload(ivId, dataUrl, displayName) {
    const safe =
      String(displayName || '면접원')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim()
        .slice(0, 80) || 'image';
    downloadImageDataUrlAsFile(dataUrl, `${safe}-첨부`);
  }

  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: tag || 'ann', icon: '../icon-192.png' });
    } catch (_) {
      new Notification(title, { body });
    }
  }

  /** 푸시·브라우저 알림 전용 — 전역/방별 끔이면 호출 안 함 (채팅 내용·미읽음 배지와 무관) */
  function notifyChatForUser(recipientUserId, roomId, title, body, tag) {
    if (!recipientUserId) return;
    if (isChatNotifyMutedForUser(recipientUserId)) return;
    if (roomId && isChatNotifyMutedForRoom(recipientUserId, roomId)) return;
    notify(title, body, tag || 'chat-' + recipientUserId + '-' + String(roomId || 'x'));
  }

  function toggleChatRoomNotifyMute(roomId) {
    if (!state.me || !isStaffAccountRole(state.me.role) || !roomId) return;
    if (!state.chatNotifyMutedRoomsByUser || typeof state.chatNotifyMutedRoomsByUser !== 'object')
      state.chatNotifyMutedRoomsByUser = {};
    if (!state.chatNotifyMutedRoomsByUser[state.me.id]) state.chatNotifyMutedRoomsByUser[state.me.id] = {};
    const m = state.chatNotifyMutedRoomsByUser[state.me.id];
    if (m[roomId]) {
      delete m[roomId];
      showToast('이 채팅 푸시·알림을 켰습니다.');
      if (Object.keys(m).length === 0) delete state.chatNotifyMutedRoomsByUser[state.me.id];
    } else {
      m[roomId] = true;
      showToast('이 채팅 푸시·알림만 껐습니다. 대화는 그대로 볼 수 있어요.');
    }
    saveState();
  }

  /** 외부(카카오톡·문자 등)로 넘길 때 쓰는 문장 포맷 */
  function formatNoticeForExternalShare(title, body, prefix) {
    const t = (title || '').trim();
    const b = (body || '').trim();
    const p = prefix || '【H-채팅 공지】';
    return `${p}${t}${b ? '\n\n' + b : ''}`;
  }

  async function shareOrCopyPlainText(text, shareTitle) {
    const t = String(text || '').trim();
    if (!t) {
      alert('공유할 내용을 먼저 입력해 주세요.');
      return false;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle || '공지', text: t });
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
      }
    }
    try {
      await navigator.clipboard.writeText(t);
      showToast('복사했습니다. 카카오톡·문자 앱에 붙여 넣어 주세요.');
      return true;
    } catch (_) {
      window.prompt('아래 내용을 복사해 주세요:', t);
      return true;
    }
  }

  function broadcastAnnouncement(title, body) {
    notify('공지·' + title, body, 'ann-' + Date.now());
    const targetRoom = state.rooms.find((r) => r.isAnnounceFeed);
    if (!targetRoom) return;

    const msg = {
      id: uid(),
      senderId: state.me.id,
      text: '【공지】' + title + '\n' + body,
      image: null,
      video: null,
      ts: Date.now(),
      isAnnouncement: true,
    };
    if (!state.messages[targetRoom.id]) state.messages[targetRoom.id] = [];
    state.messages[targetRoom.id].push(msg);
    targetRoom.updatedAt = Date.now();
    targetRoom.lastPreview = '공지: ' + title;
    saveState();
  }

  function ensureAnnounceRoom() {
    let room = state.rooms.find((r) => r.isAnnounceFeed);
    if (!room) {
      room = {
        id: uid(),
        type: 'group',
        name: '전체 공지',
        memberIds: [state.me.id],
        updatedAt: Date.now(),
        lastPreview: '공지가 여기에 표시됩니다',
        isAnnounceFeed: true,
        interviewerChatAllowed: false,
        roomNoticeTitle: '',
        roomNoticeBody: '',
      };
      state.rooms.push(room);
      state.messages[room.id] = [];
    }
    return room;
  }

  function updateShellClasses() {
    const chatLayout = !!(state.me && view.screen === 'chat');
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.toggle('app--chat-layout', chatLayout);
  }

  function render() {
    const root = el.root;
    if (!root) return;

    if (!state.me) view.screen = 'login';
    /* 세션은 localStorage(state.me)에만 있고 view.screen 은 항상 초기값 login 이라,
       로그인된 채로도 로그인 화면이 그려지고 shared:state 마다 전체 DOM 이 갈리며 입력·IME 가 깨짐 */
    else if (view.screen === 'login') view.screen = 'main';

    if (view.screen === 'login') {
      root.innerHTML = loginHTML();
      bindLogin();
      updateShellClasses();
      return;
    }

    if (state.me && !canManageAccounts() && view.tab === 'accounts') view.tab = 'chats';
    if (state.me && !canManageAccounts() && view.tab === 'devbulk') view.tab = 'chats';
    if (state.me && !getExtraMainTabsOpen() && (view.tab === 'feedback' || view.tab === 'traffic')) view.tab = 'chats';
    if (
      state.me &&
      view.tab === 'traffic' &&
      state.me.role !== 'supervisor' &&
      state.me.role !== 'interviewer'
    )
      view.tab = 'chats';
    if (state.me && state.me.role === 'researcher' && view.tab === 'contacts') view.tab = 'chats';

    ensureAnnounceRoom();
    state.rooms.forEach(normalizeRoomModeration);
    if (!Array.isArray(state.feedbackThreads)) state.feedbackThreads = [];

    if (view.screen === 'main') {
      root.innerHTML = mainHTML();
      bindMain();
    } else if (view.screen === 'chat') {
      if (view._lastOpenRoomId !== view.roomId) {
        view.chatSideOpen = false;
        view._lastOpenRoomId = view.roomId;
      }
      root.innerHTML = chatHTML();
      bindChat();
    }

    if (view.modal) bindModal();
    updateShellClasses();
  }

  function buildLoginSocketPanelHtml() {
    const socketOk = !!(realtimeSocket && realtimeSocket.connected);
    const explicit = getExplicitSocketBaseUrl();
    const attempt = lastSocketConnectBase || resolveSocketBaseUrl() || `${window.location.protocol}//${window.location.host}`;
    const errBlock = realtimeConnectError
      ? `<p class="hint socket-setup-error" role="alert">${escapeHtml(realtimeConnectError)}</p>`
      : '';
    if (!socketOk) {
      return `<div class="socket-setup">
        <p class="hint"><strong>실시간 서버에 연결되지 않았습니다.</strong> (여러 PC·폰에서 같이 채팅하려면 필요합니다.)</p>
        <ul class="hint socket-setup-list">
          <li><strong>권장:</strong> 이 폴더에서 터미널로 <code>npm start</code> 실행 후, 주소창에 <code>http://127.0.0.1:8787/</code> 를 직접 입력해 접속합니다.</li>
          <li>Live Server 등 <strong>다른 포트</strong>로 연 경우, 자동으로 <code>http://${escapeHtml(
            location.hostname || '127.0.0.1'
          )}:8787</code> 에 소켓을 붙입니다. 그쪽에서도 Node 서버가 떠 있어야 합니다.</li>
          <li>HTML 파일만 연 경우(<code>file://</code>) 기본값은 <code>http://127.0.0.1:8787</code> 입니다.</li>
          <li><code>PORT=3000 npm start</code> 처럼 <strong>8787이 아닌 포트</strong>를 쓰면, 아래에 실제 주소를 적고 「저장 후 다시 연결」을 누르세요.</li>
        </ul>
        ${errBlock}
        <div class="field">
          <label for="socket-url-input">소켓 서버 주소 (선택·이 브라우저에 저장)</label>
          <input type="text" id="socket-url-input" placeholder="http://127.0.0.1:8787" value="${escapeHtml(
            explicit
          )}" autocomplete="off" />
        </div>
        <button type="button" class="btn btn-secondary" id="btn-socket-reconnect">주소 저장 후 다시 연결</button>
        <p class="hint socket-setup-attempt">현재 연결 시도: <code>${escapeHtml(attempt)}</code></p>
      </div>`;
    }
    return `<p class="hint socket-setup-ok">실시간 서버 연결됨 · 시도 주소 <code>${escapeHtml(attempt)}</code></p>`;
  }

  function loginSyncHintText() {
    const socketOk = !!(realtimeSocket && realtimeSocket.connected);
    return socketOk
      ? '계정·채팅 내용은 연결된 서버와 동기화되며, 로그인 정보만 이 브라우저에 있습니다.'
      : '지금은 실시간에 실패한 상태입니다. 로그인·채팅은 이 브라우저 저장소를 쓰며, 서버와 합치지 못할 수 있습니다.';
  }

  function loginHTML() {
    return `
      <div class="screen login-panel">
        <div class="login-toolbar">${themeToggleButtonHtml()}</div>
        <h1>H-채팅</h1>
        <p class="sub">아이디·비밀번호로 로그인 (역할은 계정에 따름)</p>
        ${buildPublicTunnelAdminHtml()}
        <div id="login-socket-panel-wrap">${buildLoginSocketPanelHtml()}</div>
        <div class="field">
          <label for="login-id">아이디</label>
          <input type="text" id="login-id" placeholder="예: researcher1" autocomplete="username" />
        </div>
        <div class="field">
          <label for="login-pw">비밀번호</label>
          <input type="password" id="login-pw" placeholder="비밀번호" autocomplete="current-password" />
        </div>
        <button type="button" class="btn btn-primary" id="btn-login">로그인</button>
        <p class="hint"><span id="login-sync-hint">${loginSyncHintText()}</span></p>
      </div>
    `;
  }

  function shouldPatchLoginInsteadOfRender() {
    return !state.me && view.screen === 'login' && document.getElementById('login-socket-panel-wrap');
  }

  /** 소켓 disconnect/connect_error/connect 마다 render() 하면 채팅 DOM이 통째로 갈리며 입력창·포커스가 끊김 (Render 등에서 끊김이 잦을 때 치명적) */
  function shouldSkipSocketDrivenRender() {
    return !!(state.me && view.screen === 'chat');
  }

  function patchLoginSocketUiOnly() {
    const wrap = document.getElementById('login-socket-panel-wrap');
    if (!wrap) return;
    const urlEl = document.getElementById('socket-url-input');
    const savedUrl = urlEl ? urlEl.value : '';
    wrap.innerHTML = buildLoginSocketPanelHtml();
    const newUrl = document.getElementById('socket-url-input');
    if (newUrl && savedUrl) newUrl.value = savedUrl;
    const hint = document.getElementById('login-sync-hint');
    if (hint) hint.textContent = loginSyncHintText();
    bindSocketReconnectButton();
  }

  function bindSocketReconnectButton() {
    const btnSock = document.getElementById('btn-socket-reconnect');
    if (!btnSock) return;
    btnSock.addEventListener('click', async () => {
      const raw = (document.getElementById('socket-url-input').value || '').trim();
      if (raw) localStorage.setItem(LS_SOCKET_URL, normalizeSocketBaseUrl(raw));
      else localStorage.removeItem(LS_SOCKET_URL);
      realtimeConnectError = '';
      await initRealtimeConnection();
      await migrateAndSeed();
      render();
    });
  }

  function bindLogin() {
    bindSocketReconnectButton();
    document.getElementById('btn-login').addEventListener('click', async () => {
      const loginId = (document.getElementById('login-id').value || '').trim();
      const password = document.getElementById('login-pw').value || '';
      if (!loginId || !password) {
        alert('아이디와 비밀번호를 입력해 주세요.');
        return;
      }
      const acc = state.accounts.find((a) => a.loginId === loginId);
      if (!acc) {
        alert('아이디 또는 비밀번호가 올바르지 않습니다.');
        return;
      }
      const h = await hashPassword(password);
      if (acc.passHash !== h) {
        alert('아이디 또는 비밀번호가 올바르지 않습니다.');
        return;
      }
      state.me = {
        id: acc.id,
        loginId: acc.loginId,
        name: acc.name,
        role: acc.role,
        team: acc.team || null,
      };
      saveState();
      view.screen = 'main';
      render();
    });

    const btnPubSave = document.getElementById('btn-save-public-url');
    if (btnPubSave) {
      btnPubSave.addEventListener('click', async () => {
        const url = (document.getElementById('public-url-input').value || '').trim();
        if (!url) {
          alert('주소를 입력해 주세요.');
          return;
        }
        try {
          const r = await fetch(`${window.location.origin}/api/admin/public-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            alert(j.error || '저장에 실패했습니다.');
            return;
          }
          await refreshLanAccessHint();
          showToast('공개 주소를 저장했습니다.');
          render();
        } catch (_) {
          alert('서버에 연결할 수 없습니다.');
        }
      });
    }
    const btnPubClr = document.getElementById('btn-clear-public-url');
    if (btnPubClr) {
      btnPubClr.addEventListener('click', async () => {
        try {
          const r = await fetch(`${window.location.origin}/api/admin/public-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: '' }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            alert(j.error || '삭제에 실패했습니다.');
            return;
          }
          await refreshLanAccessHint();
          showToast('공개 주소를 지웠습니다.');
          render();
        } catch (_) {
          alert('서버에 연결할 수 없습니다.');
        }
      });
    }
    bindLanCopyButtons(el.root);
    bindThemeToggle();
  }

  function pruneStalePinsForCurrentUser() {
    if (!state.me || !state.pinnedChatsByUser) return;
    const meId = state.me.id;
    const arr = state.pinnedChatsByUser[meId];
    if (!Array.isArray(arr)) return;
    const valid = new Set(
      state.rooms.filter((r) => r.memberIds && r.memberIds.includes(meId)).map((r) => r.id)
    );
    const next = arr.filter((id) => valid.has(id));
    if (next.length !== arr.length) {
      state.pinnedChatsByUser[meId] = next;
      saveState();
    }
  }

  function mainHTML() {
    const me = state.me;
    const roleInfo = ROLES[me.role];
    if (view.tab === 'chats') pruneStalePinsForCurrentUser();
    const rooms = sortedChatsForUser(
      [...state.rooms].filter((r) => r.memberIds && r.memberIds.includes(me.id)),
      me.id
    );

    let listBody = '';
    if (view.tab === 'chats') {
      if (rooms.length === 0) {
        listBody = '<div class="hint" style="padding:2rem 1rem;text-align:center;">채팅이 없습니다. + 를 눌러 대화를 시작하세요.</div>';
      } else {
        batchEnsureLastReadBaselineForRooms(me.id, rooms);
        listBody = rooms
          .map((r) => {
            const isGroup = r.type === 'group';
            const titleHtml = roomDisplayTitleHtml(r);
            const otherId = !isGroup ? r.memberIds.find((id) => id !== me.id) : null;
            const otherU = otherId ? userById(otherId) : null;
            const initial = isGroup ? 'G' : otherU ? otherU.name.charAt(0) : roomTitle(r).charAt(0);
            const isPinned = isChatPinnedForUser(me.id, r.id);
            const pinClass = isPinned ? ' room-list-pin-btn--on' : '';
            const rowClass = isPinned ? ' room-item-row--pinned' : '';
            const unread = unreadCountForRoom(r.id, me.id);
            const unreadHtml =
              unread > 0
                ? `<span class="room-unread-badge" aria-label="읽지 않은 메시지 ${unread}개">${unread > 99 ? '99+' : String(unread)}</span>`
                : '';
            const staff = me.role === 'researcher' || me.role === 'supervisor';
            const roomNotifyMuted = staff && isChatNotifyMutedForRoom(me.id, r.id);
            const notifyBtn = staff
              ? `<button type="button" class="room-list-notify-btn${roomNotifyMuted ? ' room-list-notify-btn--off' : ''}" data-room-notify="${r.id}" title="${
                  roomNotifyMuted ? '이 채팅 푸시·알림 켜기' : '이 채팅만 푸시·알림 끄기 (채팅 보기는 가능)'
                }" aria-label="${roomNotifyMuted ? '이 채팅 푸시·알림 켜기' : '이 채팅만 푸시·알림 끄기'}">${roomNotifyMuted ? '🔕' : '🔔'}</button>`
              : '';
            const dmStaffPresenceDot = dmOtherStaffPresenceDotHtml(r);
            return `
              <div class="room-item-row${rowClass}">
                <div class="room-item room-item-main" data-room="${r.id}">
                  <div class="avatar-wrap">
                    <div class="avatar ${isGroup ? 'group' : ''}">${isGroup ? 'G' : initial}</div>
                    ${unreadHtml}
                  </div>
                  <div class="room-meta">
                    <div class="room-title">${titleHtml}${dmStaffPresenceDot}${isPinned ? ' <span class="room-pin-badge" aria-hidden="true">고정</span>' : ''}${
                      roomNotifyMuted ? ' <span class="room-notify-badge" aria-hidden="true">푸시끔</span>' : ''
                    }</div>
                    <div class="room-preview">${escapeHtml(r.lastPreview || '메시지 없음')}</div>
                  </div>
                </div>
                <div class="room-item-actions">
                  <button type="button" class="room-list-pin-btn${pinClass}" data-room-pin="${r.id}" title="${isPinned ? '고정 해제' : '맨 위 고정'}" aria-label="${isPinned ? '고정 해제' : '채팅 고정'}">📌</button>
                  ${notifyBtn}
                  <button type="button" class="room-list-leave-btn" data-room-leave="${r.id}">나가기</button>
                </div>
              </div>
            `;
          })
          .join('');
      }
    } else if (view.tab === 'contacts') {
      /** 면접원 주소록에는 슈퍼바이저만 (연구원 목록 숨김) */
      const contactRoleKeys = me.role === 'interviewer' ? ['supervisor'] : ['researcher', 'supervisor'];
      const roleBlocks = contactRoleKeys.map((roleKey) => {
        const users = state.accounts.filter((u) => u.role === roleKey && u.id !== me.id);
        if (users.length === 0) return '';
        const title = ROLES[roleKey].label;
        return `
            <div class="directory">
              <div class="dir-section-title">${title}</div>
              ${users
                .map(
                  (u) => `
                <div class="dir-user-row">
                  <div class="dir-user dir-user-main" data-user="${u.id}">
                    <div class="avatar" style="background:var(--surface2)">${u.name.charAt(0)}</div>
                    <div class="dir-user-text"><span class="dir-user-name">${escapeHtml(u.name)}</span>${staffPresenceDotForAccountHtml(u)}${publicLoginIdCaptionHtml(u)}</div>
                  </div>
                  <button type="button" class="dir-leave-btn" data-dir-leave="${u.id}">삭제</button>
                </div>
              `
                )
                .join('')}
            </div>
          `;
      });
      listBody = roleBlocks.join('') + interviewerContactsHTML(me);
    } else if (view.tab === 'accounts' && canManageAccounts()) {
      listBody = accountsAdminHTML();
    } else if (view.tab === 'feedback') {
      listBody = feedbackTabHTML(me);
    } else if (view.tab === 'devbulk' && canManageAccounts()) {
      listBody = devBulkTabHTML();
    } else if (view.tab === 'traffic' && (me.role === 'supervisor' || me.role === 'interviewer')) {
      listBody = trafficToolTabHTML(me);
    }

    const annBtn =
      me.role === 'supervisor'
        ? `<button type="button" class="btn btn-ghost" id="btn-ann">공지</button>`
        : '';

    const rtBadge =
      typeof io !== 'undefined'
        ? realtimeSocket && realtimeSocket.connected
          ? '<span class="rt-badge rt-badge--on" title="서버와 실시간 동기화 중">실시간</span>'
          : '<span class="rt-badge rt-badge--off" title="서버에 연결되지 않음 · 이 기기에만 저장">로컬</span>'
        : '';

    const showAccTab = me.role === 'researcher' || me.role === 'supervisor';
    /** 연구원은 숨김 — 슈퍼바이저·면접원만 표시 */
    const showContactsTab = me.role === 'supervisor' || me.role === 'interviewer';
    const extraMainTabsOpen = getExtraMainTabsOpen();
    const tabsClass = 'tabs tabs-compact';
    const tabAccountsBtn = showAccTab
      ? `<button type="button" class="tab ${view.tab === 'accounts' ? 'active' : ''}" data-tab="accounts">계정</button>`
      : '';
    const tabContactsBtn = showContactsTab
      ? `<button type="button" class="tab ${view.tab === 'contacts' ? 'active' : ''}" data-tab="contacts">주소록</button>`
      : '';
    const tabFeedbackBtn = extraMainTabsOpen
      ? `<button type="button" class="tab ${view.tab === 'feedback' ? 'active' : ''}" data-tab="feedback">질문 / 의견</button>`
      : '';
    const tabDevBulkBtn = showAccTab
      ? `<button type="button" class="tab ${view.tab === 'devbulk' ? 'active' : ''}" data-tab="devbulk">개인/단체 전송</button>`
      : '';
    const showTrafficToolTab = me.role === 'supervisor' || me.role === 'interviewer';
    const tabTrafficBtn =
      extraMainTabsOpen && showTrafficToolTab
        ? `<button type="button" class="tab ${view.tab === 'traffic' ? 'active' : ''}" data-tab="traffic">교통비</button>`
        : '';
    const tabMoreBtn = `<button type="button" class="tab tab-more${extraMainTabsOpen ? ' tab-more--open' : ''}" id="btn-toggle-extra-tabs" title="${
      extraMainTabsOpen ? '질문·의견·교통비 탭 숨기기' : '질문·의견·교통비 탭 보이기'
    }">${extraMainTabsOpen ? '간단히' : '더보기'}</button>`;
    const fabHidden =
      view.tab === 'accounts' ||
      view.tab === 'feedback' ||
      view.tab === 'devbulk' ||
      view.tab === 'traffic'
        ? ' hidden'
        : '';

    const chatNotifyPrefBar =
      showAccTab && view.tab === 'chats'
        ? `<div class="chat-notify-pref-bar">
            <label class="chat-notify-pref">
              <input type="checkbox" id="pref-chat-notify-muted"${isChatNotifyMutedForUser(me.id) ? ' checked' : ''} />
              <span>모든 채팅 푸시·알림 끄기</span>
            </label>
            <span class="chat-notify-pref-hint">채팅 내용·목록·미읽음 표시는 그대로입니다. <strong>기기로 오는 알림</strong>(푸시·브라우저 알림)만 안 옵니다. 목록의 🔔/🔕로 방마다 따로 조절할 수 있습니다.</span>
          </div>`
        : '';

    return `
      <div class="screen">
        <header class="main-header">
          <div class="main-header-ident">
            <span class="who">${escapeHtml(me.name)}</span>
            <span class="role-badge" style="background:var(--${roleInfo.className});color:var(--text-on-accent);">${roleInfo.label}</span>
            ${rtBadge}
            ${annBtn}
            ${staffPresenceControlHtml('main')}
            ${
              shouldHidePublicLoginId(me.role)
                ? ''
                : `<div class="caption">@${escapeHtml(me.loginId || '')}</div>`
            }
            ${
              me.role === 'interviewer' && teamLabel(me.team)
                ? `<div class="caption">${escapeHtml(teamLabel(me.team))}</div>`
                : ''
            }
          </div>
          <div class="main-header-actions">
            ${themeToggleButtonHtml()}
            <button type="button" class="btn btn-ghost" id="btn-logout">나가기</button>
          </div>
        </header>
        ${buildLanAccessBannerHtml()}
        <nav class="${tabsClass}">
          <button type="button" class="tab ${view.tab === 'chats' ? 'active' : ''}" data-tab="chats">채팅</button>
          ${tabContactsBtn}
          ${tabDevBulkBtn}
          ${tabAccountsBtn}
          ${tabFeedbackBtn}
          ${tabTrafficBtn}
          ${tabMoreBtn}
        </nav>
        ${chatNotifyPrefBar}
        <div class="list-scroll">${listBody}</div>
        <button type="button" class="fab${fabHidden}" id="fab-new" title="새 채팅">+</button>
      </div>
    `;
  }

  function interviewerContactsHTML(me) {
    const users = state.accounts.filter((u) => u.role === 'interviewer' && u.id !== me.id);
    if (!users.length) return '';
    const byTeam = {};
    const unassigned = [];
    for (const u of users) {
      const tk = u.team && TEAMS[u.team] ? u.team : null;
      if (!tk) unassigned.push(u);
      else {
        if (!byTeam[tk]) byTeam[tk] = [];
        byTeam[tk].push(u);
      }
    }
    const rowHtml = (u) => `
                <div class="dir-user-row">
                  <div class="dir-user dir-user-main" data-user="${u.id}">
                    <div class="avatar" style="background:var(--surface2)">${u.name.charAt(0)}</div>
                    <div>${escapeHtml(u.name)}<span class="caption" style="display:block;margin:0">@${escapeHtml(u.loginId)}${
      u.team && TEAMS[u.team] ? ' · ' + escapeHtml(TEAMS[u.team]) : ''
    }</span></div>
                  </div>
                  <button type="button" class="dir-leave-btn" data-dir-leave="${u.id}">삭제</button>
                </div>`;
    let inner = '';
    for (const tid of TEAM_ORDER) {
      const list = byTeam[tid];
      if (!list || !list.length) continue;
      inner += `<div class="dir-subsection-title">${TEAMS[tid]}</div>`;
      inner += list.map(rowHtml).join('');
    }
    if (unassigned.length) {
      inner += `<div class="dir-subsection-title">팀 미지정</div>`;
      inner += unassigned.map(rowHtml).join('');
    }
    return `<div class="directory"><div class="dir-section-title">${ROLES.interviewer.label}</div>${inner}</div>`;
  }

  function feedbackThreadCardHtml(t, opts) {
    const { showReplyForm, showDelete } = opts;
    const author = userById(t.authorId);
    const an = author ? author.name : '알 수 없음';
    const tl =
      author && author.role === 'interviewer' && teamLabel(author.team)
        ? ' · ' + escapeHtml(teamLabel(author.team))
        : '';
    const roleLb = author ? ROLES[author.role].label : '';
    const titlePart = (t.title || '').trim()
      ? `<div class="feedback-thread-title">${escapeHtml(t.title.trim())}</div>`
      : '';
    const replies = Array.isArray(t.replies) ? t.replies : [];
    const repliesHtml = replies
      .map((r) => {
        const ru = userById(r.authorId);
        const rnm = ru ? ru.name : '알 수 없음';
        const rrole = ru ? ROLES[ru.role].label : '';
        return `<div class="feedback-reply">
            <div class="feedback-reply-meta">${escapeHtml(rnm)} · ${escapeHtml(rrole)} · ${formatTime(r.ts)}</div>
            <div class="feedback-reply-body">${escapeHtml(r.text).replace(/\n/g, '<br/>')}</div>
          </div>`;
      })
      .join('');
    const replyBlock = showReplyForm
      ? `<div class="feedback-reply-compose">
          <textarea class="fb-reply-text" rows="2" placeholder="답변을 입력…" aria-label="답변 입력"></textarea>
          <button type="button" class="btn btn-primary fb-reply-submit" data-thread-id="${escapeHtml(t.id)}">답변 등록</button>
        </div>`
      : '';
    const deleteBtn = showDelete
      ? `<button type="button" class="feedback-thread-delete" data-thread-id="${escapeHtml(t.id)}">삭제</button>`
      : '';
    return `
      <div class="feedback-thread" data-thread-id="${escapeHtml(t.id)}">
        <div class="feedback-thread-head">
          <span class="feedback-thread-author">${escapeHtml(an)}</span>
          <span class="caption">${escapeHtml(roleLb)}${tl}</span>
          <span class="feedback-thread-time">${formatTime(t.createdAt || t.updatedAt)}</span>
          ${deleteBtn}
        </div>
        ${titlePart}
        <div class="feedback-thread-body">${escapeHtml(t.body || '').replace(/\n/g, '<br/>')}</div>
        ${repliesHtml ? `<div class="feedback-reply-list">${repliesHtml}</div>` : ''}
        ${replyBlock}
      </div>`;
  }

  function feedbackTabHTML(me) {
    const threads = Array.isArray(state.feedbackThreads) ? state.feedbackThreads : [];
    const sorted = [...threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (me.role === 'interviewer') {
      const mine = sorted.filter((t) => t.authorId === me.id);
      const list =
        mine.length === 0
          ? '<p class="hint" style="padding:1rem 0">아직 보낸 질문이 없습니다.</p>'
          : mine.map((t) => feedbackThreadCardHtml(t, { showReplyForm: false, showDelete: true })).join('');
      return `
        <div class="feedback-tab">
          <div class="feedback-compose">
            <h2 class="feedback-heading">질문 · 의견 보내기</h2>
            <p class="caption">연구원·슈퍼바이저에게 전달됩니다. (이 기기에 저장되는 데모입니다.)</p>
            <div class="field">
              <label for="fb-title">제목 <span class="caption">(선택)</span></label>
              <input type="text" id="fb-title" maxlength="120" placeholder="예: 조사 일정 문의" autocomplete="off" />
            </div>
            <div class="field">
              <label for="fb-body">내용</label>
              <textarea id="fb-body" rows="4" placeholder="질문이나 의견을 적어 주세요."></textarea>
            </div>
            <button type="button" class="btn btn-primary" id="fb-submit">보내기</button>
          </div>
          <div class="feedback-my-list">
            <h3 class="feedback-subheading">내가 보낸 글</h3>
            ${list}
          </div>
        </div>`;
    }

    if (me.role === 'researcher' || me.role === 'supervisor') {
      const fromIv = sorted.filter((t) => {
        const a = userById(t.authorId);
        return a && a.role === 'interviewer';
      });
      const list =
        fromIv.length === 0
          ? '<p class="hint" style="padding:1.5rem 0;text-align:center;">면접원이 보낸 질문이 없습니다.</p>'
          : fromIv.map((t) => feedbackThreadCardHtml(t, { showReplyForm: true, showDelete: false })).join('');
      return `
        <div class="feedback-tab feedback-tab--staff">
          <h2 class="feedback-heading">면접원 질문 · 의견</h2>
          <p class="caption">아래에 답변을 남기면 면접원이 이 탭에서 확인할 수 있습니다.</p>
          ${list}
        </div>`;
    }

    return '<p class="hint">이 탭은 면접원·연구원·슈퍼바이저용입니다.</p>';
  }

  function markTrafficExpenseSubmittedForIv(ivAccountId, opts) {
    const id = String(ivAccountId || '').trim();
    if (!id) return false;
    const acc = state.accounts.find((a) => a.id === id && a.role === 'interviewer');
    if (!acc) return false;
    if (!state.trafficExpenseSubmittedByIvId || typeof state.trafficExpenseSubmittedByIvId !== 'object')
      state.trafficExpenseSubmittedByIvId = {};
    const record = {
      at: opts && typeof opts.at === 'number' && Number.isFinite(opts.at) ? opts.at : Date.now(),
      manual: !!(opts && opts.manual),
      source: (opts && opts.source) || 'manual',
    };
    if (opts && opts.cleared) record.cleared = true;
    // 파일 정보 저장 (Supabase Storage URLs)
    if (opts && opts.files) {
      record.files = opts.files;
    }
    // 요약 정보 저장
    if (opts && opts.summary) {
      record.summary = opts.summary;
    }
    state.trafficExpenseSubmittedByIvId[id] = record;
    return true;
  }

  function guessProjectKeyForTrafficPayload(p) {
    // 구조적으로 겹치는 단체방(roomId) 때문에 중복 기록이 나는 문제를 막기 위해
    // "프로젝트 번호 자체"를 제출 키로 사용한다. (ivId + projectNumber = 유일)
    const pn = p && p.projectNumber != null ? String(p.projectNumber).trim() : '';
    if (pn) return 'pn:' + pn;
    const pname = p && p.projectName != null ? String(p.projectName).trim() : '';
    if (pname) return 'name:' + pname;
    return '';
  }

  function trafficSubmissionKeyFromRoomId(roomId) {
    const rid = String(roomId || '').trim();
    if (!rid) return '';
    const r = state.rooms.find((x) => x && x.id === rid);
    if (r && r.type === 'group') {
      const pn = String(r.projectNumber || '').trim();
      if (pn) return 'pn:' + pn;
    }
    // projectNumber가 없으면 roomId 기반으로라도 분리
    return 'room:' + rid;
  }

  function markTrafficExpenseSubmittedForIvProjectKey(ivAccountId, projectKey, opts) {
    const id = String(ivAccountId || '').trim();
    const pk = String(projectKey || '').trim();
    if (!id || !pk) return false;
    const acc = state.accounts.find((a) => a.id === id && a.role === 'interviewer');
    if (!acc) return false;
    if (!state.trafficExpenseSubmittedByIvProjectKey || typeof state.trafficExpenseSubmittedByIvProjectKey !== 'object')
      state.trafficExpenseSubmittedByIvProjectKey = {};
    if (!state.trafficExpenseSubmittedByIvProjectKey[id] || typeof state.trafficExpenseSubmittedByIvProjectKey[id] !== 'object')
      state.trafficExpenseSubmittedByIvProjectKey[id] = {};
    // 프로젝트 번호 단위로 1개만 남기기: 같은 pn이 다른 키에 있거나, 같은 엑셀 URL이 다른 키에 있으면 취소 처리
    try {
      const byPk = state.trafficExpenseSubmittedByIvProjectKey[id];
      const excelUrl = opts && opts.files && opts.files.excel ? String(opts.files.excel) : '';
      const opn =
        (opts && opts.projectNumber && String(opts.projectNumber).trim()) ||
        (pk.indexOf('pn:') === 0 ? pk.slice(3) : '');
      for (const otherPk of Object.keys(byPk)) {
        if (otherPk === pk) continue;
        const r = byPk[otherPk];
        if (!r || typeof r !== 'object') continue;
        if (r.cleared) continue;
        let dup = false;
        if (opn) {
          const rpn = String(r.projectNumber || '').trim();
          if (rpn && rpn === opn) dup = true;
          if (!rpn && otherPk === 'pn:' + opn) dup = true;
        }
        if (!dup && excelUrl) {
          const ex2 = r.files && r.files.excel ? String(r.files.excel) : '';
          if (ex2 && ex2 === excelUrl) dup = true;
        }
        if (dup) {
          byPk[otherPk] = {
            at: Date.now(),
            cleared: true,
            manual: false,
            source: 'auto-dedupe',
          };
        }
      }
    } catch (_) {}
    const record = {
      at: opts && typeof opts.at === 'number' && Number.isFinite(opts.at) ? opts.at : Date.now(),
      manual: !!(opts && opts.manual),
      source: (opts && opts.source) || 'manual',
    };
    if (opts && opts.cleared) record.cleared = true;
    if (opts && opts.files) record.files = opts.files;
    if (opts && opts.summary) record.summary = opts.summary;
    if (pk.indexOf('pn:') === 0) record.projectNumber = pk.slice(3);
    else if (opts && opts.projectNumber) record.projectNumber = String(opts.projectNumber).trim();
    state.trafficExpenseSubmittedByIvProjectKey[id][pk] = record;
    return true;
  }

  function markTrafficExpenseClearedForIvProjectKey(ivAccountId, projectKey, opts) {
    const id = String(ivAccountId || '').trim();
    const pk = String(projectKey || '').trim();
    if (!id || !pk) return false;
    const acc = state.accounts.find((a) => a.id === id && a.role === 'interviewer');
    if (!acc) return false;
    if (!state.trafficExpenseSubmittedByIvProjectKey || typeof state.trafficExpenseSubmittedByIvProjectKey !== 'object')
      state.trafficExpenseSubmittedByIvProjectKey = {};
    if (!state.trafficExpenseSubmittedByIvProjectKey[id] || typeof state.trafficExpenseSubmittedByIvProjectKey[id] !== 'object')
      state.trafficExpenseSubmittedByIvProjectKey[id] = {};
    state.trafficExpenseSubmittedByIvProjectKey[id][pk] = {
      at: Date.now(),
      cleared: true,
      manual: true,
      source: (opts && opts.source) || 'manual-clear',
    };
    return true;
  }

  function markTrafficExpenseClearedForIv(ivAccountId, opts) {
    const id = String(ivAccountId || '').trim();
    if (!id) return false;
    const acc = state.accounts.find((a) => a.id === id && a.role === 'interviewer');
    if (!acc) return false;
    if (!state.trafficExpenseSubmittedByIvId || typeof state.trafficExpenseSubmittedByIvId !== 'object')
      state.trafficExpenseSubmittedByIvId = {};
    const record = {
      at: Date.now(),
      cleared: true,
      manual: true,
      source: (opts && opts.source) || 'manual-clear',
    };
    state.trafficExpenseSubmittedByIvId[id] = record;
    return true;
  }

  function markTrafficExpenseSubmittedByLoginId(loginId, opts) {
    const acc = findInterviewerForTrafficMessage({ loginId });
    if (!acc) return false;
    const source = typeof opts === 'string' ? opts : (opts && opts.source) || 'postMessage';
    return markTrafficExpenseSubmittedForIv(acc.id, {
      source: source,
      manual: false,
      files: opts && opts.files,
      summary: opts && opts.summary,
    });
  }

  function onTrafficToolPostMessage(ev) {
    if (!trafficPostMessageOriginAllowed(ev.origin)) {
      try {
        if (localStorage.getItem('company-chat-debug-traffic') === '1')
          console.warn('[traffic] postMessage 출처 거부:', ev.origin, ev.data);
      } catch (_) {}
      return;
    }
    let data = ev.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (_) {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'companychat-traffic-submitted') return;
    if (!state.me) return;
    const acc = findInterviewerForTrafficMessage(data);
    if (!acc) {
      try {
        if (localStorage.getItem('company-chat-debug-traffic') === '1')
          console.warn('[traffic] 면접원 매칭 실패. payload:', JSON.stringify(data));
      } catch (_) {}
      return;
    }
    const payloadPn = data && data.projectNumber != null ? String(data.projectNumber).trim() : '';
    const opts = {
      source: data.source || 'route-calc',
      files: data.files || null,
      summary: data.summary || null,
      projectNumber: payloadPn,
    };
    const projectKey = guessProjectKeyForTrafficPayload(data);
    const okProject = projectKey
      ? markTrafficExpenseSubmittedForIvProjectKey(acc.id, projectKey, { ...opts, manual: false })
      : false;
    if (!projectKey) markTrafficExpenseSubmittedForIv(acc.id, { ...opts, manual: false });
    if (okProject || projectKey === '') {
      saveState();
      showToast('교통비 제출로 기록했습니다: ' + acc.name + ' (@' + acc.loginId + ')');
      if (view.screen === 'main' && view.tab === 'traffic') render();
    }
  }

  function ensureTrafficPostMessageListener() {
    if (trafficPostMessageListenerAttached) return;
    trafficPostMessageListenerAttached = true;
    window.addEventListener('message', onTrafficToolPostMessage, false);
  }

  function sanitizeTrafficDownloadFileName(s) {
    return String(s || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extFromStorageUrl(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
      return m ? m[1].toLowerCase() : 'bin';
    } catch (_) {
      return 'bin';
    }
  }

  function trafficExpenseProjectLabelForRoomId(roomId) {
    if (!roomId) return '프로젝트';
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return '프로젝트';
    const pn = String(room.projectNumber || '').trim();
    if (pn) return pn;
    return String(room.name || '프로젝트').trim() || '프로젝트';
  }

  /**
   * 프로젝트(단체방) 필터: 면접원 1명당 "선택한 방의 projectNumber"와 저장된 제출의 projectNumber(또는 pn: 키)가
   * 정확히 맞을 때만 제출 완료로 표시. 전체 맵 스캔 폴백은 제거해 프로젝트 간 오표시를 막음.
   */
  function pickTrafficRecordForProjectRoom(mp, room) {
    if (!mp || typeof mp !== 'object' || !room || room.type !== 'group') return null;
    const expectedPn = String(room.projectNumber || '').trim();
    const roomScopedKey = 'room:' + String(room.id);

    if (expectedPn) {
      const pnKey = 'pn:' + expectedPn;
      if (mp[pnKey] && typeof mp[pnKey] === 'object') {
        const r = mp[pnKey];
        const rpn = String(r.projectNumber || '').trim();
        if (rpn && rpn !== expectedPn) return null;
        return r;
      }
      if (mp[room.id] && typeof mp[room.id] === 'object') {
        const r = mp[room.id];
        const rpn = String(r.projectNumber || '').trim();
        if (rpn === expectedPn) return r;
        return null;
      }
      return null;
    }

    if (mp[roomScopedKey] && typeof mp[roomScopedKey] === 'object') return mp[roomScopedKey];
    if (mp[room.id] && typeof mp[room.id] === 'object') return mp[room.id];
    return null;
  }

  function trafficExpenseMonthLabelForRow(fil, recAt) {
    if (fil && fil.ym && /^\d{4}-\d{2}$/.test(fil.ym)) {
      return parseInt(fil.ym.split('-')[1], 10) + '월';
    }
    const at = recAt && Number(recAt) ? Number(recAt) : Date.now();
    const d = new Date(at);
    return d.getMonth() + 1 + '월';
  }

  async function downloadTrafficExpenseFromUrl(url, filename, btn) {
    if (!url) return;
    if (btn) {
      if (btn.getAttribute('data-traffic-dl-busy') === '1') return;
      btn.setAttribute('data-traffic-dl-busy', '1');
      btn.disabled = true;
    }
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = obj;
      a.download = sanitizeTrafficDownloadFileName(filename) || 'download';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(obj), 3000);
      showToast('다운로드를 시작했습니다.');
    } catch (e) {
      try {
        console.warn('[traffic-dl]', e);
      } catch (_) {}
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (_) {}
      showToast('브라우저 제한으로 새 탭에서 열었습니다. 저장 시 파일명을 직접 지정해 주세요.');
    } finally {
      if (btn) {
        btn.removeAttribute('data-traffic-dl-busy');
        btn.disabled = false;
      }
    }
  }

  function ensureTrafficExpenseFileDownloadBinder() {
    if (trafficFileDlBinderAttached) return;
    trafficFileDlBinderAttached = true;
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.traffic-file-dl');
      if (!btn) return;
      ev.preventDefault();
      const url = btn.getAttribute('data-traffic-url');
      const filename = btn.getAttribute('data-traffic-filename') || 'download';
      if (!url) return;
      downloadTrafficExpenseFromUrl(url, filename, btn).catch(() => {});
    });
  }

  /** 다른 탭에서 저장한 교통비 제출 맵을 localStorage(storage 이벤트)으로 반영 */
  function onTrafficSharedStorageSync(ev) {
    if (ev.key !== STORAGE_V2 || !ev.newValue || ev.storageArea !== localStorage) return;
    try {
      const data = JSON.parse(ev.newValue);
      const incomingResetAt =
        typeof data.trafficExpenseResetAt === 'number' && Number.isFinite(data.trafficExpenseResetAt) ? data.trafficExpenseResetAt : 0;
      const curResetAt =
        typeof state.trafficExpenseResetAt === 'number' && Number.isFinite(state.trafficExpenseResetAt)
          ? state.trafficExpenseResetAt
          : 0;
      state.trafficExpenseResetAt = Math.max(curResetAt, incomingResetAt);

      const incFlat = data.trafficExpenseSubmittedByIvId;
      const incProj = data.trafficExpenseSubmittedByIvProjectKey;
      let changed = false;

      if (incFlat && typeof incFlat === 'object') {
        const merged = mergeTrafficExpenseMaps(state.trafficExpenseSubmittedByIvId, incFlat, state.trafficExpenseResetAt);
        if (JSON.stringify(state.trafficExpenseSubmittedByIvId || {}) !== JSON.stringify(merged)) {
          state.trafficExpenseSubmittedByIvId = merged;
          changed = true;
        }
      }

      if (incProj && typeof incProj === 'object') {
        if (!state.trafficExpenseSubmittedByIvProjectKey || typeof state.trafficExpenseSubmittedByIvProjectKey !== 'object')
          state.trafficExpenseSubmittedByIvProjectKey = {};
        for (const ivId of Object.keys(incProj)) {
          const cur = state.trafficExpenseSubmittedByIvProjectKey[ivId];
          const inc = incProj[ivId];
          const merged = mergeTrafficExpenseMaps(cur, inc, state.trafficExpenseResetAt);
          if (JSON.stringify(cur || {}) !== JSON.stringify(merged)) {
            state.trafficExpenseSubmittedByIvProjectKey[ivId] = merged;
            changed = true;
          }
        }
      }

      if (!changed && incomingResetAt <= curResetAt) return;
      if (view.screen === 'main' && view.tab === 'traffic') render();
    } catch (_) {}
  }

  function ensureTrafficCrossTabStorageSync() {
    if (trafficCrossTabStorageAttached) return;
    trafficCrossTabStorageAttached = true;
    window.addEventListener('storage', onTrafficSharedStorageSync, false);
  }

  /** 유류비 GitHub Pages 단독 탭용 — Supabase에 쌓인 신호를 읽어 제출 표 갱신 */
  function getTrafficBridgeSupabase() {
    if (trafficBridgeSupabaseClient) return trafficBridgeSupabaseClient;
    const cfg = typeof window !== 'undefined' ? window.COMPANYCHAT_TRAFFIC_BRIDGE : null;
    if (!cfg || !cfg.url || !cfg.anonKey) return null;
    const sup = typeof window !== 'undefined' ? window.supabase : null;
    if (!sup || typeof sup.createClient !== 'function') return null;
    try {
      trafficBridgeSupabaseClient = sup.createClient(cfg.url, cfg.anonKey);
      return trafficBridgeSupabaseClient;
    } catch (_) {
      return null;
    }
  }

  function getProcessedTrafficBridgeIds() {
    try {
      const raw = localStorage.getItem(LS_TRAFFIC_BRIDGE_IDS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function rememberTrafficBridgeRowId(id) {
    if (!id) return;
    const arr = getProcessedTrafficBridgeIds();
    if (arr.includes(id)) return;
    arr.unshift(id);
    while (arr.length > 300) arr.pop();
    try {
      localStorage.setItem(LS_TRAFFIC_BRIDGE_IDS, JSON.stringify(arr));
    } catch (_) {}
  }

  async function pollTrafficBridgeSignalsOnce() {
    const client = getTrafficBridgeSupabase();
    if (!client || !state.me) return;
    const { data, error } = await client
      .from('traffic_submission_signals')
      .select('id,payload,created_at')
      .order('created_at', { ascending: false })
      .limit(45);
    if (error) {
      try {
        if (localStorage.getItem('company-chat-debug-traffic') === '1')
          console.warn('[traffic-bridge] Supabase 조회 오류:', error.message || error);
      } catch (_) {}
      return;
    }
    if (!data || !data.length) return;
    const done = new Set(getProcessedTrafficBridgeIds());
    const rows = [...data].reverse();
    let changed = false;
    for (const row of rows) {
      if (done.has(row.id)) continue;
      const p = row.payload;
      if (!p || typeof p !== 'object' || p.type !== 'companychat-traffic-submitted') {
        rememberTrafficBridgeRowId(row.id);
        continue;
      }
      const acc = findInterviewerForTrafficMessage(p);
      if (!acc) {
        rememberTrafficBridgeRowId(row.id);
        continue;
      }
      const at = row.created_at ? Date.parse(row.created_at) : 0;
      if (
        typeof state.trafficExpenseResetAt === 'number' &&
        state.trafficExpenseResetAt > 0 &&
        at > 0 &&
        at < state.trafficExpenseResetAt
      ) {
        rememberTrafficBridgeRowId(row.id);
        continue;
      }
      const bridgePn = p && p.projectNumber != null ? String(p.projectNumber).trim() : '';
      const opts = {
        source: (p.source || 'route-calc') + '+supabase',
        files: p.files || null,
        summary: p.summary || null,
        at: at || undefined,
        projectNumber: bridgePn,
      };
      const projectKey = guessProjectKeyForTrafficPayload(p);
      if (projectKey) {
        if (markTrafficExpenseSubmittedForIvProjectKey(acc.id, projectKey, { ...opts, manual: false })) changed = true;
      } else {
        if (markTrafficExpenseSubmittedForIv(acc.id, { ...opts, manual: false })) changed = true;
      }
      rememberTrafficBridgeRowId(row.id);
    }
    if (changed) {
      saveState();
      if (view.screen === 'main' && view.tab === 'traffic') render();
      showToast('유류비 제출이 동기화되었습니다.');
    }
  }

  function ensureTrafficBridgePolling() {
    if (trafficBridgePollStarted) return;
    if (!getTrafficBridgeSupabase()) return;
    trafficBridgePollStarted = true;
    setInterval(function () {
      if (state.me) pollTrafficBridgeSignalsOnce().catch(function () {});
    }, 16000);
    if (state.me) pollTrafficBridgeSignalsOnce().catch(function () {});
  }

  /** 슈퍼바이저·면접원 — 외부 교통·유류비 계산기 (GitHub Pages) + 제출 현황 표 */
  function trafficToolTabHTML(me) {
    const u = TRAFFIC_TOOL_URL;
    const esc = escapeHtml(u);
    const subsFlat =
      state.trafficExpenseSubmittedByIvId && typeof state.trafficExpenseSubmittedByIvId === 'object'
        ? state.trafficExpenseSubmittedByIvId
        : {};
    const subsByProj =
      state.trafficExpenseSubmittedByIvProjectKey && typeof state.trafficExpenseSubmittedByIvProjectKey === 'object'
        ? state.trafficExpenseSubmittedByIvProjectKey
        : {};
    if (!view.trafficListFilter || typeof view.trafficListFilter !== 'object')
      view.trafficListFilter = { q: '', team: '', roomId: '', ym: '' };
    const fil = view.trafficListFilter;

    const ivsAll = state.accounts.filter((x) => x.role === 'interviewer');
    const teamKeySet = new Set(ivsAll.map((iv) => (iv.team && TEAMS[iv.team] ? iv.team : '_other')));
    const teamKeysOrdered = [...teamKeySet].sort((a, b) => {
      if (a === '_other') return 1;
      if (b === '_other') return -1;
      const ia = TEAM_ORDER.indexOf(a);
      const ib = TEAM_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return String(a).localeCompare(String(b), 'ko');
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const projectRooms = [...state.rooms]
      .filter(
        (r) =>
          r.type === 'group' &&
          Array.isArray(r.memberIds) &&
          r.memberIds.some((mid) => state.accounts.some((aa) => aa.id === mid && aa.role === 'interviewer'))
      )
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
    const roomOpts = [
      '<option value="">' + escapeHtml('전체 프로젝트 (단체방)') + '</option>',
      ...projectRooms.map((r) => {
        const sel = fil.roomId === r.id ? ' selected' : '';
        const pn = (r.projectNumber || '').trim();
        const label = (pn ? pn + ' · ' : '') + (r.name || '이름 없음');
        return `<option value="${escapeHtml(r.id)}"${sel}>${escapeHtml(label)}</option>`;
      }),
    ].join('');
    const teamOpts = [
      '<option value="">' + escapeHtml('전체 팀') + '</option>',
      ...teamKeysOrdered.map((tk) => {
        const label = tk === '_other' ? '팀 미지정 · 기타' : TEAMS[tk] || tk;
        const sel = fil.team === tk ? ' selected' : '';
        return `<option value="${escapeHtml(tk)}"${sel}>${escapeHtml(label)}</option>`;
      }),
    ].join('');

    const ymSet = new Set();
    for (const iv of ivsAll) {
      const rec = subsFlat[iv.id];
      const at = rec && rec.at ? Number(rec.at) : 0;
      if (!at) continue;
      const d = new Date(at);
      const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      ymSet.add(ym);
    }
    const ymOrdered = [...ymSet].sort().reverse();
    const ymOpts = [
      '<option value="">' + escapeHtml('전체 월') + '</option>',
      ...ymOrdered.map((ym) => {
        const sel = fil.ym === ym ? ' selected' : '';
        return `<option value="${escapeHtml(ym)}"${sel}>${escapeHtml(ym.replace('-', '년 ') + '월')}</option>`;
      }),
    ].join('');

    const canToggleRow = (urow) =>
      me.role === 'supervisor' || (me.role === 'interviewer' && me.id === urow.id);

    const activeProjectRoomId = fil.roomId || '';
    const activeProjectRoom =
      activeProjectRoomId ? state.rooms.find((r) => r.id === activeProjectRoomId && r.type === 'group') : null;

    function oneRow(uv) {
      const rec =
        activeProjectRoom && subsByProj[uv.id] && typeof subsByProj[uv.id] === 'object'
          ? pickTrafficRecordForProjectRoom(subsByProj[uv.id], activeProjectRoom)
          : !activeProjectRoomId
            ? subsFlat[uv.id]
            : null;
      const at = rec && rec.at ? Number(rec.at) : 0;
      const submitted = at > 0 && !(rec && rec.cleared);
      const status = submitted
        ? `<span class="traffic-cell-status traffic-cell-status--ok">제출 완료 · ${escapeHtml(formatTime(at))}</span>`
        : `<span class="traffic-cell-status traffic-cell-status--no">미제출</span>`;

      let fileButtons = '';
      if (submitted && rec.files) {
        const projLabel = trafficExpenseProjectLabelForRoomId(activeProjectRoomId);
        const monthLabel = trafficExpenseMonthLabelForRow(fil, rec.at);
        const ivName = String(uv.name || '면접원').trim();
        if (rec.files.excel) {
          const excelDlName = sanitizeTrafficDownloadFileName(`${projLabel}_${ivName}_${monthLabel}.xlsx`);
          fileButtons += `<button type="button" class="btn btn-ghost traffic-file-btn traffic-file-dl" title="엑셀 다운로드" data-traffic-url="${escapeHtml(
            rec.files.excel
          )}" data-traffic-filename="${escapeHtml(excelDlName)}">📊</button>`;
        }
        if (rec.files.images) {
          const imgKeys = Object.keys(rec.files.images);
          imgKeys.forEach((key) => {
            const label = key === 'toll' ? '통행료' : key === 'meal' ? '식비' : '기타';
            const iu = rec.files.images[key];
            const ext = extFromStorageUrl(iu);
            const imgDlName = sanitizeTrafficDownloadFileName(`${projLabel}_${ivName}_${label}_${monthLabel}.${ext}`);
            fileButtons += `<button type="button" class="btn btn-ghost traffic-file-btn traffic-file-dl" title="${label} 영수증" data-traffic-url="${escapeHtml(
              iu
            )}" data-traffic-filename="${escapeHtml(imgDlName)}">🧾</button>`;
          });
        }
      }

      let summaryInfo = '';
      if (submitted && rec.summary) {
        const cost = rec.summary.totalCost ? Number(rec.summary.totalCost).toLocaleString() + '원' : '';
        summaryInfo = cost ? ` <span class="traffic-summary-cost">(${cost})</span>` : '';
      }

      const actions = canToggleRow(uv)
        ? submitted
          ? `<button type="button" class="btn btn-ghost traffic-submit-toggle" data-iv-id="${escapeHtml(uv.id)}" data-action="clear">표시 취소</button>`
          : `<button type="button" class="btn btn-secondary traffic-submit-toggle" data-iv-id="${escapeHtml(uv.id)}" data-action="set">제출 표시</button>`
        : '—';

      const tk = uv.team && TEAMS[uv.team] ? uv.team : '_other';
      const roomIdList = state.rooms
        .filter((r) => r.type === 'group' && r.memberIds && r.memberIds.includes(uv.id))
        .map((r) => r.id)
        .join(',');
      const roomNames = state.rooms
        .filter((r) => r.type === 'group' && r.memberIds && r.memberIds.includes(uv.id))
        .map((r) => r.name || '');
      const searchHay = [String(uv.loginId || ''), String(uv.name || ''), teamLabel(uv.team) || '', ...roomNames]
        .join(' ')
        .toLowerCase();

      const ym = submitted
        ? (() => {
            const d = new Date(at);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
          })()
        : '';

      return `<tr class="traffic-iv-row" data-iv-id="${escapeHtml(uv.id)}" data-team-key="${escapeHtml(
        tk
      )}" data-room-ids="${escapeHtml(roomIdList)}" data-search="${escapeHtml(searchHay)}" data-submitted="${
        submitted ? '1' : '0'
      }" data-ym="${escapeHtml(ym)}">
          <td class="traffic-cell-id"><code>${escapeHtml(String(uv.loginId))}</code></td>
          <td>${escapeHtml(uv.name)}</td>
          <td>${escapeHtml(teamLabel(uv.team) || '—')}</td>
          <td class="traffic-cell-status-wrap">${status}${summaryInfo}</td>
          <td class="traffic-cell-files">${fileButtons || '—'}</td>
          <td class="traffic-cell-actions">${actions}</td>
        </tr>`;
    }

    let rows = '';
    if (ivsAll.length === 0) {
      rows = '<tr><td colspan="6" class="traffic-cell-empty">등록된 면접원이 없습니다.</td></tr>';
    } else {
      for (const tk of teamKeysOrdered) {
        const label = tk === '_other' ? '팀 미지정 · 기타' : TEAMS[tk] || tk;
        const ivs = ivsAll
          .filter((iv) => (iv.team && TEAMS[iv.team] ? iv.team : '_other') === tk)
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
        if (ivs.length === 0) continue;
        rows += `<tr class="traffic-team-subhead" data-team-key="${escapeHtml(tk)}"><td colspan="6" class="traffic-team-subhead-cell"><span class="traffic-team-subhead-title">${escapeHtml(
          label
        )}</span><span class="caption traffic-team-subhead-meta"> · ${ivs.length}명</span></td></tr>`;
        for (const uv of ivs) rows += oneRow(uv);
      }
      if (!rows) rows = '<tr><td colspan="6" class="traffic-cell-empty">등록된 면접원이 없습니다.</td></tr>';
    }
    const parentOriginEsc = escapeHtml(window.location.origin || '');
    const filterQEsc = escapeHtml(fil.q || '');
    return `
      <div class="traffic-tool-tab feedback-tab">
        <h2 class="feedback-heading">교통비 · 거리 계산</h2>
        <p class="caption">제출 반영: ① iframe·「새 탭에서 열기」로 연 유류비 창에서 전송 시 바로 <code>postMessage</code>. ② <strong>유류비 사이트만 단독으로 연 경우</strong>엔 Supabase <code>traffic_submission_signals</code> 큐로 쌓이며, 이 탭이 열려 있으면 약 16초마다 표에 동기화됩니다. (Supabase에 마이그레이션 <code>002_traffic_submission_signals.sql</code> 적용 필요.)</p>

        <section class="traffic-tool-embed-block" aria-label="ROUTE CALC 도구">
          <h3 class="traffic-block-title">ROUTE CALC · 거리·유류비</h3>
          <div class="traffic-tool-bar">
            <button type="button" class="btn btn-secondary traffic-tool-open-newtab" id="traffic-tool-open-newtab">새 탭에서 전체 화면으로 열기</button>
            <a class="btn btn-ghost traffic-tool-open-href" href="${esc}" target="_blank" rel="noopener noreferrer">새 탭(링크만)</a>
            ${
              me && (me.role === 'researcher' || me.role === 'supervisor')
                ? `<button type="button" class="btn btn-ghost" id="traffic-reset-all">교통비 제출 전체 삭제</button>`
                : ''
            }
          </div>
          <p class="caption traffic-tool-note">연동을 쓰려면 위 <strong>버튼</strong>으로 여세요(오른쪽 링크는 보안상 opener가 없을 수 있습니다). iframe이 비면 버튼으로 새 탭을 이용해 주세요.</p>
          <div class="traffic-iframe-wrap">
            <iframe class="traffic-iframe" title="거리 및 유류비 계산기" src="${esc}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
          </div>
          <p class="caption traffic-tool-credit">도구 페이지: <a href="${esc}" target="_blank" rel="noopener noreferrer">apingdola-boop.github.io/trafficservice.github.io</a></p>
        </section>

        <div class="traffic-expense-sheet-wrap">
          <h3 class="traffic-sheet-title">면접원 교통비 제출 현황</h3>
          <div class="traffic-table-toolbar">
            <label class="traffic-filter-field"><span class="traffic-filter-label">검색</span>
              <input type="search" id="traffic-filter-q" class="traffic-filter-input" placeholder="이름, 아이디, 팀, 프로젝트명" autocomplete="off" value="${filterQEsc}" /></label>
            <label class="traffic-filter-field"><span class="traffic-filter-label">월</span>
              <select id="traffic-filter-ym" class="traffic-filter-select">${ymOpts}</select></label>
            <label class="traffic-filter-field"><span class="traffic-filter-label">팀</span>
              <select id="traffic-filter-team" class="traffic-filter-select">${teamOpts}</select></label>
            <label class="traffic-filter-field traffic-filter-field--grow"><span class="traffic-filter-label">프로젝트 (단체방)</span>
              <select id="traffic-filter-room" class="traffic-filter-select">${roomOpts}</select></label>
          </div>
          <p id="traffic-filter-stats" class="traffic-filter-stats" aria-live="polite"></p>
          <p class="traffic-sheet-hint">프로젝트를 바꾸면 표가 그 프로젝트 번호(단체방 설정)와 저장된 제출의 <code>projectNumber</code>가 동일한 경우에만 &quot;제출 완료&quot;로 다시 계산됩니다. 여러 방에 같은 프로젝트 번호가 들어 있으면 한 제출이 둘 다에 표시됩니다.</p>
          <div class="traffic-expense-table-scroll">
            <table class="traffic-expense-grid">
              <thead>
                <tr>
                  <th scope="col">면접원 ID</th>
                  <th scope="col">이름</th>
                  <th scope="col">팀</th>
                  <th scope="col">교통비 제출</th>
                  <th scope="col">파일</th>
                  <th scope="col">수동</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        <details class="traffic-integration-details">
          <summary>ROUTE CALC에서 자동으로 「제출」 표시하기 (개발자용)</summary>
          <p class="caption">GitHub Pages <a href="${esc}" target="_blank" rel="noopener noreferrer">trafficservice</a> 에서 「자동 이메일 전송」 성공 직후 실행. <strong>loginId</strong>는 표의 면접원 ID(예: 33406)와 같으면 됩니다. 이름만 알면 <strong>name</strong> 필드(동명이인이 없을 때만 매칭). companychat 내부 id는 <strong>ivId</strong>.</p>
          <pre class="traffic-code-sample">(function () {
  var targetOrigin = '${parentOriginEsc}';
  var payload = {
    type: 'companychat-traffic-submitted',
    loginId: '33406',
    // name: '강형희',
    // ivId: 'companychat_내부_uuid'
  };
  var w = null;
  if (window.opener && !window.opener.closed) w = window.opener;
  else if (window.parent !== window) w = window.parent;
  if (w) w.postMessage(payload, targetOrigin);
})();</pre>
          <p class="caption"><code>targetOrigin</code>은 companychat 주소와 동일해야 합니다. 표시가 안 되면 콘솔에서 <code>localStorage.setItem('company-chat-debug-traffic','1')</code> 후 새로고침 → 매칭 실패·출처 거부 로그 확인. 다른 도구 도메인은 <code>company-chat-traffic-tool-origins</code> 에 origin 추가.</p>
        </details>
      </div>`;
  }

  function applyTrafficExpenseFilters() {
    const tbody = document.querySelector('.traffic-expense-grid tbody');
    if (!tbody) return;
    const q = (view.trafficListFilter && view.trafficListFilter.q ? view.trafficListFilter.q : '')
      .trim()
      .toLowerCase();
    const team = (view.trafficListFilter && view.trafficListFilter.team) || '';
    const roomId = (view.trafficListFilter && view.trafficListFilter.roomId) || '';
    const ym = (view.trafficListFilter && view.trafficListFilter.ym) || '';
    const ivRows = tbody.querySelectorAll('tr.traffic-iv-row');
    let sub = 0;
    let tot = 0;
    ivRows.forEach((tr) => {
      const tid = tr.getAttribute('data-team-key') || '';
      const rooms = (tr.getAttribute('data-room-ids') || '').split(',').filter(Boolean);
      const hay = (tr.getAttribute('data-search') || '').toLowerCase();
      const rowYm = tr.getAttribute('data-ym') || '';
      let show = true;
      if (q && !hay.includes(q)) show = false;
      if (team && tid !== team) show = false;
      if (roomId && !rooms.includes(roomId)) show = false;
      if (ym && rowYm !== ym) show = false;
      tr.style.display = show ? '' : 'none';
      if (show) {
        tot++;
        if (tr.getAttribute('data-submitted') === '1') sub++;
      }
    });
    tbody.querySelectorAll('tr.traffic-team-subhead').forEach((th) => {
      const tk = th.getAttribute('data-team-key');
      if (!tk) return;
      const any = [...ivRows].some(
        (tr) => tr.getAttribute('data-team-key') === tk && tr.style.display !== 'none'
      );
      th.style.display = any ? '' : 'none';
    });
    const statsEl = document.getElementById('traffic-filter-stats');
    if (statsEl) {
      const pend = tot - sub;
      statsEl.innerHTML = `필터 결과 <strong>${tot}명</strong> · 제출 <strong class="traffic-stat-ok">${sub}명</strong> · 미제출 <strong class="traffic-stat-no">${pend}명</strong>`;
    }
  }

  function bindTrafficExpenseFilters() {
    const qEl = document.getElementById('traffic-filter-q');
    const ymEl = document.getElementById('traffic-filter-ym');
    const teamEl = document.getElementById('traffic-filter-team');
    const roomEl = document.getElementById('traffic-filter-room');
    if (!qEl || !ymEl || !teamEl || !roomEl) return;
    if (!view.trafficListFilter || typeof view.trafficListFilter !== 'object')
      view.trafficListFilter = { q: '', team: '', roomId: '', ym: '' };
    qEl.value = view.trafficListFilter.q || '';
    ymEl.value = view.trafficListFilter.ym || '';
    teamEl.value = view.trafficListFilter.team || '';
    roomEl.value = view.trafficListFilter.roomId || '';
    let qTimer = null;
    const run = () => applyTrafficExpenseFilters();
    qEl.addEventListener('input', () => {
      view.trafficListFilter.q = qEl.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(run, 120);
    });
    ymEl.addEventListener('change', () => {
      view.trafficListFilter.ym = ymEl.value;
      run();
    });
    teamEl.addEventListener('change', () => {
      view.trafficListFilter.team = teamEl.value;
      run();
    });
    roomEl.addEventListener('change', () => {
      // 프로젝트(단체방)마다 제출 레코드 매칭이 달라지므로 행 HTML 자체를 다시 생성해야 함.
      // applyTrafficExpenseFilters만 쓰면 가시성·집계만 바뀌고 제출/미제출 셀이 이전 방 기준으로 남는다.
      view.trafficListFilter.q = qEl.value;
      view.trafficListFilter.ym = ymEl.value;
      view.trafficListFilter.team = teamEl.value;
      view.trafficListFilter.roomId = roomEl.value;
      render();
    });
    run();
  }

  /** 연구원·슈퍼바이저: 면접원별 개별 문구를 각 1:1 채팅으로 한 번에 전송 */
  function devBulkTabHTML() {
    if (!state.me || !isStaffAccountRole(state.me.role)) {
      return '<p class="hint">이 탭은 연구원·슈퍼바이저만 사용할 수 있습니다.</p>';
    }
    if (!Array.isArray(view.devBulkSelectedIds)) view.devBulkSelectedIds = [];
    const allIv = state.accounts.filter((u) => u.role === 'interviewer');
    if (!allIv.length) {
      return `<div class="devbulk-tab feedback-tab">
        <h2 class="feedback-heading">개인/단체 전송</h2>
        <p class="hint" style="padding:1rem 0">등록된 면접원이 없습니다. 계정 탭에서 먼저 등록해 주세요.</p>
      </div>`;
    }
    const userByIdLocal = (id) => state.accounts.find((a) => a.id === id && a.role === 'interviewer');
    const rowHtml = (u) => {
      const teamCap = u.team && TEAMS[u.team] ? TEAMS[u.team] : '팀 미지정';
      const pend = devBulkPendingImageByIvId[u.id];
      const previewInner = pend ? devBulkPreviewSlotHtml(u.id, u.name, pend) : '';
      return `<tr class="devbulk-row" data-devbulk-user="${escapeHtml(u.id)}">
        <td class="devbulk-cell-name">
          <button type="button" class="btn btn-ghost devbulk-row-remove" data-devbulk-remove="${escapeHtml(
            u.id
          )}" title="이 면접원만 작업 표에서 빼기">이 사람만 빼기</button>
          <div class="devbulk-name">${escapeHtml(u.name)}</div>
          <div class="devbulk-cell-team caption">${escapeHtml(teamCap)}</div>
        </td>
        <td class="devbulk-cell-msg">
          <textarea class="devbulk-textarea" rows="2" data-devbulk-ta="${escapeHtml(
            u.id
          )}" placeholder="이 면접원에게 보낼 문구"></textarea>
        </td>
        <td class="devbulk-cell-photo">
          <div class="devbulk-preview-slot" data-devbulk-preview-slot="${escapeHtml(u.id)}">${previewInner}</div>
          <label class="devbulk-img-pick devbulk-img-pick--cell">
            <span>📷 첨부</span>
            <input type="file" accept="image/*" class="devbulk-file" data-devbulk-file="${escapeHtml(u.id)}" />
          </label>
          <span class="caption devbulk-img-hint" data-devbulk-img-hint="${escapeHtml(u.id)}"></span>
        </td>
      </tr>`;
    };
    let tbodyInner = '';
    const picked = view.devBulkSelectedIds.map((id) => userByIdLocal(id)).filter(Boolean);
    if (!picked.length) {
      tbodyInner = `<tr><td colspan="3" class="devbulk-empty-hint"><p class="hint" style="margin:0">위에서 이름·아이디로 검색해 면접원을 추가하세요. 추가한 사람만 이 표에 모입니다.</p></td></tr>`;
    } else {
      tbodyInner = picked.map(rowHtml).join('');
    }
    const nSel = picked.length;
    const tableHtml = `
        <div class="devbulk-work-head">
          <h3 class="devbulk-work-title">작업 표 <span class="caption">(선택 ${nSel}명)</span></h3>
        </div>
        <div class="devbulk-table-scroll">
          <table class="devbulk-grid">
            <thead>
              <tr>
                <th scope="col" class="devbulk-col-name">면접원명</th>
                <th scope="col" class="devbulk-col-msg">문구</th>
                <th scope="col" class="devbulk-col-photo">사진</th>
              </tr>
            </thead>
            <tbody>${tbodyInner}</tbody>
          </table>
        </div>`;
    return `
      <div class="devbulk-tab feedback-tab">
        <h2 class="feedback-heading">개인/단체 전송</h2>
        <p class="caption"><strong>검색해서 면접원을 골라 추가</strong>하면 아래 작업 표에만 모입니다. 표에서 행마다 문구·사진을 다르게 넣고「한꺼번에 전송」하면 각자 1:1 채팅으로 갑니다.</p>
        <section class="devbulk-pick-panel" aria-label="면접원 검색 및 추가">
          <div class="field devbulk-search-field">
            <label for="devbulk-search">면접원 검색 <span class="caption">(이름·@아이디·팀명)</span></label>
            <input type="search" id="devbulk-search" autocomplete="off" placeholder="예: 최면접, @id, 부산팀" value="${escapeHtml(view.devBulkSearchDraft || '')}" />
          </div>
          <div id="devbulk-search-results" class="devbulk-search-results" role="listbox" aria-label="검색 결과"></div>
          <div class="devbulk-pick-actions">
            <button type="button" class="btn btn-secondary" id="devbulk-add-all-iv">등록 면접원 전체 추가</button>
            <button type="button" class="btn btn-ghost" id="devbulk-clear-picked">작업 목록 비우기</button>
          </div>
        </section>
        <div class="devbulk-toolbar">
          <div class="field" style="margin-bottom:0.75rem">
            <label for="devbulk-common">공통 문구 <span class="caption">(선택 · 아래 표의 문구 칸에 한꺼번에 넣기)</span></label>
            <textarea id="devbulk-common" rows="2" placeholder="예: 4월 9일까지 제출 부탁드립니다. (모든 행에 넣으려면 아래 버튼 사용)"></textarea>
          </div>
          <button type="button" class="btn btn-secondary" id="devbulk-fill-all">작업 표 전체 행에 문구 넣기</button>
        </div>
        <div class="devbulk-list devbulk-list--table">${tableHtml}</div>
        <button type="button" class="btn btn-primary devbulk-send-btn" id="devbulk-send">한꺼번에 전송</button>
        <section class="devbulk-future" aria-label="추가 도구 예정 영역">
          <h3 class="devbulk-future-heading">추가 기능 (예정)</h3>
          <p class="caption">개발자 모드에 다른 도구·자동화를 단계적으로 붙일 수 있도록 아래 여백을 두었습니다.</p>
          <div class="devbulk-future-placeholder"></div>
        </section>
      </div>`;
  }

  function devBulkRefreshSearchResults() {
    if (!Array.isArray(view.devBulkSelectedIds)) view.devBulkSelectedIds = [];
    const box = document.getElementById('devbulk-search-results');
    const input = document.getElementById('devbulk-search');
    if (!box) return;
    const q = ((input && input.value) || view.devBulkSearchDraft || '').trim();
    if (!q) {
      box.innerHTML = '';
      return;
    }
    const sel = new Set(view.devBulkSelectedIds);
    let ivs = state.accounts.filter((u) => u.role === 'interviewer' && accountMatchesSearch(u, q) && !sel.has(u.id));
    if (!ivs.length) {
      box.innerHTML =
        '<p class="hint devbulk-search-empty" style="margin:0.35rem 0">일치하는 면접원이 없거나 이미 작업 목록에 있습니다.</p>';
      return;
    }
    const btns = ivs
      .map(
        (u) =>
          `<button type="button" class="devbulk-search-pick" role="option" data-devbulk-pick="${escapeHtml(u.id)}"><strong>${escapeHtml(
            u.name
          )}</strong><span class="caption"> · ${escapeHtml(teamLabel(u.team) || '팀 미지정')} · @${escapeHtml(u.loginId)}</span></button>`
      )
      .join('');
    box.innerHTML = btns;
  }

  function accountsAdminHTML() {
    const rows = [...state.accounts].sort((a, b) => a.loginId.localeCompare(b.loginId));
    const cards = rows
      .map((a) => {
        const roleLabel = ROLES[a.role].label;
        const teamPart =
          a.role === 'interviewer'
            ? teamLabel(a.team)
              ? ' · ' + escapeHtml(teamLabel(a.team))
              : ' · 팀 미지정'
            : '';
        const teamBtn =
          a.role === 'interviewer'
            ? `<button type="button" class="btn-team" data-account="${a.id}">팀</button>`
            : '';
        return `
          <div class="account-card" data-account="${a.id}">
            <div class="row">
              <div>
                <div class="login-id">${escapeHtml(a.loginId)}</div>
                <div class="meta">${escapeHtml(a.name)} · ${roleLabel}${teamPart}</div>
              </div>
              <div class="actions">
                <button type="button" class="btn-pw" data-account="${a.id}">비밀번호</button>
                ${teamBtn}
                <button type="button" class="btn-del danger" data-account="${a.id}">삭제</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
    return `
      <div class="account-toolbar">
        <div class="toolbar-btns">
          <button type="button" class="btn btn-primary" id="btn-add-account">＋ 계정 추가</button>
          <button type="button" class="btn btn-secondary" id="btn-xlsx-template">양식(엑셀) 받기</button>
          <label class="btn btn-secondary btn-file">엑셀 업로드<input type="file" id="input-xlsx-import" accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" /></label>
        </div>
        <p class="caption"><strong>엑셀 형식</strong> — 1행: <code>아이디 | 비밀번호 | 이름 | 역할 | 팀</code> · <strong>팀</strong>은 면접원일 때만 필수(부산팀·대구팀·대전팀·광주팀·정량조사부 1팀·정량조사부 2팀 또는 부산/대구/quant1 등). 연구원·슈퍼바이저는 팀 칸 비워도 됩니다.</p>
        <p class="caption">이 탭은 <strong>연구원·슈퍼바이저만</strong> 사용할 수 있습니다. 비밀번호는 이 기기에만 해시로 저장됩니다.</p>
      </div>
      ${cards || '<p class="hint" style="padding:1.5rem">등록된 계정이 없습니다.</p>'}
    `;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function bindMain() {
    ensureTrafficPostMessageListener();
    ensureTrafficExpenseFileDownloadBinder();
    ensureTrafficCrossTabStorageSync();
    ensureTrafficBridgePolling();

    document.getElementById('btn-logout').addEventListener('click', () => {
      state.me = null;
      view.screen = 'login';
      saveState();
      render();
    });

    const ann = document.getElementById('btn-ann');
    if (ann) {
      ann.addEventListener('click', () => {
        view.modal = 'announce';
        openAnnounceModal();
      });
    }

    document.getElementById('btn-staff-presence-main')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cycleStaffPresence();
    });

    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        const next = t.dataset.tab;
        if (view.tab === 'devbulk' && next !== 'devbulk') {
          for (const k of Object.keys(devBulkPendingImageByIvId)) delete devBulkPendingImageByIvId[k];
          view.devBulkSelectedIds = [];
          view.devBulkSearchDraft = '';
        }
        view.tab = next;
        render();
      });
    });

    const prefMuted = document.getElementById('pref-chat-notify-muted');
    if (prefMuted) {
      prefMuted.addEventListener('change', () => {
        if (!state.me || !isStaffAccountRole(state.me.role)) return;
        if (!state.chatNotifyMutedByUser || typeof state.chatNotifyMutedByUser !== 'object')
          state.chatNotifyMutedByUser = {};
        state.chatNotifyMutedByUser[state.me.id] = !!prefMuted.checked;
        saveState();
        showToast(
          prefMuted.checked ? '전체 푸시·알림을 껐습니다. 채팅은 언제든 열어서 볼 수 있어요.' : '전체 푸시·알림을 켰습니다.'
        );
      });
    }

    document.getElementById('btn-toggle-extra-tabs')?.addEventListener('click', () => {
      const cur = getExtraMainTabsOpen();
      if (cur) {
        setExtraMainTabsOpen(false);
        if (view.tab === 'feedback' || view.tab === 'traffic') view.tab = 'chats';
      } else {
        setExtraMainTabsOpen(true);
      }
      render();
    });

    if (view.tab === 'feedback') {
      const submit = document.getElementById('fb-submit');
      if (submit) {
        submit.addEventListener('click', () => {
          if (!state.me || state.me.role !== 'interviewer') return;
          const titleIn = document.getElementById('fb-title');
          const bodyIn = document.getElementById('fb-body');
          const title = (titleIn && titleIn.value ? titleIn.value : '').trim();
          const body = (bodyIn && bodyIn.value ? bodyIn.value : '').trim();
          if (!body) {
            alert('내용을 입력해 주세요.');
            return;
          }
          if (!Array.isArray(state.feedbackThreads)) state.feedbackThreads = [];
          state.feedbackThreads.push({
            id: uid(),
            authorId: state.me.id,
            title,
            body,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            replies: [],
          });
          saveState();
          if (titleIn) titleIn.value = '';
          if (bodyIn) bodyIn.value = '';
          showToast('등록했습니다.');
          render();
        });
      }
      document.querySelectorAll('.fb-reply-submit').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!canPostRoomModeration()) return;
          const tid = btn.getAttribute('data-thread-id');
          const wrap = btn.closest('.feedback-thread');
          const ta = wrap && wrap.querySelector('.fb-reply-text');
          const text = ta ? (ta.value || '').trim() : '';
          if (!tid) return;
          if (!text) {
            alert('답변 내용을 입력해 주세요.');
            return;
          }
          const thread = state.feedbackThreads.find((x) => x.id === tid);
          if (!thread) return;
          if (!Array.isArray(thread.replies)) thread.replies = [];
          thread.replies.push({
            id: uid(),
            authorId: state.me.id,
            text,
            ts: Date.now(),
          });
          thread.updatedAt = Date.now();
          saveState();
          ta.value = '';
          showToast('답변을 등록했습니다.');
          render();
        });
      });
      document.querySelectorAll('.feedback-thread-delete').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const tid = btn.getAttribute('data-thread-id');
          if (!tid || !state.me || state.me.role !== 'interviewer') return;
          const thread = state.feedbackThreads.find((x) => x.id === tid);
          if (!thread || thread.authorId !== state.me.id) return;
          if (!confirm('이 글을 삭제할까요? 답변도 함께 삭제됩니다.')) return;
          state.feedbackThreads = state.feedbackThreads.filter((x) => x.id !== tid);
          saveState();
          showToast('삭제했습니다.');
          render();
        });
      });
    }

    if (view.tab === 'devbulk' && canManageAccounts()) {
      if (!Array.isArray(view.devBulkSelectedIds)) view.devBulkSelectedIds = [];

      const searchInp = document.getElementById('devbulk-search');
      if (searchInp) {
        searchInp.addEventListener('input', () => {
          view.devBulkSearchDraft = searchInp.value;
          devBulkRefreshSearchResults();
        });
        searchInp.addEventListener('focus', () => devBulkRefreshSearchResults());
      }

      document.getElementById('devbulk-search-results')?.addEventListener('click', (ev) => {
        const pick = ev.target.closest('.devbulk-search-pick');
        if (!pick) return;
        const id = pick.getAttribute('data-devbulk-pick');
        if (!id) return;
        if (!state.accounts.some((a) => a.id === id && a.role === 'interviewer')) return;
        if (!view.devBulkSelectedIds.includes(id)) view.devBulkSelectedIds.push(id);
        showToast('작업 목록에 추가했습니다.');
        render();
        requestAnimationFrame(() => {
          devBulkRefreshSearchResults();
        });
      });

      document.getElementById('devbulk-add-all-iv')?.addEventListener('click', () => {
        const sortByName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko');
        const all = state.accounts.filter((u) => u.role === 'interviewer').sort(sortByName);
        const set = new Set(view.devBulkSelectedIds);
        for (const u of all) set.add(u.id);
        view.devBulkSelectedIds = Array.from(set);
        showToast(`${view.devBulkSelectedIds.length}명을 작업 목록에 두었습니다.`);
        render();
        requestAnimationFrame(() => devBulkRefreshSearchResults());
      });

      document.getElementById('devbulk-clear-picked')?.addEventListener('click', () => {
        if (!view.devBulkSelectedIds.length) {
          showToast('비울 면접원이 없습니다.');
          return;
        }
        if (!confirm('작업 목록과 붙여 둔 사진 초안을 모두 비울까요?')) return;
        for (const k of Object.keys(devBulkPendingImageByIvId)) delete devBulkPendingImageByIvId[k];
        view.devBulkSelectedIds = [];
        render();
      });

      document.getElementById('devbulk-fill-all')?.addEventListener('click', () => {
        const com = (document.getElementById('devbulk-common')?.value || '').trim();
        if (!com) {
          showToast('공통 문구 칸에 먼저 내용을 입력해 주세요.');
          return;
        }
        const tas = document.querySelectorAll('.devbulk-textarea');
        if (!tas.length) {
          showToast('먼저 작업 목록에 면접원을 추가해 주세요.');
          return;
        }
        tas.forEach((ta) => {
          ta.value = com;
        });
        showToast('작업 표의 모든 문구 칸에 넣었습니다.');
      });

      document.querySelectorAll('.devbulk-file').forEach((inp) => {
        inp.addEventListener('change', () => {
          const ivId = inp.getAttribute('data-devbulk-file');
          const row = inp.closest('.devbulk-row');
          if (!ivId || !row) {
            inp.value = '';
            return;
          }
          const f = inp.files && inp.files[0];
          inp.value = '';
          if (!f) return;
          if (!fileLooksImage(f)) {
            showToast('사진만 첨부할 수 있습니다.');
            return;
          }
          if (f.size > MAX_CHAT_IMAGE_SOURCE_BYTES) {
            showToast('사진 원본이 너무 큽니다. 다른 파일을 선택해 주세요.');
            return;
          }
          const slot = row.querySelector(`[data-devbulk-preview-slot="${ivId}"]`);
          const hint = row.querySelector(`[data-devbulk-img-hint="${ivId}"]`);
          if (hint) hint.textContent = '사진 처리 중…';
          const applyThumb = (dataUrl) => {
            delete devBulkPendingImageByIvId[ivId];
            if (!dataUrl) {
              if (hint) hint.textContent = '';
              return;
            }
            devBulkPendingImageByIvId[ivId] = dataUrl;
            if (slot) {
              const nmEl = row.querySelector('.devbulk-name');
              const nm = nmEl ? String(nmEl.textContent || '').trim() : '';
              slot.innerHTML = devBulkPreviewSlotHtml(ivId, nm, dataUrl);
            }
            if (hint) hint.textContent = '';
          };
          compressImageFileToDataUrl(f).then((dataUrl) => {
            if (dataUrl) {
              applyThumb(dataUrl);
              return;
            }
            if (f.size > MAX_CHAT_MEDIA_BYTES) {
              if (hint) hint.textContent = '';
              showToast('이 사진은 압축되지 않아 용량 초과입니다.');
              return;
            }
            const fr = new FileReader();
            fr.onerror = () => {
              if (hint) hint.textContent = '';
              showToast('파일을 읽지 못했습니다.');
            };
            fr.onload = () => applyThumb(fr.result);
            fr.readAsDataURL(f);
          });
        });
      });

      document.querySelectorAll('.devbulk-list').forEach((listEl) => {
        listEl.addEventListener('click', (ev) => {
          const rm = ev.target.closest('.devbulk-row-remove');
          if (rm) {
            ev.preventDefault();
            ev.stopPropagation();
            const rid = rm.getAttribute('data-devbulk-remove');
            if (!rid) return;
            view.devBulkSelectedIds = view.devBulkSelectedIds.filter((x) => x !== rid);
            delete devBulkPendingImageByIvId[rid];
            render();
            requestAnimationFrame(() => devBulkRefreshSearchResults());
            return;
          }
          const dl = ev.target.closest('.devbulk-img-download');
          if (dl) {
            ev.preventDefault();
            ev.stopPropagation();
            const did = dl.getAttribute('data-devbulk-download');
            if (!did) return;
            const nm = dl.getAttribute('data-devbulk-dl-name') || '';
            triggerDevBulkImageDownload(did, devBulkPendingImageByIvId[did], nm);
            return;
          }
          const btn = ev.target.closest('.devbulk-img-clear');
          if (!btn) return;
          ev.preventDefault();
          const ivId = btn.getAttribute('data-devbulk-clear');
          if (!ivId) return;
          delete devBulkPendingImageByIvId[ivId];
          const row = btn.closest('.devbulk-row');
          const slot = row && row.querySelector(`[data-devbulk-preview-slot="${ivId}"]`);
          if (slot) slot.innerHTML = '';
          const hint = row && row.querySelector(`[data-devbulk-img-hint="${ivId}"]`);
          if (hint) hint.textContent = '';
        });
      });

      requestAnimationFrame(() => devBulkRefreshSearchResults());

      document.getElementById('devbulk-send')?.addEventListener('click', () => {
        if (!state.me || !isStaffAccountRole(state.me.role)) return;
        const tas = document.querySelectorAll('.devbulk-textarea');
        let sent = 0;
        for (const ta of tas) {
          const ivId = ta.getAttribute('data-devbulk-ta');
          if (!ivId) continue;
          const text = (ta.value || '').trim();
          const imageData = devBulkPendingImageByIvId[ivId] || null;
          if (!text && !imageData) continue;
          const acc = state.accounts.find((a) => a.id === ivId && a.role === 'interviewer');
          if (!acc) continue;
          const room = ensureDmRoom(ivId);
          normalizeRoomModeration(room);
          if (!state.messages[room.id]) state.messages[room.id] = [];
          state.messages[room.id].push({
            id: uid(),
            senderId: state.me.id,
            text: text || (imageData ? '(사진)' : ''),
            image: imageData,
            video: null,
            ts: Date.now(),
            isAnnouncement: false,
          });
          room.updatedAt = Date.now();
          if (imageData && !text) room.lastPreview = '📷 사진';
          else if (imageData) room.lastPreview = ('📷 ' + text).slice(0, 40);
          else room.lastPreview = text.slice(0, 40);
          delete devBulkPendingImageByIvId[ivId];
          sent += 1;
          ta.value = '';
        }
        if (!sent) {
          showToast('보낼 내용이 없습니다. 작업 목록에 면접원을 넣고 문구 또는 사진을 입력해 주세요.');
          return;
        }
        saveState();
        showToast(`${sent}명의 면접원에게 1:1로 보냈습니다.`);
        view.devBulkSelectedIds = [];
        view.devBulkSearchDraft = '';
        render();
      });
    }

    if (view.tab === 'traffic' && (state.me.role === 'supervisor' || state.me.role === 'interviewer')) {
      document.getElementById('traffic-tool-open-newtab')?.addEventListener('click', () => {
        window.open(TRAFFIC_TOOL_URL, '_blank');
      });
      document.getElementById('traffic-reset-all')?.addEventListener('click', () => {
        if (!state.me || !(state.me.role === 'supervisor' || state.me.role === 'researcher')) return;
        const ok = window.confirm('교통비 제출 표시를 전부 삭제할까요? (되돌릴 수 없습니다)');
        if (!ok) return;
        resetAllTrafficExpenseSubmissions();
      });
      bindTrafficExpenseFilters();
      document.querySelectorAll('.traffic-submit-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-iv-id');
          const action = btn.getAttribute('data-action');
          if (!id || !state.me) return;
          const acc = state.accounts.find((a) => a.id === id && a.role === 'interviewer');
          if (!acc) return;
          const allowed =
            state.me.role === 'supervisor' || (state.me.role === 'interviewer' && state.me.id === id);
          if (!allowed) return;
        if (!view.trafficListFilter || !view.trafficListFilter.roomId) {
          showToast('프로젝트(단체방)를 먼저 선택해 주세요.');
          return;
        }
        const pk = trafficSubmissionKeyFromRoomId(view.trafficListFilter.roomId);
        if (!pk) return;
        const trRoom = state.rooms.find((r) => r.id === view.trafficListFilter.roomId);
        const trPn = trRoom && trRoom.projectNumber ? String(trRoom.projectNumber).trim() : '';
          if (action === 'set') {
          markTrafficExpenseSubmittedForIvProjectKey(id, pk, {
            manual: true,
            source: 'manual',
            projectNumber: trPn,
          });
            saveState();
            showToast('제출 완료로 표시했습니다.');
          } else if (action === 'clear') {
          markTrafficExpenseClearedForIvProjectKey(id, pk, { source: 'manual-clear' });
            saveState();
            showToast('제출 표시를 지웠습니다.');
          }
          render();
        });
      });
    }

    document.querySelectorAll('.room-item-main').forEach((row) => {
      row.addEventListener('click', () => {
        view.roomId = row.dataset.room;
        view.screen = 'chat';
        render();
      });
    });

    document.querySelectorAll('.room-list-pin-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rid = btn.getAttribute('data-room-pin');
        if (!rid) return;
        togglePinChatRoom(rid);
        render();
      });
    });

    document.querySelectorAll('.room-list-notify-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rid = btn.getAttribute('data-room-notify');
        if (!rid || !state.me || !isStaffAccountRole(state.me.role)) return;
        toggleChatRoomNotifyMute(rid);
        render();
      });
    });

    document.querySelectorAll('.room-list-leave-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rid = btn.getAttribute('data-room-leave');
        const r = state.rooms.find((x) => x.id === rid);
        if (!r) return;
        const t = roomDisplayTitlePlain(r);
        const msg =
          r.type === 'group'
            ? `'${t}' 방에서 나가시겠습니까?`
            : `'${t}' 님과의 1:1 대화에서 나가시겠습니까?`;
        if (!confirm(msg)) return;
        leaveChatRoom(rid);
        showToast('채팅방에서 나갔습니다.');
        render();
      });
    });

    document.querySelectorAll('.dir-user-main').forEach((row) => {
      row.addEventListener('click', () => {
        const otherId = row.dataset.user;
        const room = ensureDmRoom(otherId);
        saveState();
        view.roomId = room.id;
        view.screen = 'chat';
        render();
      });
    });

    document.querySelectorAll('.dir-leave-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const oid = btn.getAttribute('data-dir-leave');
        const dm = findDmRoomWith(oid);
        if (!dm) {
          showToast('해당 분과 열린 1:1 대화가 없습니다.');
          return;
        }
        if (!confirm('이 1:1 대화방을 삭제(나가기)하시겠습니까?')) return;
        leaveChatRoom(dm.id);
        showToast('대화방을 삭제했습니다.');
        render();
      });
    });

    const fab = document.getElementById('fab-new');
    if (fab) {
      fab.addEventListener('click', () => {
        view.modal = 'newchat';
        openNewChatModal();
      });
    }
    if (canManageAccounts() && view.tab === 'accounts') {
      const addBtn = document.getElementById('btn-add-account');
      if (addBtn) addBtn.addEventListener('click', () => openAddAccountModal());
      const tpl = document.getElementById('btn-xlsx-template');
      if (tpl) tpl.addEventListener('click', downloadAccountTemplate);
      const xlsxIn = document.getElementById('input-xlsx-import');
      if (xlsxIn) {
        xlsxIn.addEventListener('change', async () => {
          const f = xlsxIn.files && xlsxIn.files[0];
          xlsxIn.value = '';
          if (!f) return;
          await importAccountsFromExcelFile(f);
        });
      }
      document.querySelectorAll('.btn-pw').forEach((b) => {
        b.addEventListener('click', () => openChangePasswordModal(b.dataset.account));
      });
      document.querySelectorAll('.btn-team').forEach((b) => {
        b.addEventListener('click', () => openChangeTeamModal(b.dataset.account));
      });
      document.querySelectorAll('.btn-del').forEach((b) => {
        b.addEventListener('click', () => deleteAccountConfirm(b.dataset.account));
      });
    }
    bindLanCopyButtons(el.root);
    bindThemeToggle();
  }

  function openAnnounceModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:80vh">
        <div class="modal-head">공지 보내기</div>
        <div class="modal-body">
          <div class="field">
            <label for="ann-title">제목</label>
            <input type="text" id="ann-title" placeholder="예: 내일 스케줄 변경" />
          </div>
          <div class="field">
            <label for="ann-body">내용</label>
            <textarea id="ann-body" rows="4" style="width:100%;border-radius:12px;border:1px solid var(--border);background:var(--bg);padding:0.65rem" placeholder="상세 내용"></textarea>
          </div>
          <p class="hint">슈퍼바이저만 전체 공지를 올릴 수 있습니다. 카카오·문자 <strong>자동 발송</strong>은 백엔드·API가 있어야 가능합니다. 이 기기에서 브라우저 알림을 허용하면 공지 작성 직후 <strong>이 PC/폰</strong>에 뜨는 정도만 됩니다. 면접원에게 보내려면 「공유하기」로 카카오톡 등에 붙여 넣으세요.</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="ann-cancel">취소</button>
          <button type="button" class="btn btn-secondary" id="ann-share">공유하기</button>
          <button type="button" class="btn btn-primary" id="ann-send">보내기</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#ann-cancel').addEventListener('click', () => {
      overlay.remove();
      view.modal = null;
    });
    overlay.querySelector('#ann-share').addEventListener('click', async () => {
      const title = (overlay.querySelector('#ann-title').value || '').trim();
      const body = (overlay.querySelector('#ann-body').value || '').trim();
      if (!title || !body) {
        alert('공유하려면 제목과 내용을 모두 입력해 주세요.');
        return;
      }
      const txt = formatNoticeForExternalShare(title, body, '【전체 공지】');
      await shareOrCopyPlainText(txt, title);
    });
    overlay.querySelector('#ann-send').addEventListener('click', () => {
      const title = (overlay.querySelector('#ann-title').value || '').trim();
      const body = (overlay.querySelector('#ann-body').value || '').trim();
      if (!title || !body) {
        alert('제목과 내용을 입력해 주세요.');
        return;
      }
      broadcastAnnouncement(title, body);
      overlay.remove();
      view.modal = null;
      showToast('공지를 보냈습니다.');
      render();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        view.modal = null;
      }
    });
  }

  function openRoomNoticeModal(roomId) {
    if (!canPostRoomModeration()) return;
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    normalizeRoomModeration(room);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:80vh">
        <div class="modal-head">이 방 공지</div>
        <div class="modal-body">
          <div class="field">
            <label for="room-ann-title">제목</label>
            <input type="text" id="room-ann-title" placeholder="예: 오늘 일정" autocomplete="off" />
          </div>
          <div class="field">
            <label for="room-ann-body">내용</label>
            <textarea id="room-ann-body" rows="4" style="width:100%;border-radius:12px;border:1px solid var(--border);background:var(--bg);padding:0.65rem" placeholder="상세 내용"></textarea>
          </div>
          <p class="hint">연구원·슈퍼바이저만 수정할 수 있습니다. 제목·내용을 모두 비우면 상단 배너만 지웁니다. 상대 폰으로 자동 문자·알림톡은 서버 연동이 필요하며, 「공유하기」로 카카오톡 등에 넘길 수 있습니다.</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="room-ann-cancel">닫기</button>
          <button type="button" class="btn btn-secondary" id="room-ann-share">공유하기</button>
          <button type="button" class="btn btn-primary" id="room-ann-save">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const titleIn = overlay.querySelector('#room-ann-title');
    const bodyIn = overlay.querySelector('#room-ann-body');
    titleIn.value = room.roomNoticeTitle || '';
    bodyIn.value = room.roomNoticeBody || '';
    const close = () => {
      overlay.remove();
      view.modal = null;
    };
    overlay.querySelector('#room-ann-cancel').addEventListener('click', close);
    overlay.querySelector('#room-ann-share').addEventListener('click', async () => {
      const title = (titleIn.value || '').trim();
      const body = (bodyIn.value || '').trim();
      if (!title || !body) {
        alert('공유하려면 제목과 내용을 모두 입력해 주세요.');
        return;
      }
      const rname = roomDisplayTitlePlain(room);
      const txt = formatNoticeForExternalShare(title, body, `【방 공지 · ${rname}】`);
      await shareOrCopyPlainText(txt, title);
    });
    overlay.querySelector('#room-ann-save').addEventListener('click', () => {
      const title = (titleIn.value || '').trim();
      const body = (bodyIn.value || '').trim();
      if (!title && !body) {
        room.roomNoticeTitle = '';
        room.roomNoticeBody = '';
        room.updatedAt = Date.now();
        saveState();
        close();
        render();
        return;
      }
      if (!title) {
        alert('제목을 입력하거나, 배너를 지우려면 제목·내용을 모두 비우세요.');
        return;
      }
      const prevT = (room.roomNoticeTitle || '').trim();
      const prevB = (room.roomNoticeBody || '').trim();
      const changed = title !== prevT || body !== prevB;
      room.roomNoticeTitle = title;
      room.roomNoticeBody = body;
      room.updatedAt = Date.now();
      if (changed) {
        if (!state.messages[room.id]) state.messages[room.id] = [];
        state.messages[room.id].push({
          id: uid(),
          senderId: state.me.id,
          text: '【방 공지】' + title + (body ? '\n' + body : ''),
          image: null,
          video: null,
          ts: Date.now(),
          isRoomNotice: true,
        });
        room.lastPreview = '공지: ' + title;
      }
      saveState();
      close();
      render();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  function openRoomProjectNumberModal(roomId) {
    if (!canPostRoomModeration()) return;
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room || room.type !== 'group') return;
    normalizeRoomModeration(room);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:80vh">
        <div class="modal-head">프로젝트 번호</div>
        <div class="modal-body">
          <div class="field">
            <label for="room-proj-num">단체방 프로젝트 번호</label>
            <input type="text" id="room-proj-num" placeholder="예: 2025-31-1948" autocomplete="off" />
          </div>
          <p class="hint">교통비 탭에서 프로젝트(단체방)를 고유하게 구분하는 번호입니다. 유류비 사이트에서 보낸 <strong>projectNumber</strong>와 일치하면 자동 매칭이 더 정확해집니다.</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="room-proj-cancel">닫기</button>
          <button type="button" class="btn btn-primary" id="room-proj-save">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const inEl = overlay.querySelector('#room-proj-num');
    inEl.value = room.projectNumber || '';
    const close = () => {
      overlay.remove();
      view.modal = null;
    };
    overlay.querySelector('#room-proj-cancel').addEventListener('click', close);
    overlay.querySelector('#room-proj-save').addEventListener('click', () => {
      const v = (inEl.value || '').trim();
      room.projectNumber = v;
      room.updatedAt = Date.now();
      saveState();
      close();
      render();
      showToast('프로젝트 번호를 저장했습니다.');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  function newChatMemberRowHtml(u) {
    return `<label class="newchat-mem-label" data-mem-id="${u.id}"><input type="checkbox" value="${u.id}" /><span class="check-list-txt">${escapeHtml(u.name)} · ${ROLES[u.role].label}${
      u.role === 'interviewer' && teamLabel(u.team) ? ' · ' + escapeHtml(teamLabel(u.team)) : ''
    }${publicLoginIdListSuffixEscaped(u)}</span></label>`;
  }

  function groupNewChatMembersChecklistHtml(others) {
    const sortByName = (arr) =>
      [...arr].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
    const researchers = others.filter((u) => u.role === 'researcher');
    const supervisors = others.filter((u) => u.role === 'supervisor');
    const interviewers = others.filter((u) => u.role === 'interviewer');
    const byTeam = {};
    const unassigned = [];
    for (const u of interviewers) {
      const tk = u.team && TEAMS[u.team] ? u.team : null;
      if (!tk) unassigned.push(u);
      else {
        if (!byTeam[tk]) byTeam[tk] = [];
        byTeam[tk].push(u);
      }
    }
    const section = (title, inner) =>
      inner
        ? `<div class="check-list-section"><div class="check-list-section-title">${escapeHtml(title)}</div>${inner}</div>`
        : '';
    let html = '';
    html += section('연구원', sortByName(researchers).map(newChatMemberRowHtml).join(''));
    html += section('슈퍼바이저', sortByName(supervisors).map(newChatMemberRowHtml).join(''));
    for (const tid of TEAM_ORDER) {
      const list = byTeam[tid];
      if (list && list.length) html += section(TEAMS[tid], sortByName(list).map(newChatMemberRowHtml).join(''));
    }
    if (unassigned.length)
      html += section(
        '면접원 · 팀 미지정',
        sortByName(unassigned).map(newChatMemberRowHtml).join('')
      );
    return html || '<p class="caption" style="padding:0.5rem 0">선택 가능한 멤버가 없습니다.</p>';
  }

  function normalizeProjectNumber(v) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    return s.replace(/\s/g, '');
  }

  function normalizeProjectName(v) {
    return String(v ?? '').trim();
  }

  function sheetToProjectRows(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return [];
    const headerRow = (matrix[0] || []).map((cell) => String(cell || '').trim().toLowerCase());
    const findIndex = (keys) => headerRow.findIndex((h) => keys.some((k) => h.includes(k)));
    const numIdx = findIndex(['프로젝트', 'project', '번호', 'number', 'no']);
    const nameIdx = findIndex(['프로젝트명', 'projectname', 'name', '명', 'title']);
    const hasHeader = numIdx !== -1 || nameIdx !== -1;
    const start = hasHeader ? 1 : 0;
    const out = [];
    for (let i = start; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row) continue;
      const number = normalizeProjectNumber(row[hasHeader ? numIdx : 0]);
      const name = normalizeProjectName(row[hasHeader ? nameIdx : 1]);
      if (!number && !name) continue;
      out.push({ sheetRow: i + 1, number, name });
    }
    return out;
  }

  async function importProjectsFromExcelFile(file) {
    if (typeof XLSX === 'undefined') {
      alert('엑셀 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인 후 새로고침 해 주세요.');
      return;
    }
    if (!canManageAccounts()) return;
    let wb;
    try {
      const buf = await file.arrayBuffer();
      wb = XLSX.read(buf, { type: 'array' });
    } catch (_) {
      alert('파일을 읽을 수 없습니다.');
      return;
    }
    const sn = wb.SheetNames[0];
    if (!sn) {
      alert('시트가 비어 있습니다.');
      return;
    }
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    const parsed = sheetToProjectRows(matrix);
    if (!parsed.length) {
      alert('가져올 프로젝트가 없습니다. (프로젝트 번호/프로젝트명 열이 있는지 확인)');
      return;
    }
    if (!Array.isArray(state.projects)) state.projects = [];
    const byNum = new Map(state.projects.map((p) => [String(p.number), p]));
    let added = 0;
    for (const r of parsed) {
      if (!r.number) continue;
      if (byNum.has(r.number)) continue;
      byNum.set(r.number, { number: r.number, name: r.name || '' });
      added++;
    }
    state.projects = Array.from(byNum.values()).sort((a, b) => String(a.number).localeCompare(String(b.number)));
    saveState();
    showToast(`프로젝트 ${added}개를 추가했습니다.`);
  }

  let projectsSeedFetchPromise = null;
  async function ensureProjectsCatalogLoaded() {
    if (Array.isArray(state.projects) && state.projects.length) return true;
    if (projectsSeedFetchPromise) return projectsSeedFetchPromise;
    projectsSeedFetchPromise = (async () => {
      try {
        const res = await fetch('data/seed-projects.json', { cache: 'no-store' });
        if (!res.ok) return false;
        const j = await res.json();
        const list = j && Array.isArray(j.projects) ? j.projects : [];
        if (!list.length) return false;
        state.projects = list
          .filter((p) => p && p.number)
          .map((p) => ({ number: String(p.number).trim(), name: p.name != null ? String(p.name).trim() : '' }))
          .sort((a, b) => String(a.number).localeCompare(String(b.number)));
        saveState();
        return true;
      } catch (_) {
        return false;
      }
    })();
    return projectsSeedFetchPromise;
  }

  function openNewChatModal() {
    const others = state.accounts.filter((u) => u.id !== state.me.id);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">새 채팅</div>
        <div class="modal-body">
          <div class="field">
            <label for="newchat-search">이름·아이디 검색</label>
            <input type="search" id="newchat-search" placeholder="이름 또는 @아이디" autocomplete="off" />
            <p class="caption" style="margin-top:0.35rem">검색은 단체방 멤버 목록과 함께 적용됩니다. 1:1 상대가 <strong>한 명만</strong> 남으면 아래 목록에서 자동 선택됩니다. 같은 상태에서 <strong>Enter</strong>를 누르면 바로 1:1 방이 열립니다.</p>
          </div>
          <div class="field">
            <label for="dm-select">1:1 대화 — 상대 선택</label>
            <select id="dm-select" class="field" style="margin-top:0.35rem">
              <option value="">선택…</option>
              ${others
                .map((u) => {
                  const teamS =
                    u.role === 'interviewer' && teamLabel(u.team)
                      ? ' · ' + escapeHtml(teamLabel(u.team))
                      : '';
                  return `<option value="${u.id}">${escapeHtml(u.name)} (${ROLES[u.role].label}${teamS})${publicLoginIdListSuffixEscaped(u)}</option>`;
                })
                .join('')}
            </select>
            <button type="button" class="btn btn-primary" id="btn-dm" style="margin-top:0.75rem">1:1 방 열기</button>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:1rem 0" />
          <div class="field">
            <label for="grp-name">단체방 이름</label>
            <input type="text" id="grp-name" placeholder="예: 4월 현장조사 TF" />
          </div>
          <div class="field">
            <label for="grp-project-number">프로젝트 번호</label>
            <input type="text" id="grp-project-number" placeholder="예: 2025-31-1948" autocomplete="off" />
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;flex-wrap:wrap">
              <input type="search" id="grp-project-search" placeholder="프로젝트 검색 (번호/이름)" autocomplete="off" style="flex:1 1 14rem" />
              <button type="button" class="btn btn-secondary" id="btn-project-add-temp" style="flex:0 0 auto">임시 등록</button>
            </div>
            <div id="grp-project-results" class="devbulk-search-results" role="listbox" aria-label="프로젝트 검색 결과" style="margin-top:0.5rem"></div>
            <p class="caption" style="margin-top:0.35rem">프로젝트를 검색해서 선택할 수 있습니다. 목록에 없으면 번호/이름을 직접 입력한 뒤 <strong>임시 등록</strong>하세요. (프로젝트 목록 엑셀 반영은 서버의 <code>data/seed-projects.json</code>로 미리 넣어 둡니다.)</p>
          </div>
          <div class="field">
            <fieldset style="border:none;margin:0;padding:0;min-width:0">
            <legend style="font-size:0.8rem;color:var(--muted);margin-bottom:0.35rem;padding:0">멤버 선택</legend>
            <div class="newchat-member-scroll">
            <div class="check-list" id="grp-members">
              ${groupNewChatMembersChecklistHtml(others)}
            </div>
            </div>
            <button type="button" class="btn btn-grp-create" id="btn-grp">단체방 만들기</button>
            </fieldset>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="newchat-close">닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const searchIn = overlay.querySelector('#newchat-search');
    const dmSelect = overlay.querySelector('#dm-select');
    const projNumIn = overlay.querySelector('#grp-project-number');
    const projSearchIn = overlay.querySelector('#grp-project-search');
    const projResults = overlay.querySelector('#grp-project-results');
    const projAddTempBtn = overlay.querySelector('#btn-project-add-temp');
    function applyNewChatSearchFilter() {
      const q = searchIn.value || '';
      Array.from(dmSelect.options).forEach((opt, idx) => {
        if (idx === 0 || !opt.value) {
          opt.hidden = false;
          return;
        }
        const u = others.find((x) => x.id === opt.value);
        opt.hidden = !!(u && !accountMatchesSearch(u, q));
      });
      const visibleDmOpts = Array.from(dmSelect.options).filter((opt, idx) => idx > 0 && opt.value && !opt.hidden);
      if (visibleDmOpts.length === 1) {
        dmSelect.value = visibleDmOpts[0].value;
      } else {
        const cur = dmSelect.value;
        const curStill = visibleDmOpts.some((o) => o.value === cur);
        if (!curStill) dmSelect.value = '';
      }
      overlay.querySelectorAll('#grp-members .newchat-mem-label').forEach((lab) => {
        const id = lab.getAttribute('data-mem-id');
        const u = others.find((x) => x.id === id);
        const show = !u || accountMatchesSearch(u, q);
        lab.classList.toggle('hidden', !show);
      });
      overlay.querySelectorAll('#grp-members .check-list-section').forEach((sec) => {
        const labels = sec.querySelectorAll('.newchat-mem-label');
        const anyVisible = Array.from(labels).some((lab) => !lab.classList.contains('hidden'));
        sec.classList.toggle('check-list-section--empty', labels.length > 0 && !anyVisible);
      });
    }
    searchIn.addEventListener('input', applyNewChatSearchFilter);
    searchIn.addEventListener('search', applyNewChatSearchFilter);
    searchIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      applyNewChatSearchFilter();
      const sid = dmSelect.value;
      if (!sid) return;
      overlay.querySelector('#btn-dm').click();
    });

    function close() {
      overlay.remove();
      view.modal = null;
    }

    overlay.querySelector('#newchat-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('#btn-dm').addEventListener('click', () => {
      const sid = overlay.querySelector('#dm-select').value;
      if (!sid) {
        alert('상대를 선택해 주세요.');
        return;
      }
      const room = ensureDmRoom(sid);
      saveState();
      close();
      view.roomId = room.id;
      view.screen = 'chat';
      render();
    });

    overlay.querySelector('#btn-grp').addEventListener('click', () => {
      const name = (overlay.querySelector('#grp-name').value || '').trim();
      if (!name) {
        alert('단체방 이름을 입력해 주세요.');
        return;
      }
      const projectNumber = (projNumIn && projNumIn.value ? String(projNumIn.value) : '').trim();
      const ids = Array.from(overlay.querySelectorAll('#grp-members input:checked')).map((i) => i.value);
      const memberIds = [state.me.id, ...ids];
      if (memberIds.length < 2) {
        alert('단체방은 본인 외 최소 1명을 선택해 주세요.');
        return;
      }
      const room = {
        id: uid(),
        type: 'group',
        name,
        projectNumber,
        memberIds,
        updatedAt: Date.now(),
        lastPreview: '방이 개설되었습니다',
        interviewerChatAllowed: true,
        roomNoticeTitle: '',
        roomNoticeBody: '',
      };
      state.rooms.unshift(room);
      state.messages[room.id] = [];
      saveState();
      close();
      view.roomId = room.id;
      view.screen = 'chat';
      render();
    });

    async function renderProjectSearchResults() {
      if (!projResults || !projSearchIn) return;
      const q = (projSearchIn.value || '').trim().toLowerCase();
      if (!q) {
        projResults.innerHTML = '';
        return;
      }
      if (!Array.isArray(state.projects) || state.projects.length === 0) {
        await ensureProjectsCatalogLoaded();
      }
      const list = Array.isArray(state.projects) ? state.projects : [];
      const hits = list
        .filter((p) => {
          const n = String(p.number || '').toLowerCase();
          const nm = String(p.name || '').toLowerCase();
          return n.includes(q) || nm.includes(q);
        })
        .slice(0, 50);
      if (!hits.length) {
        projResults.innerHTML = '<p class="hint" style="margin:0.35rem 0">일치하는 프로젝트가 없습니다.</p>';
        return;
      }
      projResults.innerHTML = hits
        .map((p) => {
          const label = `${escapeHtml(p.number)} · ${escapeHtml(p.name || '')}`;
          return `<button type="button" class="devbulk-search-pick" role="option" data-proj-pick="${escapeHtml(
            p.number
          )}" data-proj-name="${escapeHtml(p.name || '')}"><strong>${label}</strong></button>`;
        })
        .join('');
    }

    projSearchIn?.addEventListener('input', () => {
      renderProjectSearchResults();
    });
    projResults?.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-proj-pick]') : null;
      if (!btn) return;
      const num = btn.getAttribute('data-proj-pick') || '';
      const nm = btn.getAttribute('data-proj-name') || '';
      if (projNumIn) projNumIn.value = num;
      const grpNameIn = overlay.querySelector('#grp-name');
      if (grpNameIn && !String(grpNameIn.value || '').trim()) grpNameIn.value = nm || num;
      if (projSearchIn) projSearchIn.value = '';
      if (projResults) projResults.innerHTML = '';
      showToast('프로젝트를 선택했습니다.');
    });

    projAddTempBtn?.addEventListener('click', () => {
      const number = normalizeProjectNumber(projNumIn ? projNumIn.value : '');
      const nm = normalizeProjectName((overlay.querySelector('#grp-name')?.value || '').trim());
      const name = normalizeProjectName(nm);
      if (!number) {
        showToast('프로젝트 번호를 먼저 입력해 주세요.');
        return;
      }
      if (!Array.isArray(state.projects)) state.projects = [];
      if (state.projects.some((p) => String(p.number) === number)) {
        showToast('이미 등록된 프로젝트 번호입니다.');
        return;
      }
      state.projects.push({ number, name: name || '' });
      state.projects.sort((a, b) => String(a.number).localeCompare(String(b.number)));
      saveState();
      showToast('프로젝트를 임시 등록했습니다.');
      renderProjectSearchResults();
    });
  }

  function openAddAccountModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:85vh">
        <div class="modal-head">계정 추가</div>
        <div class="modal-body">
          <div class="field">
            <label for="acc-loginId">아이디 (로그인용)</label>
            <input type="text" id="acc-loginId" autocomplete="off" placeholder="영문·숫자 권장" />
          </div>
          <div class="field">
            <label for="acc-pw">비밀번호</label>
            <input type="password" id="acc-pw" autocomplete="new-password" />
          </div>
          <div class="field">
            <label for="acc-name">이름 (채팅에 표시)</label>
            <input type="text" id="acc-name" maxlength="30" />
          </div>
          <div class="field">
            <label for="acc-role">역할 (연구원·슈퍼바이저·면접원)</label>
            <select id="acc-role">
              <option value="researcher">연구원</option>
              <option value="supervisor">슈퍼바이저</option>
              <option value="interviewer">면접원</option>
            </select>
          </div>
          <div class="field hidden" id="acc-team-wrap">
            <label for="acc-team">소속 팀 (면접원 필수)</label>
            <select id="acc-team">
              <option value="">팀을 선택하세요</option>
              ${TEAM_ORDER.map((k) => `<option value="${k}">${TEAMS[k]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="acc-add-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="acc-add-save">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const roleSel = overlay.querySelector('#acc-role');
    const teamWrap = overlay.querySelector('#acc-team-wrap');
    function syncTeamVisibility() {
      const show = roleSel.value === 'interviewer';
      teamWrap.classList.toggle('hidden', !show);
    }
    roleSel.addEventListener('change', syncTeamVisibility);
    syncTeamVisibility();
    const close = () => {
      overlay.remove();
      view.modal = null;
    };
    overlay.querySelector('#acc-add-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#acc-add-save').addEventListener('click', async () => {
      const loginId = (overlay.querySelector('#acc-loginId').value || '').trim();
      const pw = overlay.querySelector('#acc-pw').value || '';
      const name = (overlay.querySelector('#acc-name').value || '').trim();
      const role = overlay.querySelector('#acc-role').value;
      if (!loginId || !pw || !name) {
        alert('아이디·비밀번호·이름을 모두 입력해 주세요.');
        return;
      }
      if (!isValidAccountRoleKey(role)) {
        alert('역할을 선택해 주세요.');
        return;
      }
      let team = null;
      if (role === 'interviewer') {
        team = overlay.querySelector('#acc-team').value;
        if (!team || !TEAMS[team]) {
          alert('면접원은 부산·대구·대전·광주·정량조사부 1팀·정량조사부 2팀 중 하나를 선택해 주세요.');
          return;
        }
      }
      if (state.accounts.some((a) => a.loginId === loginId)) {
        alert('이미 같은 아이디가 있습니다.');
        return;
      }
      if (isStaffAccountRole(role)) {
        const nn = normalizeStaffDisplayName(name);
        if (staffDisplayNameTakenByExisting(nn, null)) {
          alert(
            '연구원·슈퍼바이저 중에 같은 이름이 이미 있습니다. 동명이인을 피해 다른 이름을 입력해 주세요.'
          );
          return;
        }
      }
      const passHash = await hashPassword(pw);
      const acc = {
        id: uid(),
        loginId,
        passHash,
        name: normalizeStaffDisplayName(name) || name,
        role,
      };
      if (role === 'interviewer' && team) acc.team = team;
      state.accounts.push(acc);
      saveState();
      close();
      showToast('계정을 추가했습니다.');
      render();
    });
  }

  function downloadAccountTemplate() {
    if (typeof XLSX === 'undefined') {
      alert('엑셀 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인 후 새로고침 해 주세요.');
      return;
    }
    const ws = XLSX.utils.aoa_to_sheet([
      ['아이디', '비밀번호', '이름', '역할', '팀'],
      ['hong_lab', 'temp1234', '홍길동', '연구원', ''],
      ['kim_sup', 'temp1234', '김슈퍼', '슈퍼바이저', ''],
      ['lee_rs', 'temp5678', '이연구', '연구원', ''],
      ['park_iv', 'temp1234', '박면접', '면접원', '부산팀'],
      ['jung_iv', 'temp1234', '정면접', '면접원', '정량조사부 2팀'],
    ]);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '계정목록');
    XLSX.writeFile(wb, 'H-채팅_계정등록양식.xlsx');
  }

  function sheetToAccountRows(matrix) {
    let start = 0;
    if (matrix.length && matrix[0] && matrix[0].length) {
      const h = String(matrix[0][0] ?? '').trim();
      const hl = h.toLowerCase();
      if (h === '아이디' || hl === 'loginid' || hl === 'id' || hl === 'userid') start = 1;
    }
    const out = [];
    for (let i = start; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row) continue;
      const loginId = String(row[0] ?? '').trim();
      const password = row[1] != null ? String(row[1]) : '';
      const name = String(row[2] ?? '').trim();
      const roleCell = row[3];
      const teamCell = row.length > 4 ? row[4] : '';
      if (!loginId && !String(password).trim() && !name) continue;
      out.push({ sheetRow: i + 1, loginId, password, name, roleCell, teamCell });
    }
    return out;
  }

  async function importAccountsFromExcelFile(file) {
    if (typeof XLSX === 'undefined') {
      alert('엑셀 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인 후 새로고침 해 주세요.');
      return;
    }
    if (!canManageAccounts()) return;
    let wb;
    try {
      const buf = await file.arrayBuffer();
      wb = XLSX.read(buf, { type: 'array' });
    } catch (_) {
      alert('파일을 읽을 수 없습니다.');
      return;
    }
    const sn = wb.SheetNames[0];
    if (!sn) {
      alert('시트가 비어 있습니다.');
      return;
    }
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    const parsed = sheetToAccountRows(matrix);
    const errors = [];
    let ok = 0;
    const pending = [];
    const seen = new Set();
    const staffNamesInBatch = new Set();

    for (const row of parsed) {
      const { sheetRow, loginId, password, name, roleCell, teamCell } = row;
      if (!loginId) {
        errors.push(`${sheetRow}행: 아이디 없음`);
        continue;
      }
      const pwTrim = String(password).trim();
      if (!pwTrim) {
        errors.push(`${sheetRow}행 (${loginId}): 비밀번호 없음`);
        continue;
      }
      if (pwTrim.length < 4) {
        errors.push(`${sheetRow}행 (${loginId}): 비밀번호 4자 이상 필요`);
        continue;
      }
      if (!name) {
        errors.push(`${sheetRow}행 (${loginId}): 이름 없음`);
        continue;
      }
      const roleNorm = normalizeAccountRole(roleCell);
      if (!roleNorm) {
        errors.push(
          `${sheetRow}행 (${loginId}): 역할은 연구원·슈퍼바이저·면접원(또는 researcher/supervisor/interviewer)`
        );
        continue;
      }
      let team = null;
      if (roleNorm === 'interviewer') {
        team = normalizeInterviewerTeam(teamCell);
        if (!team) {
          errors.push(
            `${sheetRow}행 (${loginId}): 면접원은 5열「팀」에 부산팀·대구팀·대전팀·광주팀·정량조사부 1팀·정량조사부 2팀(또는 부산/대구/quant1 등) 입력`
          );
          continue;
        }
      }
      if (state.accounts.some((a) => a.loginId === loginId)) {
        errors.push(`${sheetRow}행: 아이디 중복(기등록): ${loginId}`);
        continue;
      }
      if (seen.has(loginId)) {
        errors.push(`${sheetRow}행: 파일 내 아이디 중복: ${loginId}`);
        continue;
      }
      if (isStaffAccountRole(roleNorm)) {
        const nn = normalizeStaffDisplayName(name);
        if (staffDisplayNameTakenByExisting(nn, null)) {
          errors.push(
            `${sheetRow}행 (${loginId}): 연구원·슈퍼바이저 이름 중복(이미 등록된 이름): ${name}`
          );
          continue;
        }
        if (staffNamesInBatch.has(nn)) {
          errors.push(`${sheetRow}행 (${loginId}): 파일 내 연구원·슈퍼바이저 동명이인: ${name}`);
          continue;
        }
        staffNamesInBatch.add(nn);
      }
      seen.add(loginId);
      pending.push({
        loginId,
        password: pwTrim,
        name: normalizeStaffDisplayName(name) || name,
        role: roleNorm,
        team,
      });
    }

    for (const p of pending) {
      const passHash = await hashPassword(p.password);
      const row = {
        id: uid(),
        loginId: p.loginId,
        passHash,
        name: p.name,
        role: p.role,
      };
      if (p.role === 'interviewer' && p.team) row.team = p.team;
      state.accounts.push(row);
      ok += 1;
    }
    saveState();
    let msg = `등록 완료: ${ok}명`;
    if (errors.length) msg += `\n\n건너뜀·오류 ${errors.length}건:\n` + errors.slice(0, 18).join('\n');
    if (errors.length > 18) msg += `\n… 외 ${errors.length - 18}건`;
    alert(msg);
    showToast(ok ? `${ok}명 계정을 추가했습니다.` : '추가된 계정 없음');
    render();
  }

  function openChangePasswordModal(accountId) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box">
        <div class="modal-head">비밀번호 변경</div>
        <div class="modal-body">
          <div class="field">
            <label for="acc-new-pw">새 비밀번호</label>
            <input type="password" id="acc-new-pw" autocomplete="new-password" />
          </div>
          <div class="field">
            <label for="acc-new-pw2">새 비밀번호 확인</label>
            <input type="password" id="acc-new-pw2" autocomplete="new-password" />
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="acc-pw-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="acc-pw-save">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      view.modal = null;
    };
    overlay.querySelector('#acc-pw-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#acc-pw-save').addEventListener('click', async () => {
      const p1 = overlay.querySelector('#acc-new-pw').value || '';
      const p2 = overlay.querySelector('#acc-new-pw2').value || '';
      if (!p1 || p1.length < 4) {
        alert('비밀번호는 4자 이상으로 설정해 주세요.');
        return;
      }
      if (p1 !== p2) {
        alert('새 비밀번호가 일치하지 않습니다.');
        return;
      }
      const acc = state.accounts.find((a) => a.id === accountId);
      if (!acc) {
        close();
        return;
      }
      acc.passHash = await hashPassword(p1);
      saveState();
      close();
      showToast('비밀번호를 변경했습니다.');
      render();
    });
  }

  function openChangeTeamModal(accountId) {
    const acc = state.accounts.find((a) => a.id === accountId);
    if (!acc || acc.role !== 'interviewer') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    const cur = acc.team && TEAMS[acc.team] ? acc.team : '';
    overlay.innerHTML = `
      <div class="modal centered-box">
        <div class="modal-head">면접원 소속 팀</div>
        <div class="modal-body">
          <div class="field">
            <label for="acc-edit-team">팀</label>
            <select id="acc-edit-team">
              <option value="">선택하세요</option>
              ${TEAM_ORDER.map(
                (k) => `<option value="${k}"${cur === k ? ' selected' : ''}>${TEAMS[k]}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="team-edit-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="team-edit-save">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      view.modal = null;
    };
    overlay.querySelector('#team-edit-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#team-edit-save').addEventListener('click', () => {
      const v = overlay.querySelector('#acc-edit-team').value;
      if (!v || !TEAMS[v]) {
        alert('팀을 선택해 주세요.');
        return;
      }
      acc.team = v;
      if (state.me && state.me.id === acc.id) state.me.team = v;
      saveState();
      close();
      showToast('팀을 저장했습니다.');
      render();
    });
  }

  function deleteAccountConfirm(accountId) {
    const acc = state.accounts.find((a) => a.id === accountId);
    if (!acc) return;
    if (state.me && acc.id === state.me.id) {
      alert('현재 로그인한 본인 계정은 여기서 삭제할 수 없습니다. 나가기 후 필요 시 데이터를 초기화하세요.');
      return;
    }
    const supCount = state.accounts.filter((a) => a.role === 'supervisor').length;
    if (acc.role === 'supervisor' && supCount <= 1) {
      alert('마지막 슈퍼바이저 계정은 삭제할 수 없습니다.');
      return;
    }
    if (!confirm(`${acc.loginId} (${acc.name}) 계정을 삭제할까요?`)) return;
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
    if (state.staffPresenceByUser && state.staffPresenceByUser[accountId]) delete state.staffPresenceByUser[accountId];
    saveState();
    showToast('계정을 삭제했습니다.');
    render();
  }

  async function migrateAndSeed() {
    if (state._legacyDirectory && state._legacyDirectory.length) {
      const tmp = await hashPassword('changeme');
      state.accounts = [];
      for (const u of state._legacyDirectory) {
        const raw = String(u.name || 'user').replace(/\s/g, '').toLowerCase();
        const base = raw.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'user';
        let loginId = base + '_' + String(u.id).replace(/[^a-z0-9]/gi, '').slice(-4);
        let n = 0;
        while (state.accounts.some((a) => a.loginId === loginId)) {
          n += 1;
          loginId = base + '_' + n;
        }
        state.accounts.push({
          id: u.id,
          loginId,
          passHash: tmp,
          name: u.name,
          role: u.role,
        });
      }
      delete state._legacyDirectory;
      state.me = null;
      saveState();
      showToast('기존 데이터를 계정으로 옮겼습니다. 임시 비밀번호: changeme');
    }
    delete state._migrateV1;

    /* 서버가 빈 accounts(손상 복구·빈 파일 등)를 보냈을 때 realtimeSyncedFromServer 가 이미 true 면
       예전 조건 때문에 시드를 건너뛰어 로그인 가능한 계정이 전무해질 수 있음 */
    if (!state.accounts.length) {
      const rows = [
        { id: 'demo-admin', loginId: 'admin', password: 'hrc7766', name: '관리자', role: 'supervisor' },
        { id: 'demo-r1', loginId: 'researcher1', password: 'demo1234', name: '김연구', role: 'researcher' },
        { id: 'demo-r2', loginId: 'researcher2', password: 'demo1234', name: '이실험', role: 'researcher' },
        { id: 'demo-s1', loginId: 'supervisor1', password: 'demo1234', name: '박슈퍼', role: 'supervisor' },
        { id: 'demo-i1', loginId: 'interviewer1', password: 'demo1234', name: '최면접', role: 'interviewer', team: 'busan' },
        { id: 'demo-i2', loginId: 'interviewer2', password: 'demo1234', name: '정리서치', role: 'interviewer', team: 'quant2' },
      ];
      state.accounts = [];
      for (const r of rows) {
        const acc = {
          id: r.id,
          loginId: r.loginId,
          passHash: await hashPassword(r.password),
          name: r.name,
          role: r.role,
        };
        if (r.team) acc.team = r.team;
        state.accounts.push(acc);
      }
      saveState();
    }
  }

  function bindModal() {}

  function sortRoomMemberIds(ids) {
    return [...ids].sort((a, b) => {
      if (a === state.me.id) return -1;
      if (b === state.me.id) return 1;
      const ua = userById(a);
      const ub = userById(b);
      return String(ua?.name || '').localeCompare(String(ub?.name || ''), 'ko');
    });
  }

  function chatSideMemberRowHtml(mid, room) {
    const u = userById(mid);
    const isYou = mid === state.me.id;
    const initial = u ? u.name.charAt(0) : '?';
    const nm = u ? u.name : '알 수 없음';
    let meta = '';
    if (u) {
      const tl = u.role === 'interviewer' && teamLabel(u.team) ? ' · ' + escapeHtml(teamLabel(u.team)) : '';
      const hideOthersLogin =
        state.me && state.me.role === 'interviewer' && !isYou;
      const isStaff = u.role === 'researcher' || u.role === 'supervisor';
      const idPart =
        isStaff || hideOthersLogin ? '' : ' · ' + escapeHtml('@' + (u.loginId || ''));
      meta = `${escapeHtml(ROLES[u.role].label)}${tl}${idPart}`;
    }
    const showKick =
      room &&
      room.type === 'group' &&
      canKickInterviewersFromRoom() &&
      u &&
      u.role === 'interviewer' &&
      !isYou;
    const kickBtn = showKick
      ? `<button type="button" class="btn-kick-iv" data-kick="${mid}">${'\uB0B4\uBCF4\uB0B4\uAE30'}</button>`
      : '';
    return `
        <div class="chat-side-member">
          <div class="avatar sm">${escapeHtml(initial)}</div>
          <div class="chat-side-member-txt">
            <div class="chat-side-member-name">${escapeHtml(nm)}${
      isYou ? ' <span class="you-tag">(나)</span>' : ''
    }</div>
            ${meta ? `<div class="chat-side-member-meta">${meta}</div>` : ''}
          </div>
          ${kickBtn ? `<div class="chat-side-member-actions">${kickBtn}</div>` : ''}
        </div>`;
  }

  function chatSideMembersGroupedHTML(room) {
    const ids = room.memberIds;
    const researchers = sortRoomMemberIds(ids.filter((id) => userById(id)?.role === 'researcher'));
    const supervisors = sortRoomMemberIds(ids.filter((id) => userById(id)?.role === 'supervisor'));
    const interviewers = ids.filter((id) => userById(id)?.role === 'interviewer');
    const byTeam = {};
    const unassigned = [];
    for (const id of interviewers) {
      const u = userById(id);
      const tk = u && u.team && TEAMS[u.team] ? u.team : null;
      if (!tk) unassigned.push(id);
      else {
        if (!byTeam[tk]) byTeam[tk] = [];
        byTeam[tk].push(id);
      }
    }
    const unknown = sortRoomMemberIds(ids.filter((id) => !userById(id)));

    let html = '';
    function section(title, idList) {
      if (!idList.length) return;
      html += `<div class="chat-side-group-title">${escapeHtml(title)}</div>`;
      html += idList.map((mid) => chatSideMemberRowHtml(mid, room)).join('');
    }

    section('연구원', researchers);
    section('슈퍼바이저', supervisors);
    for (const tid of TEAM_ORDER) {
      section(TEAMS[tid], sortRoomMemberIds(byTeam[tid] || []));
    }
    section('팀 미지정', sortRoomMemberIds(unassigned));
    section('알 수 없음', unknown);
    return html;
  }

  function openInviteToGroupModal(roomId) {
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room || room.type !== 'group') return;
    const candidates = state.accounts.filter(
      (a) => a.id !== state.me.id && !room.memberIds.includes(a.id)
    );
    if (!candidates.length) {
      showToast('초대할 다른 멤버가 없습니다.');
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:88vh">
        <div class="modal-head">멤버 초대</div>
        <div class="modal-body">
          <div class="field">
            <label for="invite-search">이름·아이디 검색</label>
            <input type="search" id="invite-search" placeholder="검색…" autocomplete="off" />
          </div>
          <p class="caption">초대할 사람을 선택하세요. (이미 방에 있는 사람은 목록에 없습니다.)</p>
          <div class="newchat-member-scroll" style="max-height:220px">
            <div class="check-list" id="invite-check-list">
              ${candidates
                .map(
                  (u) => `
                <label class="invite-mem-label" data-invite-id="${u.id}">
                  <input type="checkbox" value="${u.id}" />
                  <span class="check-list-txt">${escapeHtml(u.name)} · ${ROLES[u.role].label}${
                    u.role === 'interviewer' && teamLabel(u.team) ? ' · ' + escapeHtml(teamLabel(u.team)) : ''
                  }${publicLoginIdListSuffixEscaped(u)}</span>
                </label>
              `
                )
                .join('')}
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="invite-cancel">취소</button>
          <button type="button" class="btn btn-primary" id="invite-confirm">초대</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const searchIn = overlay.querySelector('#invite-search');
    function applyInviteFilter() {
      const q = searchIn.value || '';
      overlay.querySelectorAll('.invite-mem-label').forEach((lab) => {
        const id = lab.getAttribute('data-invite-id');
        const u = candidates.find((x) => x.id === id);
        const show = !u || accountMatchesSearch(u, q);
        lab.classList.toggle('hidden', !show);
      });
    }
    searchIn.addEventListener('input', applyInviteFilter);
    searchIn.addEventListener('search', applyInviteFilter);
    const close = () => {
      overlay.remove();
    };
    overlay.querySelector('#invite-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#invite-confirm').addEventListener('click', () => {
      const ids = Array.from(overlay.querySelectorAll('#invite-check-list input:checked')).map((i) => i.value);
      if (!ids.length) {
        alert('초대할 사람을 한 명 이상 선택해 주세요.');
        return;
      }
      const r = state.rooms.find((x) => x.id === roomId);
      if (!r) {
        close();
        return;
      }
      for (const id of ids) {
        if (!r.memberIds.includes(id)) r.memberIds.push(id);
      }
      r.updatedAt = Date.now();
      saveState();
      close();
      showToast(`${ids.length}명을 초대했습니다.`);
      render();
    });
  }

  /** 채팅 말풍선 HTML — shared:state 시 목록만 갈아끼울 때도 동일 규칙 사용 */
  function chatBubbleRowsHtml(roomId) {
    const msgs = state.messages[roomId] || [];
    if (!state.me) return '';
    return msgs
      .map((m) => {
        if (m.isAbsenceAutoReply) {
          return `
          <div class="bubble-row bubble-row--auto-absence">
            <div class="bubble bubble--auto-absence">${escapeHtml(m.text).replace(/\n/g, '<br/>')}</div>
            <div class="msg-time">${formatTime(m.ts)}</div>
          </div>
        `;
        }
        const isMe = m.senderId === state.me.id;
        const sender = userById(m.senderId);
        const name = sender ? sender.name : '알 수 없음';
        const senderTeam =
          sender && sender.role === 'interviewer' && teamLabel(sender.team)
            ? ` <span class="sender-team">(${escapeHtml(teamLabel(sender.team))})</span>`
            : '';
        const imgHtml =
          m.image && String(m.image).startsWith('data:image/')
            ? `<img class="chat-img" src="${escapeDataUrlForAttr(m.image)}" alt="" title="사진을 누르면 기기에 저장됩니다" />`
            : '';
        const videoHtml =
          m.video && String(m.video).startsWith('data:video/')
            ? `<video class="chat-video" controls playsinline preload="metadata" src="${escapeDataUrlForAttr(m.video)}"></video>`
            : '';
        const mediaHtml = imgHtml + videoHtml;
        const annClass = m.isAnnouncement || m.isRoomNotice ? ' announce' : '';
        return `
          <div class="bubble-row ${isMe ? 'me' : 'them'}">
            ${!isMe ? `<div class="bubble-sender">${escapeHtml(name)}${senderTeam}</div>` : ''}
            <div class="bubble${annClass}">${escapeHtml(m.text).replace(/\n/g, '<br/>')}${mediaHtml}</div>
            <div class="msg-time">${formatTime(m.ts)}</div>
          </div>
        `;
      })
      .join('');
  }

  function flushChatInboxFromState() {
    if (view.screen !== 'chat' || !view.roomId || !state.me) return;
    const room = state.rooms.find((r) => r.id === view.roomId);
    const list = document.getElementById('msg-list');
    if (!room || !list) return;
    list.innerHTML = chatBubbleRowsHtml(room.id);
    list.scrollTop = list.scrollHeight;
  }

  /** 실시간 동기화 시 채팅 textarea 를 건드리지 않고 말풍선만 갱신 (한글 IME·전송 직후 목록 유실 방지) */
  function tryPatchChatInboxOnlyAfterSharedState() {
    if (view.screen !== 'chat' || !view.roomId || !state.me) return false;
    const room = state.rooms.find((r) => r.id === view.roomId);
    if (!room) return false;
    const list = document.getElementById('msg-list');
    if (!list) return false;
    const ta = document.getElementById('msg-input');
    if (ta && chatImeComposing) {
      chatInboxPatchPending = true;
      return true;
    }
    flushChatInboxFromState();
    chatInboxPatchPending = false;
    return true;
  }

  function chatHTML() {
    const room = state.rooms.find((r) => r.id === view.roomId);
    if (!room) {
      view.screen = 'main';
      return mainHTML();
    }
    normalizeRoomModeration(room);
    const titleHtml = roomDisplayTitleHtml(room);
    const staffPresenceChat = staffPresenceControlHtml('chat');
    const dmStaffPresenceInTitle = dmOtherStaffPresenceDotHtml(room);
    const ivBlocked = interviewerChatSendBlocked(room);
    const showMod = canPostRoomModeration();

    const bubbles = chatBubbleRowsHtml(room.id);

    const annStrip =
      state.me.role === 'supervisor' && !room.isAnnounceFeed
        ? `<div class="ann-bar"><span>이 방은 일반 채팅입니다. 헤더의「공지」는 전체 공지용입니다.</span></div>`
        : room.isAnnounceFeed
          ? `<div class="ann-bar"><span>전체 공지 피드 (슈퍼바이저가 보낸 공지가 쌓입니다)</span></div>`
          : '';

    const nt = (room.roomNoticeTitle || '').trim();
    const nb = (room.roomNoticeBody || '').trim();
    const roomNoticeBanner =
      nt || nb
        ? `<div class="room-notice-banner">
            <div class="room-notice-label">방 공지</div>
            ${nt ? `<div class="room-notice-title">${escapeHtml(nt)}</div>` : ''}
            ${nb ? `<div class="room-notice-body">${escapeHtml(nb).replace(/\n/g, '<br/>')}</div>` : ''}
          </div>`
        : '';

    const ivToggleBtn =
      showMod && room.type === 'group'
        ? `<button type="button" class="btn-chat-mod${room.interviewerChatAllowed ? ' btn-chat-mod--on' : ''}" id="btn-toggle-iv-chat">${
            room.interviewerChatAllowed ? '면접원 채팅 막기' : '면접원 채팅 허용'
          }</button>`
        : '';

    const projNumBtn =
      showMod && room.type === 'group'
        ? `<button type="button" class="btn-chat-mod" id="btn-room-project-number">프로젝트 번호</button>`
        : '';
    const modRow = showMod
      ? `<div class="chat-mod-row">
          <button type="button" class="btn-chat-mod" id="btn-room-notice">방 공지</button>
          ${projNumBtn}
          ${ivToggleBtn}
        </div>`
      : '';

    const lockHint = ivBlocked
      ? room.isAnnounceFeed
        ? `<div class="chat-lock-hint" role="status">면접원은 <strong>전체 공지 피드</strong> 방에 글을 쓸 수 없습니다. 일반 채팅방을 이용하거나 연구원·슈퍼바이저 계정으로 로그인해 주세요.</div>`
        : `<div class="chat-lock-hint" role="status">면접원은 이 단체방에서 연구원·슈퍼바이저가 <strong>「면접원 채팅 허용」</strong>을 켠 뒤에만 입력할 수 있습니다. (지금 화면은 키보드 입력란이 없는 <strong>안내 버튼</strong>만 보일 수 있습니다.)</div>`
      : '';
    const inputBarClass = ivBlocked ? 'input-bar input-bar--locked' : 'input-bar';
    /* iOS: disabled textarea는 포커스·키보드가 안 뜨는 경우가 많아, 막힌 경우에는 안내 버튼만 둠 */
    const msgField = ivBlocked
      ? `<button type="button" class="msg-input-placeholder" id="msg-input-blocked-hint" aria-label="면접원 채팅 안내">면접원 채팅이 아직 허용되지 않았습니다. 탭하여 안내를 확인하세요.</button>`
      : `<textarea id="msg-input" rows="1" placeholder="메시지 입력…" aria-label="메시지 입력" autocomplete="off" inputmode="text" enterkeyhint="send"></textarea>`;
    const inputBar = `
        <div class="chat-composer-fixed" role="region" aria-label="메시지 입력">
        ${lockHint}
        <div class="${inputBarClass}">
          <label class="attach" title="사진·동영상">
            <span>📎</span>
            <input type="file" id="file-media" accept="image/*,video/*" aria-label="사진·동영상 첨부"${ivBlocked ? ' disabled' : ''} />
          </label>
          ${msgField}
          <button type="button" class="send" id="btn-send"${ivBlocked ? ' disabled' : ''}>전송</button>
        </div>
        </div>`;

    const chatHeaderInner =
      room.type === 'group'
        ? `
          <div class="chat-header-main">
            <button type="button" class="back" id="chat-back" aria-label="뒤로">‹</button>
            ${staffPresenceChat}
            <div class="chat-title">${titleHtml}</div>
            <div class="chat-header-trailing">
              ${themeToggleButtonHtml('btn-theme--compact')}
              <button type="button" class="chat-header-video" id="btn-video-call" title="화상 회의">화상</button>
              <button type="button" class="chat-header-members" id="chat-members-btn" title="참가자">참가자</button>
              <button type="button" class="chat-header-leave" id="chat-leave-btn">나가기</button>
            </div>
          </div>
          ${modRow}`
        : `
          <div class="chat-header-main">
            <button type="button" class="back" id="chat-back" aria-label="뒤로">‹</button>
            ${staffPresenceChat}
            <div class="chat-title">${titleHtml}${dmStaffPresenceInTitle}</div>
            <div class="chat-header-trailing">
              ${themeToggleButtonHtml('btn-theme--compact')}
              <button type="button" class="chat-header-video" id="btn-video-call" title="화상 회의">화상</button>
              <button type="button" class="chat-header-leave" id="chat-leave-btn">나가기</button>
            </div>
          </div>
          ${modRow}`;

    /* 1:1도 단체방과 동일 flex 컬럼(chat-main-col) — 이전엔 .screen 직계만 있어 모바일에서 입력줄 레이어가 어긋나는 경우가 있었음 */
    if (room.type !== 'group') {
      return `
      <div class="screen chat-screen-wrap">
        <div id="chat-layout" class="chat-layout chat-layout--dm">
          <div class="chat-main-col">
            <header class="chat-header chat-header--stack">
              ${chatHeaderInner}
            </header>
            ${roomNoticeBanner}
            ${annStrip}
            <div class="messages" id="msg-list">${bubbles}</div>
            ${inputBar}
          </div>
        </div>
      </div>
    `;
    }

    const sideMembersHtml = chatSideMembersGroupedHTML(room);

    const panelOpen = view.chatSideOpen ? ' chat-layout--panel-open' : '';

    return `
      <div class="screen chat-screen-wrap">
        <div id="chat-layout" class="chat-layout${panelOpen}">
          <button type="button" class="chat-side-backdrop" id="chat-side-backdrop" aria-label="패널 닫기"></button>
          <div class="chat-main-col">
            <header class="chat-header chat-header--stack">
              ${chatHeaderInner}
            </header>
            ${roomNoticeBanner}
            ${annStrip}
            <div class="messages" id="msg-list">${bubbles}</div>
            ${inputBar}
          </div>
          <aside class="chat-side-panel" aria-label="대화 참가자">
            <div class="chat-side-head">
              <span>참가자 <strong>${room.memberIds.length}</strong>명</span>
              <button type="button" class="chat-side-close" id="chat-side-close" aria-label="닫기">✕</button>
            </div>
            <div class="chat-side-list">${sideMembersHtml}</div>
            <div class="chat-side-foot">
              <button type="button" class="btn btn-primary" id="chat-invite-btn">멤버 초대</button>
              <button type="button" class="btn btn-secondary chat-side-leave" id="chat-leave-from-panel">채팅방 나가기</button>
            </div>
          </aside>
        </div>
      </div>
    `;
  }

  function bindChat() {
    chatImeComposing = false;
    chatInboxPatchPending = false;
    if (state.me && view.roomId) markRoomAsRead(state.me.id, view.roomId);

    const list = document.getElementById('msg-list');
    if (list) list.scrollTop = list.scrollHeight;

    list?.addEventListener('click', (ev) => {
      const img = ev.target.closest('img.chat-img');
      if (!img) return;
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('data:image/')) return;
      ev.preventDefault();
      const room = state.rooms.find((r) => r.id === view.roomId);
      const roomBit = room ? roomDisplayTitlePlain(room) : '채팅';
      downloadImageDataUrlAsFile(src, `채팅-${roomBit}-${Date.now()}`);
    });

    document.getElementById('chat-back')?.addEventListener('click', () => {
      document.getElementById('video-call-overlay')?.remove();
      view.chatSideOpen = false;
      view.screen = 'main';
      render();
    });

    document.getElementById('btn-staff-presence-chat')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cycleStaffPresence();
    });

    document.getElementById('btn-video-call')?.addEventListener('click', () => {
      openVideoCallOverlay(view.roomId);
    });

    document.getElementById('btn-room-notice')?.addEventListener('click', () => {
      openRoomNoticeModal(view.roomId);
    });
    document.getElementById('btn-room-project-number')?.addEventListener('click', () => {
      openRoomProjectNumberModal(view.roomId);
    });
    document.getElementById('btn-toggle-iv-chat')?.addEventListener('click', () => {
      const r = state.rooms.find((x) => x.id === view.roomId);
      if (!r || r.type !== 'group' || !canPostRoomModeration()) return;
      normalizeRoomModeration(r);
      r.interviewerChatAllowed = !r.interviewerChatAllowed;
      r.updatedAt = Date.now();
      saveState();
      showToast(r.interviewerChatAllowed ? '이 단체방에서 면접원 채팅을 허용했습니다.' : '이 단체방에서 면접원 채팅을 막았습니다.');
      render();
    });

    const layout = document.getElementById('chat-layout');
    if (layout) {
      const syncPanelClass = () => {
        layout.classList.toggle('chat-layout--panel-open', !!view.chatSideOpen);
      };
      document.getElementById('chat-members-btn')?.addEventListener('click', () => {
        view.chatSideOpen = !view.chatSideOpen;
        syncPanelClass();
      });
      document.getElementById('chat-side-close')?.addEventListener('click', () => {
        view.chatSideOpen = false;
        syncPanelClass();
      });
      document.getElementById('chat-side-backdrop')?.addEventListener('click', () => {
        view.chatSideOpen = false;
        syncPanelClass();
      });
      document.getElementById('chat-invite-btn')?.addEventListener('click', () => {
        openInviteToGroupModal(view.roomId);
      });
      document.getElementById('chat-leave-from-panel')?.addEventListener('click', () => {
        if (!confirm('이 단체 채팅방에서 나가시겠습니까?')) return;
        document.getElementById('video-call-overlay')?.remove();
        view.chatSideOpen = false;
        leaveChatRoom(view.roomId);
        view.screen = 'main';
        showToast('채팅방에서 나갔습니다.');
        render();
      });
      document.querySelectorAll('.btn-kick-iv').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const tid = btn.getAttribute('data-kick');
          const u = userById(tid);
          const nm = u ? u.name : tid;
          if (!confirm(`${nm} 면접원을 이 방에서 내보낼까요?`)) return;
          if (kickInterviewerFromRoom(view.roomId, tid)) {
            render();
          }
        });
      });
    }

    document.getElementById('chat-leave-btn')?.addEventListener('click', () => {
      const r = state.rooms.find((x) => x.id === view.roomId);
      const isGrp = r && r.type === 'group';
      const msg = isGrp ? '이 단체 채팅방에서 나가시겠습니까?' : '이 1:1 대화에서 나가시겠습니까?';
      if (!confirm(msg)) return;
      document.getElementById('video-call-overlay')?.remove();
      view.chatSideOpen = false;
      leaveChatRoom(view.roomId);
      view.screen = 'main';
      showToast('채팅방에서 나갔습니다.');
      render();
    });

    document.getElementById('msg-input-blocked-hint')?.addEventListener('click', () => {
      showToast('단체방에서 면접원 채팅이 아직 허용되지 않았습니다. 연구원·슈퍼바이저에게「면접원 채팅 허용」을 요청하세요.');
    });

    let pendingAttachment = null;
    const fileInput = document.getElementById('file-media');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const r0 = state.rooms.find((x) => x.id === view.roomId);
        if (r0 && interviewerChatSendBlocked(r0)) return;
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        const isImg = fileLooksImage(f);
        const isVid = fileLooksVideo(f);
        if (!isImg && !isVid) {
          showToast('사진 또는 동영상만 첨부할 수 있습니다.');
          return;
        }
        let kind = null;
        if (isVid && isImg) kind = (f.type || '').startsWith('video/') ? 'video' : 'image';
        else if (isVid) kind = 'video';
        else kind = 'image';

        if (kind === 'video') {
          if (f.size > MAX_CHAT_MEDIA_BYTES) {
            showToast('동영상 용량이 너무 큽니다(약 36MB 이하). 더 짧게 녹화하거나 편집해 주세요.');
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => showToast('파일을 읽지 못했습니다. 다시 시도해 주세요.');
          reader.onload = () => {
            pendingAttachment = { kind: 'video', dataUrl: reader.result };
            showToast('동영상이 첨부되었습니다. 전송을 누르세요.');
          };
          reader.readAsDataURL(f);
          return;
        }

        if (f.size > MAX_CHAT_IMAGE_SOURCE_BYTES) {
          showToast('사진 원본이 너무 큽니다(약 80MB 이하를 선택해 주세요).');
          return;
        }

        compressImageFileToDataUrl(f).then((dataUrl) => {
          if (dataUrl) {
            pendingAttachment = { kind: 'image', dataUrl };
            showToast('사진이 첨부되었습니다. 전송을 누르세요.');
            return;
          }
          if (f.size > MAX_CHAT_MEDIA_BYTES) {
            showToast(
              '이 사진은 이 기기에서 자동 압축이 되지 않았고 원본도 커서 보낼 수 없습니다. 스크린샷을 JPEG로 저장하거나 다른 사진을 선택해 주세요.'
            );
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => showToast('파일을 읽지 못했습니다. 다시 시도해 주세요.');
          reader.onload = () => {
            pendingAttachment = { kind: 'image', dataUrl: reader.result };
            showToast('사진이 첨부되었습니다. 전송을 누르세요.');
          };
          reader.readAsDataURL(f);
        });
      });
    }

    function send() {
      const ta = document.getElementById('msg-input');
      if (!ta) return;
      const text = (ta.value || '').trim();
      if (!text && !pendingAttachment) return;
      const room = state.rooms.find((r) => r.id === view.roomId);
      if (!room) return;
      normalizeRoomModeration(room);
      if (interviewerChatSendBlocked(room)) {
        showToast('단체방에서 면접원 채팅이 아직 허용되지 않았습니다.');
        return;
      }

      const cap =
        pendingAttachment && pendingAttachment.kind === 'video' ? '(동영상)' : pendingAttachment ? '(사진)' : '';
      const msg = {
        id: uid(),
        senderId: state.me.id,
        text: text || cap,
        image: pendingAttachment && pendingAttachment.kind === 'image' ? pendingAttachment.dataUrl : null,
        video: pendingAttachment && pendingAttachment.kind === 'video' ? pendingAttachment.dataUrl : null,
        ts: Date.now(),
        isAnnouncement: false,
      };
      if (!state.messages[room.id]) state.messages[room.id] = [];
      state.messages[room.id].push(msg);
      if (state.me.role === 'interviewer' && roomHasStaffAwayOrVacation(room)) {
        state.messages[room.id].push({
          id: uid(),
          senderId: state.me.id,
          text: AUTO_ABSENCE_REPLY_TEXT,
          image: null,
          video: null,
          ts: Date.now(),
          isAnnouncement: false,
          isAbsenceAutoReply: true,
        });
      }
      room.updatedAt = Date.now();
      room.lastPreview = pendingAttachment
        ? pendingAttachment.kind === 'video'
          ? '🎬 동영상'
          : '📷 사진'
        : text.slice(0, 40);
      saveState();
      pendingAttachment = null;
      ta.value = '';
      render();
    }

    const msgInput = document.getElementById('msg-input');
    if (msgInput) {
      document.getElementById('btn-send')?.addEventListener('click', send);
      msgInput.addEventListener(
        'focusin',
        () => {
          requestAnimationFrame(() => {
            try {
              msgInput.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            } catch (_) {}
          });
        },
        { passive: true }
      );
      msgInput.addEventListener('compositionstart', () => {
        chatImeComposing = true;
      });
      msgInput.addEventListener('compositionend', () => {
        chatImeComposing = false;
        if (chatInboxPatchPending) {
          chatInboxPatchPending = false;
          try {
            flushChatInboxFromState();
          } catch (_) {}
        }
      });
      msgInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        send();
      });
    }

    bindThemeToggle();
  }

  async function init() {
    el.root = document.getElementById('app');
    applyTheme(getTheme());
    await initRealtimeConnection();
    await refreshLanAccessHint();
    await migrateAndSeed();
    registerSw();
    render();

    /** 지원용: 개발자도구 콘솔에서 `__companyChatHealth()` 실행 후 결과를 복사해 보내 주세요. */
    window.__companyChatHealth = () => ({
      v: 2,
      page: location.href.split('?')[0],
      origin: location.origin,
      hasAppRoot: !!document.getElementById('app'),
      accountCount: state.accounts ? state.accounts.length : 0,
      loggedIn: !!state.me,
      viewScreen: view.screen,
      socketConnected: !!(realtimeSocket && realtimeSocket.connected),
      socketTried: lastSocketConnectBase || '',
      socketError: realtimeConnectError || '',
      ioScript: typeof io !== 'undefined',
      localStorageOk: (() => {
        try {
          const k = '__cc_ls_probe';
          localStorage.setItem(k, '1');
          localStorage.removeItem(k);
          return true;
        } catch (e) {
          return String(e && e.message);
        }
      })(),
      /* 채팅 화면일 때 입력 가능 여부 빠른 판별 */
      chatHasRealTextarea: !!document.getElementById('msg-input'),
      chatInterviewerBlockedPlaceholder: !!document.getElementById('msg-input-blocked-hint'),
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
  else void init();
})();
