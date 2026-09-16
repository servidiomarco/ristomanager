// Credenziali del nodo di sala: scaricate dal cloud (/sala-node/credentials)
// e persistite su disco, così un riavvio del nodo DURANTE un outage riparte
// comunque con segreto JWT e certificato — è esattamente lo scenario per cui
// il nodo esiste. Il file di stato contiene segreti veri: sta in
// sala-node/state/ (gitignorato) e non va mai loggato.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SalaNodeCredentials {
    tenant_id: number;
    domain: string | null;
    port: number;
    jwt_secret: string;
    allowed_origins: string[];
    cert: { cert_pem: string; key_pem: string; expires_at: string } | null;
}

function isValid(c: any): c is SalaNodeCredentials {
    return c
        && Number.isInteger(c.tenant_id) && c.tenant_id > 0
        && typeof c.jwt_secret === 'string' && c.jwt_secret.length > 0
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
        // mode 0600: il file porta il segreto JWT e la chiave privata TLS.
        writeFileSync(stateFile, JSON.stringify(creds), { mode: 0o600 });
    } catch (err: any) {
        console.error('[sala-node] persistenza credenziali fallita:', err?.message || err);
    }
}
