// Офлайн-режим: сначала сеть (чтобы обновления приходили сразу),
// при её отсутствии — последняя сохранённая копия.
// Свои файлы всегда сверяем с сервером (no-cache): иначе браузер может
// до 10 минут отдавать старую версию из своего HTTP-кэша.

const CACHE = 'fastreader-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const own = new URL(e.request.url).origin === self.location.origin;
  // Для своих файлов — запрос по адресу: у запроса страницы (navigate) нельзя менять параметры
  e.respondWith(
    (own ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || Response.error())),
  );
});
