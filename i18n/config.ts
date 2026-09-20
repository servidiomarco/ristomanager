import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import Backend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';

// Fondazione i18n riusabile per la SPA (Card dev board #33). Oggi non la usa
// ancora nessuna schermata: il widget /prenota resta vanilla JS e traduce da
// sé (vedi public/prenota.html), ma legge le STESSE risorse — stesso path
// public/locales/{{lng}}/{{ns}}.json — così quando una schermata React
// migrerà le traduzioni non vanno riscritte, solo agganciate qui.
export type SupportedLanguage = 'it' | 'en';
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['it', 'en'];
// Namespace della SPA autenticata: una namespace per vista, più `common` per
// ciò che le attraversa tutte (navigazione, etichette di stato, toast,
// conferme). Solo `common` è precaricata; le viste caricano la loro alla
// prima apertura via useTranslation('<vista>') — il palmare in Comande non
// si tira giù il testo di Impostazioni.
export const COMMON_NAMESPACE = 'common';
// Il widget pubblico /prenota NON passa da qui (è HTML statico con il suo
// motore), ma legge gli stessi file: la namespace resta esportata per chi la
// referenzia.
export const DEFAULT_NAMESPACE = 'prenota';
// Card dev board #35 — pagina pubblica /pay/:token, stesso schema di risorse
// del widget /prenota ma con un namespace proprio (una pagina, un file). Non
// in `ns` qui sotto: caricato on-demand da useTranslation('paytable'), così
// il conto non tira giù prenota.json e viceversa.
export const PAY_NAMESPACE = 'paytable';
// Stesso schema per le altre due pagine pubbliche React: scontrino digitale
// (/scontrino/:token) e preventivo banchetto (/preventivo/:token). Anche
// questi caricati on-demand da useTranslation, mai in `ns`.
export const RECEIPT_NAMESPACE = 'receipt';
export const QUOTE_NAMESPACE = 'quote';

i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        supportedLngs: SUPPORTED_LANGUAGES,
        // Italiano come ripiego: una chiave non ancora tradotta esce in
        // italiano, mai come chiave grezza sotto gli occhi di un cameriere.
        fallbackLng: 'it',
        ns: [COMMON_NAMESPACE],
        defaultNS: COMMON_NAMESPACE,
        backend: {
            // La SPA (Vercel) serve public/ come asset statici: stesso path
            // che il backend (Railway) espone esplicitamente per il widget.
            loadPath: '/locales/{{lng}}/{{ns}}.json',
        },
        detection: {
            order: ['localStorage', 'navigator'],
            caches: ['localStorage'],
        },
        interpolation: {
            // React già esegue l'escaping in fase di render.
            escapeValue: false,
        },
    });

export default i18n;
