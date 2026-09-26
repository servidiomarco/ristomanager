import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Caso Sarubbi 26/09/2026: 7 secondi di saluto e riaggancio, un minuto dopo
// lo stesso numero richiama e prenota. La prima chiamata restava «Da
// ricontattare» perché non collegata a nessuna prenotazione. Ora la chiamata
// servita chiude i tentativi a vuoto dello stesso numero nelle 24 ore prima;
// quelli con una richiesta propria (richiamata chiesta) restano aperti.
const TELEFONO = '3390000811';
const ALTRO = '3390000812';
const CONV = 'conv-test-richiamata-servita';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const inserisciChiamata = async (suffisso: string, phone: string, opts: { callback?: boolean; oreFa?: number } = {}) => {
    const r = await dbQuery(
        `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds, callback_requested, created_at)
         VALUES (1, $1, $2, 7, $3, NOW() - make_interval(hours => $4::int)) RETURNING id`,
        [`${CONV}-${suffisso}`, phone, opts.callback ?? false, opts.oreFa ?? 0]
    );
    return r.rows[0].id as number;
};

const stato = async (id: number) =>
    (await dbQuery(`SELECT follow_up_status FROM voice_calls WHERE id = $1`, [id])).rows[0].follow_up_status;

describe('chiamata servita chiude i tentativi a vuoto dello stesso numero', () => {
    let token: string;
    let aVuoto: number;
    let conRichiamata: number;
    let altroNumero: number;
    let vecchia: number;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        // Stesso numero salvato in E.164, come lo scrive il post-call.
        aVuoto = await inserisciChiamata('a-vuoto', `+39${TELEFONO}`);
        conRichiamata = await inserisciChiamata('richiamata', `+39${TELEFONO}`, { callback: true });
        altroNumero = await inserisciChiamata('altro', `+39${ALTRO}`);
        vecchia = await inserisciChiamata('vecchia', `+39${TELEFONO}`, { oreFa: 30 });
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM voice_calls WHERE conversation_id LIKE $1 || '%'`, [CONV]);
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND phone LIKE '%' || $1`, [TELEFONO]);
        await dbQuery(`DELETE FROM customers WHERE tenant_id = 1 AND phone LIKE '%' || $1`, [TELEFONO]);
    });

    it('prenota: chiude la chiamata a vuoto, lascia le altre', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Richiamata Servita',
            phone: TELEFONO,
            date: '2027-08-11',
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
            conversation_id: `${CONV}-servita`,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // linkConversation è fire-and-forget: si aspetta che l'UPDATE atterri.
        for (let i = 0; i < 30 && (await stato(aVuoto)) !== 'CONTACTED'; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const chiusa = await dbQuery(
            `SELECT follow_up_status, follow_up_updated_by, follow_up_updated_at, reservation_id FROM voice_calls WHERE id = $1`,
            [aVuoto]
        );
        expect(chiusa.rows[0].follow_up_status).toBe('CONTACTED');
        expect(chiusa.rows[0].follow_up_updated_by).toBeNull();
        expect(chiusa.rows[0].follow_up_updated_at).toBeTruthy();
        expect(chiusa.rows[0].reservation_id).toBeNull();

        expect(await stato(conRichiamata)).toBe('PENDING');
        expect(await stato(altroNumero)).toBe('PENDING');
        expect(await stato(vecchia)).toBe('PENDING');

        const servita = await dbQuery(`SELECT reservation_id FROM voice_calls WHERE conversation_id = $1`, [`${CONV}-servita`]);
        expect(servita.rows[0].reservation_id).toBe(res.body.reservation_id);

        // Il numero sparisce dalla lista «da ricontattare» solo per la
        // chiamata a vuoto: la richiamata chiesta resta lì.
        const pending = await api().get('/voice-calls').set(bearer(token)).query({ follow_up: 'pending', q: TELEFONO });
        expect(pending.status).toBe(200);
        const ids = pending.body.items.map((i: any) => i.id);
        expect(ids).not.toContain(aVuoto);
        expect(ids).toContain(conRichiamata);
    });
});
