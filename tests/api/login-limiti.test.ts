import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { withBcryptSlot, BcryptBusyError, replyIfBcryptBusy } from '../../auth/bcryptGate';

// Audit M-07 e L-01: limiti sui tentativi di password, cancello di bcrypt,
// reset che non paga bcrypt per un token a caso, step-up token che non vale
// come sessione, sessioni chiuse dalla password impostata dal titolare.
//
// Ogni gruppo parla da un IP suo (X-Forwarded-For: il server ha trust proxy
// 1, quindi l'ultimo hop È req.ip) — così i contatori di questo file non
// toccano mai quelli di 127.0.0.1, da cui il resto della suite fa i suoi
// login. Gli utenti nascono via SQL con bcrypt a costo 4: i tentativi
// sbagliati qui sono decine, a costo 12 il file durerebbe secondi di troppo.

const PASSWORD = 'password-limiti-1';
const WRONG = 'password-sbagliata-1';
const SUSPENDED_TENANT_ID = 9701;
const EMAILS = {
    a: 'limiti-a@test.local',
    b: 'limiti-b@test.local',
    c: 'limiti-c@test.local',
    pa: 'limiti-piattaforma@test.local',
    sospeso: 'limiti-sospeso@test.local',
    titolare: 'limiti-titolare@test.local',
    disattivo: 'limiti-disattivo@test.local',
    mePassword: 'limiti-me-password@test.local',
};

const fromIp = (ip: string) => ({ 'X-Forwarded-For': ip });
const login = (email: string, password: string, ip: string) =>
    api().post('/auth/login').set(fromIp(ip)).send({ email, password });
// Gli header di express-rate-limit (draft-7 e legacy) più Retry-After.
const rateLimitHeaders = (res: { headers: Record<string, unknown> }) =>
    Object.fromEntries(Object.entries(res.headers).filter(([k]) => /^(ratelimit|x-ratelimit|retry-after)/i.test(k)));

