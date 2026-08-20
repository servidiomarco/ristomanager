// Fase D4 — Allowlist CORS condivisa fra l'API Express (server.ts) e il
// handshake Socket.IO (socketService.ts): prima erano due logiche diverse
// (Express aperto con `origin: true`, Socket.IO con una lista hardcoded del
// solo Frantoio) e ogni tenant con dominio custom sarebbe rimasto fuori.
//
// Regole, nell'ordine:
//   1. CORS_ALLOW_ALL=true → tutto passa (per debugging, com'era prima).
//   2. Nessun Origin → passa: curl, print-agent, webhook server-to-server
//      e le app native non mandano l'header, e non sono soggetti a CORS.
//   3. localhost / 127.0.0.1 / ::1 su qualunque porta → sviluppo locale.
//   4. *.vercel.app e *.railway.app → deploy preview (ogni PR del frontend
//      riceve un sottodominio Vercel diverso; idem gli ambienti Railway).
//   5. Gli hostname di CRM_APP_BASE_URL e PUBLIC_BOOKING_BASE_URL (con gli
//      stessi fallback storici usati altrove nel codice).
//   6. I domini custom dei tenant letti da tenant_domains, con cache a TTL
//      (60s) così un dominio appena registrato funziona senza redeploy e
//      il DB non viene interrogato a ogni preflight.
import { queryWithRetry, runAsPlatform } from '../db.js';

// TTL della cache dei domini tenant: 60s è il compromesso fra "un dominio
// nuovo funziona quasi subito" e "niente query per ogni richiesta".
const TENANT_DOMAINS_TTL_MS = 60_000;

let tenantDomainsCache: Set<string> = new Set();
let tenantDomainsFetchedAt = 0;
// Una sola refresh in volo: N preflight simultanei a cache scaduta non
// devono lanciare N query identiche.
let tenantDomainsRefreshing: Promise<void> | null = null;

const refreshTenantDomains = async (): Promise<void> => {
    try {
        // Lettura di piattaforma: la allowlist CORS è per definizione l'unione
        // dei domini di TUTTI i tenant.
        const res = await runAsPlatform(() => queryWithRetry('SELECT domain FROM tenant_domains'));
        tenantDomainsCache = new Set(
            res.rows.map((r: { domain: string }) => String(r.domain).trim().toLowerCase())
        );
    } catch (err: any) {
        // DB non pronto (boot: le migration girano dopo la listen) o giù:
        // si tiene la cache precedente e si ritenta al prossimo TTL — meglio
        // negare un dominio custom per 60s che martellare un DB in affanno
        // a ogni richiesta.
        console.warn('[cors] refresh tenant_domains fallito:', err?.message || err);
    } finally {
        tenantDomainsFetchedAt = Date.now();
    }
};

const getTenantDomains = async (): Promise<Set<string>> => {
    if (Date.now() - tenantDomainsFetchedAt >= TENANT_DOMAINS_TTL_MS) {
        if (!tenantDomainsRefreshing) {
            tenantDomainsRefreshing = refreshTenantDomains().finally(() => {
                tenantDomainsRefreshing = null;
            });
        }
        await tenantDomainsRefreshing;
    }
    return tenantDomainsCache;
};

// Hostname "di piattaforma" dagli env, con gli stessi fallback storici di
// paymentProviderService (CRM) e del link caparra (booking): un deploy senza
// env configurati continua a servire il Frantoio.
const platformHostnames = (): Set<string> => {
    const hosts = new Set<string>();
    for (const base of [
        process.env.CRM_APP_BASE_URL || 'https://crm.vecchiofrantoio.com',
        process.env.PUBLIC_BOOKING_BASE_URL || 'https://prenotazioni.vecchiofrantoio.com',
    ]) {
        try {
            hosts.add(new URL(base.trim()).hostname.toLowerCase());
        } catch {
            // Env malformato: si ignora la voce invece di rompere ogni CORS.
        }
    }
    return hosts;
};

// Decide se un Origin può parlare con l'API. Usata sia dal middleware cors
// di Express sia dal cors del handshake Socket.IO: la risposta DEVE essere
// identica, o il client carica la SPA ma non riceve gli eventi real-time.
export const isAllowedOrigin = async (origin: string | undefined): Promise<boolean> => {
    // Scappatoia di emergenza: riapre tutto (per debugging, com'era prima).
    if (process.env.CORS_ALLOW_ALL === 'true') return true;

    // Nessun header Origin: curl, print-agent, webhook, app native.
    if (!origin) return true;

    let hostname: string;
    try {
        hostname = new URL(origin).hostname.toLowerCase();
    } catch {
        return false; // Origin malformato: negare, non indovinare.
    }

    // Sviluppo locale, qualunque porta.
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

    // Deploy preview: suffix match sul dominio, NON `includes()` — un
    // "vercel.app.attacker.com" non deve passare.
    if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app')) return true;
    if (hostname === 'railway.app' || hostname.endsWith('.railway.app')) return true;

    if (platformHostnames().has(hostname)) return true;

    // Domini custom dei tenant (booking e CRM) da tenant_domains.
    const tenantDomains = await getTenantDomains();
    return tenantDomains.has(hostname);
};
