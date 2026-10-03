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
// - dizionari (/locales/) → NetworkFirst senza timeout: online sempre
//   quelli del deploy, a rete giù l'ultima copia letta, così l'app riparte
//   con le parole e non con le chiavi grezze.
// - Sala dal vivo (assets/sala3d/) → CacheFirst, solo su chi la apre.
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

// Sala dal vivo (3D): fuori dal precache (vite.config.ts la manda in
// assets/sala3d/, dove il glob non arriva), così la scaricano solo i
// dispositivi che aprono la pagina e non ogni palmare e schermo di cucina.
// Nomi con hash = immutabili: CacheFirst, e la scadenza pulisce le versioni
// vecchie. Dopo la prima apertura il tablet all'ingresso la riapre anche a
// linea caduta: il codice da qui, i testi dalla rotta dei dizionari sotto.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/sala3d/'),
  new CacheFirst({
    cacheName: 'sala-3d',
    plugins: [
      // Vercel riscrive ogni file mancante su index.html con 200
      // (vercel.json): un chunk vecchio chiesto dopo un deploy tornerebbe
      // HTML, e in cache resterebbe per sempre al posto del JavaScript.
      {
        cacheWillUpdate: async ({ response }) =>
          response && response.ok && (response.headers.get('content-type') || '').includes('javascript')
            ? response
            : null,
      },
      new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 60 * 24 * 60 * 60 }),
    ],
  }),
);

// Dizionari dell'interfaccia (/locales/{lingua}/{namespace}.json, i18n/config.ts):
// la shell riparte a linea caduta, ma i testi no. i18next prende una lettura
// fallita per un dizionario vuoto e la pagina mostra le chiavi grezze
// («title», «summary») invece delle parole. Prima la rete, sempre: online
// ogni avvio legge il dizionario del deploy in corso, come prima, e la copia
// serve solo quando la rete non risponde. Niente timeout: una copia
// vecchia servita a rete lenta, dopo un deploy con chiavi nuove, mostrerebbe
// proprio le chiavi grezze. In cache vanno solo le namespace che il
// dispositivo ha già aperto.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/locales/') && url.pathname.endsWith('.json'),
  new NetworkFirst({
    cacheName: 'locales',
    plugins: [
      // Un dizionario che non c'è torna index.html con 200 (vercel.json):
      // in cache solo JSON vero.
      {
        cacheWillUpdate: async ({ response }) =>
          response && response.ok && (response.headers.get('content-type') || '').includes('json')
            ? response
            : null,
      },
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 24 * 60 * 60 }),
    ],
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
  // Il tag accompagna il click fino all'app, che segna letta la notifica
  // (POST /notifications/read-by-tag): toccata qui, sparisce anche dalla
  // campanella degli altri dispositivi. Per una finestra nuova viaggia
  // nell'URL come ?ntag=, per una già aperta nel postMessage.
  const tag = event.notification.tag || '';
  let targetUrl = (event.notification.data && event.notification.data.url) || '/';
  if (tag) {
    try {
      const u = new URL(targetUrl, self.location.origin);
      u.searchParams.set('ntag', tag);
      targetUrl = u.origin === self.location.origin ? u.pathname + u.search + u.hash : u.toString();
    } catch (e) { /* URL malformato: si apre senza segnare letta */ }
  }

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          // Tell the SPA to navigate in-app instead of reloading; client.navigate
          // would force a full reload and lose unsaved state.
          try { client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl, tag }); } catch (e) { /* ignore */ }
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
