import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 5173,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
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
