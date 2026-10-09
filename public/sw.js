const CACHE_NAME = 'pulse-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: Network first with Cache fallback for app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip caching for API, uploads, and socket requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});

// ── Web Push Notification Handler ─────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {
    title: 'Pulse Messenger',
    body: 'You have a new message',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: { url: '/' }
  };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon.svg',
    badge: data.badge || '/icons/icon.svg',
    vibrate: [120, 60, 120, 60, 200],
    data: data.data || { url: '/' },
    actions: [
      { action: 'open', title: '💬 Open Chat' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ],
    tag: data.data?.conversation_id ? `conv-${data.data.conversation_id}` : 'pulse-msg',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── Notification Click Handler ───────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.focus();
          if (event.notification.data?.conversation_id) {
            client.postMessage({
              type: 'OPEN_CONVERSATION',
              conversation_id: event.notification.data.conversation_id
            });
          }
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
