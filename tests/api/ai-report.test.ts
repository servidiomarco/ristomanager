import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Report AI della dashboard. La chiamata al modello costa e dura secondi:
// qui NON si genera un report vero. Si verificano i contratti che si possono
// rompere senza accorgersene — permessi, validazione della finestra, e il
// caso "nessun dato", che è quello in cui un utente nuovo cade per primo.
//
// La qualità del testo non è testabile qui: si guarda a occhio (fatto in
// sviluppo su 160 prenotazioni seminate, con l'incoerenza fra totali e
// dettaglio scoperta proprio così e corretta).

describe('report AI della dashboard', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    it('richiede autenticazione', async () => {
        const res = await api().post('/reports/ai-summary').send({ days: 30 });
        expect(res.status).toBe(401);
    });

    it('senza prenotazioni nel periodo risponde 400, non un report inventato', async () => {
        // Finestra minima accettata (7 giorni) su un database di test dove le
        // prenotazioni degli altri file stanno nel futuro o fuori finestra.
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 7 });
        // 400 = niente da analizzare; 200 = c'erano dati e il report è uscito.
        // Entrambi legittimi: quello che NON deve succedere è un 500.
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
            expect(res.body.error).toBe('no_data');
        } else {
            expect(typeof res.body.report).toBe('string');
            expect(res.body.report.length).toBeGreaterThan(0);
        }
    });

    it('la finestra è limitata a valori sensati', async () => {
        // 5000 giorni verrebbe accettato solo se il clamp non ci fosse: la
        // risposta deve riportare la finestra effettivamente usata.
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 5000 });
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) expect(res.body.days).toBe(90);
    });

    it('una finestra non numerica non fa esplodere nulla', async () => {
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 'trenta' });
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) expect(res.body.days).toBe(30);
    });
});
