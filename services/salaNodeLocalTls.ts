// Il TLS del nodo di sala, lato NODO (tappa 4, rifinitura pre-collaudo).
//
// La PWA esige un contesto sicuro: i palmari arrivano su
// https://sala.<slug>.sympotia.com:8443, e il certificato Let's Encrypt lo
// emette il CLOUD (challenge DNS-01 su Cloudflare) — il nodo se lo scarica
// con le credenziali, come faceva il relay della tappa 3. Qui il full-server
// fa lo stesso: al boot chiede cert+chiave a GET /sala-node/credentials, li
// tiene in cache SU DISCO (un riavvio durante un outage deve ripartire in
// HTTPS comunque), e li rinfresca ogni 12h con setSecureContext — il
// rinnovo del certificato non richiede riavvii.
//
// Senza materiale (primo avvio a linea giù, o dominio mai configurato) si
// parte in HTTP col warn: utile solo in laboratorio, i client veri non
// arriverebbero comunque.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Server as HttpsServer } from 'node:https';

export interface NodeTlsMaterial {
    cert_pem: string;
    key_pem: string;
    expires_at?: string | null;
}

const REFRESH_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

const cachePath = (): string => {
    const dir = process.env.SALA_NODE_STATE_DIR || process.cwd();
    return path.join(dir, 'sala-node-tls.json');
};

const readCache = (): NodeTlsMaterial | null => {
    try {
        const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'));
        if (typeof parsed?.cert_pem === 'string' && typeof parsed?.key_pem === 'string') return parsed;
    } catch { /* assente o corrotta */ }
    return null;
};

const writeCache = (material: NodeTlsMaterial): void => {
    try {
        mkdirSync(path.dirname(cachePath()), { recursive: true });
        writeFileSync(cachePath(), JSON.stringify(material), { mode: 0o600 });
    } catch (err: any) {
        console.warn('[node-tls] cache su disco non scritta:', err?.message || err);
    }
};

const fetchFromCloud = async (): Promise<NodeTlsMaterial | null> => {
    const base = (process.env.SALA_NODE_CLOUD_URL || '').replace(/\/+$/, '');
    const token = process.env.SALA_NODE_TOKEN || '';
    if (!base || !token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/sala-node/credentials`, {
            headers: { 'X-Sala-Node-Token': token, accept: 'application/json' },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body: any = await res.json();
        const cert = body?.cert;
        if (typeof cert?.cert_pem === 'string' && typeof cert?.key_pem === 'string') {
            return { cert_pem: cert.cert_pem, key_pem: cert.key_pem, expires_at: cert.expires_at ?? null };
        }
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/** Il materiale TLS per il listener del nodo: prima il cloud (e si
 *  aggiorna la cache), a cloud muto la copia su disco. null = HTTP. */
export const loadNodeTlsMaterial = async (): Promise<NodeTlsMaterial | null> => {
    const fresh = await fetchFromCloud();
    if (fresh) {
        writeCache(fresh);
        return fresh;
    }
    const cached = readCache();
    if (cached) console.warn('[node-tls] cloud non raggiungibile: certificato dalla cache su disco');
    return cached;
};

/** Rinfresco periodico: il cloud rinnova il certificato ~30 giorni prima
 *  della scadenza, il nodo lo monta a caldo senza riavvii. */
export const startNodeTlsRefresh = (server: HttpsServer, current: NodeTlsMaterial): void => {
    let active = current;
    const timer = setInterval(async () => {
        const fresh = await fetchFromCloud();
        if (!fresh) return;
        if (fresh.cert_pem !== active.cert_pem) {
            try {
                server.setSecureContext({ cert: fresh.cert_pem, key: fresh.key_pem });
                active = fresh;
                writeCache(fresh);
                console.log('[node-tls] certificato aggiornato a caldo');
            } catch (err: any) {
                console.error('[node-tls] setSecureContext fallito:', err?.message || err);
            }
        }
    }, REFRESH_MS);
    if (typeof timer.unref === 'function') timer.unref();
};
