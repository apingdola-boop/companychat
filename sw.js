'use strict';
/**
 * Service Worker — 네트워크 가로채기 없음 (항상 최신 JS/CSS 사용).
 * 과거 버전이 app.js/styles 를 오래 캐시하면 Chrome만 입력·로그인이 깨진 것처럼 보일 수 있어
 * 여기서는 캐시 미사용 + 활성화 시 기존 Cache Storage 전부 삭제.
 */
self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      await self.clients.claim();
    })()
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const title = data && data.title ? String(data.title) : 'H-채팅';
  const body = data && data.body ? String(data.body) : '새 메시지가 도착했습니다.';
  const url = data && data.url ? String(data.url) : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data && data.tag ? String(data.tag) : 'company-chat-push',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    event.notification && event.notification.data && event.notification.data.url
      ? String(event.notification.data.url)
      : '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});
