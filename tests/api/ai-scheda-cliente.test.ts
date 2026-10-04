import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Le due AI dei Messaggi (agente e risposta suggerita) leggono la scheda del
// cliente in rubrica. Il 03/10/2026 un cliente col tavolo preferito segnato
// ha chiesto «posso mangiare al mio tavolo preferito?» e l'AI gli ha chiesto
// quale fosse: la scheda non arrivava al prompt. Senza chiave le rotte
// rispondono 503, quindi si prova solo con lo stub locale di Anthropic (job
// «Test API (report AI, stub locale)» di ci.yml):
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/ai-scheda-cliente.test.ts

const IN_RUBRICA = '3391112233';
const SCONOSCIUTO = '3391112244';
const SALA = 'Veranda Scheda';
const TAVOLO = 'S12';

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

describe.runIf(AI_STUB_PORT > 0)('AI dei Messaggi: scheda cliente in rubrica', () => {
    const received: any[] = [];
    let stub: http.Server;
    let db: Client;
    let token = '';
    let roomId = 0;

    beforeAll(async () => {
        stub = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try { received.push(JSON.parse(body)); } catch { received.push(null); }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_stub_scheda', type: 'message', role: 'assistant', model: 'stub',
                    content: [{ type: 'text', text: 'Certo, ti teniamo il tavolo se è libero.' }],
                    stop_reason: 'end_turn', stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 5 },
                }));
            });
        });
        await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));

        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(
            `INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Scheda test', 'Siamo aperti a cena')`
        );
        const r = await db.query(
            `INSERT INTO rooms (tenant_id, name, width, height) VALUES (1, $1, 800, 600) RETURNING id`, [SALA]
        );
        roomId = r.rows[0].id;
        const t = await db.query(
            `INSERT INTO tables (tenant_id, room_id, name, shape, seats, x, y, status)
             VALUES (1, $1, $2, 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`,
            [roomId, TAVOLO]
        );
        const tableId = t.rows[0].id;
        // Il numero in rubrica scritto in un'altra forma: il confronto è
        // sulle cifre, col prefisso o senza.
        await db.query(
            `INSERT INTO customers (tenant_id, name, phone, is_vip, preferred_table_id, preferences_notes, dietary_notes, notes)
             VALUES (1, 'Ospite Scheda', $1, TRUE, $2, 'Ama il vino rosso', 'Celiaco', 'Paga sempre in ritardo')`,
            [`+39 ${IN_RUBRICA}`, tableId]
        );
        await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, phone, reservation_time, shift, guests, payment_status, table_id)
             VALUES (1, 'Ospite Scheda', $1, NOW() + interval '2 days', 'DINNER', 2, 'PENDING', $2)`,
            [IN_RUBRICA, tableId]
        );
        for (const numero of [IN_RUBRICA, SCONOSCIUTO]) {
            await db.query(
                `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status)
                 VALUES (1, 'twilio', 'whatsapp', 'inbound', $1, $2, 'Posso mangiare al mio tavolo preferito?', 'received')`,
                [`+39${numero}`, `39${numero}`]
            );
        }
    });

    afterAll(async () => {
        await new Promise<void>(resolve => stub.close(() => resolve()));
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND from_phone_digits = ANY($1)`,
            [[`39${IN_RUBRICA}`, `39${SCONOSCIUTO}`]]);
        await db.query(`DELETE FROM agent_proposals WHERE tenant_id = 1 AND phone_digits = ANY($1)`, [[IN_RUBRICA, SCONOSCIUTO]]);
        await db.query(`DELETE FROM reservations WHERE tenant_id = 1 AND customer_name = 'Ospite Scheda'`);
        await db.query(`DELETE FROM customers WHERE tenant_id = 1 AND name = 'Ospite Scheda'`);
        await db.query(`DELETE FROM tables WHERE tenant_id = 1 AND room_id = $1`, [roomId]);
        await db.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Scheda test'`);
        await db.query(`DELETE FROM ai_token_usage WHERE feature IN ('whatsapp_agent', 'suggest_reply')`);
        await db.end();
    });

    for (const [rotta, nome] of [['/messages/agent/run', 'agente'], ['/messages/suggest-reply', 'risposta suggerita']] as const) {
        it(`${nome}: il tavolo preferito arriva al prompt, le note alimentari no`, async () => {
            const res = await api().post(rotta).set(bearer(token)).send({ phone_digits: IN_RUBRICA });
            expect(res.status).toBe(200);
            const system: string = received[received.length - 1].system;
            expect(system).toContain(`- Tavolo preferito: tavolo ${TAVOLO} in ${SALA}`);
            expect(system).toContain('- Cliente VIP del ristorante');
            expect(system).toContain('- Preferenze annotate: Ama il vino rosso');
            // La prenotazione collegata dice su che tavolo è già.
            expect(system).toContain(`- Tavolo: ${TAVOLO}`);
            expect(system).toContain('non chiedergli quale sia');
            expect(system).not.toContain('Celiaco');
            expect(system).not.toContain('Paga sempre in ritardo');
        });

        it(`${nome}: un numero fuori rubrica lo dice, senza inventare una scheda`, async () => {
            const res = await api().post(rotta).set(bearer(token)).send({ phone_digits: SCONOSCIUTO });
            expect(res.status).toBe(200);
            const system: string = received[received.length - 1].system;
            expect(system).toContain('(questo numero non è in rubrica)');
            expect(system).not.toContain('- Tavolo preferito:');
        });
    }
});
