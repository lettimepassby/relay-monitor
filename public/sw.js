// PWA Service Worker：静态资源网络优先（面板由 Watchtower 自动更新，
// 不能让旧版本粘在缓存里），断网时回退缓存壳；API 请求不拦截（数据必须新鲜）。
const CACHE = "relay-monitor-shell-v2";
// v2（Next.js）：JS/CSS 均为带哈希的 /_next/static 资源，运行时按 fetch 缓存即可，
// 壳清单只预缓存入口与图标（v1 的 /app.js /styles.css 已不存在）
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 只处理同源静态 GET；API 与跨域请求直接走网络
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/mock/")) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      // 离线导航回退到缓存的应用壳
      if (e.request.mode === "navigate") {
        const shell = await caches.match("/");
        if (shell) return shell;
      }
      return new Response("离线且无缓存", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  })());
});
