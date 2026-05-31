const CACHE_NAME = 'turnkey-crm-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '';
  const url = event.notification.data?.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If CRM tab is open, focus it
      for (const client of clientList) {
        if (client.url.includes('TurnkeyCRM') && 'focus' in client) {
          client.focus();
          if (link) client.navigate(client.url.replace(/\/[^\/]*$/, '/') + link);
          return;
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// Handle background sync for notifications (optional future use)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'TurnkeyCRM', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [300, 100, 300],
      requireInteraction: true,
      data: data
    })
  );
});
