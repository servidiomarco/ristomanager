import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Food cost: la bozza della scheda con l'AI. Propone righe, non scrive niente.
// Nella suite ordinaria non c'è la chiave: si provano validazione, permesso,
// «non disponibile» e l'unità che il salvataggio fissa. Il comportamento col
// modello gira con lo stub locale di Anthropic (job «Test API (report AI,
// stub locale)»):
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/food-cost-bozza.test.ts

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

const WAITER_EMAIL = 'cameriere.bozza@example.com';
const WAITER_PASSWORD = 'password-bozza-waiter';

describe('food cost · bozza della scheda con l\'AI', () => {
    let owner = '';
    let db: Client;
    let piattoId = 0;
    let spaghetti = 0, uova = 0, pecorino = 0, ragu = 0;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(owner)).send({ food_cost: true });
        const crea = async (body: Record<string, unknown>) => {
            const res = await api().post('/food-cost/ingredienti').set(bearer(owner)).send(body);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            return res.body.id as number;
        };
        spaghetti = await crea({ nome: 'Spaghetti bozza', unitaCosto: 'kg', costoCents: 150 });
        uova = await crea({ nome: 'Uova bozza', unitaCosto: 'pz', costoCents: 25 });
        ragu = await crea({ nome: 'Ragù bozza', unitaCosto: 'kg', isPreparazione: true });
        // Un prodotto del magazzino com'è oggi al Frantoio: senza unità di costo.
        const p = await db.query(
            `INSERT INTO inventory_products (tenant_id, area, name, unit) VALUES (1, 'CUCINA', 'Pecorino bozza', 'kg') RETURNING id`,
        );
        pecorino = p.rows[0].id;
        const piatto = await api().post('/dishes').set(bearer(owner)).send({
            name: 'Carbonara bozza', description: 'Guanciale, uova, pecorino', price: 14, category: 'Primi', allergens: [],
        });
        expect(piatto.status).toBe(201);
        piattoId = piatto.body.id;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM food_cost_righe WHERE tenant_id = 1 AND (dish_id = $1 OR preparazione_id = $2)`, [piattoId, ragu]);
        await db.query(`DELETE FROM food_cost_piatti WHERE dish_id = $1`, [piattoId]);
        await db.query(`DELETE FROM dishes WHERE id = $1`, [piattoId]);
        await db.query(`DELETE FROM food_cost_prezzi WHERE product_id = ANY($1::int[])`, [[spaghetti, uova, ragu, pecorino]]);
        await db.query(`DELETE FROM inventory_products WHERE id = ANY($1::int[]) OR (tenant_id = 1 AND name = 'Guanciale bozza')`, [[spaghetti, uova, ragu, pecorino]]);
        await db.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
        await db.end();
    });

    it('vuole un piatto o un semilavorato, non tutti e due', async () => {
        expect((await api().post('/food-cost/bozza').set(bearer(owner)).send({})).status).toBe(400);
        const both = await api().post('/food-cost/bozza').set(bearer(owner)).send({ piattoId, preparazioneId: ragu });
        expect(both.status).toBe(400);
    });

    it('un cameriere non la chiede', async () => {
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Bozza', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        const res = await api().post('/food-cost/bozza').set(bearer(login.body.accessToken)).send({ piattoId });
        expect(res.status).toBe(403);
    });

    it.runIf(!process.env.ANTHROPIC_API_KEY)('senza chiave: non disponibile, e i dati lo dicono', async () => {
        const res = await api().post('/food-cost/bozza').set(bearer(owner)).send({ piattoId });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('ai_not_configured');
        const dati = await api().get('/food-cost/dati').set(bearer(owner));
        expect(dati.body.aiDisponibile).toBe(false);
    });

    it('il salvataggio fissa l\'unità di un ingrediente che non ne ha, e non ne cambia una già scritta', async () => {
        const ok = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(owner)).send({
            righe: [
                { productId: spaghetti, quantita: 100, unita: 'kg' },
                { productId: pecorino, quantita: 30, unita: 'kg' },
            ],
            porzioni: 1,
        });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        const p = await db.query(`SELECT unita_costo, costo_cents FROM inventory_products WHERE id = $1`, [pecorino]);
        expect(p.rows[0]).toEqual({ unita_costo: 'kg', costo_cents: null });

        const conflitto = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(owner)).send({
            righe: [{ productId: uova, quantita: 50, unita: 'kg' }],
            porzioni: 1,
        });
        expect(conflitto.status).toBe(400);
        expect(conflitto.body.code).toBe('unita');
        // La scheda di prima è rimasta com'era.
        const righe = await db.query(`SELECT product_id FROM food_cost_righe WHERE dish_id = $1 ORDER BY sort_order`, [piattoId]);
        expect(righe.rows.map(r => r.product_id)).toEqual([spaghetti, pecorino]);

        const doppia = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(owner)).send({
            righe: [{ productId: spaghetti, quantita: 50, unita: 'kg' }, { productId: spaghetti, quantita: 1, unita: 'pz' }],
            porzioni: 1,
        });
        expect(doppia.status).toBe(400);

        // Svuotata, per le prove dopo.
        const vuota = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(owner)).send({ righe: [], porzioni: 1 });
        expect(vuota.status).toBe(200);
        await db.query(`UPDATE inventory_products SET unita_costo = NULL WHERE id = $1`, [pecorino]);
    });

    describe.runIf(AI_STUB_PORT > 0)('con lo stub locale di Anthropic', () => {
        const received: any[] = [];
        let stub: http.Server;

        // La risposta si costruisce dalla richiesta: la chiave è quella che il
        // server ha mandato, gli id quelli veri del ristorante.
        const risposta = (body: any) => {
            const content = String(body?.messages?.[0]?.content ?? '');
            const chiave = /"chiave":"([^"]+)"/.exec(content)?.[1] ?? '';
            if (chiave.startsWith('semilavorato:')) {
                return {
                    schede: [{
                        chiave,
                        righe: [
                            { ingrediente_id: ragu, nuovo_ingrediente: null, unita: 'g', quantita: 100, nota: null },
                            { ingrediente_id: null, nuovo_ingrediente: 'Carne macinata', unita: 'g', quantita: 1500, nota: null },
                        ],
                        resa_quantita: 3000,
                        resa_unita: 'g',
                        avvisi: [],
                    }],
                };
            }
            return {
                schede: [{
                    chiave,
                    righe: [
                        { ingrediente_id: spaghetti, nuovo_ingrediente: null, unita: 'g', quantita: 100, nota: null },
                        { ingrediente_id: uova, nuovo_ingrediente: null, unita: 'pz', quantita: 1, nota: 'più un tuorlo' },
                        { ingrediente_id: null, nuovo_ingrediente: 'pecorino BOZZA', unita: 'g', quantita: 30, nota: null },
                        { ingrediente_id: null, nuovo_ingrediente: 'Guanciale bozza', unita: 'g', quantita: 40, nota: null },
                        { ingrediente_id: 987654, nuovo_ingrediente: null, unita: 'g', quantita: 10, nota: null },
                        { ingrediente_id: uova, nuovo_ingrediente: null, unita: 'g', quantita: 50, nota: null },
                    ],
                    resa_quantita: null,
                    resa_unita: null,
                    avvisi: ['versione romana classica'],
                }],
            };
        };

        beforeAll(async () => {
            stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    let parsed: any = null;
                    try { parsed = JSON.parse(body); } catch { /* resta null */ }
                    received.push({ url: req.url, headers: req.headers, body: parsed });
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'msg_stub_bozza', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
                        content: [{ type: 'text', text: JSON.stringify(risposta(parsed)) }],
                        stop_reason: 'end_turn', stop_sequence: null,
                        usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 },
                    }));
                });
            });
            await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => stub.close(() => resolve()));
        });

        it('i dati dicono che la bozza si può chiedere', async () => {
            const dati = await api().get('/food-cost/dati').set(bearer(owner));
            expect(dati.body.aiDisponibile).toBe(true);
        });

        it('propone le righe ripulite e non scrive niente', async () => {
            const res = await api().post('/food-cost/bozza').set(bearer(owner)).send({ piattoId, porzioni: 2 });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.righe).toEqual([
                { productId: spaghetti, nomeNuovo: null, unita: 'kg', quantita: 100, nota: null },
                { productId: uova, nomeNuovo: null, unita: 'pz', quantita: 1, nota: 'più un tuorlo' },
                // Il «nuovo» che il magazzino ha già, col suo nome: è quello.
                { productId: pecorino, nomeNuovo: null, unita: 'kg', quantita: 30, nota: null },
                { productId: null, nomeNuovo: 'Guanciale bozza', unita: 'kg', quantita: 40, nota: null },
            ]);
            expect(res.body.avvisi).toEqual(['versione romana classica', 'Uova bozza: proposto in g ma si conta a pz, da aggiungere a mano']);

            const last = received[received.length - 1];
            expect(last.body.model).toBe('claude-opus-5-5');
            expect(last.body.output_config.format.type).toBe('json_schema');
            expect(last.body.fallbacks).toBe('default');
            const system = last.body.system.map((b: any) => b.text).join('\n');
            expect(system).toContain('Spaghetti bozza');
            expect(last.body.system[last.body.system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
            // Il menu scrive i nomi con le iniziali maiuscole.
            expect(last.body.messages[0].content).toMatch(/Carbonara bozza/i);
            expect(last.body.messages[0].content).toContain('"porzioni":2');

            const righe = await db.query(`SELECT 1 FROM food_cost_righe WHERE dish_id = $1`, [piattoId]);
            expect(righe.rows).toHaveLength(0);
            const guanciale = await db.query(`SELECT 1 FROM inventory_products WHERE tenant_id = 1 AND name = 'Guanciale bozza'`);
            expect(guanciale.rows).toHaveLength(0);
        });

        it('registra il consumo in Consumi AI, con la cache al suo prezzo', async () => {
            let row: any = null;
            for (let i = 0; i < 40 && !row; i++) {
                const r = await db.query(
                    `SELECT model, prompt_tokens, output_tokens FROM ai_token_usage WHERE feature = 'food_cost_bozza' ORDER BY id DESC LIMIT 1`,
                );
                row = r.rows[0] ?? null;
                if (!row) await new Promise(res => setTimeout(res, 50));
            }
            // 2000 in ingresso + 1000 scritti in cache a 1,25×.
            expect(row).toEqual({ model: 'claude-opus-5-5', prompt_tokens: 3250, output_tokens: 400 });
        });

        it('per un semilavorato porta la resa e non mette il semilavorato in sé stesso', async () => {
            const res = await api().post('/food-cost/bozza').set(bearer(owner)).send({ preparazioneId: ragu });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.righe).toEqual([{ productId: null, nomeNuovo: 'Carne macinata', unita: 'kg', quantita: 1500, nota: null }]);
            expect(res.body.resaQuantita).toBe(3000);
            expect(res.body.resaUnita).toBe('kg');
        });

        it('le schede già fatte entrano come esempio, quelle della stessa categoria per prime', async () => {
            const altro = await api().post('/dishes').set(bearer(owner)).send({
                name: 'Amatriciana bozza', description: '', price: 13, category: 'Primi', allergens: [],
            });
            expect(altro.status).toBe(201);
            try {
                const salvata = await api().put(`/food-cost/schede/piatto/${altro.body.id}`).set(bearer(owner)).send({
                    righe: [{ productId: spaghetti, quantita: 110 }, { productId: uova, quantita: 1 }],
                    porzioni: 1,
                });
                expect(salvata.status).toBe(200);
                const res = await api().post('/food-cost/bozza').set(bearer(owner)).send({ piattoId });
                expect(res.status).toBe(200);
                const system = received[received.length - 1].body.system.map((b: any) => b.text).join('\n');
                expect(system).toContain('SCHEDE GIÀ FATTE');
                expect(system).toMatch(/"nome":"Amatriciana bozza".*"ingrediente":"Spaghetti bozza","quantita":110,"unita":"g"/i);
            } finally {
                await db.query(`DELETE FROM food_cost_righe WHERE dish_id = $1`, [altro.body.id]);
                await db.query(`DELETE FROM food_cost_piatti WHERE dish_id = $1`, [altro.body.id]);
                await db.query(`DELETE FROM dishes WHERE id = $1`, [altro.body.id]);
            }
        });

        it('un piatto che non c\'è: 404', async () => {
            const res = await api().post('/food-cost/bozza').set(bearer(owner)).send({ piattoId: 99_999_999 });
            expect(res.status).toBe(404);
        });
    });
});
