// ═══════════════════════════════════════════════════════════
//  FUNCIONÁRIO APP — Service Worker (ponto-sw.js)
//  Versão independente do sw.js do app principal.
//  Cache name diferente para não colidir.
// ═══════════════════════════════════════════════════════════

var CACHE_NAME = 'funcionario-ponto-v1';

// Recursos para cache offline (só o próprio app)
var CACHE_URLS = [
  '/ponto.html',
  '/ponto-manifest.json'
];

// INSTALL — cria cache inicial
self.addEventListener('install', function(event) {
  console.log('[Ponto SW] install');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS).catch(function(e) {
        console.warn('[Ponto SW] cache parcial:', e);
      });
    })
  );
  self.skipWaiting();
});

// ACTIVATE — limpa caches antigos DESTE app (prefixo "funcionario-ponto-")
self.addEventListener('activate', function(event) {
  console.log('[Ponto SW] activate');
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          // Só limpa caches deste app (não toca no cache do app principal)
          return key.startsWith('funcionario-ponto-') && key !== CACHE_NAME;
        }).map(function(key) {
          console.log('[Ponto SW] deletando cache antigo:', key);
          return caches.delete(key);
        })
      );
    })
  );
  return self.clients.claim();
});

// FETCH — serve do cache, fallback para rede
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Não intercepta Firebase, Google APIs, CDNs externos
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    url.includes('cdnjs.cloudflare.com') ||
    url.includes('gstatic.com')
  ) {
    return; // deixa o browser lidar normalmente
  }

  // Só intercepta requisições do mesmo origin
  if (!url.startsWith(self.location.origin)) return;

  // Estratégia: Cache-first para o ponto.html, network-first para o resto
  if (url.includes('ponto.html') || url.includes('ponto-manifest.json')) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        var networkFetch = fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function() {
          return cached; // offline fallback
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Para outros recursos do mesmo origin: network-first
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});

// Mensagem SKIP_WAITING
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
