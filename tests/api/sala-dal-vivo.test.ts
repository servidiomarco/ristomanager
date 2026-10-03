import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Sala dal vivo (PR2b): la pagina è una vista nuova, ViewState.SALA_DAL_VIVO.
// Il server valida preferred_landing_view contro lo STESSO enum di types.ts,
// che compila anche lui: se l'enum del server restasse indietro, «Pagina di
// partenza → Sala dal vivo» in Impostazioni → Profilo risponderebbe 400. Per
// questo il deploy di Railway va prima di quello di Vercel.
//
// Tutto su un utente creato qui, MAI sul seed owner: il suo token è in cache
// e condiviso dagli altri file. Il cameriere ha floorplan:view, il permesso
// della vista.
describe('Sala dal vivo come pagina di partenza', () => {
    let owner: string;
    let db: Client;
    let token: string;
    const createdUserIds: number[] = [];
    const EMAIL = 'sala-dal-vivo@test.local';
    const PASSWORD = 'password-sala-vivo-1';

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email: EMAIL, password: PASSWORD, full_name: 'Schermo Ingresso', role: 'WAITER' });
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

    it('accetta SALA_DAL_VIVO come pagina di partenza e la rilegge da /auth/me', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token))
            .send({ preferred_landing_view: 'SALA_DAL_VIVO' });
        expect(put.status).toBe(200);
        expect(put.body.preferred_landing_view).toBe('SALA_DAL_VIVO');
        // Il permesso della vista: senza, l'app la scarterebbe all'avvio.
        expect(put.body.permissions).toContain('floorplan:view');

        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.preferred_landing_view).toBe('SALA_DAL_VIVO');
    });

    it('null la toglie e si torna alla pagina di sempre', async () => {
        const put = await api().put('/auth/me/preferences').set(bearer(token))
            .send({ preferred_landing_view: null });
        expect(put.status).toBe(200);
        expect(put.body.preferred_landing_view ?? null).toBeNull();

        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.body.preferred_landing_view ?? null).toBeNull();
    });
});
