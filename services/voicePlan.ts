// Piano dei minuti di Sofia inclusi nell'add-on voce.
//
// Fase 1 (settembre 2026): valori unici per tutti i tenant, scritti qui.
// Servono a misurare — minuti conteggiati, costo, ricavo stimato e margine —
// prima di fatturare qualcosa. Con la Fase 2 diventano impostazioni per
// tenant nel DB e questi restano i default.
//
// Numeri decisi il 23/09/2026 sui consumi reali del Vecchio Frantoio
// (≈ 300 min in un mese normale, 1.048 ad agosto) e su un costo ElevenLabs
// di ≈ 0,10 $/min dopo il fix della cache LLM.

export const VOICE_PLAN_DEFAULTS = {
    /** Prezzo dell'add-on al mese, in centesimi di euro. */
    priceCents: 4900,
    /** Minuti di conversazione inclusi nel mese. */
    includedMinutes: 250,
    /** Prezzo del minuto oltre gli inclusi, in centesimi di euro. */
    overageCentsPerMinute: 20,
} as const;

/** Le chiamate più corte non si contano: riagganci e chiamate per errore
 *  costano pochi centesimi e contarle farebbe solo discutere. */
export const VOICE_MIN_BILLABLE_SECONDS = 10;

/** Espressione SQL dei secondi conteggiati di una riga voice_calls. */
export const BILLABLE_SECONDS_SQL =
    `CASE WHEN COALESCE(duration_seconds, 0) >= ${VOICE_MIN_BILLABLE_SECONDS} THEN duration_seconds ELSE 0 END`;

/** Minuti conteggiati da una somma di secondi: arrotondati per eccesso sul
 *  totale del periodo, non chiamata per chiamata. */
export const billableMinutes = (billableSeconds: number): number =>
    Math.ceil(Math.max(0, billableSeconds) / 60);

/** Ricavo stimato del mese in centesimi: canone + minuti oltre gli inclusi.
 *  Nessun tetto in Fase 1: è una stima di quanto si fatturerebbe. */
export const estimatedRevenueCents = (minutes: number, plan = VOICE_PLAN_DEFAULTS): number => {
    const extra = Math.max(0, minutes - plan.includedMinutes);
    return plan.priceCents + extra * plan.overageCentsPerMinute;
};
