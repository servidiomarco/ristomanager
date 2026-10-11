// I segreti delle integrazioni salvati nel database (oggi il token d'accesso
// di Meta di ogni ristorante), cifrati con AES-256-GCM. La chiave sta solo
// nell'ambiente (INTEGRATION_SECRETS_KEY, 32 byte in base64 o in esadecimale):
// un dump del database da solo non basta a mandare messaggi a nome di un
// locale. Senza chiave non si salva niente: meglio un collegamento rifiutato
// che un token in chiaro.

import crypto from 'crypto';

const PREFIX = 'v1:';

function keyFrom(env: NodeJS.ProcessEnv = process.env): Buffer | null {
    const raw = (env.INTEGRATION_SECRETS_KEY || '').trim();
    if (!raw) return null;
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
}

export function isSecretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return keyFrom(env) != null;
}

/** `v1:` + base64(iv 12 byte | tag 16 byte | testo cifrato). */
export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
    const key = keyFrom(env);
    if (!key) throw new Error('INTEGRATION_SECRETS_KEY mancante o non valida (32 byte)');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
    const key = keyFrom(env);
    if (!key) throw new Error('INTEGRATION_SECRETS_KEY mancante o non valida (32 byte)');
    if (!stored.startsWith(PREFIX)) throw new Error('segreto in un formato sconosciuto');
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
