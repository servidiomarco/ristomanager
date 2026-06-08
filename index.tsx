import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { ShoppingProvider } from './contexts/ShoppingContext';
import { TodosProvider } from './contexts/TodosContext';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AuthProvider>
      <ShoppingProvider>
        <TodosProvider>
          <App />
        </TodosProvider>
      </ShoppingProvider>
    </AuthProvider>
  </React.StrictMode>
);