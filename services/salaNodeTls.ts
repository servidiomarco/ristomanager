// Provisioning TLS per il nodo di sala (tappa 3 ibrido, PR 4).
//
// Il nodo serve HTTPS in LAN su un sottodominio per installazione
// (sala.<slug>.sympotia.com) il cui record A punta all'IP PRIVATO del nodo.
// Un certificato per un IP di LAN non esiste: la strada è Let's Encrypt con
// challenge DNS-01 — la sfida sta in un TXT pubblico, quindi non serve che
// il nodo sia raggiungibile da internet (non lo è, per costruzione).
//
// Tutto gira QUI, lato cloud: niente certbot/acme.sh sul PC di sala. Il
// certificato finisce in sala_node_certs e il nodo lo scarica da
// /sala-node/credentials (hot-swap ogni 12h, vedi sala-node/index.ts).
// «Il nodo è bestiame»: se muore, il sostituto riscarica tutto.
//
// DNS via API Cloudflare (sympotia.com è già lì). Il record A è DNS-only
// (proxied:false) OBBLIGATORIAMENTE: un record arancione verso un IP privato
// non instrada nulla. Env richiesti:
//   CLOUDFLARE_API_TOKEN  — token con permesso Zone.DNS:Edit sulla zona
//   SALA_NODE_ZONE        — la zona dei nodi (default sympotia.com, audit H-05)
//   ACME_CONTACT_EMAIL    — contatto per l'account Let's Encrypt (opzionale)
//   ACME_STAGING=1        — usa la directory staging (collaudo: cert non fidato
//                           ma niente rate limit di produzione)
//
// Audit isolamento tenant H-05 (25/09): dominio e IP arrivavano liberi da
// qualunque tenant con settings:full, la zona si cercava salendo i suffissi
// col token globale e l'emissione scriveva anche il record A. Il login demo
// della Pizzeria (condiviso coi prospect) poteva così puntare a un IP
// pubblico qualunque host di sympotia.com, apex e www compresi, e farsi
// emettere un certificato. Da qui: zona fissata, dominio solo nella zona e
// mai un host di piattaforma, IP solo privato, record A in una sync a parte.

import * as acme from 'acme-client';
import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACME_ACCOUNT_KEY_SETTING = 'sala_node_acme_account_key';
const RENEW_BEFORE_DAYS = 30;
const RENEW_CHECK_MS = 24 * 60 * 60 * 1000;

export class SalaNodeTlsError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'SalaNodeTlsError';
    }
}

export const isSalaNodeTlsConfigured = (): boolean =>
    Boolean((process.env.CLOUDFLARE_API_TOKEN || '').trim());

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

async function cfRequest(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${(process.env.CLOUDFLARE_API_TOKEN || '').trim()}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.success !== true) {
        const detail = body?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
        throw new SalaNodeTlsError(`Cloudflare: ${detail}`, 'cloudflare');
    }
    return body.result;
}

// La zona è FISSATA (audit H-05). Prima si saliva i suffissi del dominio
// col token globale: un dominio scritto da un tenant qualunque trovava
// qualunque zona visibile al token. Il default è la zona in cui vive oggi il
// nodo del Frantoio (sala.vecchiofrantoio.sympotia.com): nessun env da
// toccare al deploy, e un valore diverso si imposta su Railway.
export const salaNodeZone = (): string =>
    (process.env.SALA_NODE_ZONE || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '') || 'sympotia.com';

async function findZoneId(domain: string): Promise<string> {
    const zone = salaNodeZone();
    if (!domain.endsWith(`.${zone}`)) {
        throw new SalaNodeTlsError(`${domain} non sta nella zona ${zone}`, 'domain_not_allowed');
    }
    const zones = await cfRequest(`/zones?name=${encodeURIComponent(zone)}&status=active`);
    if (Array.isArray(zones) && zones.length > 0) return zones[0].id;
    throw new SalaNodeTlsError(`Nessuna zona Cloudflare ${zone}`, 'zone_not_found');
}

// ---------------------------------------------------------------------------
// Regole su dominio e IP (audit H-05)
// ---------------------------------------------------------------------------

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Etichette che sotto la zona sono (o saranno) host della piattaforma:
// prenota., api., app. esistono già, gli altri sono i nomi che un giorno
// servono. Un nodo non ci si siede mai, nemmeno come sala.<x>.
const RESERVED_LABELS = new Set([
    'www', 'app', 'api', 'prenota', 'crm', 'mail', 'email', 'smtp', 'imap', 'pop', 'mx',
    'ns', 'ns1', 'ns2', 'admin', 'status', 'docs', 'blog', 'help', 'support',
    'static', 'cdn', 'assets', 'staging', 'autoconfig', 'autodiscover',
]);

