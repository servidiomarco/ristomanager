import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { ShoppingProvider } from './contexts/ShoppingContext';
import { TodosProvider } from './contexts/TodosContext';
import { PublicPayPageEntry } from './components/PublicPayPage';
import I18nProvider from './i18n/I18nProvider';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// Public pay-at-table page: mounted OUTSIDE the AuthProvider so guests
// hitting the QR link don't trigger the login redirect. Everything else
// still goes through the standard authenticated app shell.
const isPublicPayRoute = /^\/pay\//.test(window.location.pathname);

root.render(
  <React.StrictMode>
    {isPublicPayRoute ? (
      <I18nProvider>
        <PublicPayPageEntry />
      </I18nProvider>
    ) : (
      <AuthProvider>
        <ShoppingProvider>
          <TodosProvider>
            <App />
          </TodosProvider>
        </ShoppingProvider>
      </AuthProvider>
    )}
  </React.StrictMode>
);
