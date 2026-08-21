import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Report AI della dashboard.
//
// Il test NON genera un report vero: chiamare il modello costa e dura secondi,
// e in CI la chiave Anthropic non c'è di proposito — una suite di test non
// deve spendere su un'API a pagamento. Quindi l'endpoint può finire in tre
// stati diversi a seconda di dove gira, e il contratto che si verifica qui è
// che siano TUTTI e tre puliti:
//
//   503 not_configured  → nessuna chiave (la CI)
//   400 no_data         → chiave presente ma niente da analizzare
//   200                 → report generato (sviluppo, con la chiave)
//
// Quello che non deve succedere mai è un 500, o una risposta 200 senza testo.
// La qualità del report non è testabile qui: si guarda a occhio (fatto in
// sviluppo su 160 prenotazioni seminate — è così che è saltata fuori
// l'incoerenza fra totali e dettaglio, poi corretta).

/** Verifica che la risposta sia coerente con il proprio stato, qualunque sia. */
const rispostaCoerente = (res: { status: number; body: any }, giorniAttesi?: number) => {
    expect([200, 400, 503]).toContain(res.status);
    if (res.status === 503) {
        expect(res.body.error).toBe('not_configured');
    } else if (res.status === 400) {
        expect(res.body.error).toBe('no_data');
    } else {
        expect(typeof res.body.report).toBe('string');
        expect(res.body.report.length).toBeGreaterThan(0);
        if (giorniAttesi !== undefined) expect(res.body.days).toBe(giorniAttesi);
    }
};

describe('report AI della dashboard', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    it('richiede autenticazione', async () => {
        // Unico caso indipendente dalla configurazione: l'auth viene prima.
        const res = await api().post('/reports/ai-summary').send({ days: 30 });
        expect(res.status).toBe(401);
    });

    it('risponde in modo pulito, mai 500', async () => {
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 7 });
        rispostaCoerente(res);
    });

    it('la finestra è limitata a valori sensati', async () => {
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 5000 });
        rispostaCoerente(res, 90);
    });

    it('una finestra non numerica ricade sul valore predefinito', async () => {
        const res = await api().post('/reports/ai-summary').set(bearer(token)).send({ days: 'trenta' });
        rispostaCoerente(res, 30);
    });
});
