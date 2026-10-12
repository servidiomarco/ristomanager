// Quale template usare per un ristorante, in quale lingua.
//
// Per i ristoranti che scrivono dal numero Twilio in env (il Frantoio) la
// SID sta nelle variabili TWILIO_WA_CONTENT_SID_*, come sempre. Per un
// locale col proprio numero Meta è il template creato nel suo account
// (templates/provision.ts), se Meta l'ha approvato. Una SID del Frantoio non
// vale mai per un altro locale: esiste solo nel suo account, e porta il suo
// nome. Senza template il messaggio scende su SMS o email, come quando una
// SID non è ancora impostata.
//
// La funzione resta sincrona: i builder dei messaggi in server.ts lo sono, e
// sono chiamati in una ventina di punti. Per Meta legge la memoria dei
// template approvati (templates/meta.ts).

import { isEnglishGuest } from '../../../utils/language.js';
import { envTenantIds, twilioEnvSender } from '../config.js';
import { TEMPLATE_ENV_PREFIX } from './catalog.js';
import { isMetaTemplateSendable, metaTemplateRef } from './meta.js';

/** Il locale scrive dal numero Twilio in env, come getSender: elencato in
 *  WHATSAPP_ENV_TENANT_IDS e con le credenziali presenti. */
export const writesFromEnvTwilio = (tenantId: number, env: NodeJS.ProcessEnv = process.env): boolean =>
    envTenantIds(env).has(tenantId) && twilioEnvSender(env) != null;

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
    if (!writesFromEnvTwilio(tenantId, env)) {
        // Il numero Meta del locale: stessa regola sulla lingua, coi
        // template approvati nel suo account.
        const key = baseEnvKey.startsWith(TEMPLATE_ENV_PREFIX) ? baseEnvKey.slice(TEMPLATE_ENV_PREFIX.length) : baseEnvKey;
        if (isEnglishGuest(language) && isMetaTemplateSendable(tenantId, key, 'en')) {
            return { contentSid: metaTemplateRef(key, 'en'), english: true };
        }
        return isMetaTemplateSendable(tenantId, key, 'it') ? { contentSid: metaTemplateRef(key, 'it'), english: false } : undefined;
    }
    const englishSid = isEnglishGuest(language) ? env[`${baseEnvKey}_EN`] : undefined;
    if (englishSid) return { contentSid: englishSid, english: true };
    const italianSid = env[baseEnvKey];
    return italianSid ? { contentSid: italianSid, english: false } : undefined;
}
