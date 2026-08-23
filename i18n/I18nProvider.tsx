import React from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from './config';

interface I18nProviderProps {
    children: React.ReactNode;
}

// Non ancora montato in App.tsx (Card dev board #33 traduce solo il widget
// /prenota, non la SPA): pronto da avvolgere intorno alla radice quando una
// prima schermata React migrerà a react-i18next.
export default function I18nProvider({ children }: I18nProviderProps) {
    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
