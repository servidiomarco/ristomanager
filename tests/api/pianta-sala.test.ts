import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Pianta di sala reale, tranche API: PATCH /rooms/:id impara nome, misure e
// il blob plan (con la rev come guardia anti-sovrascrittura), e PUT
// /tables/:id separa i campi di stato da quelli di layout — prima chi poteva
// segnare un tavolo «sporco» poteva anche spostarlo o rinominarlo.

const WAITER_EMAIL = 'sala.pianta@example.com';
const PASSWORD = 'password-pianta-sala';

const validPlan = (rev: number) => ({
    version: 1,
    rev,
    width_cm: 1200,
    height_cm: 800,
    elements: [
        { id: 'el-bancone', kind: 'bar', x_cm: 20, y_cm: 20, w_cm: 300, h_cm: 60, rotation: 0, label: 'Bancone' },
        { id: 'el-colonna', kind: 'column', x_cm: 600, y_cm: 400, w_cm: 40, h_cm: 40, rotation: 0 },
    ],
});

describe('pianta sala — API e permessi', () => {
    let owner = '';
    let waiterToken = '';
    let roomId = 0;
    let tableId = 0;

    beforeAll(async () => {
        owner = await ownerToken();

        const room = await api().post('/rooms').set(bearer(owner)).send({
            name: 'Sala Pianta Test', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        roomId = room.body.id;

        const table = await api().post('/tables').set(bearer(owner)).send({
            name: 'P1', shape: 'RECTANGLE', seats: 4, x: 50, y: 50, room_id: roomId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;

        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: PASSWORD, full_name: 'Test Sala', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        waiterToken = login.body.accessToken;
    });

    afterAll(async () => {
        // I file di test condividono il database e girano in sequenza: si
        // rimuove quello che questo file ha creato.
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
            if (tableId) await client.query(`DELETE FROM tables WHERE id = $1`, [tableId]);
            if (roomId) await client.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        } finally {
            await client.end();
        }
    });

    it('il plan si salva, torna da GET /rooms e si rimuove con null', async () => {
        const patched = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: validPlan(1) });
        expect(patched.status).toBe(200);
        expect(patched.body.plan.rev).toBe(1);
        expect(patched.body.plan.elements).toHaveLength(2);

        const rooms = await api().get('/rooms').set(bearer(owner));
        expect(rooms.status).toBe(200);
        const mine = rooms.body.find((r: any) => r.id === roomId);
        expect(mine.plan.width_cm).toBe(1200);
        expect(mine.plan.elements[0].kind).toBe('bar');

        const cleared = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.plan).toBeNull();
    });

    it('una rev non più fresca fa 409 e riporta la pianta corrente', async () => {
        const first = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: validPlan(1) });
        expect(first.status).toBe(200);

        // Stessa rev: l'altro dispositivo non sa del salvataggio appena fatto.
        const stale = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: validPlan(1) });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe('plan_conflict');
        expect(stale.body.current.plan.rev).toBe(1);

        const fresh = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: validPlan(2) });
        expect(fresh.status).toBe(200);
        expect(fresh.body.plan.rev).toBe(2);
    });

    it('un plan malformato non entra nel database', async () => {
        const badKind = { ...validPlan(3), elements: [{ id: 'x', kind: 'piscina', x_cm: 0, y_cm: 0, w_cm: 10, h_cm: 10, rotation: 0 }] };
        expect((await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: badKind })).status).toBe(400);

        const tooSmall = { ...validPlan(3), width_cm: 50 };
        expect((await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: tooSmall })).status).toBe(400);

        const noVersion = { ...validPlan(3), version: 2 };
        expect((await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ plan: noVersion })).status).toBe(400);
    });

    it('PATCH /rooms accetta anche nome e chiusura come prima', async () => {
        const renamed = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ name: 'Sala Pianta Rinominata' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe('Sala Pianta Rinominata');

        const closed = await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ is_closed: true });
        expect(closed.status).toBe(200);
        expect(closed.body.is_closed).toBe(true);

        expect((await api().patch(`/rooms/${roomId}`).set(bearer(owner)).send({ name: '  ' })).status).toBe(400);
    });

    it('il cameriere gira lo stato ma non sposta né rinomina il tavolo', async () => {
        // Premessa documentata: WAITER ha update_status ma non floorplan:full.
        const perms = await api().get('/auth/permissions/roles/WAITER').set(bearer(owner));
        expect(perms.status).toBe(200);
        expect(perms.body.permissions).toContain('floorplan:update_status');
        expect(perms.body.permissions).not.toContain('floorplan:full');

        const status = await api().put(`/tables/${tableId}`).set(bearer(waiterToken)).send({ status: 'DIRTY' });
        expect(status.status).toBe(200);
        expect(status.body.status).toBe('DIRTY');

        expect((await api().put(`/tables/${tableId}`).set(bearer(waiterToken)).send({ x: 200 })).status).toBe(403);
        expect((await api().put(`/tables/${tableId}`).set(bearer(waiterToken)).send({ name: 'P1bis' })).status).toBe(403);
        expect((await api().put(`/tables/${tableId}`).set(bearer(waiterToken)).send({ x_cm: 300, y_cm: 200 })).status).toBe(403);
        // Misto stato+layout: il layout comanda, niente aggiornamento parziale.
        expect((await api().put(`/tables/${tableId}`).set(bearer(waiterToken)).send({ status: 'FREE', x: 200 })).status).toBe(403);
    });

    it('la direzione piazza il tavolo sulla pianta in cm', async () => {
        const moved = await api().put(`/tables/${tableId}`).set(bearer(owner)).send({ x_cm: 340, y_cm: 220 });
        expect(moved.status).toBe(200);
        expect(moved.body.x_cm).toBe(340);
        expect(moved.body.y_cm).toBe(220);
        // I legacy x/y non vengono riscritti dal piazzamento in cm.
        expect(moved.body.x).toBe(50);
        expect(moved.body.y).toBe(50);
    });
});
