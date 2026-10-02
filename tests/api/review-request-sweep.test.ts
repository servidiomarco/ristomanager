import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
    CLAIM_REVIEW_REQUEST_SQL,
    FINISH_REVIEW_REQUEST_SQL,
    RECENT_REVIEW_REQUEST_SQL,
    GOOGLE_REVIEW_LINK_HOST,
    buildGoogleReviewUrl,
    reviewFailureDigest,
    reviewFailureTag,
} from '../../services/reviewRequests';
import { api, ownerToken, bearer } from './helpers';

// Le query della richiesta di recensione, eseguite contro un Postgres vero.
//
// È il controllo che mancava nell'incidente del 18-19/09/2026: i test di
// allora coprivano permessi, impostazioni e forma delle risposte, ma nessuno
// eseguiva mai la UPDATE di marcatura. Quella query era invalida ($1 dedotto
// insieme varchar e text) e falliva SOLO a contatto col database — in
// produzione, dopo che il messaggio era già partito, lasciando la riga non
// marcata e quindi da rimandare ogni 15 minuti.
//
// Qui si parla col DB direttamente (come orders-cassa-incassi.test.ts) invece
// che via HTTP: lo scheduler non è raggiungibile da fuori, e il valore del
// test sta nel far preparare davvero l'SQL a Postgres.

const TENANT = 1;
let db: Client;
let reservationId: number;

const nuovaPrenotazione = async (phone: string): Promise<number> => {
    const r = await db.query(
        `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, payment_status, reservation_status, arrival_status)
         VALUES ($1, 'Collaudo Recensioni', NOW() - INTERVAL '4 hours', 'DINNER', 2, $2, 'NONE', 'CONFIRMED', 'DEPARTED')
         RETURNING id`,
        [TENANT, phone]
    );
    return Number(r.rows[0].id);
};

const statoDi = async (id: number) => {
    const r = await db.query(
        `SELECT review_request_status, review_request_channel, review_request_sent_at, review_request_error,
                review_request_failed_at
         FROM reservations WHERE id = $1`,
        [id]
    );
    return r.rows[0];
};

