(function () {
  'use strict';

  const STORAGE_V2 = 'company-chat-draft-v2';
  const STORAGE_V1 = 'company-chat-draft-v1';

  const ROLES = {
    researcher: { label: '연구원', className: 'researcher' },
    supervisor: { label: '슈퍼바이저', className: 'supervisor' },
    interviewer: { label: '면접원', className: 'interviewer' },
  };

  const TEAM_ORDER = ['seoul', 'busan', 'daegu', 'daejeon', 'gwangju'];
  const TEAMS = {
    busan: '부산팀',
    daejeon: '대전팀',
    daegu: '대구팀',
    gwangju: '광주팀',
    seoul: '서울팀',
  };

  /** 연구원·슈퍼바이저 업무 상태(면접원 미사용): 초록 업무·주황 자리비움·빨강 휴가 */
  const STAFF_PRESENCE_CYCLE = ['available', 'away', 'vacation'];
  const STAFF_PRESENCE_META = {
    available: { label: '업무 중' },
    away: { label: '자리비움' },
    vacation: { label: '휴가' },
  };

  function normalizeInterviewerTeam(value) {
    const raw = String(value ?? '').trim();
    const c = raw.replace(/\s/g, '');
    const t = c.toLowerCase();
    if (raw === '부산팀' || c === '부산' || t === 'busan' || t === 'busan team') return 'busan';
    if (raw === '대전팀' || c === '대전' || t === 'daejeon' || t === 'daejeonteam') return 'daejeon';
    if (raw === '대구팀' || c === '대구' || t === 'daegu' || t === 'daeguteam') return 'daegu';
    if (raw === '광주팀' || c === '광주' || t === 'gwangju' || t === 'gwangjuteam') return 'gwangju';
    if (raw === '서울팀' || c === '서울' || t === 'seoul' || t === 'seoulteam') return 'seoul';
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
    if (room.type === 'group' && typeof room.interviewerChatAllowed !== 'boolean') {
      room.interviewerChatAllowed = !room.isAnnounceFeed;
    }
    if (typeof room.roomNoticeTitle !== 'string') room.roomNoticeTitle = '';
    if (typeof room.roomNoticeBody !== 'string') room.roomNoticeBody = '';
  }

  /** 단체방만: 면접원은 연구원·슈퍼바이저가 허용하기 전까지 메시지·사진 전송 불가 */
  function interviewerChatSendBlocked(room) {
    if (!state.me || state.me.role !== 'interviewer' || !room || room.type !== 'group') return false;
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

  function loadState() {
    const { data, fromV1 } = loadStateRaw();
    if (!data) return { ...emptyState(), _migrateV1: false };

    const base = {
      me: data.me && data.me.loginId ? data.me : null,
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
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
  };

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

  function normalizeSocketBaseUrl(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    s = s.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }

  function getExplicitSocketBaseUrl() {
    try {
      const q =
        new URLSearchParams(window.location.search).get('socket') ||
        new URLSearchParams(window.location.search).get('chatSocket');
      if (q && q.trim()) return normalizeSocketBaseUrl(q.trim());
    } catch (_) {}
    try {
      const s = localStorage.getItem(LS_SOCKET_URL);
      if (s && s.trim()) return normalizeSocketBaseUrl(s.trim());
    } catch (_) {}
    const meta = document.querySelector('meta[name="company-chat-socket-url"]');
    const mc = meta && meta.getAttribute('content');
    if (mc && String(mc).trim()) return normalizeSocketBaseUrl(String(mc).trim());
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

  function buildInternetAccessBannerHtml() {
    if (!publicUrlFromServer) return '';
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return '';
    const u = `${publicUrlFromServer.replace(/\/+$/, '')}/`;
    const enc = encodeURIComponent(u);
    const vis = escapeHtml(u);
    return `<div class="lan-access-banner lan-access-banner--internet">
      <p class="lan-access-title">인터넷 공개 주소 (다른 Wi-Fi·LTE·전 세계)</p>
      <p class="lan-access-row"><code>${vis}</code> <button type="button" class="btn btn-ghost btn-lan-copy" data-copy-lan="${enc}">복사</button></p>
      <p class="hint"><strong>Render / Fly / Railway</strong>에 올리면 이 주소가 배포마다 유지되는 고정 호스트입니다. 직접 산 도메인을 썼다면 서버 환경변수 <code>PUBLIC_BASE_URL</code>에 넣은 주소가 여기 표시됩니다. 임시 터널(localtunnel)만 쓰는 경우에만 주소가 자주 바뀔 수 있습니다.</p>
    </div>`;
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
    return buildInternetAccessBannerHtml() + buildLanOnlyBannerHtml();
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
        <label>공개 접속 주소</label>
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
      rooms: state.rooms,
      messages: state.messages,
      feedbackThreads: state.feedbackThreads,
      pinnedChatsByUser: state.pinnedChatsByUser || {},
      lastReadByUser: state.lastReadByUser || {},
      chatNotifyMutedByUser: state.chatNotifyMutedByUser || {},
      chatNotifyMutedRoomsByUser: state.chatNotifyMutedRoomsByUser || {},
      staffPresenceByUser: state.staffPresenceByUser || {},
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
    state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
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
        applySharedPayload(payload);
        realtimeSyncedFromServer = true;
        realtimeConnectError = '';
        syncSessionMeWithAccounts();
        try {
          render();
        } catch (_) {
          /* render 아직 정의 전일 수 있음 — 무시 */
        }
        clearTimeout(t);
        done(true);
      });
      realtimeSocket.on('connect', () => {
        realtimeConnectError = '';
        try {
          render();
        } catch (_) {}
      });
      realtimeSocket.on('disconnect', () => {
        try {
          render();
        } catch (_) {}
      });
      realtimeSocket.on('connect_error', (err) => {
        const msg = err && err.message ? err.message : 'connect_error';
        realtimeConnectError = `${msg} (시도: ${lastSocketConnectBase})`;
        try {
          render();
        } catch (_) {}
      });
    });
  }

  function saveState() {
    try {
      const persist = {
        me: state.me,
        accounts: state.accounts,
        rooms: state.rooms,
        messages: state.messages,
        feedbackThreads: state.feedbackThreads,
        pinnedChatsByUser: state.pinnedChatsByUser || {},
        lastReadByUser: state.lastReadByUser || {},
        chatNotifyMutedByUser: state.chatNotifyMutedByUser || {},
        chatNotifyMutedRoomsByUser: state.chatNotifyMutedRoomsByUser || {},
        staffPresenceByUser: state.staffPresenceByUser || {},
      };
      localStorage.setItem(STORAGE_V2, JSON.stringify(persist));
      if (localStorage.getItem(STORAGE_V1)) localStorage.removeItem(STORAGE_V1);
      if (realtimeSocket && realtimeSocket.connected) {
        realtimeSocket.emit('shared:update', getSharedPayload());
      }
    } catch (_) {}
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
    navigator.serviceWorker.register('./sw.js').catch(() => {});
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
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 14px;border-radius:10px;font-size:12px;z-index:200;max-width:90%;text-align:center';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
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
    const p = prefix || '【회사 채팅 공지】';
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

  function render() {
    const root = el.root;
    if (!root) return;

    if (!state.me) view.screen = 'login';

    if (view.screen === 'login') {
      root.innerHTML = loginHTML();
      bindLogin();
      return;
    }

    if (state.me && !canManageAccounts() && view.tab === 'accounts') view.tab = 'chats';
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
  }

  function loginHTML() {
    const socketOk = !!(realtimeSocket && realtimeSocket.connected);
    const explicit = getExplicitSocketBaseUrl();
    const attempt = lastSocketConnectBase || resolveSocketBaseUrl() || `${window.location.protocol}//${window.location.host}`;
    const errBlock = realtimeConnectError
      ? `<p class="hint socket-setup-error" role="alert">${escapeHtml(realtimeConnectError)}</p>`
      : '';
    const socketPanel = !socketOk
      ? `<div class="socket-setup">
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
          <label>소켓 서버 주소 (선택·이 브라우저에 저장)</label>
          <input type="text" id="socket-url-input" placeholder="http://127.0.0.1:8787" value="${escapeHtml(
            explicit
          )}" autocomplete="off" />
        </div>
        <button type="button" class="btn btn-secondary" id="btn-socket-reconnect">주소 저장 후 다시 연결</button>
        <p class="hint socket-setup-attempt">현재 연결 시도: <code>${escapeHtml(attempt)}</code></p>
      </div>`
      : `<p class="hint socket-setup-ok">실시간 서버 연결됨 · 시도 주소 <code>${escapeHtml(attempt)}</code></p>`;

    const storageHint = socketOk
      ? '계정·채팅 내용은 연결된 서버와 동기화되며, 로그인 정보만 이 브라우저에 있습니다.'
      : '지금은 실시간에 실패한 상태입니다. 로그인·채팅은 이 브라우저 저장소를 쓰며, 서버와 합치지 못할 수 있습니다.';

    return `
      <div class="screen login-panel">
        <h1>회사 채팅</h1>
        <p class="sub">아이디·비밀번호로 로그인 (역할은 계정에 따름)</p>
        ${buildLanAccessBannerHtml()}
        ${buildPublicTunnelAdminHtml()}
        ${socketPanel}
        <div class="field">
          <label>아이디</label>
          <input type="text" id="login-id" placeholder="예: researcher1" autocomplete="username" />
        </div>
        <div class="field">
          <label>비밀번호</label>
          <input type="password" id="login-pw" placeholder="비밀번호" autocomplete="current-password" />
        </div>
        <button type="button" class="btn btn-primary" id="btn-login">로그인</button>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" id="btn-notify">알림 허용 요청</button>
        </div>
        <p class="hint">데모 계정: researcher1 / demo1234 · supervisor1 / demo1234 · interviewer1 / demo1234 등. <strong>등록·추가는 연구원·슈퍼바이저만</strong> 「계정」 탭에서 가능하며, 면접원 계정도 여기서 <strong>생성해 줄 수 있습니다</strong>. ${storageHint}</p>
        <p class="hint">공지를 <strong>카카오톡·문자처럼 상대 폰으로 자동</strong> 보내려면 알림톡/SMS 같은 유료 API와 서버가 필요합니다. 이 웹앱만으로는 상대 기기에 직접 가지 않으며, 공지 화면의 「공유하기」로 글을 복사하거나 휴대폰 공유 기능을 쓸 수 있습니다.</p>
      </div>
    `;
  }

  function bindLogin() {
    const btnSock = document.getElementById('btn-socket-reconnect');
    if (btnSock) {
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

    document.getElementById('btn-notify').addEventListener('click', requestNotifyPermission);
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
    const tabsClass = 'tabs tabs-compact';
    const tabAccountsBtn = showAccTab
      ? `<button type="button" class="tab ${view.tab === 'accounts' ? 'active' : ''}" data-tab="accounts">계정</button>`
      : '';
    const tabContactsBtn = showContactsTab
      ? `<button type="button" class="tab ${view.tab === 'contacts' ? 'active' : ''}" data-tab="contacts">주소록</button>`
      : '';
    const tabFeedbackBtn = `<button type="button" class="tab ${view.tab === 'feedback' ? 'active' : ''}" data-tab="feedback">질문 / 의견</button>`;
    const fabHidden = view.tab === 'accounts' || view.tab === 'feedback' ? ' hidden' : '';

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
            <span class="role-badge" style="background:var(--${roleInfo.className});color:#fff;">${roleInfo.label}</span>
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
          <button type="button" class="btn btn-ghost" id="btn-logout">나가기</button>
        </header>
        ${buildLanAccessBannerHtml()}
        <nav class="${tabsClass}">
          <button type="button" class="tab ${view.tab === 'chats' ? 'active' : ''}" data-tab="chats">채팅</button>
          ${tabContactsBtn}
          ${tabAccountsBtn}
          ${tabFeedbackBtn}
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
          <textarea class="fb-reply-text" rows="2" placeholder="답변을 입력…"></textarea>
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
              <label>제목 <span class="caption">(선택)</span></label>
              <input type="text" id="fb-title" maxlength="120" placeholder="예: 조사 일정 문의" autocomplete="off" />
            </div>
            <div class="field">
              <label>내용</label>
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
        <p class="caption"><strong>엑셀 형식</strong> — 1행: <code>아이디 | 비밀번호 | 이름 | 역할 | 팀</code> · <strong>팀</strong>은 면접원일 때만 필수(부산팀·대전팀·대구팀·광주팀·서울팀 또는 부산/대전 등). 연구원·슈퍼바이저는 팀 칸 비워도 됩니다.</p>
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
        view.tab = t.dataset.tab;
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
  }

  function openAnnounceModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:80vh">
        <div class="modal-head">공지 보내기</div>
        <div class="modal-body">
          <div class="field">
            <label>제목</label>
            <input type="text" id="ann-title" placeholder="예: 내일 스케줄 변경" />
          </div>
          <div class="field">
            <label>내용</label>
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
            <label>제목</label>
            <input type="text" id="room-ann-title" placeholder="예: 오늘 일정" autocomplete="off" />
          </div>
          <div class="field">
            <label>내용</label>
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

  function openNewChatModal() {
    const others = state.accounts.filter((u) => u.id !== state.me.id);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">새 채팅</div>
        <div class="modal-body">
          <div class="field">
            <label>이름·아이디 검색</label>
            <input type="search" id="newchat-search" placeholder="이름 또는 @아이디" autocomplete="off" />
            <p class="caption" style="margin-top:0.35rem">1:1 상대 목록과 단체 멤버 목록이 함께 필터됩니다. 체크·선택은 그대로 가능합니다.</p>
          </div>
          <div class="field">
            <label>1:1 대화 — 상대 선택</label>
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
            <label>단체방 이름</label>
            <input type="text" id="grp-name" placeholder="예: 4월 현장조사 TF" />
          </div>
          <div class="field">
            <label>멤버 선택</label>
            <div class="newchat-member-scroll">
            <div class="check-list" id="grp-members">
              ${groupNewChatMembersChecklistHtml(others)}
            </div>
            </div>
            <button type="button" class="btn btn-grp-create" id="btn-grp">단체방 만들기</button>
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
      if (dmSelect.value) {
        const o = dmSelect.options[dmSelect.selectedIndex];
        if (o && o.hidden) dmSelect.value = '';
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
  }

  function openAddAccountModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay centered';
    overlay.innerHTML = `
      <div class="modal centered-box" style="max-height:85vh">
        <div class="modal-head">계정 추가</div>
        <div class="modal-body">
          <div class="field">
            <label>아이디 (로그인용)</label>
            <input type="text" id="acc-loginId" autocomplete="off" placeholder="영문·숫자 권장" />
          </div>
          <div class="field">
            <label>비밀번호</label>
            <input type="password" id="acc-pw" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>이름 (채팅에 표시)</label>
            <input type="text" id="acc-name" maxlength="30" />
          </div>
          <div class="field">
            <label>역할 (연구원·슈퍼바이저·면접원)</label>
            <select id="acc-role">
              <option value="researcher">연구원</option>
              <option value="supervisor">슈퍼바이저</option>
              <option value="interviewer">면접원</option>
            </select>
          </div>
          <div class="field hidden" id="acc-team-wrap">
            <label>소속 팀 (면접원 필수)</label>
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
          alert('면접원은 부산·대전·대구·광주·서울 팀 중 하나를 선택해 주세요.');
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
      ['jung_iv', 'temp1234', '정면접', '면접원', '서울팀'],
    ]);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '계정목록');
    XLSX.writeFile(wb, '회사채팅_계정등록양식.xlsx');
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
            `${sheetRow}행 (${loginId}): 면접원은 5열「팀」에 부산팀·대전팀·대구팀·광주팀·서울팀(또는 부산/대전 등) 입력`
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
            <label>새 비밀번호</label>
            <input type="password" id="acc-new-pw" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>새 비밀번호 확인</label>
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
            <label>팀</label>
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

    if (!state.accounts.length && !realtimeSyncedFromServer) {
      const rows = [
        { id: 'demo-r1', loginId: 'researcher1', password: 'demo1234', name: '김연구', role: 'researcher' },
        { id: 'demo-r2', loginId: 'researcher2', password: 'demo1234', name: '이실험', role: 'researcher' },
        { id: 'demo-s1', loginId: 'supervisor1', password: 'demo1234', name: '박슈퍼', role: 'supervisor' },
        { id: 'demo-i1', loginId: 'interviewer1', password: 'demo1234', name: '최면접', role: 'interviewer', team: 'busan' },
        { id: 'demo-i2', loginId: 'interviewer2', password: 'demo1234', name: '정리서치', role: 'interviewer', team: 'seoul' },
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
            <label>이름·아이디 검색</label>
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
    const msgs = state.messages[room.id] || [];
    const ivBlocked = interviewerChatSendBlocked(room);
    const showMod = canPostRoomModeration();

    const bubbles = msgs
      .map((m) => {
        const isMe = m.senderId === state.me.id;
        const sender = userById(m.senderId);
        const name = sender ? sender.name : '알 수 없음';
        const senderTeam =
          sender && sender.role === 'interviewer' && teamLabel(sender.team)
            ? ` <span class="sender-team">(${escapeHtml(teamLabel(sender.team))})</span>`
            : '';
        const imgHtml =
          m.image && String(m.image).startsWith('data:image/')
            ? `<img class="chat-img" src="${String(m.image).replace(/"/g, '&quot;')}" alt="" />`
            : '';
        const annClass = m.isAnnouncement || m.isRoomNotice ? ' announce' : '';
        return `
          <div class="bubble-row ${isMe ? 'me' : 'them'}">
            ${!isMe ? `<div class="bubble-sender">${escapeHtml(name)}${senderTeam}</div>` : ''}
            <div class="bubble${annClass}">${escapeHtml(m.text).replace(/\n/g, '<br/>')}${imgHtml}</div>
            <div class="msg-time">${formatTime(m.ts)}</div>
          </div>
        `;
      })
      .join('');

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

    const modRow = showMod
      ? `<div class="chat-mod-row">
          <button type="button" class="btn-chat-mod" id="btn-room-notice">방 공지</button>
          ${ivToggleBtn}
        </div>`
      : '';

    const lockHint = ivBlocked
      ? `<div class="chat-lock-hint">단체방에서는 연구원·슈퍼바이저가「면접원 채팅 허용」을 켠 뒤에만 메시지를 보낼 수 있습니다.</div>`
      : '';
    const inputBarClass = ivBlocked ? 'input-bar input-bar--locked' : 'input-bar';
    /* iOS: disabled textarea는 포커스·키보드가 안 뜨는 경우가 많아, 막힌 경우에는 안내 버튼만 둠 */
    const msgField = ivBlocked
      ? `<button type="button" class="msg-input-placeholder" id="msg-input-blocked-hint" aria-label="면접원 채팅 안내">면접원 채팅이 아직 허용되지 않았습니다. 탭하여 안내를 확인하세요.</button>`
      : `<textarea id="msg-input" rows="1" placeholder="메시지 입력…" autocomplete="off" autocorrect="on" autocapitalize="sentences" inputmode="text" enterkeyhint="send"></textarea>`;
    const inputBar = `
        <div class="chat-composer-fixed" role="region" aria-label="메시지 입력">
        ${lockHint}
        <div class="${inputBarClass}">
          <label class="attach" title="사진">
            <span>🖼</span>
            <input type="file" id="file-img" accept="image/*"${ivBlocked ? ' disabled' : ''} />
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
              <button type="button" class="chat-header-video" id="btn-video-call" title="화상 회의">화상</button>
              <button type="button" class="chat-header-leave" id="chat-leave-btn">나가기</button>
            </div>
          </div>
          ${modRow}`;

    if (room.type !== 'group') {
      return `
      <div class="screen">
        <header class="chat-header chat-header--stack">
          ${chatHeaderInner}
        </header>
        ${roomNoticeBanner}
        ${annStrip}
        <div class="messages" id="msg-list">${bubbles}</div>
        ${inputBar}
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
    if (state.me && view.roomId) markRoomAsRead(state.me.id, view.roomId);

    const list = document.getElementById('msg-list');
    if (list) list.scrollTop = list.scrollHeight;

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

    let pendingImage = null;
    const fileInput = document.getElementById('file-img');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const r0 = state.rooms.find((x) => x.id === view.roomId);
        if (r0 && interviewerChatSendBlocked(r0)) return;
        const f = fileInput.files && fileInput.files[0];
        if (!f || !f.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
          pendingImage = reader.result;
          showToast('사진이 첨부되었습니다. 전송을 누르세요.');
        };
        reader.readAsDataURL(f);
        fileInput.value = '';
      });
    }

    function send() {
      const ta = document.getElementById('msg-input');
      const text = (ta.value || '').trim();
      if (!text && !pendingImage) return;
      const room = state.rooms.find((r) => r.id === view.roomId);
      if (!room) return;
      normalizeRoomModeration(room);
      if (interviewerChatSendBlocked(room)) {
        showToast('단체방에서 면접원 채팅이 아직 허용되지 않았습니다.');
        return;
      }

      const msg = {
        id: uid(),
        senderId: state.me.id,
        text: text || (pendingImage ? '(사진)' : ''),
        image: pendingImage,
        ts: Date.now(),
        isAnnouncement: false,
      };
      if (!state.messages[room.id]) state.messages[room.id] = [];
      state.messages[room.id].push(msg);
      room.updatedAt = Date.now();
      room.lastPreview = pendingImage ? '📷 사진' : text.slice(0, 40);
      saveState();
      pendingImage = null;
      ta.value = '';
      render();
    }

    const msgInput = document.getElementById('msg-input');
    if (msgInput) {
      document.getElementById('btn-send')?.addEventListener('click', send);
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      function scrollInputIntoViewForKeyboard() {
        requestAnimationFrame(() => {
          try {
            msgInput.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'smooth' });
          } catch (_) {}
          try {
            const vv = window.visualViewport;
            if (!vv) return;
            const bar = msgInput.closest('.input-bar');
            if (!bar) return;
            const rect = bar.getBoundingClientRect();
            const obscured = rect.bottom > vv.height - 8;
            if (obscured) {
              window.scrollBy(0, rect.bottom - vv.height + 16);
            }
          } catch (_) {}
        });
      }
      msgInput.addEventListener('focus', scrollInputIntoViewForKeyboard);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          if (document.activeElement === msgInput) scrollInputIntoViewForKeyboard();
        });
      }
      msgInput.addEventListener('touchstart', () => {
        try {
          msgInput.focus();
        } catch (_) {}
      }, { passive: true });
      document.querySelector('.input-bar')?.addEventListener('click', (ev) => {
        if (ev.target.closest('textarea#msg-input, .send, .attach, label.attach')) return;
        try {
          msgInput.focus();
        } catch (_) {}
      });
    }
  }

  async function init() {
    el.root = document.getElementById('app');
    await initRealtimeConnection();
    await refreshLanAccessHint();
    await migrateAndSeed();
    registerSw();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
  else void init();
})();
