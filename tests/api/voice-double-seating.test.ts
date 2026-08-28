import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Doppio turno del canale voce (voice_double_seating_enabled): a turno pieno
// check_availability propone l'orario in cui si libera il primo tavolo adatto
// (second_seating_from) e create_reservation può assegnare a quell'ora un
// tavolo che ha già una prenotazione nello stesso shift, purché le finestre
// di servizio non si sovrappongano (durata: duration_minutes, fallback 90'
// pranzo / 120' cena).
//
// Il DB è condiviso fra i file di test: qui si riempiono TUTTI i tavoli del
// tenant su una data dedicata, così il turno risulta davvero al completo
// qualunque cosa abbiano creato i file precedenti. Slot cena di default
// 19:30–23:30 (seed opening_hours), quindi 22:00 è uno slot valido.
const DATA = '2027-06-16';
const PRIMO_TURNO = `${DATA}T20:00:00`;

describe('doppio turno voce (voice_double_seating_enabled)', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();

        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        // Un tavolo dedicato al test più quelli accumulati dagli altri file:
        // tutti prenotati alle 20:00, cena piena per qualunque numero di ospiti.
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Doppio Turno',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'DT1',
            shape: 'SQUARE',
            seats: 4,
            x: 100,
            y: 100,
            room_id: room.body.id,
            status: 'FREE',
        });
        expect(table.status).toBe(201);

        const tables = await api().get('/tables').set(bearer(token));
        expect(tables.status).toBe(200);
        for (const t of tables.body) {
            const created = await api().post('/reservations').set(bearer(token)).send({
                customer_name: `Primo Giro ${t.id}`,
                reservation_time: PRIMO_TURNO,
                shift: 'DINNER',
                guests: 1,
                children: 0,
                table_id: t.id,
            });
            expect(created.status).toBe(201);
        }
    });

    afterAll(async () => {
        // Stato condiviso fra file: l'interruttore torna spento.
        await api().put('/settings/features').set(bearer(token)).send({ voice_double_seating_enabled: false });
    });

    it('interruttore spento: turno pieno senza proposta di seconda battuta', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA,
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
        expect(res.body.second_seating_from).toBeUndefined();
    });

    it('interruttore acceso: propone lo slot in cui si libera un tavolo (22:00)', async () => {
        const put = await api().put('/settings/features').set(bearer(token)).send({ voice_double_seating_enabled: true });
        expect(put.status).toBe(200);
        expect(put.body.voice_double_seating_enabled).toBe(true);

        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA,
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
        // 20:00 + 120' di default = 22:00, già sulla griglia slot.
        expect(res.body.second_seating_from).toBe('22:00');
        expect(res.body.message).toContain('22:00');
    });

    it('create alle 22:00: tavolo assegnato in seconda battuta', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Secondo Giro',
            phone: '3391112233',
            date: DATA,
            time: '22:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const list = await api().get('/reservations').set(bearer(token));
        const created = list.body.find((r: any) => r.customer_name === 'Secondo Giro');
        expect(created).toBeTruthy();
        expect(created.table_id).not.toBeNull();
    });

    it('create alle 20:30 (sovrapposta): nessun tavolo, resta al piazzamento manuale', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Giro Sovrapposto',
            phone: '3394445566',
            date: DATA,
            time: '20:30',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const list = await api().get('/reservations').set(bearer(token));
        const created = list.body.find((r: any) => r.customer_name === 'Giro Sovrapposto');
        expect(created).toBeTruthy();
        expect(created.table_id).toBeNull();
    });
});
