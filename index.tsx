import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ShoppingProvider } from './contexts/ShoppingContext';
import { TodosProvider } from './contexts/TodosContext';
import { PublicPayPageEntry } from './components/PublicPayPage';
import { PublicReceiptPage } from './components/PublicReceiptPage';
import { PublicQuotePage } from './components/PublicQuotePage';
import I18nProvider from './i18n/I18nProvider';
import './index.css';

// Shell offline: il service worker (precache Workbox + push) si registra al
// boot per TUTTI — prima lo installava solo chi attivava le notifiche push,
// e a linea caduta un refresh moriva in pagina bianca perché la shell vive
// su Vercel. Solo in produzione: sotto HMR un SW serve shell stantie.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Best-effort: senza SW l'app funziona come sempre, solo non offline.
    });
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// Public pay-at-table page: mounted OUTSIDE the AuthProvider so guests
// hitting the QR link don't trigger the login redirect. Everything else
// still goes through the standard authenticated app shell.
const isPublicPayRoute = /^\/pay\//.test(window.location.pathname);
// Scontrino digitale: stessa famiglia di /pay — l'ospite arriva dal QR
// sull'esito di chiusura, niente login.
const isPublicReceiptRoute = /^\/scontrino\//.test(window.location.pathname);
// Preventivo banchetto condiviso: il cliente apre il link ricevuto via
// WhatsApp o email, niente login.
const isPublicQuoteRoute = /^\/preventivo\//.test(window.location.pathname);

root.render(
  <React.StrictMode>
    {isPublicPayRoute ? (
      <I18nProvider>
        <PublicPayPageEntry />
      </I18nProvider>
    ) : isPublicReceiptRoute ? (
      <I18nProvider>
        <PublicReceiptPage />
      </I18nProvider>
    ) : isPublicQuoteRoute ? (
      <I18nProvider>
        <PublicQuotePage />
      </I18nProvider>
    ) : (
      <AuthProvider>
        <ToastProvider>
          <ShoppingProvider>
            <TodosProvider>
              <App />
            </TodosProvider>
          </ShoppingProvider>
        </ToastProvider>
      </AuthProvider>
    )}
  </React.StrictMode>
);
