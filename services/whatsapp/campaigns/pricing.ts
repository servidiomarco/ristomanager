// Quanto costa un messaggio di una campagna. I template MARKETING si pagano a
// Meta per messaggio consegnato, a tariffa per paese; per i locali su Twilio
// (il Frantoio) si aggiunge la quota di Twilio. Le cifre sono una stima per
// decidere, non la fattura: si cambiano con le variabili d'ambiente quando
// cambia il listino (Italia dal 01/07/2026: 0,0795 $ per il marketing, da
// riconfermare sul listino Meta).

import { USD_EUR } from '../../aiPricing.js';

const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Il costo stimato di un messaggio di campagna, in centesimi di euro. */
export function campaignUnitCostCents(env: NodeJS.ProcessEnv = process.env): number {
    const meta = num(env.WA_MARKETING_RATE_USD, 0.0795);
    const twilio = num(env.WA_TWILIO_FEE_USD, 0.005);
    return Math.round((meta + twilio) * USD_EUR * 10000) / 100;
}

export const estimateCostCents = (recipients: number, env: NodeJS.ProcessEnv = process.env): number =>
    Math.ceil(recipients * campaignUnitCostCents(env));
