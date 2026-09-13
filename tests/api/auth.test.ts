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

    it('il token e /auth/me portano il tenant (Fase B2)', async () => {
        const login = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        expect(login.status).toBe(200);
        expect(login.body.user.tenant).toEqual({
            id: 1,
            slug: 'vecchio-frantoio',
            name: 'Il Vecchio Frantoio',
            // Entitlements commerciali (Fase C1): il tenant 1 è grandfathered,
            // il seed della migration tenant-features li accende tutti.
            features: { voice: true, whatsapp: true, web_booking: true, pay_at_table: true, passepartout: true },
            // Onboarding (coda D1): i tenant nati prima del wizard sono
            // backfillati a completato.
            needs_onboarding: false,
        });

        // Il claim tenantId sta nel payload del JWT (segmento centrale).
        const payload = JSON.parse(
            Buffer.from(login.body.accessToken.split('.')[1], 'base64url').toString()
        );
        expect(payload.tenantId).toBe(1);

        const me = await api().get('/auth/me').set(bearer(login.body.accessToken));
        expect(me.body.tenant.slug).toBe('vecchio-frantoio');
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

        // Finestra di grazia della rotazione: il token appena ruotato passa
        // ancora (risposta persa in rete → il client ritenta col vecchio).
        // NON è il vecchio replay-sempre-valido di bcrypt troncato a 72
        // byte: un token mai emesso da questa sessione sotto è un 401 secco.
        const replay = await api().post('/auth/refresh').send({ refreshToken: primo });
        expect(replay.status).toBe(200);

        const estraneo = await api().post('/auth/refresh').send({
            refreshToken: primo.slice(0, -2) + 'xx',
        });
        expect(estraneo.status).toBe(401);

        // E il logout senza body revoca tutto: nemmeno l'ultimo token
        // emesso passa più.
        const logout = await api()
            .post('/auth/logout')
            .set(bearer(login.body.accessToken))
            .send({});
        expect(logout.status).toBe(200);

        const dopoLogout = await api().post('/auth/refresh').send({
            refreshToken: replay.body.refreshToken,
        });
        expect(dopoLogout.status).toBe(401);
    });

    it('due dispositivi sullo stesso account convivono e si sloggano uno alla volta', async () => {
        // Il caso reale dei palmari: stesso utente loggato su più device.
        // Con l'hash unico su users il secondo login revocava il primo, che
        // moriva alla scadenza dell'access token — a metà servizio.
        const deviceA = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        const deviceB = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: OWNER_PASSWORD,
        });
        expect(deviceA.status).toBe(200);
        expect(deviceB.status).toBe(200);

        // Entrambe le sessioni si rinnovano, in qualunque ordine.
        const refreshA = await api().post('/auth/refresh').send({ refreshToken: deviceA.body.refreshToken });
        const refreshB = await api().post('/auth/refresh').send({ refreshToken: deviceB.body.refreshToken });
        expect(refreshA.status).toBe(200);
        expect(refreshB.status).toBe(200);

        // Logout del solo device A (refresh token nel body): B resta dentro.
        const logoutA = await api()
            .post('/auth/logout')
            .set(bearer(refreshA.body.accessToken))
            .send({ refreshToken: refreshA.body.refreshToken });
        expect(logoutA.status).toBe(200);

        const refreshADopo = await api().post('/auth/refresh').send({ refreshToken: refreshA.body.refreshToken });
        expect(refreshADopo.status).toBe(401);

        const refreshBDopo = await api().post('/auth/refresh').send({ refreshToken: refreshB.body.refreshToken });
        expect(refreshBDopo.status).toBe(200);
    });
});
