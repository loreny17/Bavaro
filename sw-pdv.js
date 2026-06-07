// Service Worker do PDV Bávaro
// Scope: apenas /pdv.html
// Estratégia: network-only (sem cache offline)

var CACHE_NAME = 'pdv-bavaro-v3';

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.map(function(n){
        return caches.delete(n); // limpa tudo
      }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

// Network only — sem cache
self.addEventListener('fetch', function(e){
  return; // passa direto
});
