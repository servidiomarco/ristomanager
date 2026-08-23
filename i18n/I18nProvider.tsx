import React from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from './config';

interface I18nProviderProps {
    children: React.ReactNode;
}

// Non montato in App.tsx: la SPA autenticata non traduce ancora nulla.
// Card dev board #35 lo avvolge intorno alla sola radice pubblica /pay/:token
// (index.tsx), la prima schermata React a usare davvero react-i18next.
export default function I18nProvider({ children }: I18nProviderProps) {
    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
