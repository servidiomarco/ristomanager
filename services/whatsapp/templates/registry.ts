// Quale template usare per un ristorante, in quale lingua.
//
// Per i ristoranti che usano le credenziali in env (il Frantoio) la SID sta
// nelle variabili TWILIO_WA_CONTENT_SID_*, come sempre. Per gli altri non
// c'è niente finché non collegano un proprio numero: una SID è valida solo
// nell'account dove è stata approvata, e una SID del Frantoio usata da un
// altro ristorante avrebbe mandato ai suoi clienti il nome del Frantoio.
// Senza template il messaggio scende su SMS o email, come quando una SID
// non è ancora impostata.
//
// La funzione resta sincrona: i builder dei messaggi in server.ts lo sono, e
// sono chiamati in una ventina di punti.

import { isEnglishGuest } from '../../../utils/language.js';
import { envTenantIds } from '../config.js';

export interface PickedTemplate {
    contentSid: string;
    english: boolean;
}

/**
 * La SID del template `baseEnvKey` (la variabile senza `_EN`) per la lingua
 * dell'ospite. L'inglese si usa SOLO quando l'ospite è inglese E la SID _EN
 * c'è: finché manca si resta sulla SID italiana con variabili italiane, mai
 * un ibrido «corpo italiano + variabili inglesi».
 */
export function pickTemplate(
    tenantId: number,
    baseEnvKey: string,
    language: string | null | undefined,
    env: NodeJS.ProcessEnv = process.env
): PickedTemplate | undefined {
    if (!envTenantIds(env).has(tenantId)) return undefined;
    const englishSid = isEnglishGuest(language) ? env[`${baseEnvKey}_EN`] : undefined;
    if (englishSid) return { contentSid: englishSid, english: true };
    const italianSid = env[baseEnvKey];
    return italianSid ? { contentSid: italianSid, english: false } : undefined;
}
