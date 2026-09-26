import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Il modulo «Modifica dipendente» manda "" per le date lasciate vuote. In
// produzione una scheda senza date d'assunzione e fine contratto non si
// salvava più: "" arrivava al cast a DATE e la PUT rispondeva 500 — trovato
// collegando l'account di un cuoco alla sua scheda per il piano ferie.

const EMAIL = 'cuoco.date@example.com';

describe('scheda personale — date vuote dal modulo', () => {
    let owner = '';
    let staffId = '';
    let userId = 0;

    beforeAll(async () => {
        owner = await ownerToken();
        const staff = await api().post('/staff').set(bearer(owner)).send({
            name: 'Marco', surname: 'Senzadate', category: 'CUCINA', staffType: 'FISSO',
        });
        expect(staff.status).toBe(201);
        staffId = staff.body.id;
        const user = await api().post('/auth/users').set(bearer(owner)).send({
            email: EMAIL, password: 'password-date-test', full_name: 'Marco Senzadate', role: 'KITCHEN',
        });
        expect(user.status).toBe(201);
        userId = user.body.id;
    });

    afterAll(async () => {
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        try {
            await db.query('DELETE FROM staff_members WHERE id = $1', [staffId]);
            await db.query('DELETE FROM users WHERE email = $1', [EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('il modulo intero con date vuote salva e collega l\'account', async () => {
        // La stessa forma che manda StaffManagement dal telefono.
        const res = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({
            name: 'Marco', surname: 'Senzadate', category: 'CUCINA', staffType: 'FISSO',
            phone: '', email: '', role: '', hireDate: '', contractEndDate: '',
            weeklyRestDay: null, notes: '', userId,
        });
        expect(res.status).toBe(200);
        expect(res.body.userId).toBe(userId);
        expect(res.body.hireDate).toBeNull();
        expect(res.body.contractEndDate).toBeNull();
    });

    it('"" svuota una data, assente la lascia, una data non valida è un 400', async () => {
        const set = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({ hireDate: '2025-03-01', contractEndDate: '2026-10-31' });
        expect(set.status).toBe(200);
        expect(set.body.hireDate).toBe('2025-03-01');

        const keep = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({ notes: 'solo note' });
        expect(keep.body.hireDate).toBe('2025-03-01');
        expect(keep.body.contractEndDate).toBe('2026-10-31');

        const clear = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({ contractEndDate: '' });
        expect(clear.status).toBe(200);
        expect(clear.body.contractEndDate).toBeNull();
        expect(clear.body.hireDate).toBe('2025-03-01');

        const bad = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({ hireDate: '31/12/2025' });
        expect(bad.status).toBe(400);
    });
});
