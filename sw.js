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
