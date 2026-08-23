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
export const DEFAULT_NAMESPACE = 'prenota';

i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        supportedLngs: SUPPORTED_LANGUAGES,
        fallbackLng: 'it',
        ns: [DEFAULT_NAMESPACE],
        defaultNS: DEFAULT_NAMESPACE,
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
