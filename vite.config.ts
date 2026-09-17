import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
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
          // Fuori le pagine del backend (menu/prenota/ordina.html) e i
          // locales: vivono sul dominio API, qui sono solo di passaggio.
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
      })],
      define: {
        // Build-time app version. Read from whichever host is doing the SPA
        // build: Vercel (frontend at crm.vecchiofrantoio.com) exposes
        // VERCEL_GIT_COMMIT_SHA, Railway (backend, or if the SPA is ever
        // built there) exposes RAILWAY_GIT_COMMIT_SHA. We bake the 7-char
        // short SHA into the bundle so the client can compare it against
        // the /version endpoint and prompt the user to reload when a newer
        // deploy is live. Falls back to 'dev' locally so the banner never
        // fires (useAppVersion early-returns on 'dev').
        __APP_VERSION__: JSON.stringify(
          (
            process.env.VERCEL_GIT_COMMIT_SHA
            || process.env.RAILWAY_GIT_COMMIT_SHA
            || ''
          ).slice(0, 7) || 'dev'
        ),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
