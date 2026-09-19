import { useTranslation } from 'react-i18next';
import i18n from '../i18n/config';
import type { SupportedLanguage } from '../i18n/config';

/* ── Formato di date, orari e numeri nella lingua dell'operatore ───────────
   Import SOLO dal frontend (niente estensione .js): il server non passa di
   qui — le sue date per l'ospite hanno la loro strada in server.ts.

   Sostituisce i `'it-IT'` cablati dentro i componenti. È una cosa diversa
   dal FUSO: utils/reservationTime.ts resta su Europe/Rome perché lì è
   correttezza del dato (a che ora ha prenotato il cliente), qui è solo come
   lo si scrive. */

// en-GB e non en-US di proposito: giorno prima del mese, come a Londra e a
// Dubai — e come lo legge l'occhio italiano. Su una lista prenotazioni un
// 03/04 letto al contrario manda una persona al tavolo il giorno sbagliato.
const LOCALE_BY_LANGUAGE: Record<SupportedLanguage, string> = {
    it: 'it-IT',
    en: 'en-GB',
};

/** Locale BCP-47 per la lingua data (o quella corrente dell'istanza i18n). */
export function displayLocale(language?: string | null): string {
    const lang = (language ?? i18n.language ?? 'it').toLowerCase();
    return lang.startsWith('en') ? LOCALE_BY_LANGUAGE.en : LOCALE_BY_LANGUAGE.it;
}

export function formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions, language?: string | null): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(displayLocale(language), options);
}

export function formatTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions, language?: string | null): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    // hour12 false in entrambe le lingue: il servizio si parla in 24 ore,
    // «8 pm» su una comanda è un invito a sbagliare turno.
    return d.toLocaleTimeString(displayLocale(language), { hour12: false, ...options });
}

export function formatDateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions, language?: string | null): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(displayLocale(language), { hour12: false, ...options });
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, language?: string | null): string {
    if (!Number.isFinite(value)) return '';
    return new Intl.NumberFormat(displayLocale(language), options).format(value);
}

/**
 * Locale corrente in un componente React. È un hook e non `displayLocale()`
 * nuda perché al cambio lingua il componente deve ridisegnarsi: useTranslation
 * lo sottoscrive all'istanza i18n.
 */
export function useDisplayLocale(): string {
    const { i18n: instance } = useTranslation();
    return displayLocale(instance.language);
}
