import { describe, it, expect } from 'vitest';
import { api, bearer } from './helpers';

const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL as string;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD as string;

describe('auth', () => {
    it('rifiuta login senza campi', async () => {
        const res = await api().post('/auth/login').send({});
        expect(res.status).toBe(400);
    });

    it('rifiuta credenziali sbagliate', async () => {
        const res = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: 'password-sbagliata',
        });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('logga il seed owner e ritorna token e permessi', async () => {
        const res = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.user.email).toBe(OWNER_EMAIL);
        expect(res.body.user.role).toBe('OWNER');
        expect(Array.isArray(res.body.permissions)).toBe(true);
        expect(res.body.permissions.length).toBeGreaterThan(0);
    });

    it('protegge /auth/me e la serve col token', async () => {
        const senzaToken = await api().get('/auth/me');
        expect(senzaToken.status).toBe(401);

        const login = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        const me = await api().get('/auth/me').set(bearer(login.body.accessToken));
        expect(me.status).toBe(200);
        expect(me.body.email).toBe(OWNER_EMAIL);
        expect(Array.isArray(me.body.permissions)).toBe(true);
    });

    it('rinnova i token col refresh e li revoca al logout', async () => {
        const login = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        const primo = login.body.refreshToken as string;

        // Un secondo di attesa: due JWT emessi nello stesso secondo hanno lo
        // stesso iat e sono byte-identici, e il not.toBe sotto non proverebbe
        // nulla.
        await new Promise(resolve => setTimeout(resolve, 1100));

        const refresh = await api().post('/auth/refresh').send({ refreshToken: primo });
        expect(refresh.status).toBe(200);
        expect(refresh.body.accessToken).toBeTruthy();
        expect(refresh.body.refreshToken).not.toBe(primo);

        // La rotazione revoca il token precedente: il replay deve fallire.
        // (Il confronto passa dal digest SHA-256 del token: senza, bcrypt
        // tronca a 72 byte e qualunque refresh JWT dell'utente passerebbe.)
        const replay = await api().post('/auth/refresh').send({ refreshToken: primo });
        expect(replay.status).toBe(401);

        // E il logout azzera l'hash: nemmeno l'ultimo token emesso passa più.
        const logout = await api()
            .post('/auth/logout')
            .set(bearer(login.body.accessToken))
            .send({});
        expect(logout.status).toBe(200);

        const dopoLogout = await api().post('/auth/refresh').send({
            refreshToken: refresh.body.refreshToken,
        });
        expect(dopoLogout.status).toBe(401);
    });
});
