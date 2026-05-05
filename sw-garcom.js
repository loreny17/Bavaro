// Service Worker do Bávaro Garçom
// Versão simples: cache só do app shell, mas sempre busca do Vercel as atualizações
const CACHE = 'bavaro-garcom-v2';
const URLS = [
  '/garcom.html',
  '/icon-garcom-192.png',
  '/icon-garcom-512.png',
  '/manifest-garcom.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network first - sempre tenta a rede, cai no cache se offline
  if (event.request.method !== 'GET') return;
  // Só intercepta requisições do escopo do garçom
  const url = new URL(event.request.url);
  if (!url.pathname.includes('garcom') && !URLS.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
