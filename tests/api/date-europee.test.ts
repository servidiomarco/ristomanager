import { describe, it, expect } from 'vitest';
// Il sorgente: funzione pura.
import { isoDatesToEuropean } from '../../utils/text';

// La proposta dell'agente WhatsApp mostrava «Modifica prenotazione del
// 2026-10-05: data → 2026-10-07» (03/10/2026): le date del modello vanno
// lette all'europea, anche nelle proposte già salvate col formato ISO.
describe('isoDatesToEuropean', () => {
    it('riscrive le date ISO dentro un testo', () => {
        expect(isoDatesToEuropean('Modifica prenotazione del 2026-10-05: data → 2026-10-07'))
            .toBe('Modifica prenotazione del 05/10/2026: data → 07/10/2026');
        expect(isoDatesToEuropean('Annulla la prenotazione del 2026-12-31 alle 20:30'))
            .toBe('Annulla la prenotazione del 31/12/2026 alle 20:30');
    });

    it('lascia stare quello che non è una data', () => {
        expect(isoDatesToEuropean('telefono 2026-1234-56')).toBe('telefono 2026-1234-56');
        expect(isoDatesToEuropean('codice 2026-13-40')).toBe('codice 2026-13-40');
        expect(isoDatesToEuropean('persone: 4 → 6')).toBe('persone: 4 → 6');
        expect(isoDatesToEuropean(null)).toBe('');
    });
});
