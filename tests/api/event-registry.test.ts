import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';
// Il sorgente, non dist: la logica è pura (dati + una guardia), vitest lo
// transpila al volo e `npx tsc --noEmit` non inciampa su un dist assente.
import { DOMAIN_EVENTS, requireRegisteredEvent } from '../../services/eventRegistry';

// Il registro delle autorità (tappa 4 ibrido, fase 1): ogni tipo-evento di
// dominio dichiara chi ne è il master. Questo file È il «check in CI» della
// sez. 4 del brainstorming — estrae i literal degli eventi dai sorgenti e
// pretende che ognuno sia registrato: una feature nuova che broadcasta un
// tipo non dichiarato non passa di qui.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EVENT_LITERAL = /'([A-Za-z]+:[A-Za-z-]+)'/g;

describe('registro dei tipi-evento con autorità', () => {
    it('ogni broadcast di server.ts è un tipo registrato', () => {
        const src = readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');
        // Solo i canali di broadcast generici: i metodi tipizzati di
        // socketService hanno i literal nel proprio file, coperto sotto.
        const calls = src.match(/(?:broadcastToAll|broadcastToStation|broadcastToRolesRoom|broadcastToUsers)\([^)]*?'[A-Za-z]+:[A-Za-z-]+'/g) ?? [];
        const events = new Set<string>();
        for (const call of calls) {
            for (const m of call.matchAll(EVENT_LITERAL)) events.add(m[1]);
        }
        expect(events.size).toBeGreaterThan(30); // il pattern deve continuare a mordere
        const nonRegistrati = [...events].filter(e => !DOMAIN_EVENTS[e]);
        expect(nonRegistrati, `tipi non dichiarati in services/eventRegistry.ts: ${nonRegistrati.join(', ')}`).toEqual([]);
    });

    it('ogni literal-evento di socketService.ts è un tipo registrato', () => {
        const src = readFileSync(path.join(repoRoot, 'services/socketService.ts'), 'utf8');
        const events = new Set<string>();
        for (const m of src.matchAll(EVENT_LITERAL)) events.add(m[1]);
        expect(events.size).toBeGreaterThan(20);
        const nonRegistrati = [...events].filter(e => !DOMAIN_EVENTS[e]);
        expect(nonRegistrati, `tipi non dichiarati in services/eventRegistry.ts: ${nonRegistrati.join(', ')}`).toEqual([]);
    });

    it('il registro rifiuta i tipi ignoti e i transient sul log', () => {
        expect(() => requireRegisteredEvent('evento:inventato')).toThrow(/non registrato/);
        // I segnali realtime puri non appartengono al log di replica.
        expect(() => requireRegisteredEvent('orderpad:presence')).toThrow(/transient/);
        // Un tipo di dominio registrato passa e porta la sua versione.
        expect(requireRegisteredEvent('order:updated').schema_ver).toBe(1);
        expect(requireRegisteredEvent('order:updated').authority).toBe('service');
    });

    it('ogni autorità dichiarata è una delle quattro note', () => {
        const valide = new Set(['cloud', 'service', 'split', 'transient']);
        for (const [type, spec] of Object.entries(DOMAIN_EVENTS)) {
            expect(valide.has(spec.authority), `autorità sconosciuta su ${type}`).toBe(true);
            expect(spec.schema_ver, `schema_ver non valido su ${type}`).toBeGreaterThanOrEqual(1);
        }
    });
});

describe("l'envelope dell'event log", () => {
    let token: string;
    let db: Client;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        await db.end();
    });

    it('un evento di comanda nasce con event_id e schema_ver dal registro', async () => {
        const flags = await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Envelope', width: 800, height: 600 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'EN1', shape: 'SQUARE', seats: 2, x: 720, y: 520, room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id;

        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Envelope', description: null, price: 9, category: 'ANTIPASTI', allergens: null,
        });
        expect(dish.status).toBe(201);
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 1 }],
        });
        expect(add.status).toBe(201);

        const rows = await db.query(
            `SELECT event_id, schema_ver FROM outbox_events WHERE aggregate = $1 AND event = 'order:updated'`,
            [`order:${orderId}`]
        );
        expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows.rows) {
            // Identità globale per l'idempotenza della replica…
            expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/);
            // …e la versione del payload viene dal registro, non dal chiamante.
            expect(row.schema_ver).toBe(1);
        }
    });
});
