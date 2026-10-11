import { describe, it, expect } from 'vitest';
// Il sorgente, non dist: le funzioni sono pure e l'ora si passa da fuori.
import { slotProposal, offGridMessage, nearestSlots } from '../../services/slotProposal';

// Chiamata di Rebecca Marchese, 11/10/2026 alle 21:43: «tre persone, ora».
// Sofia passa time 21:43 e legge «alle 21:43 non prendiamo prenotazioni. Gli
// orari più vicini sono alle 21:30 o alle 21:45» — un no a un orario mai
// detto, e le 21:30 erano già passate.
const GRIGLIA = ['20:30', '20:45', '21:00', '21:15', '21:30', '21:45', '22:00', '22:15'];
const alle = (hm: string) => {
    const [h, m] = hm.split(':').map(Number);
    return { isToday: true, nowMinutes: h * 60 + m };
};

describe('orario fuori griglia: cosa si propone', () => {
    it('«ora» alle 21:43: il primo orario, senza il no e senza orari passati', () => {
        const prop = slotProposal('21:43', GRIGLIA, alle('21:43'));
        expect(prop.asap).toBe(true);
        expect(prop.near).toEqual(['21:45', '22:00']);
        const frase = offGridMessage('21:43', prop, false)!;
        expect(frase).toBe('Posso prenotarle alle 21:45 o alle 22:00: quale preferisce?');
        expect(frase).not.toContain('21:43');
        expect(frase).not.toContain('21:30');
        expect(frase).not.toContain('non prendiamo');
    });

    it('un orario appena passato resta proponibile a chi arriva adesso', () => {
        const prop = slotProposal('21:46', GRIGLIA, alle('21:46'));
        expect(prop.asap).toBe(true);
        expect(prop.near).toEqual(['21:45', '22:00']);
        expect(prop.future).toContain('21:45');
        expect(prop.future).not.toContain('21:30');
    });

    it('un orario detto dal cliente, più tardi stasera: il no resta e i vicini sono futuri', () => {
        const prop = slotProposal('21:10', GRIGLIA, alle('19:00'));
        expect(prop.asap).toBe(false);
        expect(prop.near).toEqual(['21:00', '21:15']);
        expect(offGridMessage('21:10', prop, false)).toContain('Alle 21:10 non prendiamo prenotazioni');
    });

    it('un orario già passato di parecchio: si propone dal primo libero in poi', () => {
        const prop = slotProposal('20:40', GRIGLIA, alle('21:43'));
        expect(prop.asap).toBe(true);
        expect(prop.near).toEqual(['21:45', '22:00']);
    });

    it('un altro giorno: nessun filtro sull\'ora, i due più vicini come sempre', () => {
        const prop = slotProposal('21:43', GRIGLIA, { isToday: false, nowMinutes: 21 * 60 + 43 });
        expect(prop.asap).toBe(false);
        expect(prop.near).toEqual(nearestSlots('21:43', GRIGLIA));
        expect(prop.near).toEqual(['21:30', '21:45']);
    });

    it('a griglia finita per oggi non c\'è niente da proporre', () => {
        const prop = slotProposal('23:50', GRIGLIA, alle('23:50'));
        expect(prop.future).toEqual([]);
        expect(prop.near).toEqual([]);
        expect(offGridMessage('23:50', prop, false)).toBeNull();
    });

    it('un solo orario rimasto: lo propone da solo', () => {
        // Alle 22:12 le 22:00 sono passate da più dei 10 minuti di tolleranza.
        const prop = slotProposal('22:12', GRIGLIA, alle('22:12'));
        expect(prop.near).toEqual(['22:15']);
        expect(offGridMessage('22:12', prop, false)).toBe('Posso prenotarle alle 22:15: le va bene?');
    });

    it('in inglese', () => {
        const prop = slotProposal('21:43', GRIGLIA, alle('21:43'));
        expect(offGridMessage('21:43', prop, true)).toBe('I can book you at 21:45 or 22:00: which do you prefer?');
    });
});