describe('richiesta recensione — query di marcatura', () => {
    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        reservationId = await nuovaPrenotazione('+393331112223');
    });

    afterAll(async () => {
        await db.query(`DELETE FROM reservations WHERE customer_name = 'Collaudo Recensioni' AND tenant_id = $1`, [TENANT]);
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = $1 AND body LIKE '%' || $2 || '%' AND to_phone = '+393334445556'`, [TENANT, GOOGLE_REVIEW_LINK_HOST]);
        await db.end();
    });

    it('la presa in carico riesce una volta sola', async () => {
        const primo = await db.query(CLAIM_REVIEW_REQUEST_SQL, [reservationId, TENANT]);
        expect(primo.rowCount).toBe(1);
        expect((await statoDi(reservationId)).review_request_status).toBe('sending');

        // Il secondo giro (o l'altra replica) non deve poter inviare di nuovo:
        // è questa riga a rendere impossibile il ciclo di doppioni.
        const secondo = await db.query(CLAIM_REVIEW_REQUEST_SQL, [reservationId, TENANT]);
        expect(secondo.rowCount).toBe(0);
    });

    it("l'esito 'sent' si scrive e valorizza l'orario di invio", async () => {
        // La regressione vera: prima questa query non si preparava nemmeno
        // («inconsistent types deduced for parameter $1»).
        await db.query(FINISH_REVIEW_REQUEST_SQL, ['sent', 'sms', null, reservationId, TENANT]);
        const riga = await statoDi(reservationId);
        expect(riga.review_request_status).toBe('sent');
        expect(riga.review_request_channel).toBe('sms');
        expect(riga.review_request_sent_at).not.toBeNull();
    });

    it("gli altri esiti non inventano un orario di invio", async () => {
        const id = await nuovaPrenotazione('+393332223334');
        await db.query(CLAIM_REVIEW_REQUEST_SQL, [id, TENANT]);
        await db.query(FINISH_REVIEW_REQUEST_SQL, ['skipped_consent', null, null, id, TENANT]);
        const riga = await statoDi(id);
        expect(riga.review_request_status).toBe('skipped_consent');
        expect(riga.review_request_sent_at).toBeNull();

        const fallita = await nuovaPrenotazione('+393335556667');
        await db.query(CLAIM_REVIEW_REQUEST_SQL, [fallita, TENANT]);
        await db.query(FINISH_REVIEW_REQUEST_SQL, ['failed', null, 'Twilio 21211', fallita, TENANT]);
        const riga2 = await statoDi(fallita);
        expect(riga2.review_request_error).toBe('Twilio 21211');
        // L'ora del fallimento è quella che raccoglie l'avviso della giornata.
        expect(riga2.review_request_failed_at).not.toBeNull();
        expect(riga.review_request_failed_at).toBeNull();
    });

    it("l'avviso «non partite» dice chi e perché, in breve", () => {
        expect(reviewFailureDigest([{ customerName: 'Rossi', error: 'Twilio 21211' }]))
            .toEqual({ title: '1 richiesta di recensione non partita', body: 'Rossi (Twilio 21211)' });
        const lungo = 'The message From/To pair violates a blacklist rule set by the carrier';
        const d = reviewFailureDigest([
            { customerName: 'Rossi', error: lungo },
            { customerName: 'Bianchi', error: null },
            { customerName: '', error: 'x' },
            { customerName: 'Verdi', error: 'y' },
        ]);
        expect(d.title).toBe('4 richieste di recensione non partite');
        expect(d.body).toBe('Rossi (The message From/To pair violates a…), Bianchi, cliente senza nome (x) e altre 1');
    });

    it('aprire il registro chiude l\'avviso per tutti', async () => {
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const users = await db.query(`SELECT id FROM users WHERE tenant_id = $1 LIMIT 2`, [TENANT]);
        const ids: number[] = [];
        for (const u of users.rows) {
            const r = await db.query(
                `INSERT INTO notifications (tenant_id, recipient_user_id, category, title, body, tag)
                 VALUES ($1, $2, 'system', 'Richieste non partite', 'Rossi', $3) RETURNING id`,
                [TENANT, u.id, reviewFailureTag(today)]
            );
            ids.push(Number(r.rows[0].id));
        }
        try {
            const res = await api().get('/reviews/requests').set(bearer(await ownerToken()));
            expect(res.status).toBe(200);
            const open = await db.query(
                `SELECT COUNT(*)::int AS n FROM notifications WHERE id = ANY($1::int[]) AND read_at IS NULL`, [ids]
            );
            expect(open.rows[0].n).toBe(0);
        } finally {
            await db.query(`DELETE FROM notifications WHERE id = ANY($1::int[])`, [ids]);
        }
    });

    it('una riga non presa in carico non si può chiudere', async () => {
        const id = await nuovaPrenotazione('+393336667778');
        const res = await db.query(FINISH_REVIEW_REQUEST_SQL, ['sent', 'sms', null, id, TENANT]);
        expect(res.rowCount).toBe(0);
        expect((await statoDi(id)).review_request_status).toBeNull();
    });

    it('il cooldown vede gli invii veri, non solo le righe marcate', async () => {
        const telefono = '+393334445556';
        const vuoto = await db.query(RECENT_REVIEW_REQUEST_SQL, [TENANT, 60, telefono, GOOGLE_REVIEW_LINK_HOST]);
        expect(vuoto.rows[0].recente).toBe(false);

        // Un invio uscito davvero, con la prenotazione NON marcata: è lo
        // scenario dell'incidente, e ora deve bastare a fermare il bis.
        await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status, sent_at)
             VALUES ($1, 'twilio', 'sms', 'outbound', $2, $3, $4, 'delivered', NOW())`,
            [TENANT, telefono, telefono.replace(/\D/g, ''), `Lasciaci una recensione: ${buildGoogleReviewUrl('ChIJTest')}`]
        );

        const pieno = await db.query(RECENT_REVIEW_REQUEST_SQL, [TENANT, 60, telefono, GOOGLE_REVIEW_LINK_HOST]);
        expect(pieno.rows[0].recente).toBe(true);

        // Stesso numero in forma nazionale: la chiave telefonica condivisa
        // deve riconoscerlo (right-10 qui sbaglierebbe sui 9 cifre).
        const nazionale = await db.query(RECENT_REVIEW_REQUEST_SQL, [TENANT, 60, '3334445556', GOOGLE_REVIEW_LINK_HOST]);
        expect(nazionale.rows[0].recente).toBe(true);

        // Un altro numero non deve ereditare il cooldown.
        const altro = await db.query(RECENT_REVIEW_REQUEST_SQL, [TENANT, 60, '+393339998887', GOOGLE_REVIEW_LINK_HOST]);
        expect(altro.rows[0].recente).toBe(false);
    });
});
