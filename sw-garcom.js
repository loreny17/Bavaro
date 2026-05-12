// ════════════════════════════════════════════════════════
//  Bávaro Garçom — Service Worker
//  Versão: incremente o número abaixo a cada deploy
// ════════════════════════════════════════════════════════
const CACHE_VERSION = 'bavaro-garcom-v4';
const URLS_TO_CACHE = [
  '/garcom.html',
  '/manifest-garcom.json',
  '/icon-garcom-192.png',
  '/icon-garcom-512.png'
];

// ─── Instalação: cacheia os arquivos básicos ───
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando versão', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(URLS_TO_CACHE))
      .then(() => {
        // skipWaiting: ativa o novo SW imediatamente (não espera o velho morrer)
        return self.skipWaiting();
      })
  );
});

// ─── Ativação: limpa caches antigos ───
self.addEventListener('activate', (event) => {
  console.log('[SW] Ativando versão', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((nomes) => {
      return Promise.all(
        nomes.map((nome) => {
          if(nome !== CACHE_VERSION && nome.startsWith('bavaro-garcom-')){
            console.log('[SW] Removendo cache antigo:', nome);
            return caches.delete(nome);
          }
        })
      );
    }).then(() => {
      // clients.claim: assume controle de todas as abas abertas
      return self.clients.claim();
    })
  );
});

// ─── Fetch: estratégia "network first" pro HTML (sempre busca o mais novo)
// e "cache first" pros assets (manifest, ícones)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Apenas mesma origem
  if(url.origin !== location.origin) return;
  
  // HTML do app: network first (pra sempre pegar updates)
  if(event.request.mode === 'navigate' || url.pathname.endsWith('.html')){
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Salva no cache pra fallback offline
          const cloned = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, cloned));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  
  // Assets estáticos (ícones, manifest): cache first
  if(URLS_TO_CACHE.some(u => url.pathname.endsWith(u.replace('/','')))){
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
    return;
  }
  
  // Outros recursos: deixa o browser tratar
});

// ─── Mensagens do app pra forçar atualização ───
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
