// La scheda del cliente in rubrica, per le due AI dei Messaggi (agente
// WhatsApp e risposte suggerite). Prima non c'era: il 03/10/2026 un cliente
// col tavolo preferito in rubrica ha chiesto «posso mangiare al mio tavolo
// preferito?» e l'AI gli ha chiesto quale fosse.
//
// Dentro solo ciò che serve a rispondere su WhatsApp: nome, VIP, tavolo e
// sala preferiti, preferenze annotate. Le note alimentari restano fuori di
// proposito: sulle allergie le AI non devono entrare nel merito, e un dato
// del genere nel prompt le spingerebbe a farlo. Fuori anche le note generiche
// della scheda, che possono contenere cose non da dire al cliente.

export interface AiCustomerProfile {
    name?: string | null;
    is_vip?: boolean | null;
    preferred_table_name?: string | null;
    preferred_room_name?: string | null;
    preferences_notes?: string | null;
}

/** La sezione del prompt; una riga fissa quando il numero non è in rubrica. */
export function describeCustomerForAi(c: AiCustomerProfile | null | undefined): string {
    if (!c) return '(questo numero non è in rubrica)';
    // In piantina il nome è di solito il solo numero («12»), ma c'è chi
    // scrive «Tavolo 12»: senza il controllo diventerebbe «tavolo Tavolo 12».
    const nomeTavolo = c.preferred_table_name
        ? (/^tavolo\b/i.test(c.preferred_table_name) ? c.preferred_table_name : `tavolo ${c.preferred_table_name}`)
        : null;
    const tavolo = nomeTavolo
        ? `${nomeTavolo}${c.preferred_room_name ? ` in ${c.preferred_room_name}` : ''}`
        : null;
    return [
        c.name ? `- Nome: ${c.name}` : '',
        c.is_vip ? '- Cliente VIP del ristorante' : '',
        tavolo ? `- Tavolo preferito: ${tavolo}` : '- Tavolo preferito: non annotato',
        c.preferences_notes ? `- Preferenze annotate: ${String(c.preferences_notes).slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
}

/** Come usare la scheda. L'errore da non ripetere è chiedere al cliente un
 *  dato che il ristorante ha già. E niente promesse: le prenotazioni nate
 *  dai Messaggi non prendono il tavolo preferito da sole, lo assegna una
 *  persona se è libero. */
export const CUSTOMER_PREFERENCE_RULES = `- Se il cliente chiede il suo tavolo preferito (o «il solito tavolo») e nella scheda in rubrica c'è, non chiedergli quale sia: nominalo (per esempio «il tavolo 12 in Veranda») e digli che lo abbiamo segnato come suo preferito e che, se per quel servizio è libero, cerchiamo di darglielo. Non garantirlo.
- Se la prenotazione collegata ha già quel tavolo, diglielo.
- Se il tavolo preferito non è annotato, o il numero non è in rubrica, chiedigli quale preferisce.
- Usa la scheda solo quando serve alla risposta: non elencare al cliente cosa c'è scritto e non dirgli che è VIP.`;
