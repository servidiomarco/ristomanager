import React from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from './config';

interface I18nProviderProps {
    children: React.ReactNode;
}

// Avvolge TUTTE le radici React (index.tsx): le pagine pubbliche
// (/pay, /scontrino, /preventivo) e ora anche la SPA autenticata, dove la
// lingua segue l'operatore (users.language, applicata in App.tsx).
export default function I18nProvider({ children }: I18nProviderProps) {
    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
