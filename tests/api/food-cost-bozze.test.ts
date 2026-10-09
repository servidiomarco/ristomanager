import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Food cost: le bozze dell'AI in blocco, una per ogni piatto senza scheda,
// preparate in sottofondo. Restano bozze (food_cost_bozze) finché lo chef non
// le salva come scheda o le scarta: non contano in nessun costo. Nella suite
// ordinaria non c'è la chiave; il giro col modello gira con lo stub locale
// di Anthropic (job «Test API (report AI, stub locale)»):
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/food-cost-bozze.test.ts

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

const WAITER_EMAIL = 'cameriere.bozze@example.com';
const WAITER_PASSWORD = 'password-bozze-waiter';
const CATEGORIA_VINI = 'Vini bozze';

const finoA = async (cond: () => Promise<boolean>, cosa: string) => {
    for (let i = 0; i < 100; i++) {
        if (await cond()) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`timeout: ${cosa}`);
};

describe('food cost · bozze in blocco', () => {
    let owner = '';
    let db: Client;
    let spaghetti = 0;
    let carbonara = 0, amatriciana = 0, conScheda = 0, vino = 0;
    let prefsPrima: string | null = null;
    let categoriaVini = CATEGORIA_VINI;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(owner)).send({ food_cost: true });
        const ing = await api().post('/food-cost/ingredienti').set(bearer(owner)).send({ nome: 'Spaghetti blocco', unitaCosto: 'kg', costoCents: 150 });
        expect(ing.status).toBe(201);
        spaghetti = ing.body.id;
        const piatto = async (name: string, category: string) => {
            const r = await api().post('/dishes').set(bearer(owner)).send({ name, description: '', price: 12, category, allergens: [] });
            expect(r.status).toBe(201);
            return r.body.id as number;
        };
        carbonara = await piatto('Carbonara blocco', 'Primi blocco');
        amatriciana = await piatto('Amatriciana blocco', 'Primi blocco');
        conScheda = await piatto('Cacio e pepe blocco', 'Primi blocco');
        vino = await piatto('Greco di Bianco blocco', CATEGORIA_VINI);
        const s = await api().put(`/food-cost/schede/piatto/${conScheda}`).set(bearer(owner)).send({
            righe: [{ productId: spaghetti, quantita: 100 }], porzioni: 1,
        });
        expect(s.status).toBe(200);
        // La carta dei vini non ha ricette: la categoria è segnata «vino». Il
        // nome si rilegge dal piatto, perché il menu lo riscrive (maiuscole).
        const cat = (await db.query(`SELECT category FROM dishes WHERE id = $1`, [vino])).rows[0].category;
        categoriaVini = cat;
        const p = await db.query(`SELECT text_value FROM app_settings WHERE tenant_id = 1 AND key = 'menu_category_prefs'`);
        prefsPrima = p.rows[0]?.text_value ?? null;
        const prefs = { ...(prefsPrima ? JSON.parse(prefsPrima) : {}), [cat]: { enabled: true, sort: 99, wine: true, bar: true } };
        await db.query(
            `INSERT INTO app_settings (tenant_id, key, text_value, updated_at) VALUES (1, 'menu_category_prefs', $1, now())
             ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value`,
            [JSON.stringify(prefs)],
        );
    });

    afterAll(async () => {
        const piatti = [carbonara, amatriciana, conScheda, vino];
        await db.query(`DELETE FROM food_cost_bozze WHERE dish_id = ANY($1::int[])`, [piatti]);
        await db.query(`DELETE FROM food_cost_righe WHERE dish_id = ANY($1::int[])`, [piatti]);
        await db.query(`DELETE FROM food_cost_piatti WHERE dish_id = ANY($1::int[])`, [piatti]);
        await db.query(`DELETE FROM dishes WHERE id = ANY($1::int[])`, [piatti]);
        await db.query(`DELETE FROM food_cost_prezzi WHERE product_id = $1`, [spaghetti]);
        await db.query(`DELETE FROM inventory_products WHERE id = $1`, [spaghetti]);
        if (prefsPrima == null) await db.query(`DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'menu_category_prefs'`);
        else await db.query(`UPDATE app_settings SET text_value = $1 WHERE tenant_id = 1 AND key = 'menu_category_prefs'`, [prefsPrima]);
        await db.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
        await db.end();
    });

    it('i dati contano i piatti da preparare: niente schede fatte né carta dei vini', async () => {
        const dati = await api().get('/food-cost/dati').set(bearer(owner));
        expect(dati.status).toBe(200);
        expect(dati.body.bozze).toEqual([]);
        expect(dati.body.generazione).toBeNull();
        // Almeno i due primi del test; la carbonara con scheda e il vino no.
        expect(dati.body.bozzeCandidati).toBeGreaterThanOrEqual(2);
        const r = await db.query(
            `SELECT count(*)::int AS n FROM dishes d WHERE d.tenant_id = 1 AND d.is_active AND d.crm_enabled
               AND d.category IS DISTINCT FROM $1
               AND NOT EXISTS (SELECT 1 FROM food_cost_righe r WHERE r.dish_id = d.id)
               AND NOT EXISTS (SELECT 1 FROM food_cost_piatti p WHERE p.dish_id = d.id)`,
            [categoriaVini],
        );
        expect(dati.body.bozzeCandidati).toBe(Math.min(200, r.rows[0].n));
    });

    it('un cameriere non le chiede né le scarta', async () => {
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Bozze', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        const waiter = login.body.accessToken;
        expect((await api().post('/food-cost/bozze/genera').set(bearer(waiter)).send({})).status).toBe(403);
        expect((await api().delete(`/food-cost/bozze/${carbonara}`).set(bearer(waiter))).status).toBe(403);
    });

    it.runIf(!process.env.ANTHROPIC_API_KEY)('senza chiave: non disponibili', async () => {
        const res = await api().post('/food-cost/bozze/genera').set(bearer(owner)).send({});
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('ai_not_configured');
    });

    describe.runIf(AI_STUB_PORT > 0)('con lo stub locale di Anthropic', () => {
        const received: any[] = [];
        let stub: http.Server;

        // Una scheda per ogni chiave della richiesta, dopo una piccola attesa:
        // il giro deve restare «in corso» abbastanza da provare il blocco.
        beforeAll(async () => {
            stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    let parsed: any = null;
                    try { parsed = JSON.parse(body); } catch { /* resta null */ }
                    received.push(parsed);
                    const content = String(parsed?.messages?.[0]?.content ?? '');
                    const chiavi = [...content.matchAll(/"chiave":"([^"]+)"/g)].map(m => m[1]);
                    const schede = chiavi.map(chiave => ({
                        chiave,
                        righe: [
                            { ingrediente_id: spaghetti, nuovo_ingrediente: null, unita: 'g', quantita: 100, nota: null },
                            { ingrediente_id: null, nuovo_ingrediente: 'Guanciale blocco', unita: 'g', quantita: 40, nota: null },
                            { ingrediente_id: 424242, nuovo_ingrediente: null, unita: 'g', quantita: 5, nota: null },
                        ],
                        resa_quantita: null,
                        resa_unita: null,
                        avvisi: ['versione classica'],
                    }));
                    setTimeout(() => {
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({
                            id: 'msg_stub_blocco', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
                            content: [{ type: 'text', text: JSON.stringify({ schede }) }],
                            stop_reason: 'end_turn', stop_sequence: null,
                            usage: { input_tokens: 500, output_tokens: 300 * chiavi.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
                        }));
                    }, 300);
                });
            });
            await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => stub.close(() => resolve()));
        });

        it('prepara le bozze in sottofondo, una alla volta, e non tocca i costi', async () => {
            const usoPrima = await db.query(`SELECT count(*)::int AS n FROM ai_token_usage WHERE feature = 'food_cost_bozza'`);
            const via = await api().post('/food-cost/bozze/genera').set(bearer(owner)).send({});
            expect(via.status).toBe(202);
            const totali = via.body.daPreparare;
            expect(totali).toBeGreaterThanOrEqual(2);

            // Un secondo tocco mentre lavora: 409, nessun giro doppio.
            const doppio = await api().post('/food-cost/bozze/genera').set(bearer(owner)).send({});
            expect(doppio.status).toBe(409);
            expect(doppio.body.code).toBe('in_corso');
            const durante = await api().get('/food-cost/dati').set(bearer(owner));
            expect(durante.body.generazione).toMatchObject({ totali });

            await finoA(async () => {
                const d = await api().get('/food-cost/dati').set(bearer(owner));
                return d.body.generazione === null;
            }, 'fine della generazione');

            const dati = await api().get('/food-cost/dati').set(bearer(owner));
            const perPiatto = new Map(dati.body.bozze.map((b: any) => [b.dishId, b]));
            expect(perPiatto.has(conScheda)).toBe(false);
            expect(perPiatto.has(vino)).toBe(false);
            const b: any = perPiatto.get(carbonara);
            expect(b.porzioni).toBe(1);
            expect(b.avvisi).toEqual(['versione classica']);
            // Ripulite come la bozza singola: l'id inventato non c'è.
            expect(b.righe).toEqual([
                { productId: spaghetti, nomeNuovo: null, unita: 'kg', quantita: 100, nota: null },
                { productId: null, nomeNuovo: 'Guanciale blocco', unita: 'kg', quantita: 40, nota: null },
            ]);
            expect(perPiatto.has(amatriciana)).toBe(true);
            expect(dati.body.bozzeCandidati).toBe(0);

            // Piatti a lotti da 5, una chiamata per lotto, l'elenco ingredienti in cache.
            const chiamate = received.filter(r => String(r?.messages?.[0]?.content ?? '').includes('"chiave"'));
            expect(chiamate.length).toBe(Math.ceil(totali / 5));
            expect(chiamate[0].system[chiamate[0].system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
            const usoDopo = await db.query(`SELECT count(*)::int AS n FROM ai_token_usage WHERE feature = 'food_cost_bozza'`);
            expect(usoDopo.rows[0].n - usoPrima.rows[0].n).toBe(chiamate.length);

            // Una bozza non è una scheda: il piatto resta senza costo.
            const piatti = await api().get('/food-cost/piatti').set(bearer(owner));
            const c = piatti.body.piatti.find((p: any) => p.id === carbonara);
            expect(c.stato).toBe('senza_scheda');
            expect(c.costoCents).toBeNull();
            const righe = await db.query(`SELECT 1 FROM food_cost_righe WHERE dish_id = $1`, [carbonara]);
            expect(righe.rows).toHaveLength(0);
        });

        it('un nuovo giro non rifà le bozze che ci sono', async () => {
            const res = await api().post('/food-cost/bozze/genera').set(bearer(owner)).send({});
            expect(res.status).toBe(200);
            expect(res.body.daPreparare).toBe(0);
        });

        it('salvare la scheda chiude la bozza, scartarla la toglie', async () => {
            const salvata = await api().put(`/food-cost/schede/piatto/${carbonara}`).set(bearer(owner)).send({
                righe: [{ productId: spaghetti, quantita: 100 }], porzioni: 1,
            });
            expect(salvata.status).toBe(200);
            const scartata = await api().delete(`/food-cost/bozze/${amatriciana}`).set(bearer(owner));
            expect(scartata.status).toBe(204);
            const r = await db.query(`SELECT dish_id FROM food_cost_bozze WHERE dish_id = ANY($1::int[])`, [[carbonara, amatriciana]]);
            expect(r.rows).toHaveLength(0);
            // L'amatriciana scartata torna fra i piatti da preparare.
            const dati = await api().get('/food-cost/dati').set(bearer(owner));
            expect(dati.body.bozzeCandidati).toBe(1);
        });
    });
});
