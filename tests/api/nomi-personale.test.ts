import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Anagrafica del personale in Title Case alla scrittura: comunque venga
// digitato, il dato salvato è titolato — apostrofi e trattini compresi
// («d'angelo» → «D'Angelo», «anna-maria» → «Anna-Maria»). La stessa forma
// la impone la migration nomi-personale-title-case sulle righe esistenti.

describe('personale — nomi in Title Case', () => {
    let owner = '';
    let staffId = '';

    beforeAll(async () => {
        owner = await ownerToken();
    });

    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            if (staffId) await client.query('DELETE FROM staff_members WHERE id = $1', [staffId]);
        } finally {
            await client.end();
        }
    });

    it('la creazione titola nome, cognome e ruolo', async () => {
        const res = await api().post('/staff').set(bearer(owner)).send({
            name: 'anna-maria', surname: "d'angelo rossi", category: 'SALA', staffType: 'FISSO',
            role: 'aiuto cucina',
        });
        expect(res.status).toBe(201);
        staffId = res.body.id;
        expect(res.body.name).toBe('Anna-Maria');
        expect(res.body.surname).toBe("D'Angelo Rossi");
        expect(res.body.role).toBe('Aiuto Cucina');
    });

    it('anche la modifica titola, e i campi non toccati restano', async () => {
        const res = await api().put(`/staff/${staffId}`).set(bearer(owner)).send({
            surname: 'DE ROSA',
        });
        expect(res.status).toBe(200);
        expect(res.body.surname).toBe('De Rosa');
        expect(res.body.name).toBe('Anna-Maria');
    });
});
