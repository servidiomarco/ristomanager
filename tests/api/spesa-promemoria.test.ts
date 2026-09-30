import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Promemoria della spesa: un solo avviso vivo per ristorante (tag
// shopping-pending) che si chiude per tutti quando in lista non resta niente
// da comprare — per spunta o per eliminazione dell'ultima voce.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
const TAG = 'shopping-pending';

describe('lista della spesa · promemoria', () => {
    let owner = '';
    let ownerId = 0;
    let db: Client;

    const insertReminder = async (): Promise<number> => {
        const r = await db.query(
            `INSERT INTO notifications (tenant_id, recipient_user_id, category, title, body, tag)
             VALUES (1, $1, 'system', 'Da comprare: 2 articoli', 'Latte, Farina', $2) RETURNING id`,
            [ownerId, TAG]
        );
        return Number(r.rows[0].id);
    };
    const readAt = async (id: number) =>
        (await db.query(`SELECT read_at FROM notifications WHERE id = $1`, [id])).rows[0].read_at;
    const add = async (name: string): Promise<string> => {
        const res = await api().post('/shopping').set(bearer(owner))
            .send({ name, date: '2026-09-30', category: 'CUCINA' });
        expect(res.status).toBe(201);
        return res.body.id;
    };

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
        await db.query(`DELETE FROM shopping_items WHERE tenant_id = 1`);
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE tag = $1`, [TAG]);
            await db.query(`DELETE FROM shopping_items WHERE tenant_id = 1`);
        } finally {
            await db.end();
        }
    });

    it('spuntata l\'ultima voce: il promemoria si chiude per tutti', async () => {
        const latte = await add('Latte');
        const farina = await add('Farina');
        const id = await insertReminder();

        expect((await api().put(`/shopping/${latte}/toggle`).set(bearer(owner))).status).toBe(200);
        expect(await readAt(id)).toBeNull();

        expect((await api().put(`/shopping/${farina}/toggle`).set(bearer(owner))).status).toBe(200);
        expect(await readAt(id)).not.toBeNull();
    });

    it('eliminata l\'ultima voce da comprare: si chiude', async () => {
        await db.query(`DELETE FROM notifications WHERE tag = $1`, [TAG]);
        const limoni = await add('Limoni');
        const id = await insertReminder();

        const del = await api().delete(`/shopping/${limoni}`).set(bearer(owner));
        expect(del.status).toBe(204);
        expect(await readAt(id)).not.toBeNull();
    });

    it('il promemoria di sistema è seminato e si configura come gli altri', async () => {
        const res = await api().get('/reminders').set(bearer(owner));
        expect(res.status).toBe(200);
        const spesa = res.body.reminders.find((r: any) => r.system_key === 'SHOPPING_LIST');
        expect(spesa).toBeTruthy();
        expect(spesa.schedule_time).toBe('09:30');
        expect(spesa.target_roles).toEqual(['OWNER', 'GENERAL_MANAGER', 'MANAGER']);
    });
});
