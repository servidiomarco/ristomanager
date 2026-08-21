// Quanto costa una generazione.
//
// I prezzi sono SCRITTI QUI A MANO, per modello, in dollari per milione di
// token: Anthropic fattura in dollari e non espone un'API dei listini. Vanno
// aggiornati a mano quando cambiano — se un modello non è in tabella il costo
// resta `null` e la pagina mostra "n/d" invece di un numero inventato.
//
// La conversione in euro usa un tasso fisso, dichiarato: serve a dare un
// ordine di grandezza a chi legge il conto in euro, non a fare contabilità.
// La fattura vera resta quella di Anthropic, in dollari.

export interface ModelPrice {
    /** Dollari per milione di token in ingresso. */
    inputPerMTok: number;
    /** Dollari per milione di token in uscita. */
    outputPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

// Aggiornato il 2026-08-21. Deliberatamente fisso: un tasso preso live
// renderebbe i confronti fra due aperture della pagina incoerenti, e per
// stimare qualche euro al mese non vale la dipendenza.
export const USD_EUR = 0.92;

/** Costo in dollari, o null se il modello non è in tabella. */
export const costUsd = (model: string, promptTokens: number, outputTokens: number): number | null => {
    const p = MODEL_PRICES[model];
    if (!p) return null;
    return (promptTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
};

/**
 * Frammento SQL che calcola il costo in dollari riga per riga. Sta in SQL e
 * non in JavaScript perché i totali e il grafico giornaliero sono già
 * aggregati dal database: farlo qui evita di riportare indietro ogni riga
 * solo per moltiplicarla.
 *
 * I modelli fuori tabella danno 0 e vengono contati a parte (`unpriced`), così
 * un costo mancante si vede invece di sparire dentro una somma.
 */
export const COST_USD_SQL = `(
    CASE model
${Object.entries(MODEL_PRICES).map(([m, p]) =>
    `        WHEN '${m}' THEN prompt_tokens::numeric / 1000000 * ${p.inputPerMTok} + output_tokens::numeric / 1000000 * ${p.outputPerMTok}`
).join('\n')}
        ELSE 0
    END
)`;

/** Vero quando il modello della riga non ha un prezzo noto. */
export const UNPRICED_SQL = `(model NOT IN (${Object.keys(MODEL_PRICES).map(m => `'${m}'`).join(', ')}))`;
