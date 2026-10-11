// Cosa propongono Sofia e l'agente WhatsApp quando l'orario chiesto non è
// sulla griglia. Funzioni pure, senza database né orologio (l'ora la passa
// chi chiama): bookingTools le usa con l'ora del locale, i test a ore fisse.

/** "HH:MM" → minuti dalla mezzanotte. */
export const hmToMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
};

/** I due orari della griglia più vicini a quello richiesto, per proporli a
 *  voce al posto della lista completa (7–9 slot letti al telefono sono il
 *  punto in cui i clienti riattaccano). */
export function nearestSlots(requested: string, slots: string[]): string[] {
    const req = hmToMinutes(requested);
    return [...slots]
        .sort((a, b) => Math.abs(hmToMinutes(a) - req) - Math.abs(hmToMinutes(b) - req) || hmToMinutes(a) - hmToMinutes(b))
        .slice(0, 2)
        .sort((a, b) => hmToMinutes(a) - hmToMinutes(b));
}

/** Un orario di oggi passato da meno di questo resta proponibile: chi alle
 *  21:46 dice «arriviamo adesso» prende le 21:45. */
export const SLOT_GRACE_MIN = 10;
/** Entro questo margine da adesso, l'orario chiesto è «adesso». */
export const ASAP_WINDOW_MIN = 15;

export interface SlotProposal {
    /** Uno o due orari da proporre. */
    near: string[];
    /** L'orario chiesto era «adesso»: si propone senza dire il no. */
    asap: boolean;
    /** La griglia senza gli orari già passati (per oggi). */
    future: string[];
}

/**
 * Cosa proporre al posto di un orario che non c'è.
 *
 * Per oggi, solo orari non ancora passati: alle 21:43 «le 21:30 o le 21:45»
 * proponeva un orario passato da un quarto d'ora.
 *
 * `asap`: l'orario chiesto è «adesso» — oggi, già passato o entro un quarto
 * d'ora. Succede quando il cliente dice «ora», «adesso», «subito» e l'agente
 * lo traduce nell'ora del momento: rispondere «alle 21:43 non prendiamo
 * prenotazioni» è un no a un orario che il cliente non ha mai detto
 * (chiamata di Rebecca Marchese, 11/10/2026). Si propone il primo orario,
 * senza il no.
 */
export function slotProposal(
    requested: string,
    slots: string[],
    clock: { isToday: boolean; nowMinutes: number },
): SlotProposal {
    if (!clock.isToday) return { near: nearestSlots(requested, slots), asap: false, future: slots };
    const now = clock.nowMinutes;
    const future = slots
        .filter(slot => hmToMinutes(slot) >= now - SLOT_GRACE_MIN)
        .sort((a, b) => hmToMinutes(a) - hmToMinutes(b));
    if (hmToMinutes(requested) <= now + ASAP_WINDOW_MIN) {
        return { near: future.slice(0, 2), asap: true, future };
    }
    return { near: nearestSlots(requested, future), asap: false, future };
}

/** La frase per un orario che non c'è: con «adesso» solo la proposta,
 *  altrimenti il no all'orario chiesto e i più vicini. null senza proposte. */
export function offGridMessage(requested: string, prop: Pick<SlotProposal, 'near' | 'asap'>, english: boolean): string | null {
    const { near, asap } = prop;
    if (near.length === 0) return null;
    if (asap) {
        return english
            ? (near.length === 2 ? `I can book you at ${near[0]} or ${near[1]}: which do you prefer?` : `I can book you at ${near[0]}: is that all right?`)
            : (near.length === 2 ? `Posso prenotarle alle ${near[0]} o alle ${near[1]}: quale preferisce?` : `Posso prenotarle alle ${near[0]}: le va bene?`);
    }
    return english
        ? (near.length === 2
            ? `We do not take bookings at ${requested}: the closest times are ${near[0]} or ${near[1]}. Which one do you prefer?`
            : `We do not take bookings at ${requested}: the closest time is ${near[0]}. Is that all right?`)
        : (near.length === 2
            ? `Alle ${requested} non prendiamo prenotazioni: gli orari più vicini sono le ${near[0]} o le ${near[1]}. Quale preferisce?`
            : `Alle ${requested} non prendiamo prenotazioni: l'orario più vicino è alle ${near[0]}. Le va bene?`);
}
