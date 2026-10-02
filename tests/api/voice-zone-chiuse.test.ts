import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Sofia e le zone (interno/esterno) quando le sale sono chiuse: la frase di
// check_availability deve nominare subito l'unica zona offribile — così
// l'agente non chiede mai "interno o esterno?" su una zona che quel giorno
// non esiste — e distinguere "sala chiusa" da "tutto prenotato".
//
// Le sale dei test non hanno location (la colonna si semina via SQL, non c'è
// una API): le due sale zona di questo file sono le uniche che contano nei
// free_indoor/free_outdoor, qualunque cosa abbiano creato i file precedenti.
const DATA = '2027-07-20';
const ORARIO = `${DATA}T20:00:00`;

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

describe('zone chiuse sul canale voce (check_availability)', () => {
    let token: string;
    let salaInternaId: number;
    let salaEsternaId: number;
    let tavoloEsternoId: number;

    beforeAll(async () => {
        token = await ownerToken();

        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        const interna = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Zona Interna', width: 800, height: 600 });
        expect(interna.status).toBe(201);
        salaInternaId = interna.body.id;
        const esterna = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Zona Esterna', width: 800, height: 600 });
        expect(esterna.status).toBe(201);
        salaEsternaId = esterna.body.id;

        const ti = await api().post('/tables').set(bearer(token)).send({
            name: 'ZI1', shape: 'SQUARE', seats: 4, x: 100, y: 100, room_id: salaInternaId, status: 'FREE',
        });
        expect(ti.status).toBe(201);
        const te = await api().post('/tables').set(bearer(token)).send({
            name: 'ZE1', shape: 'SQUARE', seats: 4, x: 100, y: 100, room_id: salaEsternaId, status: 'FREE',
        });
        expect(te.status).toBe(201);
        tavoloEsternoId = te.body.id;

        // La location non ha una API: si imposta come in produzione, via SQL.
        await dbQuery(`UPDATE rooms SET location = 'INDOOR' WHERE id = $1`, [salaInternaId]);
        await dbQuery(`UPDATE rooms SET location = 'OUTDOOR' WHERE id = $1`, [salaEsternaId]);
    });

    afterAll(async () => {
        // DB condiviso fra file: via le prenotazioni del test e poi le due
        // sale zona (i tavoli cascano con la sala), così i conteggi
        // indoor/outdoor di chi gira dopo tornano vuoti.
        await dbQuery(`DELETE FROM reservations WHERE customer_name LIKE 'Zona Test %'`);
        await dbQuery(`DELETE FROM rooms WHERE id = ANY($1::int[])`, [[salaInternaId, salaEsternaId]]);
    });

    const disponibilita = (extra: Record<string, any> = {}) =>
        api().post('/webhook/elevenlabs/check-availability').send({ date: DATA, shift: 'DINNER', guests: 2, ...extra });

    it('entrambe le zone aperte: frase generica, contano tutte e due', async () => {
        const res = await disponibilita();
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
        expect(res.body.free_indoor).toBeGreaterThan(0);
        expect(res.body.free_outdoor).toBeGreaterThan(0);
        // Due zone con posto: il server dice all'agente di chiedere.
        expect(res.body.ask_zone).toBe(true);
        expect(res.body.location_preference).toBeUndefined();
        expect(res.body.message).not.toContain("all'interno");
        expect(res.body.message).not.toContain("all'esterno");
    });

    it('sale esterne chiuse, nessuna preferenza: frase generica (zona mai nominata), outdoor_closed acceso', async () => {
        const chiusa = await api().patch(`/rooms/${salaEsternaId}`).set(bearer(token)).send({ is_closed: true });
        expect(chiusa.status).toBe(200);

        const res = await disponibilita();
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
        expect(res.body.free_outdoor).toBe(0);
        expect(res.body.outdoor_closed).toBe(true);
        expect(res.body.indoor_closed).toBe(false);
        // Zona unica: la decisione sta nella risposta, non in una regola del
        // prompt che il modello ignorava in 55 chiamate su 138 (analisi 23/09).
        expect(res.body.ask_zone).toBe(false);
        expect(res.body.location_preference).toBe('INDOOR');
        expect(res.body.zone_instruction).toContain('NON chiedere la zona');
        // La zona non richiesta non entra nella frase: nominarla ha già fatto
        // improvvisare all'agente domande senza senso (chiamata Gervasi 18/09).
        expect(res.body.message).not.toContain("all'interno");
        expect(res.body.message).not.toContain("all'esterno");
    });

    it('cliente chiede l\'esterno a sale chiuse: "le sale sono chiuse", non "tutto prenotato"', async () => {
        const res = await disponibilita({ location_preference: 'OUTDOOR' });
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
        expect(res.body.outdoor_closed).toBe(true);
        expect(res.body.message).toContain("le sale all'esterno sono chiuse");
        expect(res.body.message).toContain("all'interno abbiamo posto");
        expect(res.body.message).not.toContain('tutto prenotato');
    });

    // Chiamata Aragosta 19/09/2026: dette correttamente chiuse le sale esterne,
    // l'agente ha poi promesso al cliente insistente «se si libera uno spazio
    // all'esterno vi mettiamo fuori» e ha salvato «preferisce esterno se
    // disponibile». Le sale chiuse non si liberano: la nota arrivava in sala
    // come un impegno impossibile.
    it('nota che chiede una zona chiusa: la prenotazione la porta con la smentita', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Zona Test Promessa',
            phone: '3390000501',
            date: DATA,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
            notes: 'Cliente preferisce esterno se disponibile',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const riga = await dbQuery(`SELECT notes FROM reservations WHERE id = $1`, [res.body.reservation_id]);
        expect(riga.rows[0].notes).toContain('preferisce esterno');
        expect(riga.rows[0].notes).toContain("le sale all'esterno sono chiuse quel giorno");

        // Via subito: il test che segue conta sui tavoli liberi di questo turno.
        await dbQuery(`DELETE FROM reservations WHERE id = $1`, [res.body.reservation_id]);
    });

    it('nota senza zone: resta com\'è', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Zona Test Nota Neutra',
            phone: '3390000502',
            date: DATA,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
            notes: 'Allergia ai crostacei',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const riga = await dbQuery(`SELECT notes FROM reservations WHERE id = $1`, [res.body.reservation_id]);
        expect(riga.rows[0].notes).toBe('[Voce] Allergia ai crostacei');

        await dbQuery(`DELETE FROM reservations WHERE id = $1`, [res.body.reservation_id]);
    });

    it('esterno aperto ma pieno: resta "tutto prenotato"', async () => {
        const riaperta = await api().patch(`/rooms/${salaEsternaId}`).set(bearer(token)).send({ is_closed: false });
        expect(riaperta.status).toBe(200);
        const prenotata = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Zona Test Esterno Pieno',
            reservation_time: ORARIO,
            shift: 'DINNER',
            guests: 2,
            children: 0,
            table_id: tavoloEsternoId,
        });
        expect(prenotata.status).toBe(201);

        const res = await disponibilita({ location_preference: 'OUTDOOR' });
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(false);
        expect(res.body.outdoor_closed).toBe(false);
        expect(res.body.message).toContain("all'esterno è tutto prenotato");
        expect(res.body.message).toContain("all'interno abbiamo posto");
    });

    // Chiamata di prova 23/09/2026: salutato per nome, poi subito dopo la
    // disponibilità "A che nome registro la prenotazione?". L'intestazione
    // ora arriva nella risposta di check_availability.
    it('chiamante in rubrica: check_availability dice di confermare il nome, non di chiederlo', async () => {
        const creata = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Zona Test Rubrica',
            phone: '3390000503',
            date: DATA,
            time: '20:00',
            shift: 'DINNER',
            guests: 2,
        });
        expect(creata.body.success).toBe(true);
        await dbQuery(`DELETE FROM reservations WHERE id = $1`, [creata.body.reservation_id]);

        const noto = await disponibilita({ caller_id: '+393390000503' });
        expect(noto.body.available).toBe(true);
        expect(noto.body.customer_known).toBe(true);
        expect(noto.body.customer_full_name).toBe('Zona Test Rubrica');
        expect(noto.body.name_instruction).toContain('La prenotazione è a suo nome, Zona?');

        const sconosciuto = await disponibilita({ caller_id: '+393390000999' });
        expect(sconosciuto.body.available).toBe(true);
        expect(sconosciuto.body.customer_known).toBeUndefined();
        // Sconosciuto al telefono: nome e cognome in una sola domanda.
        expect(sconosciuto.body.name_instruction).toContain('Mi dice nome e cognome?');
        expect(sconosciuto.body.name_instruction).not.toContain('a suo nome');

        // Numero nascosto: stessa domanda.
        const anonimo = await disponibilita();
        expect(anonimo.body.name_instruction).toContain('Mi dice nome e cognome?');
    });
});
