import request from 'supertest';

// Base URL e credenziali arrivano dall'ambiente, popolato da globalSetup.
export const api = () => request(process.env.TEST_BASE_URL as string);

let cachedToken: string | null = null;

// Login del seed owner (ha tutti i permessi). Il token è cache-ato per file
// di test: l'access token vale 6h, ri-loggarsi a ogni richiesta è solo rumore.
export const ownerToken = async (): Promise<string> => {
    if (cachedToken) return cachedToken;
    const res = await api().post('/auth/login').send({
        email: process.env.TEST_OWNER_EMAIL,
        password: process.env.TEST_OWNER_PASSWORD,
    });
    if (res.status !== 200) {
        throw new Error(`Login owner fallito (${res.status}): ${JSON.stringify(res.body)}`);
    }
    cachedToken = res.body.accessToken as string;
    return cachedToken;
};

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
