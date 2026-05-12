// Service Worker mínimo do PDV Bávaro
// Existe APENAS para tornar o app instalável como PWA.
// Não faz cache offline — todas as requisições passam direto pra rede.

var CACHE_NAME = 'pdv-bavaro-v1';

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

// Estratégia: passa direto pra rede sempre.
// Sem cache, sem offline, mais simples e sem problemas de conteúdo desatualizado.
self.addEventListener('fetch', function(e){
  // Não intercepta nada — deixa o navegador lidar normalmente
  return;
});
