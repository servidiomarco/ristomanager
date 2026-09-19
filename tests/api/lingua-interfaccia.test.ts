import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Lingua dell'interfaccia per operatore (users.language), fondazione i18n
// della SPA. Come account.test.ts: tutto su un utente creato ad hoc, MAI sul
// seed owner — il suo token è cache-ato e condiviso dagli altri file.
describe('lingua dell\'interfaccia per operatore', () => {
    let owner: string;
    let db: Client;
    let token: string;
    const createdUserIds: number[] = [];
    const EMAIL = 'lingua-interfaccia@test.local';
    const PASSWORD = 'password-iniziale-1';

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email: EMAIL, password: PASSWORD, full_name: 'Utente Lingua', role: 'WAITER' });
        expect(created.status).toBe(201);
        createdUserIds.push(created.body.id);

        const session = await api().post('/auth/login').send({ email: EMAIL, password: PASSWORD });
        expect(session.status).toBe(200);
        token = session.body.accessToken as string;
    });

    afterAll(async () => {
        if (createdUserIds.length > 0) {
            await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
        }
        await db.end();
    });

    it('nasce senza lingua propria e col default del ristorante in chiaro', async () => {
        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.language ?? null).toBeNull();
        // Il default vive su tenants.default_language: la SPA lo usa per chi
        // non ha scelto. Seed = 'it'.
        expect(me.body.tenant?.default_language).toBe('it');
    });

    it('salva la lingua scelta e la rilegge da /auth/me', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ language: 'en' });
        expect(put.status).toBe(200);
        expect(put.body.language).toBe('en');

        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.body.language).toBe('en');
    });

    it('non tocca le altre preferenze quando si cambia solo la lingua', async () => {
        await api().put('/auth/me/preferences').set(bearer(token)).send({ preferred_design_style: 'squadrato' });
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ language: 'it' });
        expect(put.status).toBe(200);
        expect(put.body.language).toBe('it');
        expect(put.body.preferred_design_style).toBe('squadrato');
    });

    it('rifiuta una lingua fuori catalogo', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ language: 'fr' });
        expect(put.status).toBe(400);

        // Il valore precedente resta: un 400 non deve azzerare la scelta.
        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.body.language).toBe('it');
    });

    it('null rimette l\'operatore sul default del ristorante', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ language: null });
        expect(put.status).toBe(200);
        expect(put.body.language ?? null).toBeNull();
    });
});
