// Dove sta il ristorante: valuta, fuso e paese — le tre cose che un CRM dà
// per scontate finché tutti i clienti sono in Italia.
//
// Stesso schema di entitlements.ts (cache per tenant con TTL breve,
// stale-if-error, invalidazione esplicita dopo le scritture): queste tre
// informazioni si leggono su ogni importo formattato e su ogni data
// mostrata, quindi un giro a DB per lettura sarebbe solo latenza. Vive in
// services/ per la stessa ragione: importarlo da server.ts creerebbe un
// ciclo con auth/.
//
// Il default è l'Italia di sempre. Un errore di lettura non deve cambiare
// la valuta sotto i piedi di chi sta incassando: senza copia in cache si
// ripiega su Rome/EUR/IT, che è ciò che il sistema faceva prima che queste
// colonne esistessero.
import { queryWithRetry } from '../db.js';

export interface TenantLocale {
    /** ISO 4217, sempre a due decimali (vedi il CHECK sulla colonna). */
    currency: string;
    /** IANA, es. 'Europe/Rome'. */
    timezone: string;
    /** ISO 3166-1 alpha-2, es. 'IT'. */
    countryCode: string;
    /** Prefisso telefonico internazionale senza '+', derivato dal paese. */
    dialCode: string;
}

// Il prefisso si deriva dal paese invece di stare in una colonna sua: due
// fonti per lo stesso fatto divergono al primo inserimento a mano. Si
// allunga quando si vende in un paese nuovo.
const DIAL_CODE_BY_COUNTRY: Record<string, string> = {
    IT: '39',
    GB: '44',
    IE: '353',
    CH: '41',
    FR: '33',
    DE: '49',
    ES: '34',
    AE: '971',
    US: '1',
};

export const DEFAULT_TENANT_LOCALE: TenantLocale = {
    currency: 'EUR',
    timezone: 'Europe/Rome',
    countryCode: 'IT',
    dialCode: '39',
};

/** Prefisso telefonico per un paese; Italia se il paese non è in tabella. */
export function dialCodeForCountry(countryCode: string | null | undefined): string {
    const cc = String(countryCode ?? '').trim().toUpperCase();
    return DIAL_CODE_BY_COUNTRY[cc] ?? DEFAULT_TENANT_LOCALE.dialCode;
}

/** Un fuso che Intl non riconosce manderebbe in eccezione ogni formattazione. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
    const value = String(tz ?? '').trim();
    if (!value) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

const localeCache = new Map<number, { locale: TenantLocale; refreshedAt: number }>();
const LOCALE_TTL_MS = 60_000;

export async function getTenantLocale(tenantId: number): Promise<TenantLocale> {
    const cached = localeCache.get(tenantId);
    if (cached && Date.now() - cached.refreshedAt <= LOCALE_TTL_MS) {
        return cached.locale;
    }
    try {
        const result = await queryWithRetry(
            'SELECT currency, timezone, country_code FROM tenants WHERE id = $1',
            [tenantId]
        );
        const row = result.rows[0];
        if (!row) return cached ? cached.locale : { ...DEFAULT_TENANT_LOCALE };

        const countryCode = String(row.country_code ?? DEFAULT_TENANT_LOCALE.countryCode).trim().toUpperCase();
        // Il fuso si rivalida anche in lettura: la colonna ha un default ma
        // niente vincolo, e una stringa sbagliata scritta a mano romperebbe
        // ogni data mostrata invece di degradare su Roma.
        const timezone = isValidTimeZone(row.timezone) ? String(row.timezone).trim() : DEFAULT_TENANT_LOCALE.timezone;
        const locale: TenantLocale = {
            currency: String(row.currency ?? DEFAULT_TENANT_LOCALE.currency).trim().toUpperCase(),
            timezone,
            countryCode,
            dialCode: dialCodeForCountry(countryCode),
        };
        localeCache.set(tenantId, { locale, refreshedAt: Date.now() });
        return locale;
    } catch (err) {
        console.error('[tenant-locale] lettura tenants fallita:', (err as any)?.message || err);
        return cached ? cached.locale : { ...DEFAULT_TENANT_LOCALE };
    }
}

/** Da chiamare dopo ogni scrittura su tenants.currency/timezone/country_code. */
export function invalidateTenantLocaleCache(tenantId: number): void {
    localeCache.delete(tenantId);
}

/** Da chiamare a migration completate, come per gli entitlement: il server
 *  accetta richieste prima che finiscano, e una lettura in quella finestra
 *  metterebbe in cache lo stato pre-migration per tutto il TTL. */
export function clearTenantLocaleCache(): void {
    localeCache.clear();
}
