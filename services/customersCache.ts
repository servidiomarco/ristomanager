import type { Customer } from '../types';
import type { CustomerDuplicateGroup } from './apiService';

// Cache a livello modulo della rubrica clienti, stesso schema di inboxCache:
// CustomerList viene smontata a ogni cambio vista e ogni rientro rifaceva
// il fetch dell'intera rubrica (3.300+ righe) più i duplicati. Si mostra
// subito l'ultimo stato noto e si rinfresca in background
// (stale-while-revalidate); App svuota al logout. Nessun prefetch al login:
// la rubrica pesa più delle liste di comunicazione e la pagina non è tra le
// prime aperte — il primo ingresso paga il fetch una volta sola.
export const customersCache = {
  list: null as Customer[] | null,
  duplicates: null as CustomerDuplicateGroup[] | null,
  clear() {
    this.list = null;
    this.duplicates = null;
  },
};
