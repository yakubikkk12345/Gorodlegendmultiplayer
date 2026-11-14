// Город легенд — service worker: офлайн-режим для одиночной игры.
// HTML и ресурсы: сначала сеть (всегда свежая версия), при отсутствии сети — кэш.
const VER = 'gl-v48';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    // каждый файл отдельно: отсутствие одного не ломает установку
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER) await caches.delete(k);
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (_) { } }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // сервер игры (WebSocket) и чужие домены — мимо кэша
  if (url.pathname.startsWith('/api') || url.pathname === '/sw.js') return;
  const isPage = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  e.respondWith((async () => {
    const c = await caches.open(VER);
    try {
      const pre = isPage && e.preloadResponse ? await e.preloadResponse : null;
      const r = pre || await fetch(req);
      if (r && r.ok && r.type === 'basic') c.put(isPage ? '/' : req, r.clone()).catch(() => { });
      return r;
    } catch (err) {
      const hit = (await c.match(isPage ? '/' : req, { ignoreSearch: true })) || (isPage ? await c.match('/index.html') : null);
      if (hit) return hit;
      return new Response(isPage ? '<meta charset=utf-8><meta name=viewport content="width=device-width"><body style="background:#0b0f1a;color:#fff;font:18px system-ui;padding:24px"><h2>Нет сети</h2><p>Игра ещё не сохранена для офлайн-режима. Откройте её один раз с интернетом.</p>' : '', { status: 503, headers: { 'Content-Type': isPage ? 'text/html; charset=utf-8' : 'text/plain' } });
    }
  })());
});
