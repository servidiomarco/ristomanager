// Piano dei minuti di Sofia inclusi nell'add-on voce.
//
// Questi sono i DEFAULT: ogni ristorante può avere una riga in voice_plans
// che ne sovrascrive alcuni (accordi particolari, tetto scelto dal
// ristoratore). Una colonna NULL lì vale il valore di qui — cambiare il
// listino per tutti è cambiare questo file.
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
    /** Tetto di spesa per i minuti extra del mese, in centesimi. Lo sceglie
     *  il ristoratore; 0 = nessun minuto extra. */
    extraCapCents: 5000,
};

export type VoicePlan = typeof VOICE_PLAN_DEFAULTS;

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

/** Minuti oltre gli inclusi e quanto valgono, col tetto del ristoratore:
 *  oltre il tetto i minuti non si fatturano (dalla Fase 4 Sofia si ferma
 *  prima di arrivarci). */
export const extraCharge = (minutes: number, plan: VoicePlan = VOICE_PLAN_DEFAULTS) => {
    const extraMinutes = Math.max(0, minutes - plan.includedMinutes);
    const rawCents = extraMinutes * plan.overageCentsPerMinute;
    return {
        extraMinutes,
        extraCents: Math.min(rawCents, plan.extraCapCents),
        overCap: rawCents > plan.extraCapCents,
    };
};

/** Ricavo stimato del mese in centesimi: canone + extra entro il tetto. */
export const estimatedRevenueCents = (minutes: number, plan: VoicePlan = VOICE_PLAN_DEFAULTS): number =>
    plan.priceCents + extraCharge(minutes, plan).extraCents;
