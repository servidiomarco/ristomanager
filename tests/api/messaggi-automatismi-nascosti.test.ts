import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Messaggi è il posto degli scambi con le persone. La richiesta di recensione
// non aspetta risposta, ma ogni invio rimetteva il thread in cima con «Ciao X!
// Grazie per essere stati…» come anteprima: dopo i reinvii del 18-19/09/2026
// erano 483 messaggi su 75 thread, con le conversazioni vere sepolte sotto.
// Da qui in avanti chi manda dichiara il `kind` e l'inbox lo salta — in lista
// e in chat. Le conferme restano: sono la traccia di «è arrivata la conferma?».
const NUMERO = '3391234567';
const ALTRO = '3397654321';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const insertOutbound = (phone: string, body: string, kind: string | null) => dbQuery(
    `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status, kind)
     VALUES (1, 'twilio', 'sms', 'outbound', $1, $1, $2, 'sent', $3)`,
    [phone, body, kind]
);

describe('inbox: gli automatismi non sono conversazioni', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
        // Thread reale: una conferma (visibile) e la risposta del cliente.
        await insertOutbound(NUMERO, 'La tua prenotazione è confermata', 'confirmation');
        await dbQuery(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status)
             VALUES (1, 'twilio', 'sms', 'inbound', $1, $1, 'Grazie mille!', 'received')`,
            [NUMERO]
        );
        // Poi l'automatismo, che è il messaggio PIÙ RECENTE del thread: senza
        // il filtro sarebbe lui l'anteprima e spingerebbe il thread in cima.
        await insertOutbound(NUMERO, 'Ciao! Lasciaci una recensione su Google', 'review_request');
        // Numero che ha ricevuto SOLO automatismi: non deve esistere in lista.
        await insertOutbound(ALTRO, 'Ciao! Lasciaci una recensione su Google', 'review_request');
        await insertOutbound(ALTRO, 'Ci scusiamo: un errore tecnico…', 'apology');
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND to_phone_digits IN ($1, $2)`, [NUMERO, ALTRO]);
        await dbQuery(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND from_phone_digits = $1`, [NUMERO]);
    });

    it('lista: il thread di soli automatismi non compare', async () => {
        const res = await api().get('/messages/conversations').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.conversations.find((c: any) => c.phone_digits === ALTRO)).toBeUndefined();
    });

    it("lista: l'anteprima resta l'ultimo messaggio vero, non la richiesta di recensione", async () => {
        const res = await api().get('/messages/conversations').set(bearer(token));
        const thread = res.body.conversations.find((c: any) => c.phone_digits === NUMERO);
        expect(thread).toBeDefined();
        expect(thread.last_body).toBe('Grazie mille!');
        expect(thread.last_direction).toBe('inbound');
    });

    it('chat: recensione e scuse non compaiono, la conferma sì', async () => {
        const res = await api().get(`/messages/conversations/${NUMERO}`).set(bearer(token));
        expect(res.status).toBe(200);
        const corpi = res.body.messages.map((m: any) => m.body);
        expect(corpi).toContain('La tua prenotazione è confermata');
        expect(corpi).toContain('Grazie mille!');
        expect(corpi.some((b: string) => b.includes('recensione'))).toBe(false);
    });

    it('lo storico della prenotazione continua a mostrarli: nascosti, non cancellati', async () => {
        const righe = await dbQuery(
            `SELECT kind FROM outbound_messages WHERE tenant_id = 1 AND to_phone_digits = $1 AND kind = 'review_request'`,
            [NUMERO]
        );
        expect(righe.rows).toHaveLength(1);
    });
});
