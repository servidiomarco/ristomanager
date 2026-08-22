import { describe, it, expect } from 'vitest';
import { describeDepositPolicy } from '../../services/depositPolicy';

// Come la politica caparra viene raccontata al modello.
//
// Il punto di questi test non è la formattazione: è che il numero arrivi
// SEMPRE dalle Impostazioni. Prima la soglia era scritta a mano in una regola
// della base di conoscenza, e quando è cambiata da 5 a 9 la regola è rimasta
// indietro — l'AI avrebbe detto ai clienti una soglia che il sistema non
// applicava, senza che niente lo segnalasse.
//
// Aritmetica pura: non chiama il modello, non spende, gira anche in CI.

describe('politica caparra nel prompt', () => {
    it('riporta soglia e importo così come stanno nelle impostazioni', () => {
        const t = describeDepositPolicy({ enabled: true, minGuests: 9, perPersonCents: 1000 });
        expect(t).toContain('9 persone');
        expect(t).toContain('10 euro');
    });

    it('segue il cambio di soglia senza toccare nulla d\'altro', () => {
        // È la proprietà che conta: cambio in Impostazioni → cambia la frase.
        const a = describeDepositPolicy({ enabled: true, minGuests: 5, perPersonCents: 1000 });
        const b = describeDepositPolicy({ enabled: true, minGuests: 9, perPersonCents: 1000 });
        expect(a).toContain('5 persone');
        expect(b).toContain('9 persone');
        expect(a).not.toEqual(b);
    });

    it('segue anche il cambio di importo', () => {
        const t = describeDepositPolicy({ enabled: true, minGuests: 9, perPersonCents: 2500 });
        expect(t).toContain('25 euro');
    });

    it('spenta: dice che non serve, invece di tacere', () => {
        // Tacere lascerebbe il modello libero di inventare una soglia.
        const t = describeDepositPolicy({ enabled: false, minGuests: 9, perPersonCents: 1000 });
        expect(t.toLowerCase()).toContain('non è richiesta');
        expect(t).not.toMatch(/\b9\b/);
    });

    it('dato mancante: vieta esplicitamente di citare numeri', () => {
        for (const v of [undefined, null]) {
            const t = describeDepositPolicy(v as any);
            expect(t.toLowerCase()).toContain('non citare');
        }
    });

    it('non inventa mai un numero che non gli è stato dato', () => {
        // Un importo a zero centesimi non deve diventare "0 euro a persona"
        // presentato come politica valida: resta comunque ciò che dicono le
        // impostazioni, ma il test fissa che il numero non venga sostituito.
        const t = describeDepositPolicy({ enabled: true, minGuests: 2, perPersonCents: 500 });
        expect(t).toContain('2 persone');
        expect(t).toContain('5 euro');
        expect(t).not.toContain('9');
        expect(t).not.toContain('10 euro');
    });
});