describe('limiti di login, cancello bcrypt e token', () => {
    let db: Client;
    let owner = '';

    const insertUser = async (email: string, role = 'WAITER', tenantId = 1): Promise<number> => {
        const hash = await bcrypt.hash(PASSWORD, 4);
        const res = await db.query(
            `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
             VALUES ($1, $2, $3, 'Utente Limiti', $4) RETURNING id`,
            [tenantId, email, hash, role]
        );
        return Number(res.rows[0].id);
    };

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // Run ripetute sullo stesso database: si riparte puliti.
        await db.query('DELETE FROM users WHERE email = ANY($1::text[])', [Object.values(EMAILS)]);
        await db.query('DELETE FROM tenants WHERE id = $1', [SUSPENDED_TENANT_ID]);
        // Tenant sospeso con id esplicito e alto, via SQL: nessuna sequence
        // toccata e nessun id che un file successivo possa riusare.
        await db.query(
            `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'limiti-sospeso', 'Limiti Sospeso', 'suspended')`,
            [SUSPENDED_TENANT_ID]
        );
    });

    afterAll(async () => {
        await db.query('DELETE FROM users WHERE email = ANY($1::text[])', [Object.values(EMAILS)]);
        await db.query('DELETE FROM tenants WHERE id = $1', [SUSPENDED_TENANT_ID]);
        await db.end();
    });

    it('10 password sbagliate sulla stessa email → 429 anche con quella giusta; altra email o altro IP entrano', async () => {
        await insertUser(EMAILS.a);
        await insertUser(EMAILS.b);
        const ip = '203.0.113.10';

        for (let i = 0; i < 10; i++) {
            const res = await login(EMAILS.a, WRONG, ip);
            expect(res.status, `tentativo ${i + 1}`).toBe(401);
        }
        const bloccato = await login(EMAILS.a, PASSWORD, ip);
        expect(bloccato.status).toBe(429);
        expect(bloccato.body.error).toBe('rate_limited');
        expect(bloccato.body.message).toBe('Troppi tentativi, riprova tra qualche minuto.');

        // La chiave è IP+email: dallo stesso IP un collega entra, e la stessa
        // email da un altro IP pure.
        expect((await login(EMAILS.b, PASSWORD, ip)).status).toBe(200);
        expect((await login(EMAILS.a, PASSWORD, '203.0.113.11')).status).toBe(200);
    });

    it('i login riusciti non consumano il limite', async () => {
        const ip = '203.0.113.12';
        for (let i = 0; i < 12; i++) {
            const res = await login(EMAILS.b, PASSWORD, ip);
            expect(res.status, `login ${i + 1}`).toBe(200);
        }
    });

    it('il tetto per IP ferma cinquanta email diverse dallo stesso indirizzo', async () => {
        const ip = '203.0.113.20';
        for (let i = 0; i < 50; i++) {
            const res = await login(`nessuno-${i}@limiti.test`, WRONG, ip);
            expect(res.status, `email ${i + 1}`).toBe(401);
        }
        expect((await login(EMAILS.b, PASSWORD, ip)).status).toBe(429);
    });

    it('PLATFORM_ADMIN: tetto per email da qualunque IP; un account di ristorante no', async () => {
        await insertUser(EMAILS.pa, 'PLATFORM_ADMIN');
        await insertUser(EMAILS.c);

        const primi: Record<string, Awaited<ReturnType<typeof login>>> = {};
        for (const ip of ['198.51.100.30', '198.51.100.31']) {
            for (let i = 0; i < 10; i++) {
                const res = await login(EMAILS.pa, WRONG, ip);
                expect(res.status).toBe(401);
                primi.pa ??= res;
            }
        }
        // Venti errori da due IP: il terzo IP, con la password giusta, è fuori.
        const bloccato = await login(EMAILS.pa, PASSWORD, '198.51.100.32');
        expect(bloccato.status).toBe(429);
        expect(bloccato.body.error).toBe('rate_limited');

        // Lo stesso schema su un account del ristorante non lo chiude fuori:
        // altrimenti chiunque, da abbastanza IP, bloccherebbe il titolare.
        for (const ip of ['198.51.100.40', '198.51.100.41']) {
            for (let i = 0; i < 10; i++) {
                const res = await login(EMAILS.c, WRONG, ip);
                expect(res.status).toBe(401);
                primi.ristorante ??= res;
            }
        }
        expect((await login(EMAILS.c, PASSWORD, '198.51.100.42')).status).toBe(200);

        // Il primo 401 da un IP nuovo è identico per le due email: prima il
        // tetto di piattaforma scriveva i suoi header («20;w=900» e il
        // contatore globale) solo sull'email del PLATFORM_ADMIN, e un solo
        // tentativo anonimo diceva quale fosse. Nemmeno il 429 ne porta.
        expect(rateLimitHeaders(primi.pa)).toEqual({});
        expect(rateLimitHeaders(primi.ristorante)).toEqual({});
        expect(rateLimitHeaders(bloccato)).toEqual({});
    });

    it('ristorante sospeso: password sbagliata → 401, giusta → 403', async () => {
        await insertUser(EMAILS.sospeso, 'OWNER', SUSPENDED_TENANT_ID);
        const ip = '203.0.113.50';

        // Prima della correzione il 403 arrivava a chiunque provasse l'email:
        // diceva che l'account esiste e che il ristorante è sospeso.
        const sbagliata = await login(EMAILS.sospeso, WRONG, ip);
        expect(sbagliata.status).toBe(401);
        expect(sbagliata.body.error).toBe('Invalid credentials');

        const giusta = await login(EMAILS.sospeso, PASSWORD, ip);
        expect(giusta.status).toBe(403);
        expect(giusta.body.error).toBe('tenant_suspended');
    });

    it('uno step-up token usato come Bearer → 401', async () => {
        const unlock = await api().post('/auth/step-up').set(bearer(owner)).send({
            password: process.env.TEST_OWNER_PASSWORD, scope: 'staff_compensation',
        });
        expect(unlock.status).toBe(200);
        const stepUpToken = unlock.body.stepUpToken as string;

        const me = await api().get('/auth/me').set(bearer(stepUpToken));
        expect(me.status).toBe(401);
    });

    it('un access token firmato con un algoritmo diverso da HS256 → 401', async () => {
        const payload = jwt.decode(owner) as Record<string, unknown>;
        const { iat: _iat, exp: _exp, ...claims } = payload;
        // Stesso segreto dei test (globalSetup), stesso payload: cambia solo
        // l'algoritmo, e basta quello.
        const hs512 = jwt.sign(claims, 'test-jwt-secret', { algorithm: 'HS512', expiresIn: '10m' });
        expect((await api().get('/auth/me').set(bearer(hs512))).status).toBe(401);

        const hs256 = jwt.sign(claims, 'test-jwt-secret', { algorithm: 'HS256', expiresIn: '10m' });
        expect((await api().get('/auth/me').set(bearer(hs256))).status).toBe(200);
    });

    it('/auth/me/password ha il tetto per utente', async () => {
        await insertUser(EMAILS.mePassword);
        const session = await login(EMAILS.mePassword, PASSWORD, '203.0.113.55');
        expect(session.status).toBe(200);
        const token = session.body.accessToken as string;

        for (let i = 0; i < 10; i++) {
            const res = await api().post('/auth/me/password').set(bearer(token))
                .send({ current_password: WRONG, new_password: 'nuova-password-limiti-1' });
            expect(res.status, `tentativo ${i + 1}`).toBe(401);
        }
        const bloccato = await api().post('/auth/me/password').set(bearer(token))
            .send({ current_password: PASSWORD, new_password: 'nuova-password-limiti-1' });
        expect(bloccato.status).toBe(429);
    });

    it('reset-password con token a caso: 400 senza passare da bcrypt, nemmeno in raffica', async () => {
        // Trenta richieste insieme, ognuna da un IP suo (il cap per IP non
        // c'entra qui). Se il server facesse l'hash prima di cercare il token,
        // il cancello di bcrypt (2 in corso, 8 in coda) ne respingerebbe
        // almeno venti con 503.
        const risposte = await Promise.all(Array.from({ length: 30 }, (_, i) =>
            api().post('/auth/reset-password').set(fromIp(`198.51.100.${100 + i}`))
                .send({ token: `${i}`.padStart(64, 'e'), new_password: 'password-valida-1' })
        ));
        for (const res of risposte) {
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_or_expired');
        }
    });

    it('reset-password ha un tetto per IP', async () => {
        const ip = '203.0.113.60';
        for (let i = 0; i < 10; i++) {
            const res = await api().post('/auth/reset-password').set(fromIp(ip))
                .send({ token: 'f'.repeat(64), new_password: 'password-valida-1' });
            expect(res.status, `richiesta ${i + 1}`).toBe(400);
        }
        const bloccato = await api().post('/auth/reset-password').set(fromIp(ip))
            .send({ token: 'f'.repeat(64), new_password: 'password-valida-1' });
        expect(bloccato.status).toBe(429);
    });

    it('password impostata dal titolare: il refresh token di prima muore, la password nuova entra', async () => {
        const id = await insertUser(EMAILS.titolare);
        const session = await login(EMAILS.titolare, PASSWORD, '203.0.113.70');
        expect(session.status).toBe(200);
        const oldRefresh = session.body.refreshToken as string;

        const put = await api().put(`/auth/users/${id}`).set(bearer(owner))
            .send({ password: 'password-dal-titolare-1' });
        expect(put.status).toBe(200);

        // Prima il refresh ignorava la password: il palmare di un ex
        // dipendente restava dentro per sempre.
        const refresh = await api().post('/auth/refresh').send({ refreshToken: oldRefresh });
        expect(refresh.status).toBe(401);

        expect((await login(EMAILS.titolare, 'password-dal-titolare-1', '203.0.113.70')).status).toBe(200);
    });

    it('disattivare e riattivare non riporta dentro i vecchi dispositivi; una modifica del nome sì', async () => {
        const id = await insertUser(EMAILS.disattivo);

        // Modifica "innocua" come la manda UserManagement (tutti i campi,
        // is_active true): la sessione resta viva.
        const primo = await login(EMAILS.disattivo, PASSWORD, '203.0.113.80');
        const nome = await api().put(`/auth/users/${id}`).set(bearer(owner))
            .send({ email: EMAILS.disattivo, full_name: 'Nome Nuovo', role: 'WAITER', is_active: true });
        expect(nome.status).toBe(200);
        const ancoraViva = await api().post('/auth/refresh').send({ refreshToken: primo.body.refreshToken });
        expect(ancoraViva.status).toBe(200);

        const secondo = await login(EMAILS.disattivo, PASSWORD, '203.0.113.80');
        const oldRefresh = secondo.body.refreshToken as string;
        expect((await api().put(`/auth/users/${id}`).set(bearer(owner)).send({ is_active: false })).status).toBe(200);
        expect((await api().put(`/auth/users/${id}`).set(bearer(owner)).send({ is_active: true })).status).toBe(200);

        const refresh = await api().post('/auth/refresh').send({ refreshToken: oldRefresh });
        expect(refresh.status).toBe(401);
    });

    it('il cancello di bcrypt: 2 in corso, 8 in coda, oltre 503; gli slot passano in ordine', async () => {
        // Il modulo in-process, non attraverso il server: dall'esterno quante
        // richieste arrivino insieme al cancello dipende da quanto bcrypt
        // affama l'event loop (cede ogni 100 ms), e un test a tempo sarebbe
        // una moneta lanciata. Qui gli slot si aprono e chiudono a mano.
        const partiti: number[] = [];
        const chiudi: Array<() => void> = [];
        const lavoro = (n: number) => () => new Promise<number>(resolve => {
            partiti.push(n);
            chiudi[n] = () => resolve(n);
        });
        const svuotaMicrotask = () => new Promise(resolve => setImmediate(resolve));

        const dieci = Array.from({ length: 10 }, (_, i) => withBcryptSlot(lavoro(i)));
        await svuotaMicrotask();
        expect(partiti).toEqual([0, 1]);

        // Due in corso e otto in coda: l'undicesimo non aspetta, rifiuta.
        await expect(withBcryptSlot(lavoro(99))).rejects.toBeInstanceOf(BcryptBusyError);

        // Chi finisce cede lo slot al primo in coda, senza scavalcamenti.
        chiudi[1]();
        expect(await dieci[1]).toBe(1);
        await svuotaMicrotask();
        expect(partiti).toEqual([0, 1, 2]);

        for (let i = 0; i < 10; i++) {
            if (i === 1) continue;
            await svuotaMicrotask();
            chiudi[i]();
            expect(await dieci[i]).toBe(i);
        }
        expect(partiti).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        // Svuotato, il cancello riparte da zero.
        const dopo = withBcryptSlot(lavoro(10));
        await svuotaMicrotask();
        expect(partiti[partiti.length - 1]).toBe(10);
        chiudi[10]();
        expect(await dopo).toBe(10);

        // E la route risponde 503 con Retry-After, non 500.
        const inviato: Record<string, unknown> = {};
        const res = {
            set: (k: string, v: string) => { inviato.header = [k, v]; return res; },
            status: (c: number) => { inviato.status = c; return res; },
            json: (b: unknown) => { inviato.body = b; return res; },
        };
        expect(replyIfBcryptBusy(res as never, new BcryptBusyError())).toBe(true);
        expect(inviato).toEqual({
            header: ['Retry-After', '2'],
            status: 503,
            body: { error: 'server_busy', message: 'Troppe richieste in corso, riprova tra qualche secondo.' },
        });
        expect(replyIfBcryptBusy(res as never, new Error('altro'))).toBe(false);
    });
});
