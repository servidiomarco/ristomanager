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

  // ==== BADGE UPDATE (Web App Badging API) — con debug in-line ==================
  // Debug hack: iniettiamo il risultato dell'operazione badge NEL titolo della
  // notifica così l'utente lo vede senza aprire DevTools. Rimuovere dopo la
  // verifica.
  let debugTag = '';
  const badgeVal = typeof data.badge === 'number' ? Math.max(0, Math.floor(data.badge)) : null;
  const hasSet = typeof navigator.setAppBadge === 'function';
  const hasClear = typeof navigator.clearAppBadge === 'function';
  debugTag = `[dbg b=${data.badge} set=${hasSet ? 'y' : 'n'} clr=${hasClear ? 'y' : 'n'}]`;

  const badgePromise = (async () => {
    if (badgeVal === null) { debugTag += ' skip:no-badge'; return; }
    if (badgeVal > 0) {
      if (!hasSet) { debugTag += ' skip:no-set'; return; }
      try {
        await navigator.setAppBadge(badgeVal);
        debugTag += ' setOK';
      } catch (err) {
        debugTag += ` setERR:${(err && err.message) || 'unknown'}`;
      }
    } else {
      if (!hasClear) { debugTag += ' skip:no-clear'; return; }
      try {
        await navigator.clearAppBadge();
        debugTag += ' clrOK';
      } catch (err) {
        debugTag += ` clrERR:${(err && err.message) || 'unknown'}`;
      }
    }
  })();

  // Await the badge write PRIMA di showNotification così debugTag è già valorizzato
  event.waitUntil((async () => {
    await badgePromise;
    const title = data.title || 'RistoCRM';
    const options = {
      body: `${debugTag}\n${data.body || ''}`,
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/' },
      renotify: !!data.tag,
    };
    await self.registration.showNotification(title, options);
  })());
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
