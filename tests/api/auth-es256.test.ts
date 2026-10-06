import { describe, it, expect } from 'vitest';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { Client } from 'pg';
import { api, bearer } from './helpers';

// Firma ES256 degli access token (fase A1 del piano «sala, comande e conto
// sul nodo»). La suite gira con JWT_SIGN_ES256=1 (globalSetup): il cloud
// firma con una chiave privata usa e getta, i nodi verificano con la sola
// pubblica. Qui i casi che un nodo — o chiunque abbia la pubblica — non deve
// poter sfruttare.

const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL as string;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD as string;

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const parts = (token: string) => {
    const [h, p] = token.split('.');
    return {
        header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
        payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    };
};
// JWT costruiti a mano: la libreria rifiuterebbe di firmare proprio i token
// malevoli che servono qui.
const hs256 = (header: object, payload: object, secret: string | Buffer): string => {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
};

const loginOwner = async () => {
    const res = await api().post('/auth/login').send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    return res.body as { accessToken: string; refreshToken: string };
};

const publicKeys = async (): Promise<Array<{ kid: string; pem: string }>> => {
    const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await db.connect();
    try {
        const t = await db.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        const res = await api().get('/sala-node/credentials').set('x-sala-node-token', t.rows[0].sala_node_token);
        expect(res.status).toBe(200);
        return res.body.jwt_public_keys;
    } finally {
        await db.end();
    }
};

describe('access token ES256', () => {
    it('il login emette token ES256 con kid, verificati dal server', async () => {
        const { accessToken, refreshToken } = await loginOwner();
        const { header } = parts(accessToken);
        expect(header.alg).toBe('ES256');
        expect(typeof header.kid).toBe('string');
        expect((await publicKeys()).map(k => k.kid)).toContain(header.kid);
        const me = await api().get('/auth/me').set(bearer(accessToken));
        expect(me.status).toBe(200);
        // Il refresh resta HS256 e solo nel cloud: non serve a nessun nodo.
        expect(parts(refreshToken).header.alg).toBe('HS256');
        const rinnovo = await api().post('/auth/refresh').send({ refreshToken });
        expect(rinnovo.status).toBe(200);
        expect(parts(rinnovo.body.accessToken).header.alg).toBe('ES256');
    });

    it('in transizione accetta ancora i token HS256 già emessi', async () => {
        const { accessToken } = await loginOwner();
        const { payload } = parts(accessToken);
        const legacy = hs256({ alg: 'HS256', typ: 'JWT' }, payload, 'test-jwt-secret');
        const me = await api().get('/auth/me').set(bearer(legacy));
        expect(me.status).toBe(200);
    });

    it('rifiuta un HS256 firmato con la chiave pubblica come segreto (algorithm confusion)', async () => {
        const { accessToken } = await loginOwner();
        const { header, payload } = parts(accessToken);
        const pem = (await publicKeys()).find(k => k.kid === header.kid)!.pem;
        for (const secret of [pem, pem.trim(), Buffer.from(pem)]) {
            const forged = hs256({ alg: 'HS256', typ: 'JWT', kid: header.kid }, payload, secret);
            const res = await api().get('/auth/me').set(bearer(forged));
            expect(res.status).toBe(401);
        }
    });

    it('rifiuta alg none, kid sconosciuto e una firma ES256 di un\'altra chiave', async () => {
        const { accessToken } = await loginOwner();
        const { header, payload } = parts(accessToken);

        const none = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
        expect((await api().get('/auth/me').set(bearer(none))).status).toBe(401);

        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const es256 = (kid: string) => {
            const input = `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))}.${b64url(JSON.stringify(payload))}`;
            const sig = cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
            return `${input}.${sig.toString('base64url')}`;
        };
        expect((await api().get('/auth/me').set(bearer(es256('kid-inventato')))).status).toBe(401);
        expect((await api().get('/auth/me').set(bearer(es256(header.kid)))).status).toBe(401);
    });
});
