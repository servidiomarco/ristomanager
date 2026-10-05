// La politica d'accesso del nodo di sala (fase A2 del piano «sala, comande e
// conto sul nodo»). Solo col profilo service-node; server.ts la inietta in
// authMiddleware con setNodeAccessPolicy.
//
// Due regole:
// 1. Il nodo serve UN ristorante, quello del suo cursore di replica: un token
//    di un altro tenant, pur firmato dal cloud, qui viene rifiutato.
// 2. La proroga a linea giù. Login e refresh vivono nel cloud: con la linea
//    caduta un cameriere non può rinnovare l'access token, e dopo qualche ora
//    di guasto i palmari cadrebbero tutti insieme, in pieno servizio. Sul
//    nodo un token SCADUTO vale ancora se:
//    - l'uplink col cloud è giù (isCloudUplinkDown): a linea su il client
//      deve rinnovare, e la proroga non serve;
//    - è scaduto da meno di SALA_NODE_OFFLINE_GRACE_HOURS (12 di default);
//    - il tenant è quello del nodo;
//    - l'utente esiste ed è attivo nella copia locale (la sincronizzazione
//      della configurazione porta qui le disattivazioni fatte nel cloud).
//    La firma si verifica sempre per intero: si ignora solo la scadenza.

import pool, { runAsPlatform, queryWithRetry, runWithTenantContext } from '../db.js';
import type { TokenPayload } from '../auth/authService.js';
import type { NodeAccessPolicy, OfflineGraceVerdict } from '../auth/authMiddleware.js';
import { isCloudUplinkDown } from './salaNodeReplica.js';

const GRACE_MS = Math.max(0, Number(process.env.SALA_NODE_OFFLINE_GRACE_HOURS ?? 12)) * 60 * 60 * 1000;
const USER_CACHE_MS = 30_000;

// Il tenant si legge al bisogno finché il bootstrap non l'ha scritto
// (authMiddleware lo chiede a ogni richiesta finché manca); poi non cambia.
let nodeTenantId: number | null = null;

// rls-bypass: solo nodo, nessuna sessione: il tenant del nodo È quello del suo cursore di replica
const loadNodeTenant = async (): Promise<number | null> => runAsPlatform(async () => {
    if (nodeTenantId !== null) return nodeTenantId;
    try {
        // rls-bypass: solo nodo (superuser locale, un tenant): il cursore 'cloud' è unico
        const cur = await pool.query(`SELECT tenant_id FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
        const id = Number(cur.rows[0]?.tenant_id);
        if (Number.isInteger(id) && id > 0) nodeTenantId = id;
    } catch { /* tabella non ancora migrata: si riprova al giro dopo */ }
    return nodeTenantId;
});

const userActive = new Map<string, { active: boolean; at: number }>();

const isUserActiveLocally = async (tenantId: number, userId: number): Promise<boolean> => {
    const key = `${tenantId}:${userId}`;
    const cached = userActive.get(key);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.active;
    const rs = await runWithTenantContext(tenantId, () => queryWithRetry(
        `SELECT is_active FROM users WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId]
    ));
    const active = rs.rows[0]?.is_active === true;
    userActive.set(key, { active, at: Date.now() });
    return active;
};

const offlineGrace = async (payload: TokenPayload, expiresAtMs: number | null): Promise<OfflineGraceVerdict> => {
    if (!isCloudUplinkDown()) return 'not_offline';
    // Solo access token veri: uno step-up (purpose, niente ruolo) o un
    // token senza identità non diventa un accesso perché è scaduto.
    if ((payload as any).purpose || typeof payload.role !== 'string' || !Number.isInteger(payload.userId)) return 'invalid';
    if (expiresAtMs === null || Date.now() - expiresAtMs > GRACE_MS) return 'expired_offline';
    if (nodeTenantId === null || payload.tenantId !== nodeTenantId) return 'expired_offline';
    return (await isUserActiveLocally(nodeTenantId, payload.userId)) ? 'ok' : 'expired_offline';
};

export const salaNodeAccessPolicy: NodeAccessPolicy = {
    nodeTenant: () => nodeTenantId,
    loadNodeTenant,
    offlineGrace,
};

export const startSalaNodeAccess = (): void => {
    void loadNodeTenant();
    // La cache degli utenti non deve crescere senza limiti.
    const cacheTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of userActive) {
            if (now - entry.at >= USER_CACHE_MS) userActive.delete(key);
        }
    }, USER_CACHE_MS);
    if (typeof cacheTimer.unref === 'function') cacheTimer.unref();
};
