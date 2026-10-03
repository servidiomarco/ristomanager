import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Development, Roadmap e Consumi AI: strumenti del progetto, aperti dalla
// sessione di pannello (PLATFORM_ADMIN senza «Entra»). Fino al 02/10 li
// apriva solo l'email admin@ristomanager.com, che in produzione era stata
// cambiata il 26/09: da allora non li vedeva nessuno. Qui si verifica che:
// - il pannello li apre, e la card nuova finisce nel tenant di casa;
// - il seed owner, che ha ancora quella email, non li apre più;
// - la sessione «Entra» non li apre: leggerebbe il ristorante.

const PA_EMAIL = 'platform.admin.strumenti@example.com';
const PA_PASSWORD = 'password-piattaforma-strumenti';
const CARD_TITLE = 'Card strumenti di sviluppo (test)';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

describe('strumenti di sviluppo riservati al pannello di piattaforma', () => {
    let panelToken = '';
    let scopedToken = '';

    beforeAll(async () => {
        const client = await pgClient();
        try {
            const hash = await bcrypt.hash(PA_PASSWORD, 4);
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Platform Admin Strumenti', 'PLATFORM_ADMIN', 1, TRUE)
                 ON CONFLICT (email) DO NOTHING`,
                [PA_EMAIL, hash]
            );
        } finally {
            await client.end();
        }
        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        if (login.status !== 200) {
            throw new Error(`Login platform admin fallito (${login.status}): ${JSON.stringify(login.body)}`);
        }
        panelToken = login.body.accessToken;
        const entered = await api().post('/admin/tenants/1/enter').set(bearer(panelToken));
        if (entered.status !== 200) {
            throw new Error(`Enter fallito (${entered.status}): ${JSON.stringify(entered.body)}`);
        }
        scopedToken = entered.body.accessToken;
    });

    afterAll(async () => {
        const client = await pgClient();
        try {
            await client.query('DELETE FROM dev_board_cards WHERE title = $1', [CARD_TITLE]);
            await client.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
            await client.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
            await client.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('il pannello apre board, roadmap e consumi AI', async () => {
        for (const path of ['/dev-board/cards', '/roadmap/tasks', '/ai-usage/gemini']) {
            const res = await api().get(path).set(bearer(panelToken));
            expect(res.status, path).toBe(200);
        }
    });

    it('la card creata dal pannello sta nel tenant di casa', async () => {
        const res = await api().post('/dev-board/cards').set(bearer(panelToken)).send({ title: CARD_TITLE });
        expect(res.status).toBe(201);
        const client = await pgClient();
        try {
            const row = await client.query('SELECT tenant_id FROM dev_board_cards WHERE id = $1', [res.body.id]);
            expect(Number(row.rows[0]?.tenant_id)).toBe(1);
        } finally {
            await client.end();
        }
    });

    it('il seed owner con la vecchia email non li apre più', async () => {
        const token = await ownerToken();
        for (const path of ['/dev-board/cards', '/roadmap/tasks', '/ai-usage/gemini']) {
            const res = await api().get(path).set(bearer(token));
            expect(res.status, path).toBe(403);
        }
    });

    it('la sessione «Entra» non li apre', async () => {
        for (const path of ['/dev-board/cards', '/roadmap/tasks', '/ai-usage/gemini']) {
            const res = await api().get(path).set(bearer(scopedToken));
            expect(res.status, path).toBe(403);
        }
    });
});
