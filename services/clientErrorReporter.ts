import { authApiService } from './authApiService';
import { CLIENT_ERRORS_PER_BATCH, type ClientErrorReport } from './healthShared';

/* ============================================
   ERRORI DEL BROWSER → PIATTAFORMA (supporto, fase 2)
   ============================================
   Prima un crash in sala finiva solo nella console del telefono del
   cameriere, e lo si scopriva quando qualcuno telefonava. Qui si raccolgono
   gli errori non gestiti e quelli delle schede cadute (CardErrorBoundary) e
   si mandano a lotti a POST /client-errors: si allegano alle richieste di
   supporto e la piattaforma li vede nella tab «Salute».

   Prudente per costruzione: mai più di tre volte lo stesso errore e trenta
   in tutto per sessione, niente invio senza login, e nessun errore del
   reporter può generarne altri. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

const MAX_PER_KEY = 3;
const MAX_PER_SESSION = 30;
const FLUSH_DELAY_MS = 3000;

// Rumore noto, non errori dell'app: estensioni del browser, errori opachi di
// script di terzi, il ciclo innocuo di ResizeObserver.
const IGNORED = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /(chrome|moz|safari)-extension:\/\//i,
];

let currentView: string | null = null;
let installed = false;
let sentTotal = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const sentPerKey = new Map<string, number>();
const queue: ClientErrorReport[] = [];

/** La vista in cui si lavora: App la aggiorna a ogni cambio. */
export const setErrorReporterView = (view: string | null): void => { currentView = view; };

const describe = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  const maybe = error as { message?: unknown } | null;
  if (maybe && typeof maybe.message === 'string') return { message: maybe.message };
  try {
    return { message: JSON.stringify(error)?.slice(0, 300) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
};

const flush = async (): Promise<void> => {
  timer = null;
  const token = authApiService.getAccessToken();
  if (queue.length === 0 || !token) return;
  const batch = queue.splice(0, CLIENT_ERRORS_PER_BATCH);
  try {
    await fetch(`${API_URL}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ errors: batch }),
      // Un errore subito prima di una navigazione o di un reload deve
      // arrivare lo stesso.
      keepalive: true,
    });
  } catch { /* niente: un errore del reporter non deve generarne altri */ }
  if (queue.length > 0) schedule();
};

const schedule = (): void => {
  if (timer != null) return;
  timer = setTimeout(() => { void flush(); }, FLUSH_DELAY_MS);
};

export function reportClientError(error: unknown, source: ClientErrorReport['source'], label?: string, extraStack?: string): void {
  try {
    if (!authApiService.getAccessToken()) return;
    const { message, stack } = describe(error);
    if (!message) return;
    if (IGNORED.some(re => re.test(message) || (stack ? re.test(stack) : false))) return;
    const key = `${source}|${label ?? ''}|${message.slice(0, 200)}`;
    const seen = sentPerKey.get(key) ?? 0;
    if (seen >= MAX_PER_KEY || sentTotal >= MAX_PER_SESSION) return;
    sentPerKey.set(key, seen + 1);
    sentTotal++;
    const fullStack = [stack, extraStack].filter(Boolean).join('\n').slice(0, 4000) || undefined;
    let version: string | undefined;
    try { version = __APP_VERSION__; } catch { version = undefined; }
    queue.push({
      source,
      message: message.slice(0, 500),
      stack: fullStack,
      view: currentView ?? undefined,
      app_version: version,
      label,
    });
    schedule();
  } catch { /* vedi sopra */ }
}

/** Da chiamare una volta, al boot (index.tsx). */
export function installClientErrorReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event: ErrorEvent) => {
    reportClientError(event.error ?? event.message, 'onerror');
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, 'rejection');
  });
}