/**
 * Dominio NUOVO (lo scrive solo la piattaforma): una sola etichetta sotto la
 * zona, nella forma sala.<etichetta>.<zona>, mai l'apex né un nome riservato.
 * Restituisce il codice d'errore, null se va bene.
 */
export function validateNewNodeDomain(domain: string): 'invalid_domain' | 'domain_not_allowed' | 'domain_reserved' | null {
    if (domain.length > 253 || !new RegExp(`^${LABEL}(?:\\.${LABEL})+$`).test(domain)) return 'invalid_domain';
    const m = new RegExp(`^sala\\.(${LABEL})\\.${escapeRe(salaNodeZone())}$`).exec(domain);
    if (!m) return 'domain_not_allowed';
    if (RESERVED_LABELS.has(m[1])) return 'domain_reserved';
    return null;
}

/**
 * Dominio GIÀ SALVATO, sul percorso di emissione, rinnovo e sync DNS: deve
 * stare nella zona fissata, non esserne l'apex né un host di piattaforma.
 * Più largo del pattern delle scritture nuove apposta: il valore vivo del
 * Frantoio (sala.vecchiofrantoio.sympotia.com, lo slug è vecchio-frantoio)
 * resta valido così com'è, qualunque forma avesse.
 */
export function isNodeDomainInZone(domain: string): boolean {
    if (domain.length > 253) return false;
    const m = new RegExp(`^(?:${LABEL}\\.)*(${LABEL})\\.${escapeRe(salaNodeZone())}$`).exec(domain);
    return m != null && !RESERVED_LABELS.has(m[1]);
}

/**
 * IP del nodo: solo LAN privata (RFC1918) o CGNAT 100.64/10 — Tailscale, il
 * ripiego documentato nel README del nodo. Un record A sotto il brand verso
 * un IP pubblico è esattamente il dirottamento dell'audit H-05.
 */
