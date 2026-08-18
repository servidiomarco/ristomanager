import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Collaudo della scopatura tenant del dominio prenotazioni (Fase B3.5).
// Il CRUD base è già coperto da reservations.test.ts: qui si esercitano il
// flusso pubblico (PUBLIC_TENANT_ID), il 404 naturale sugli id estranei e la
// coerenza dei contatori di servizio dopo una creazione.
//
// Date future e DIVERSE da quelle degli altri file (2027-03-10): il booking
// pubblico può auto-assegnare un tavolo e occuperebbe la data su cui
// reservations.test.ts fa i propri controlli di conflitto.
const DATA_WEB = '2027-03-17';
const DATA_CUCINA = '2027-03-24';

describe('prenotazioni per tenant', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    afterAll(async () => {
        // Il flag parte spento (default false): si rimette com'era per non
        // sporcare le assunzioni degli altri file sullo stesso database.
        await api().put('/settings/features').set(bearer(token)).send({
            public_bookings_enabled: false,
        });
    });

    it('il form pubblico è spento di default e si accende via /settings/features', async () => {
        const bloccato = await api().post('/public/reservations').send({
            customer_name: 'Cliente Web Spento',
            phone: '+39 333 1112233',
            date: DATA_WEB,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(bloccato.status).toBe(503);
        expect(bloccato.body.error).toBe('bookings_disabled');

        const acceso = await api().put('/settings/features').set(bearer(token)).send({
            public_bookings_enabled: true,
        });
        expect(acceso.status).toBe(200);
        expect(acceso.body.public_bookings_enabled).toBe(true);
    });

    it('la prenotazione web nasce sul tenant pubblico e compare nella lista autenticata', async () => {
        // Slot valido del seed (cena 19:30-23:30, passo 30').
        const created = await api().post('/public/reservations').send({
            customer_name: 'Cliente Web Collaudo',
            phone: '+39 333 8765432',
            date: DATA_WEB,
            time: '20:00',
            shift: 'DINNER',
            guests: 3,
        });
        expect(created.status).toBe(201);
        expect(created.body.ok).toBe(true);
        expect(created.body.id).toBeTruthy();
        const id = created.body.id as number;

        const list = await api().get('/reservations').set(bearer(token));
        expect(list.status).toBe(200);
        const row = list.body.find((r: any) => r.id === id);
        expect(row).toBeTruthy();
        // Marcatori del canale web scritti dall'handler pubblico.
        expect(row.source).toBe('GOOGLE');
        expect(String(row.notes)).toMatch(/^\[Web\]/);
        // Auto-conferma solo col tavolo assegnato: mai un CONFIRMED senza posto.
        if (row.reservation_status === 'CONFIRMED') {
            expect(row.table_id).toBeTruthy();
        } else {
            expect(row.reservation_status).toBe('PENDING');
            expect(row.requires_review).toBe(true);
        }
    });

    it('un id inesistente/estraneo fa 404 sui sotto-endpoint (fetch scopato sul tenant)', async () => {
        const messaggi = await api().get('/reservations/99999999/messages').set(bearer(token));
        expect(messaggi.status).toBe(404);

        const conto = await api().get('/reservations/99999999/bill').set(bearer(token));
        expect(conto.status).toBe(404);
    });

    it('il riepilogo di servizio cucina conta la prenotazione appena creata', async () => {
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Tavolata Cucina',
            reservation_time: `${DATA_CUCINA}T20:30:00`,
            shift: 'DINNER',
            guests: 5,
            note_selections: [
                { preset_id: 1, label: 'Stinco collaudo', quantity: 2, variant: null },
            ],
        });
        expect(created.status).toBe(201);

        const summary = await api()
            .get('/kitchen/service-summary')
            .query({ date: DATA_CUCINA, shift: 'DINNER' })
            .set(bearer(token));
        expect(summary.status).toBe(200);
        expect(summary.body.service_date).toBe(DATA_CUCINA);
        expect(summary.body.shift).toBe('DINNER');
        expect(summary.body.reservations).toBeGreaterThanOrEqual(1);
        const stinco = summary.body.dietary.find((d: any) => d.label === 'Stinco collaudo');
        expect(stinco).toBeTruthy();
        expect(stinco.quantity).toBe(2);
    });
});
