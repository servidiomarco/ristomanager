import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // Build-time app version: 7-char short SHA from whichever host is doing
    // the SPA build — Vercel (frontend at crm.vecchiofrantoio.com) exposes
    // VERCEL_GIT_COMMIT_SHA, Railway RAILWAY_GIT_COMMIT_SHA. Falls back to
    // 'dev' locally so the banner never fires (useAppVersion early-returns).
    const appVersion = (
        process.env.VERCEL_GIT_COMMIT_SHA
        || process.env.RAILWAY_GIT_COMMIT_SHA
        || ''
    ).slice(0, 7) || 'dev';
    return {
      server: {
        port: 5173,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss(), VitePWA({
        // injectManifest, non generateSW: il service worker è il NOSTRO
        // pwa/sw.js (push + shell offline), il plugin si limita a iniettare
        // la lista degli asset del build in self.__WB_MANIFEST e a compilare
        // gli import workbox. Output: dist/sw.js — stesso path che
        // pushClient e index.tsx registrano da sempre.
        strategies: 'injectManifest',
        srcDir: 'pwa',
        filename: 'sw.js',
        // Registrazione manuale (index.tsx al boot, pushClient per il push):
        // niente script iniettato dal plugin.
        injectRegister: null,
        // Il manifest PWA esiste già in public/manifest.webmanifest.
        manifest: false,
        injectManifest: {
          // La shell e basta: bundle con hash, index.html, icone e manifest.
          // Fuori le pagine del backend (menu/prenota/ordina.html): vivono
          // sul dominio API, qui sono solo di passaggio. Fuori anche i
          // locales: la SPA li legge da qui (/locales/…), ma tutte le
          // namespace su ogni dispositivo sarebbero un peso; quelle che un
          // dispositivo apre le tiene la rotta dei dizionari di pwa/sw.js.
          globPatterns: [
            'assets/*.{js,css}',
            'index.html',
            'icon-*.png',
            'icon-sympotia.svg',
            'logo-*.{svg,png}',
            'manifest.webmanifest',
          ],
          // Il bundle principale supera i 2MB di default di Workbox.
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        },
        // In dev niente SW (index.tsx registra solo in PROD): un SW sotto
        // HMR serve shell stantie e confonde più di quanto aiuti.
        devOptions: { enabled: false },
      }), {
        // version.json accanto a index.html: è la fonte del banner «Nuova
        // versione». Il banner DEVE confrontarsi con la versione del
        // frontend pubblicato (stessa origin, stesso deploy atomico del
        // bundle), non con /version del backend Railway: i due deploy non
        // finiscono insieme, e nella finestra in cui Railway era già nuovo
        // ma Vercel no il banner ricompariva subito dopo ogni «Ricarica»
        // perché il reload riscaricava per forza il bundle vecchio.
        name: 'emit-version-json',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ version: appVersion }),
          });
        },
      }],
      define: {
        // Stessa versione cotta nel bundle, da confrontare con version.json.
        __APP_VERSION__: JSON.stringify(appVersion),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        rollupOptions: {
          output: {
            // Solo three in un chunk suo: non importa niente dal bundle
            // principale, quindi il suo hash cambia solo quando si aggiorna la
            // libreria, e la cache dei dispositivi lo tiene fra un deploy e
            // l'altro. Anche three/addons (MapControls) finisce qui. R3F no:
            // importa React dal chunk d'ingresso, e col suo hash cambierebbe a
            // ogni deploy; viaggia col chunk della scena.
            manualChunks: (id) => (/[\\/]node_modules[\\/]three[\\/]/.test(id) ? 'three' : undefined),
            // La Sala dal vivo in assets/sala3d/: il glob del precache
            // ('assets/*.{js,css}', qui sopra) non scende nelle sottocartelle,
            // così palmari e schermi di cucina non la scaricano mai; la serve
            // a chi apre la pagina la rotta CacheFirst di pwa/sw.js. Oltre a
            // three e ai chunk SalaVivo*, anche un eventuale chunk comune fatto
            // solo di moduli della Sala dal vivo: col nome di un modulo
            // qualsiasi, finirebbe nel precache di tutti.
            chunkFileNames: (chunk) =>
              chunk.name === 'three'
                || chunk.name.startsWith('SalaVivo')
                || (chunk.moduleIds.length > 0 && chunk.moduleIds.every(id => /[\\/]components[\\/]salaVivo[\\/]/.test(id)))
                ? 'assets/sala3d/[name]-[hash].js'
                : 'assets/[name]-[hash].js',
          },
        },
      },
    };
});
