import { describe, it, expect } from 'vitest';
import { normalizePhoneE164, normalizeItalianPhone } from '../../utils/phone.js';

// «Un numero senza prefisso è italiano» era vero finché i clienti erano tutti
// in Italia. Qui si certifica che per l'Italia non cambi nulla e che per gli
// altri paesi il numero locale prenda il prefisso giusto.
describe('telefoni in forma internazionale', () => {
    it('per l\'Italia si comporta come ha sempre fatto', () => {
        expect(normalizeItalianPhone('333 1234567')).toBe('+393331234567');
        expect(normalizeItalianPhone('+39 333 1234567')).toBe('+393331234567');
        expect(normalizeItalianPhone('393331234567')).toBe('+393331234567');
        expect(normalizeItalianPhone('0039 333 1234567')).toBe('+393331234567');
    });

    it('i cellulari italiani che cominciano per 39 restano numeri locali', () => {
        // 392, 393… sono prefissi di cellulare veri: presi per «+39 2…»
        // finirebbero a un numero inesistente.
        expect(normalizePhoneE164('3921234567', '39')).toBe('+393921234567');
        expect(normalizePhoneE164('3931234567', '39')).toBe('+393931234567');
    });

    it('lo zero dei fissi italiani non si tocca', () => {
        // In Italia lo zero fa parte del numero: +39 06… è giusto, +39 6… no.
        expect(normalizePhoneE164('06 5551234', '39')).toBe('+39065551234');
        expect(normalizePhoneE164('02 12345678', '39')).toBe('+390212345678');
    });

    it('nel Regno Unito lo zero iniziale è un prefisso e si toglie', () => {
        expect(normalizePhoneE164('07700 900123', '44')).toBe('+447700900123');
        expect(normalizePhoneE164('020 7946 0958', '44')).toBe('+442079460958');
        expect(normalizePhoneE164('7700900123', '44')).toBe('+447700900123');
    });

    it('un numero già internazionale non viene toccato, qualunque sia il paese di casa', () => {
        // Il caso che romperebbe tutto: un +44 salvato a mano in un ristorante
        // italiano non deve diventare +39 44…
        expect(normalizePhoneE164('+44 7700 900123', '39')).toBe('+447700900123');
        expect(normalizePhoneE164('+39 333 1234567', '44')).toBe('+393331234567');
        expect(normalizePhoneE164('00971 50 1234567', '39')).toBe('+971501234567');
    });

    it('un numero di Dubai locale prende il prefisso degli Emirati', () => {
        expect(normalizePhoneE164('50 1234567', '971')).toBe('+971501234567');
    });

    it('input vuoto o senza cifre non produce un finto numero', () => {
        expect(normalizePhoneE164('', '44')).toBe('');
        expect(normalizePhoneE164('   ', '44')).toBe('');
        expect(normalizePhoneE164('n/d', '44')).toBe('');
    });
});
