// Service worker dell'app: shell offline (precache Workbox) + Web Push.
//
// Shell offline — il prerequisito della modalità ibrida: al collaudo del
// 17/09, a linea caduta, un refresh mostrava pagina bianca perché index.html
// e bundle vivono su Vercel. Da qui in poi la shell riparte dalla cache del
// dispositivo e l'app può parlare col nodo di sala anche senza internet.
//
// Le strategie, e perché:
// - asset con hash (assets/*.js|css) → precache: immutabili per costruzione.
// - navigazioni → NetworkFirst con timeout: a rete viva si serve SEMPRE la
//   shell fresca di Vercel (il flusso deploy → banner «Ricarica» resta
//   com'è oggi, nessun bundle vecchio incollato); a rete giù si ripiega
//   sull'index.html precachato.
// - font Google → cache runtime, così anche il primo avvio offline ha la
//   grafia giusta.
// - NIENTE cache sulle API: sono su un altro dominio (cloud o nodo di
//   sala) e il SW same-origin non le tocca per costruzione — la staleness
//   dei dati la governa già il nodo con X-Sala-Node, non il browser.
//
// Compilato da vite-plugin-pwa (strategia injectManifest): self.__WB_MANIFEST
// è la lista degli asset del build, iniettata a build time.

import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const navigationStrategy = new NetworkFirst({
  cacheName: 'pages',
  // A rete lenta non si aspetta il TCP: dopo 3s si serve la copia in cache
  // (o il fallback precache sotto) — la stessa filosofia di fetchNodeAware.
  networkTimeoutSeconds: 3,
});

registerRoute(new NavigationRoute(
  async (params) => {
    try {
      return await navigationStrategy.handle(params);
    } catch {
      // Prima navigazione offline di sempre (cache 'pages' vuota): la shell
      // precachata è la rete di salvataggio.
      const shell = await matchPrecache('/index.html');
      if (shell) return shell;
      throw new Error('shell non in cache');
    }
  },
  {
    // Le pagine statiche del backend (copiate in public/ ma servite dal
    // dominio API) e qualunque richiesta di file diretto non sono la SPA.
    denylist: [/^\/(menu|prenota|ordina)\.html/, /\/[^/?]+\.[^/?]+$/],
  },
));

// Font: il CSS di Google cambia (SWR), i woff2 sono immutabili (CacheFirst).
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'google-fonts-css' }),
);
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-woff',
    plugins: [new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 365 * 24 * 60 * 60 })],
  }),
);

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Client asks us to skip waiting when the "Ricarica" button in the version
// banner is pressed. Without this, an updated SW would stay in the waiting
// state and the client would boot the old cached scripts on reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
  // numerico lo applichiamo sull'icona PWA — il server la include con la
  // conta corrente di "cose da attenzionare" così l'utente vede il numero
  // aggiornato anche a app chiusa. Feature-detect + best-effort: se
  // l'ambiente non supporta l'API (Safari macOS, Firefox) o rifiuta, la
  // notifica viene comunque mostrata normalmente.
  const badgeUpdate = (async () => {
    if (typeof data.badge !== 'number') return;
    const n = Math.max(0, Math.floor(data.badge));
    if (n > 0) {
      if (typeof navigator.setAppBadge !== 'function') return;
      try { await navigator.setAppBadge(n); } catch (_e) { /* ignore */ }
    } else {
      if (typeof navigator.clearAppBadge !== 'function') return;
      try { await navigator.clearAppBadge(); } catch (_e) { /* ignore */ }
    }
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
