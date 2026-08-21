import { describe, it, expect } from 'vitest';
import { costUsd, MODEL_PRICES, COST_USD_SQL, UNPRICED_SQL } from '../../services/aiPricing';

// Il listino è scritto a mano e va aggiornato a mano: questi test non
// verificano che i prezzi siano GIUSTI (non c'è un'API da interrogare), ma
// che il calcolo li applichi come dichiarato e che un modello sconosciuto
// non produca silenziosamente un costo di zero.
//
// Non chiama nulla: è aritmetica, gira ovunque, non spende.

describe('listino e calcolo dei costi AI', () => {
    it('applica il prezzo dichiarato per il modello', () => {
        // 1M token in ingresso su opus-5 = 5 dollari, per definizione.
        expect(costUsd('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5, 6);
        expect(costUsd('claude-opus-5', 0, 1_000_000)).toBeCloseTo(25, 6);
    });

    it('somma ingresso e uscita, che hanno prezzi diversi', () => {
        // Un giro dell'agente misurato in sviluppo: 3038 in + 195 out.
        const atteso = (3038 / 1e6) * 5 + (195 / 1e6) * 25;
        expect(costUsd('claude-opus-5', 3038, 195)).toBeCloseTo(atteso, 9);
        // ~2 centesimi: se questo numero cambia di ordine di grandezza,
        // o è cambiato il listino o è cambiato il prompt.
        expect(costUsd('claude-opus-5', 3038, 195)).toBeLessThan(0.05);
    });

    it('un modello fuori listino dà null, non zero', () => {
        // Zero sarebbe indistinguibile da "gratis" e sparirebbe in una somma.
        expect(costUsd('gemini-3.5-flash', 10_000, 5_000)).toBeNull();
        expect(costUsd('modello-inventato', 1, 1)).toBeNull();
    });

    it('l\'uscita costa più dell\'ingresso su ogni modello in listino', () => {
        // Non è un dettaglio: è il motivo per cui conviene un prompt lungo e
        // una risposta corta. Se un giorno si invertisse, va notato.
        for (const [modello, p] of Object.entries(MODEL_PRICES)) {
            expect(p.outputPerMTok, modello).toBeGreaterThan(p.inputPerMTok);
        }
    });

    it('il frammento SQL copre esattamente i modelli del listino', () => {
        // Se qualcuno aggiunge un prezzo alla tabella, il SQL deve seguirlo da
        // solo: è generato da lì. Questo test fallisce se qualcuno lo riscrive
        // a mano dimenticando un modello.
        for (const modello of Object.keys(MODEL_PRICES)) {
            expect(COST_USD_SQL).toContain(`'${modello}'`);
            expect(UNPRICED_SQL).toContain(`'${modello}'`);
        }
    });
});
