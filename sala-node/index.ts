// Nodo di sala — processo LAN del ristorante (tappa 3 del piano ibrido).
//
// Gira sul PC di sala accanto a print agent e agente Passepartout, e tiene
// vivi palmari e monitor di cucina anche a linea caduta:
//   - relay Socket.IO: il cloud specchia ogni broadcast su /sala-node
//     (uplink.ts) e il nodo lo rigioca ai client LAN (localSocket.ts);
//   - cache di lettura: i GET del dominio sala passano dal nodo verso il
//     cloud, e a cloud irraggiungibile risponde l'ultima copia (readCache.ts).
// Le SCRITTURE non passano di qui: vanno sempre al cloud (coda offline dei
// client) — il nodo non è un'autorità, è un ripetitore con la memoria.
//
// Avvio (dal checkout del repo, Node >= 20):
//   SALA_NODE_TOKEN=<tenants.sala_node_token>  \
//   CLOUD_URL=https://ristomanager-production.up.railway.app \
//   node --loader ts-node/esm sala-node/index.ts
//
// Su Windows: attività pianificata AtStartup come SYSTEM, restart 1 minuto —
// identica agli altri due agenti (vedi README.md in questa cartella).

import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchCredentials, loadPersisted, persist, type SalaNodeCredentials } from './credentials.js';
import { verifyClientToken, isOriginAllowed } from './auth.js';
import { createReadCache } from './readCache.js';
import { createLocalSocket } from './localSocket.js';
import { createUplink } from './uplink.js';

const TOKEN = (process.env.SALA_NODE_TOKEN || '').trim();
const CLOUD_URL = (process.env.CLOUD_URL || 'https://ristomanager-production.up.railway.app').trim().replace(/\/+$/, '');
const VERSION = process.env.SALA_NODE_VERSION || 'dev';
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'state', 'credentials.json');
const CREDENTIALS_REFRESH_MS = 12 * 60 * 60 * 1000;

if (!TOKEN) {
    console.error('Config mancante: serve SALA_NODE_TOKEN (tenants.sala_node_token, da Impostazioni → webhook-info).');
    process.exit(1);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Bootstrap credenziali: prima il cloud (con backoff), poi l'ultima copia su
// disco — un riavvio del nodo durante un outage deve ripartire comunque.
async function obtainCredentials(): Promise<SalaNodeCredentials> {
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
        try {
            const creds = await fetchCredentials(CLOUD_URL, TOKEN);
            persist(STATE_FILE, creds);
            return creds;
        } catch (err: any) {
            const persisted = loadPersisted(STATE_FILE);
            if (persisted) {
                console.warn(`[sala-node] cloud non raggiungibile (${err?.message || err}): riparto dalle credenziali persistite`);
                return persisted;
            }
            console.warn(`[sala-node] credenziali non disponibili (tentativo ${attempt}): ${err?.message || err}`);
            await sleep(delay);
            delay = Math.min(delay * 2, 60_000);
        }
    }
}

