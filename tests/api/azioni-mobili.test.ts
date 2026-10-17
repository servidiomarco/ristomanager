import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Azioni del «+» del telefono per operatore (users.preferred_mobile_actions),
// scelte in Impostazioni → Menu. Come lingua-interfaccia.test.ts: tutto su un
// utente creato ad hoc, MAI sul seed owner — il suo token è condiviso.
describe('azioni del «+» del telefono per operatore', () => {
    let owner: string;
    let db: Client;
    let token: string;
    const createdUserIds: number[] = [];
    const EMAIL = 'azioni-mobili@test.local';
    const PASSWORD = 'password-iniziale-1';

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email: EMAIL, password: PASSWORD, full_name: 'Utente Azioni', role: 'WAITER' });
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

    it('nasce senza scelta: il telefono usa le predefinite', async () => {
        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.preferred_mobile_actions ?? null).toBeNull();
    });

    it('salva l\'elenco nell\'ordine dato e lo rilegge da /auth/me', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token))
            .send({ preferred_mobile_actions: ['shopping', 'reservation', 'task'] });
        expect(put.status).toBe(200);
        expect(put.body.preferred_mobile_actions).toEqual(['shopping', 'reservation', 'task']);

        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.body.preferred_mobile_actions).toEqual(['shopping', 'reservation', 'task']);
    });

    it('non tocca le azioni quando si cambia un\'altra preferenza', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ preferred_design_style: 'squadrato' });
        expect(put.status).toBe(200);
        expect(put.body.preferred_mobile_actions).toEqual(['shopping', 'reservation', 'task']);
    });

    it('rifiuta chiavi fuori catalogo, doppioni ed elenco vuoto', async () => {
        for (const bad of [['reservation', 'teletrasporto'], ['dish', 'dish'], [], 'reservation', [3]]) {
            const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ preferred_mobile_actions: bad });
            expect(put.status).toBe(400);
        }
        // Un 400 non deve azzerare la scelta di prima.
        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.body.preferred_mobile_actions).toEqual(['shopping', 'reservation', 'task']);
    });

    it('null rimette le predefinite', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token)).send({ preferred_mobile_actions: null });
        expect(put.status).toBe(200);
        expect(put.body.preferred_mobile_actions ?? null).toBeNull();
    });
});
