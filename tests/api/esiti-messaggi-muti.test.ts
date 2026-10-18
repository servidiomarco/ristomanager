import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';

// L'esito di un messaggio all'ospite (inviato, consegnato, letto) aggiorna
// l'icona sulla card, non la prenotazione. Il 18/10 una prenotazione appena
// creata ha dato quattro «Prenotazione aggiornata» in mezzo minuto, una per
// stato di Twilio, impilate perché a 3–4 s l'una dall'altra sfuggivano al
// dedup dei toast. Qui lo stato parte come reservation:synced (patch muta),
// con la riga arricchita, e il log di replica lo marca quiet per il nodo.

const AUTH_TOKEN = 'test-twilio-auth-token';

const connetti = (token: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, {
        transports: ['websocket', 'polling'],
        auth: { token },
        timeout: 10_000,
    });
    const fallisci = (e: Error) => { clearTimeout(t); socket.close(); reject(e); };
    const t = setTimeout(() => fallisci(new Error('socket non connesso')), 10_000);
    socket.on('connect', () => { clearTimeout(t); resolve(socket); });
    socket.on('connect_error', fallisci);
});

describe('esiti dei messaggi senza toast', () => {
    let db: Client;
    let token = '';
    let socket: Socket;

    const statoTwilio = (MessageSid: string, MessageStatus: string) => {
        const params: Record<string, string> = { MessageSid, MessageStatus, To: 'whatsapp:+393405551199' };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp-status`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp-status').set('X-Twilio-Signature', signature).type('form').send(params);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        socket = await connetti(token);
    });

    afterAll(async () => {
        socket?.disconnect();
        await db.end();
    });

    it('la consegna della conferma arriva come reservation:synced arricchita, mai come reservation:updated', async () => {
        // Senza telefono né email: nessuna conferma automatica che riscriva
        // il SID sotto al test.
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Esito Muto', reservation_time: '2027-04-12T19:30:00.000Z', shift: 'DINNER', guests: 2,
        });
        expect(res.status).toBe(201);
        const id = res.body.id;
        const sid = `SMesito${Date.now()}`;
        await db.query(`UPDATE reservations SET confirmation_provider_sid = $1, confirmation_status = 'sent', confirmation_channel = 'whatsapp' WHERE id = $2`, [sid, id]);

        const aggiornate: any[] = [];
        const suAggiornata = (r: any) => { if (r?.id === id) aggiornate.push(r); };
        socket.on('reservation:updated', suAggiornata);
        const sincronizzata = new Promise<any>(resolve => {
            const t = setTimeout(() => { socket.off('reservation:synced', ok); resolve(null); }, 5_000);
            const ok = (r: any) => {
                if (r?.id !== id || r.confirmation_status !== 'delivered') return;
                clearTimeout(t);
                socket.off('reservation:synced', ok);
                resolve(r);
            };
            socket.on('reservation:synced', ok);
        });

        expect((await statoTwilio(sid, 'delivered')).status).toBe(200);
        const riga = await sincronizzata;
        expect(riga).toBeTruthy();
        // Le colonne del join della GET ci sono: il client sostituisce la
        // riga, e senza di loro il badge VIP si spegneva.
        expect(riga).toHaveProperty('customer_is_vip');
        expect(riga).toHaveProperty('latest_payment_status');
        await new Promise(r => setTimeout(r, 500));
        socket.off('reservation:updated', suAggiornata);
        expect(aggiornate).toEqual([]);

        const log = await db.query(
            `SELECT payload FROM outbox_events WHERE aggregate = $1 AND event = 'reservation:updated' ORDER BY id DESC LIMIT 1`,
            [`reservation:${id}`]
        );
        expect(log.rows[0]?.payload).toEqual({ reservation_id: id, quiet: 1 });
    });
});
