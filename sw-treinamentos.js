// ═══════════════════════════════════════════════════════════════
//  Service Worker — app de Treinamentos
//  ⚠️ Registrado com scope '/treinamentos.html' (veja o registro no
//  próprio treinamentos.html) — isso é o que garante que ele nunca
//  controla nem interfere com o app Garçom (sw-garcom.js), mesmo os
//  dois vivendo no mesmo domínio. Cada um cuida só da sua página.
// ═══════════════════════════════════════════════════════════════
var CACHE_NOME = 'treinamentos-v1';
var ARQUIVOS_BASE = [
  '/treinamentos.html',
  '/icon-treinamentos-192.png',
  '/icon-treinamentos-512.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NOME).then(function(cache){
      return cache.addAll(ARQUIVOS_BASE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(nomes){
      return Promise.all(
        nomes.filter(function(n){ return n !== CACHE_NOME; })
             .map(function(n){ return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

// Rede primeiro, cache como reserva — garante que o conteúdo (vídeos,
// cadastro, respostas da IA) está sempre atualizado quando há internet;
// só usa o cache se a rede falhar (abrir offline continua funcionando
// pra tela principal, mesmo sem dados novos).
self.addEventListener('fetch', function(event){
  // Nunca intercepta chamadas pro Firestore/Storage/Gemini — essas
  // precisam sempre ir direto pra rede, nunca servidas do cache.
  if(event.request.url.indexOf('firestore.googleapis.com') >= 0) return;
  if(event.request.url.indexOf('firebasestorage') >= 0) return;
  if(event.request.url.indexOf('generativelanguage.googleapis.com') >= 0) return;
  if(event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(function(resp){
        var copia = resp.clone();
        caches.open(CACHE_NOME).then(function(cache){ cache.put(event.request, copia); });
        return resp;
      })
      .catch(function(){
        return caches.match(event.request);
      })
  );
});
