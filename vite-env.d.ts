/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build-time app version. Injected by vite.config.ts `define` from the
// Railway commit SHA (or 'dev' locally). Used by the update-available banner.
declare const __APP_VERSION__: string;
