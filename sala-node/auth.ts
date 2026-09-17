// Verifica dei client LAN sul nodo: stessa moneta del cloud (JWT HS256 col
// segreto provisionato da /sala-node/credentials), così un token valido per
// Railway è valido per il nodo e viceversa — nessuna seconda identità.
//
// La sola differenza dal cloud è la GRAZIA sull'exp: durante un outage lungo
// i token scadono (6h) e il refresh richiede il cloud. Un monitor di cucina
// che si spegne a metà servizio perché "il token è scaduto" mentre la linea
// è giù vanificherebbe il nodo: a uplink caduto si accettano token scaduti
// da meno di 12 ore. È deliberatamente limitata: solo con cloud
// irraggiungibile, e il nodo comunque serve SOLO letture e subscribe — le
// scritture vanno sempre al cloud, che la grazia non ce l'ha.

import jwt from 'jsonwebtoken';

export interface ClientTokenPayload {
    userId: number;
    email: string;
    role: string;
    tenantId: number;
}

const EXPIRED_GRACE_MS = 12 * 60 * 60 * 1000;

interface VerifyOpts {
    secret: string;
    tenantId: number;
    cloudUp: boolean;
}

export function verifyClientToken(token: string, opts: VerifyOpts): ClientTokenPayload | null {
    let payload: any;
    try {
        payload = jwt.verify(token, opts.secret);
    } catch (err: any) {
        if (err?.name !== 'TokenExpiredError' || opts.cloudUp) return null;
        try {
            payload = jwt.verify(token, opts.secret, { ignoreExpiration: true });
        } catch {
            return null;
        }
        const expMs = Number(payload?.exp) * 1000;
        if (!Number.isFinite(expMs) || Date.now() - expMs > EXPIRED_GRACE_MS) return null;
    }
    // Stesso fallback del cloud (socketService): i token pre-B2 non hanno il
    // claim tenant → 1. Un token di un ALTRO tenant si rifiuta: il nodo è di
    // un ristorante solo.
    const tenantId = Number.isInteger(payload?.tenantId) && payload.tenantId > 0 ? payload.tenantId : 1;
    if (tenantId !== opts.tenantId) return null;
    return {
        userId: Number(payload?.userId),
        email: String(payload?.email ?? ''),
        role: String(payload?.role ?? ''),
        tenantId,
    };
}

// Allowlist Origin, versione LAN: le regole cablate del cloud (localhost,
// preview Vercel/Railway) più gli hostname spediti dalle credenziali
// (piattaforma + domini del tenant) più il dominio del nodo stesso.
export function isOriginAllowed(origin: string | undefined, allowedHostnames: string[], nodeDomain: string | null): boolean {
    if (!origin) return true; // curl, healthcheck, app native: niente CORS.
    let hostname: string;
    try {
        hostname = new URL(origin).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app')) return true;
    if (hostname === 'railway.app' || hostname.endsWith('.railway.app')) return true;
    if (nodeDomain && hostname === nodeDomain.toLowerCase()) return true;
    return allowedHostnames.some(h => h.toLowerCase() === hostname);
}
