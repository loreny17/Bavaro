// Service Worker — Bávaro Totem (Autoatendimento)
const CACHE = 'bavaro-totem-v20260618';
const ARQUIVOS = ['/totem.html', '/manifest-totem.json'];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){
    return c.addAll(ARQUIVOS).catch(function(){});
  }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.filter(function(n){ return n !== CACHE; })
        .map(function(n){ return caches.delete(n); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  // Só intercepta requisições GET pra mesma origem
  if(e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if(url.origin !== self.location.origin) return;
  // Pra HTML: rede primeiro, cache como fallback
  if(e.request.destination === 'document' || url.pathname.endsWith('.html')){
    e.respondWith(
      fetch(e.request).then(function(resp){
        var clone = resp.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, clone).catch(function(){}); });
        return resp;
      }).catch(function(){
        return caches.match(e.request).then(function(r){ return r || caches.match('/totem.html'); });
      })
    );
  }
});
