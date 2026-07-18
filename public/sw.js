// Service worker for Web Push notifications.
// Receives push events and surfaces system notifications; handles click to focus
// or open the app, navigating to the optional payload.url.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'Notifica', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'RistoCRM';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
    renotify: !!data.tag,
  };

  // App-icon badge (Web App Badging API). Se il payload include un `badge`
  // numerico lo applichiamo sull'icona PWA — il server può inviarlo con la
  // conta corrente di "cose da attenzionare" così l'utente vede il numero
  // aggiornato anche a app chiusa. Feature-detect + best-effort: se
  // l'ambiente non supporta l'API (Safari macOS, Firefox) o rifiuta, la
  // notifica viene comunque mostrata normalmente.
  const badgeUpdate = (async () => {
    if (typeof data.badge !== 'number') return;
    const n = Math.max(0, Math.floor(data.badge));
    try {
      if (n > 0 && typeof navigator.setAppBadge === 'function') {
        await navigator.setAppBadge(n);
      } else if (typeof navigator.clearAppBadge === 'function') {
        await navigator.clearAppBadge();
      }
    } catch (_e) { /* ignore */ }
  })();

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    badgeUpdate,
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          // Tell the SPA to navigate in-app instead of reloading; client.navigate
          // would force a full reload and lose unsaved state.
          try { client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl }); } catch (e) { /* ignore */ }
          await client.focus();
          return;
        }
      } catch (e) {
        // Ignore malformed client URLs
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
