/* 회사 채팅 초안 — 오프라인 셸만 캐시 (실제 푸시는 서버 연동 필요) */
const CACHE = 'company-chat-v5';

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isAppAsset(url) {
  const p = url.split('?')[0];
  return /\/(app\.js|styles\.css|index\.html|manifest\.json)$/i.test(p);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }
  if (req.method === 'GET' && isAppAsset(url)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});

self.addEventListener('push', () => {
  /* 운영 시 여기서 showNotification — VAPID/FCM 설정 후 사용 */
});