const main = async () => {
    let creds = await obtainCredentials();
    console.log(`[sala-node] credenziali ok: tenant ${creds.tenant_id}, dominio ${creds.domain ?? '(non configurato)'}`);

    // Con certificato si serve HTTPS (i client arrivano dalla SPA su Vercel,
    // che è HTTPS: un nodo in chiaro sarebbe mixed content). Senza — collaudo
    // locale o dominio non ancora provisionato — si parte in HTTP.
    const useTls = Boolean(creds.cert);
    const PORT = Number(process.env.PORT) || (useTls ? 443 : 8080);

    const readCache = createReadCache({
        cloudUrl: CLOUD_URL,
        verifyBearer: (header) => {
            const m = /^Bearer\s+(.+)$/i.exec(header || '');
            if (!m) return false;
            return verifyClientToken(m[1], {
                secret: creds.jwt_secret,
                tenantId: creds.tenant_id,
                cloudUp: uplink.isCloudUp(),
            }) != null;
        },
        corsHeaders: (origin) => {
            if (!isOriginAllowed(origin, creds.allowed_origins, creds.domain)) return null;
            return {
                ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                // Senza expose la SPA (cross-origin) non può leggere il
                // marchio staleness e il banner "dati fermi" non esisterebbe.
                'Access-Control-Expose-Headers': 'X-Sala-Node, X-Sala-Node-Age',
                'Access-Control-Max-Age': '600',
            };
        },
    });

    const requestListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const path = new URL(req.url || '/', 'http://sala-node.local').pathname;
        // Healthcheck senza auth, solo numeri di servizio: raggiungibile solo
        // dalla LAN, è il primo comando del playbook "il nodo è vivo?".
        if (path === '/healthz') {
            const stats = readCache.stats();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
                ok: true,
                version: VERSION,
                cloud_link: uplink.isCloudUp(),
                clients: io.engine.clientsCount,
                cache_entries: stats.entries,
                oldest_cache_age_s: stats.oldestAgeSeconds,
                cert_expires_at: creds.cert?.expires_at ?? null,
            }));
            return;
        }
        void readCache.handle(req, res);
    };

    const server = useTls
        ? https.createServer({ cert: creds.cert!.cert_pem, key: creds.cert!.key_pem }, requestListener)
        : http.createServer(requestListener);

    const io = createLocalSocket(server, {
        tenantId: () => creds.tenant_id,
        jwtSecret: () => creds.jwt_secret,
        allowedHostnames: () => creds.allowed_origins,
        nodeDomain: () => creds.domain,
        cloudUp: () => uplink.isCloudUp(),
    });

    const uplink = createUplink({
        cloudUrl: CLOUD_URL,
        token: TOKEN,
        onRelay({ rooms, event, data, exclude_socket_id }) {
            // exclude_socket_id è l'id di un socket sul CLOUD: qui non esiste
            // mai, quindi si rigioca a tutti. I client LAN che hanno originato
            // la scrittura l'hanno fatta verso il cloud con l'id cloud — ma il
            // loro socket vive qui: il de-dup resta a carico dei listener,
            // idempotenti per contratto.
            const target = exclude_socket_id ? io.to(rooms).except(exclude_socket_id) : io.to(rooms);
            target.emit(event, data);
        },
        onReconnect() {
            // Dopo un buco la cache non è più "stato congelato" e i client
            // possono aver perso eventi: si svuota e si ordina il resync (gli
            // schermi ricaricano come già fanno sull'evento connect).
            readCache.invalidateAll();
            io.to(`tenant:${creds.tenant_id}`).emit('sala:resync', { at: Date.now() });
            console.log('[sala-node] uplink ripristinato: cache svuotata, sala:resync inviato');
        },
        getStats() {
            const stats = readCache.stats();
            return {
                clients: io.engine.clientsCount,
                cache_entries: stats.entries,
                oldest_cache_age_s: stats.oldestAgeSeconds,
                version: VERSION,
            };
        },
    });

    // Refresh periodico: segreto ruotato, allowlist aggiornata, certificato
    // rinnovato — con hot-swap del contesto TLS, senza riavvio.
    const refreshTimer = setInterval(async () => {
        try {
            const fresh = await fetchCredentials(CLOUD_URL, TOKEN);
            persist(STATE_FILE, fresh);
            const certChanged = fresh.cert?.cert_pem !== creds.cert?.cert_pem;
            creds = fresh;
            if (certChanged && useTls && fresh.cert) {
                (server as https.Server).setSecureContext({ cert: fresh.cert.cert_pem, key: fresh.cert.key_pem });
                console.log('[sala-node] certificato TLS aggiornato a caldo');
            }
        } catch (err: any) {
            console.warn('[sala-node] refresh credenziali fallito (riprovo tra 12h):', err?.message || err);
        }
    }, CREDENTIALS_REFRESH_MS);
    refreshTimer.unref?.();

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[sala-node] in ascolto su ${useTls ? 'https' : 'http'}://0.0.0.0:${PORT} (cloud: ${CLOUD_URL})`);
    });
};

main().catch(err => {
    console.error('[sala-node] avvio fallito:', err);
    process.exit(1);
});
