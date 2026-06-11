// firebase-messaging-sw.js
// Service Worker para notificações push com app fechado
// ⚠️  Salvar na RAIZ do projeto Vercel (mesmo nível de ponto.html e index.html)

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBmuVAH50RHsNZ7nAcMCdzulJZf3e86f74",
  authDomain: "gestao-reataurante.firebaseapp.com",
  projectId: "gestao-reataurante",
  storageBucket: "gestao-reataurante.firebasestorage.app",
  messagingSenderId: "510785409925",
  appId: "1:510785409925:web:e687e387509fb0605b6aec"
});

const messaging = firebase.messaging();

// Notificação recebida com app FECHADO (background)
messaging.onBackgroundMessage(function(payload) {
  console.log('[SW] Notificação background:', payload);
  const data = payload.data || payload.notification || {};
  const notifTitle = data.title || payload.notification && payload.notification.title || 'Bávaro Ponto';
  const notifBody  = data.body  || payload.notification && payload.notification.body  || '';
  const notifTag   = data.tag   || 'ponto';

  // Descobre de qual app veio pela URL do cliente
  const targetUrl = data.url || '/ponto.html';

  return self.registration.showNotification(notifTitle, {
    body:               notifBody,
    icon:               '/ponto-icon-192.png',
    badge:              '/ponto-badge.png',
    vibrate:            [200, 100, 200],
    tag:                notifTag,
    requireInteraction: true,
    actions: [
      {
        action: 'abrir',
        title: '🕐 Bater ponto agora'
      }
    ],
    data: { url: targetUrl }
  });
});

// Clique na notificação (corpo ou botão) → abre o app correto
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/ponto.html';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      for (var c of cs) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// Garante que o SW novo assume o controle imediatamente
self.addEventListener('install', function(e) {
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  e.waitUntil(clients.claim());
});
