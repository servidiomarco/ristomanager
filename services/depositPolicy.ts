// Come si racconta la politica caparra al modello.
//
// I numeri vengono SEMPRE dalle Impostazioni del ristorante, mai da una regola
// scritta a mano nella base di conoscenza: il gestore cambia la soglia da lì,
// e una regola col numero fisso resterebbe indietro in silenzio — l'AI
// direbbe ai clienti una soglia che il sistema non applica.
//
// La frase sta qui e non nei due servizi che la usano perché una politica
// raccontata in due modi diversi è una politica che prima o poi diverge.

export interface DepositPolicy {
    enabled: boolean;
    minGuests: number;
    perPersonCents: number;
}

/** Riga da mettere nel prompt. Mai numeri inventati: se il dato manca, si dice. */
export const describeDepositPolicy = (p?: DepositPolicy | null): string => {
    if (!p) return '(non disponibile: non citare importi o soglie)';
    if (!p.enabled) return 'Non è richiesta alcuna caparra. Se il cliente ne chiede una, di\' che non serve.';
    const euro = (p.perPersonCents / 100).toFixed(0);
    return `Richiesta dalle ${p.minGuests} persone in su, ${euro} euro a persona. Sotto le ${p.minGuests} persone non si chiede.`;
};
