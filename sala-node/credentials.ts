// Credenziali del nodo di sala: scaricate dal cloud (/sala-node/credentials)
// e persistite su disco, così un riavvio del nodo DURANTE un outage riparte
// comunque con allowlist e certificato — è esattamente lo scenario per cui
// il nodo esiste. Il file di stato contiene segreti veri (la chiave privata
// TLS): sta in sala-node/state/ (gitignorato) e non va mai loggato.
// Il segreto JWT dal 25/09 il cloud non lo consegna più (chi aveva il token
// del nodo poteva firmarsi un PLATFORM_ADMIN): il relay lo legge dall'env
// JWT_SECRET, come il full-server. jwt_secret resta opzionale qui solo per
// i file di stato scritti prima.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SalaNodeCredentials {
    tenant_id: number;
    domain: string | null;
    port: number;
    jwt_secret?: string;
    allowed_origins: string[];
    cert: { cert_pem: string; key_pem: string; expires_at: string } | null;
}

function isValid(c: any): c is SalaNodeCredentials {
    return c
        && Number.isInteger(c.tenant_id) && c.tenant_id > 0
        && Array.isArray(c.allowed_origins);
}

export async function fetchCredentials(cloudUrl: string, token: string): Promise<SalaNodeCredentials> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(`${cloudUrl}/sala-node/credentials`, {
            headers: { 'x-sala-node-token': token },
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`credenziali: il cloud ha risposto ${res.status}`);
        }
        const body = await res.json();
        if (!isValid(body)) {
            throw new Error('credenziali: payload malformato');
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

export function loadPersisted(stateFile: string): SalaNodeCredentials | null {
    try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
        return isValid(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function persist(stateFile: string, creds: SalaNodeCredentials): void {
    try {
        mkdirSync(dirname(stateFile), { recursive: true });
        // mode 0600: il file porta la chiave privata TLS. Il segreto JWT di
        // un vecchio file di stato non si riscrive.
        const { jwt_secret: _legacy, ...toStore } = creds;
        writeFileSync(stateFile, JSON.stringify(toStore), { mode: 0o600 });
    } catch (err: any) {
        console.error('[sala-node] persistenza credenziali fallita:', err?.message || err);
    }
}
