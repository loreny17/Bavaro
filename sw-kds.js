// Service Worker do Bávaro KDS (Tela de Cozinha)
// Existe APENAS para tornar a tela de cozinha instalável como PWA.
// Não faz cache offline — todas as requisições passam direto pra rede,
// porque a cozinha precisa SEMPRE dos pedidos mais recentes.

var CACHE_NAME = 'bavaro-kds-v1';

self.addEventListener('install', function(e){
  // Ativa imediatamente sem precisar fechar abas antigas
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  // Limpa caches antigos (caso existam)
  e.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.map(function(n){
        if(n !== CACHE_NAME) return caches.delete(n);
      }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

// Estratégia: passa direto pra rede sempre (sem cache, sem offline).
self.addEventListener('fetch', function(e){
  return;
});
