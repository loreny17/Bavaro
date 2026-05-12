// ════════════════════════════════════════════════════════
//  Bávaro PDV — Service Worker
//  Versão: incremente o número abaixo a cada deploy
// ════════════════════════════════════════════════════════
const CACHE_VERSION = 'bavaro-pdv-v3';
const URLS_TO_CACHE = [
  '/pdv.html'
];

// ─── Instalação: cacheia os arquivos básicos ───
self.addEventListener('install', (event) => {
  console.log('[SW-PDV] Instalando versão', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// ─── Ativação: limpa caches antigos ───
self.addEventListener('activate', (event) => {
  console.log('[SW-PDV] Ativando versão', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((nomes) => {
      return Promise.all(
        nomes.map((nome) => {
          if(nome !== CACHE_VERSION && nome.startsWith('bavaro-pdv-')){
            console.log('[SW-PDV] Removendo cache antigo:', nome);
            return caches.delete(nome);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Fetch: network first pro HTML, cache first pros assets ───
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if(url.origin !== location.origin) return;
  
  // HTML do PDV: SEMPRE busca da rede (pra updates), com fallback de cache
  if(event.request.mode === 'navigate' || url.pathname.endsWith('.html')){
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const cloned = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, cloned));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
});

// ─── Mensagens do app pra forçar atualização ───
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