export function isPrivateLanIp(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    const n = parts.map(Number);
    if (parts.some((p, i) => !/^\d{1,3}$/.test(p) || String(n[i]) !== p || n[i] > 255)) return false;
    const [a, b] = n;
    return a === 10
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

// Chi rivendica un dominio: righe certificato e impostazioni di TUTTI i
// tenant (è proprio il confronto fra tenant che serve).
async function readDomainClaims(domain: string): Promise<Array<{ src: 'cert' | 'setting'; tenant_id: number }>> {
    // rls-bypass: unicità del dominio del nodo fra tenant (audit H-05), legge solo tenant_id
    const rs = await runAsPlatform(() => queryWithRetry(
        `SELECT 'cert' AS src, tenant_id FROM sala_node_certs WHERE lower(domain) = $1
         UNION ALL
         SELECT 'setting' AS src, tenant_id FROM app_settings
          WHERE key = 'sala_node_domain' AND lower(text_value) = $1`,
        [domain.toLowerCase()]
    ));
    return rs.rows.map((r: any) => ({ src: r.src, tenant_id: Number(r.tenant_id) }));
}

/** Scrittura nuova: il dominio è preso se un ALTRO tenant lo ha, in impostazioni o in un certificato. */
export async function isNodeDomainTakenByOtherTenant(tenantId: number, domain: string): Promise<boolean> {
    return (await readDomainClaims(domain)).some(c => c.tenant_id !== tenantId);
}

// Percorso di emissione/rinnovo/DNS: le collisioni scritte PRIMA del fix
// (un tenant demo che si è preso sala.vecchiofrantoio…) restano finché la
// piattaforma non pulisce, e non devono bloccare il rinnovo del Frantoio.
// Regola deterministica: vince chi ha già la riga del certificato per quel
// dominio (se l'hanno in più d'uno, l'id più basso); se nessuno ce l'ha e un
// altro tenant rivendica lo stesso dominio, non emette nessuno — lo sblocca
// la pulizia, non chi arriva prima.
async function tenantMayUseNodeDomain(tenantId: number, domain: string): Promise<boolean> {
    const claims = await readDomainClaims(domain);
    const holders = claims.filter(c => c.src === 'cert').map(c => c.tenant_id);
    if (holders.length > 0) return Math.min(...holders) === tenantId;
    return !claims.some(c => c.tenant_id !== tenantId);
}

// I controlli comuni a emissione, rinnovo e sync DNS, PRIMA di qualunque
// chiamata a Cloudflare: valgono anche per le righe scritte prima del fix.
// La regola larga della zona basta alla piattaforma; per il gestore la sync
// DNS aggiunge la sua (vedi syncSalaNodeDnsRecord).
async function usableNodeSettings(tenantId: number): Promise<{ domain: string; lanIp: string | null }> {
    const { domain, lanIp } = await readNodeSettings(tenantId);
    if (!domain) throw new SalaNodeTlsError('Dominio del nodo non configurato', 'no_domain');
    if (!isNodeDomainInZone(domain)) {
        throw new SalaNodeTlsError(`Il dominio ${domain} non è ammesso per un nodo`, 'domain_not_allowed');
    }
    if (!(await tenantMayUseNodeDomain(tenantId, domain))) {
        throw new SalaNodeTlsError(`Il dominio ${domain} è assegnato a un altro ristorante`, 'domain_taken');
    }
    return { domain, lanIp };
}

async function upsertDnsRecord(zoneId: string, record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) {
    const existing = await cfRequest(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
    const payload = { ttl: 60, proxied: false, ...record };
    if (Array.isArray(existing) && existing.length > 0) {
        await cfRequest(`/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
        await cfRequest(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(payload) });
    }
}

async function deleteDnsRecord(zoneId: string, type: string, name: string) {
    const existing = await cfRequest(`/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    for (const r of Array.isArray(existing) ? existing : []) {
        await cfRequest(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
    }
}

// ---------------------------------------------------------------------------
// ACME
// ---------------------------------------------------------------------------

// Chiave account per tenant, riusata a ogni rinnovo (creare un account nuovo
// a ogni giro sarebbe legale ma sciupa i rate limit di Let's Encrypt).
async function getOrCreateAccountKey(tenantId: number): Promise<string> {
    const rs = await queryWithRetry(
        `SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2`,
        [tenantId, ACME_ACCOUNT_KEY_SETTING]
    );
    const existing = rs.rows[0]?.text_value;
    if (existing) return existing;
    const key = (await acme.crypto.createPrivateKey()).toString();
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, ACME_ACCOUNT_KEY_SETTING, key]
    );
    return key;
}

async function readNodeSettings(tenantId: number): Promise<{ domain: string | null; lanIp: string | null }> {
    const rs = await queryWithRetry(
        `SELECT key, text_value FROM app_settings WHERE tenant_id = $1 AND key = ANY($2)`,
        [tenantId, ['sala_node_domain', 'sala_node_lan_ip']]
    );
    const byKey = new Map(rs.rows.map((r: any) => [r.key, r.text_value]));
    return { domain: byKey.get('sala_node_domain') || null, lanIp: byKey.get('sala_node_lan_ip') || null };
}

// Freno per tenant sulla sync DNS (revisione audit H-05, 25/09). Ogni sync
// sono fino a 3 richieste API col token globale di Cloudflare, il cui limite
// (1200 ogni 5 minuti) vale per tutto l'account, dashboard compresa: un
// login con settings:full in loop (il demo@demo.com del Frantoio è
// condiviso coi prospect) bloccava l'account, anche il giorno del rinnovo
// del certificato. Conta solo le sync che hanno passato tutti i controlli e
// stanno per andare al provider: i rifiuti non costano nulla a Cloudflare e
// non devono consumare i tentativi del gestore. 5 al minuto bastano a
// ripuntare il nodo dopo un cambio di IP. In memoria come i limiter di
// express-rate-limit: il cloud è un'istanza sola.
const DNS_SYNC_LIMIT = 5;
const DNS_SYNC_WINDOW_MS = 60 * 1000;
const dnsSyncHits = new Map<number, number[]>();

function takeDnsSyncSlot(tenantId: number): void {
    const now = Date.now();
    const recent = (dnsSyncHits.get(tenantId) ?? []).filter(t => now - t < DNS_SYNC_WINDOW_MS);
    if (recent.length >= DNS_SYNC_LIMIT) {
        dnsSyncHits.set(tenantId, recent);
        throw new SalaNodeTlsError('Troppi aggiornamenti del DNS, riprova tra un minuto', 'rate_limited');
    }
    recent.push(now);
    dnsSyncHits.set(tenantId, recent);
}

// Il tenant ha già un certificato per ESATTAMENTE questo dominio (nel suo
// contesto: niente bypass).
async function tenantHoldsCertFor(tenantId: number, domain: string): Promise<boolean> {
    const rs = await queryWithRetry(
        `SELECT 1 FROM sala_node_certs WHERE tenant_id = $1 AND lower(domain) = $2 LIMIT 1`,
        [tenantId, domain.toLowerCase()]
    );
    return rs.rows.length > 0;
}

/**
 * Allinea il record A del dominio del nodo al suo IP LAN, e nient'altro.
 * Staccata dall'emissione (audit H-05): l'emissione ora è della piattaforma,
 * ma se il PC di sala cambia IP (DHCP) il gestore deve poter ripuntare il
 * record da solo — prima l'unico punto che scriveva il record A era
 * l'emissione. Solo verso IP privati o CGNAT.
 *
 * platform: chiamata da una sessione di piattaforma («Entra»). Revisione del
 * 25/09: la regola larga di isNodeDomainInZone (serve al rinnovo del valore
 * vivo) lasciava al GESTORE un record A su qualunque nome della zona salvato
 * prima del fix (pay.sympotia.com, x.y.sympotia.com…), cioè sopra un host
 * del brand non riservato. Il gestore ora ripunta solo un nome del
 * namespace dei nodi (sala.<etichetta>.<zona>) oppure quello per cui il suo
 * tenant ha già il certificato — il dominio vivo del Frantoio passa da
 * entrambe le strade; il resto lo riallinea la piattaforma.
 */
export async function syncSalaNodeDnsRecord(
    tenantId: number,
    opts: { platform?: boolean } = {}
): Promise<{ domain: string; lan_ip: string }> {
    const { domain, lanIp } = await usableNodeSettings(tenantId);
    if (!opts.platform
        && validateNewNodeDomain(domain.toLowerCase()) !== null
        && !(await tenantHoldsCertFor(tenantId, domain))) {
        throw new SalaNodeTlsError(`Il record di ${domain} lo riallinea la piattaforma`, 'domain_platform_managed');
    }
    if (!lanIp) throw new SalaNodeTlsError('IP LAN del nodo non configurato', 'no_lan_ip');
    if (!isPrivateLanIp(lanIp)) {
        throw new SalaNodeTlsError(`L'IP ${lanIp} non è un indirizzo di rete locale`, 'lan_ip_not_private');
    }
    // Prima del controllo sul token, così il freno si prova anche nei test
    // (dove il token non c'è e la sync si ferma al 503).
    takeDnsSyncSlot(tenantId);
    if (!isSalaNodeTlsConfigured()) {
        throw new SalaNodeTlsError('CLOUDFLARE_API_TOKEN non configurato', 'tls_not_configured');
    }
    const zoneId = await findZoneId(domain);
    await upsertDnsRecord(zoneId, { type: 'A', name: domain, content: lanIp, proxied: false });
    console.log(`[sala-node-tls] record A ${domain} → ${lanIp}`);
    return { domain, lan_ip: lanIp };
}

/**
 * Emette (o rinnova) il certificato del nodo per il tenant: ordina il cert
 * con DNS-01 e lo salva in sala_node_certs. Il record A NON lo tocca più
 * (vedi syncSalaNodeDnsRecord). Sincrona e lenta (la validazione DNS prende
 * decine di secondi): chi la espone via HTTP lo dica nel bottone.
 *
 * manual: emissione dal bottone. Se il certificato del dominio vale ancora
 * oltre la soglia di rinnovo si rifiuta (igiene sui rate limit Let's
 * Encrypt, condivisi da tutto sympotia.com), salvo force.
 */
export async function provisionSalaNodeCert(
    tenantId: number,
    opts: { manual?: boolean; force?: boolean } = {}
): Promise<{ domain: string; expires_at: string }> {
    const { domain } = await usableNodeSettings(tenantId);
    if (opts.manual && !opts.force) {
        const rs = await queryWithRetry(
            `SELECT 1 FROM sala_node_certs
              WHERE tenant_id = $1 AND domain = $2
                AND expires_at >= CURRENT_TIMESTAMP + ($3 || ' days')::interval`,
            [tenantId, domain, String(RENEW_BEFORE_DAYS)]
        );
        if (rs.rows.length > 0) {
            throw new SalaNodeTlsError(
                `Il certificato vale ancora più di ${RENEW_BEFORE_DAYS} giorni: il rinnovo parte da solo`,
                'cert_still_valid'
            );
        }
    }
    if (!isSalaNodeTlsConfigured()) {
        throw new SalaNodeTlsError('CLOUDFLARE_API_TOKEN non configurato', 'tls_not_configured');
    }

    const zoneId = await findZoneId(domain);

    const accountKey = await getOrCreateAccountKey(tenantId);
    const client = new acme.Client({
        directoryUrl: process.env.ACME_STAGING === '1'
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production,
        accountKey,
    });

    const [certKey, csr] = await acme.crypto.createCsr({ commonName: domain });
    const challengeName = `_acme-challenge.${domain}`;
    const certPem = await client.auto({
        csr,
        email: (process.env.ACME_CONTACT_EMAIL || '').trim() || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        // Per il dns-01 acme-client passa già il DIGEST come keyAuthorization:
        // va nel TXT così com'è.
        challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
            await upsertDnsRecord(zoneId, { type: 'TXT', name: challengeName, content: keyAuthorization });
        },
        challengeRemoveFn: async () => {
            await deleteDnsRecord(zoneId, 'TXT', challengeName);
        },
    });

    const info = acme.crypto.readCertificateInfo(certPem);
    const expiresAt = info.notAfter.toISOString();
    await queryWithRetry(
        `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, domain) DO UPDATE
           SET cert_pem = EXCLUDED.cert_pem, key_pem = EXCLUDED.key_pem,
               expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP`,
        [tenantId, domain, certPem.toString(), certKey.toString(), expiresAt]
    );
    console.log(`[sala-node-tls] certificato per ${domain} valido fino a ${expiresAt}`);
    return { domain, expires_at: expiresAt };
}

// Candidati al rinnovo. Audit H-05 e revisione del 25/09: prima si
// prendeva ogni riga in scadenza, ma provisionSalaNodeCert rilegge il
// dominio CORRENTE e fa l'upsert su (tenant, dominio) — una riga rimasta da
// un dominio vecchio non si aggiornava mai e forzava ogni giorno una nuova
// emissione per quello corrente. Ora: solo il certificato del dominio
// corrente, e solo per chi ha l'add-on sala_node.
export const RENEWAL_CANDIDATES_SQL = `
    SELECT c.tenant_id, c.domain
      FROM sala_node_certs c
      JOIN app_settings s
        ON s.tenant_id = c.tenant_id AND s.key = 'sala_node_domain'
       AND lower(s.text_value) = lower(c.domain)
      JOIN tenant_features f
        ON f.tenant_id = c.tenant_id AND f.feature = 'sala_node' AND f.enabled
     WHERE c.expires_at < CURRENT_TIMESTAMP + ($1 || ' days')::interval`;

/**
 * Rinnovo: un giro al giorno sui cert sotto i 30 giorni. Come l'outbox
 * dispatcher: interval unref (non tiene vivo il processo) e partenza a
 * migration riuscite. Un rinnovo fallito si ritenta domani — con 30 giorni
 * di margine c'è tutto il tempo di vedere l'errore nei log.
 */
export function startSalaNodeCertRenewal(): void {
    if (!isSalaNodeTlsConfigured()) return;
    const sweep = async () => {
        let rows: Array<{ tenant_id: number; domain: string }> = [];
        try {
            // rls-bypass: scansione dei certificati in scadenza di tutti i tenant; il rinnovo poi gira nel contesto di ciascuno
            const rs = await runAsPlatform(() => queryWithRetry(RENEWAL_CANDIDATES_SQL, [String(RENEW_BEFORE_DAYS)]));
            rows = rs.rows;
        } catch (err: any) {
            console.error('[sala-node-tls] scan rinnovi fallita:', err?.message || err);
            return;
        }
        for (const row of rows) {
            try {
                await runWithTenantContext(Number(row.tenant_id), () => provisionSalaNodeCert(Number(row.tenant_id)));
            } catch (err: any) {
                console.error(`[sala-node-tls] rinnovo ${row.domain} fallito:`, err?.message || err);
            }
        }
    };
    const timer = setInterval(() => { void sweep(); }, RENEW_CHECK_MS);
    (timer as any).unref?.();
    // Primo giro dopo un minuto dal boot: non in mezzo alla partenza.
    const first = setTimeout(() => { void sweep(); }, 60_000);
    (first as any).unref?.();
}
