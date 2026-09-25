import type { Response } from 'express';

// Cancello unico per bcrypt (audit M-07, login senza limiti). bcryptjs è
// JavaScript puro: ogni compare o hash a costo 12 tiene il thread principale
// per ~260 ms, e su Railway il backend è UNA replica da 0,5 vCPU. Qualche
// login al secondo con un'email valida — o una raffica di reset-password con
// token a caso — bastava a saturarlo e a fermare il Frantoio a metà servizio.
// I limiter per IP non bastano da soli: un attacco distribuito arriva da
// mille IP. Qui passano al massimo 2 operazioni insieme e poche in coda;
// oltre si risponde 503 subito, invece di accodare all'infinito e lasciare
// senza CPU tutte le altre richieste.
const MAX_IN_FLIGHT = 2;
const MAX_QUEUED = 8;

let inFlight = 0;
const queue: Array<() => void> = [];

export class BcryptBusyError extends Error {
  constructor() {
    super('bcrypt_busy');
    this.name = 'BcryptBusyError';
  }
}

export const withBcryptSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
  } else if (queue.length < MAX_QUEUED) {
    // Lo slot arriva già ceduto da chi finisce (vedi finally): inFlight non
    // scende e risale, così nessuna richiesta nuova lo scavalca fra il
    // resolve e il risveglio di questa.
    await new Promise<void>(resolve => queue.push(resolve));
  } else {
    throw new BcryptBusyError();
  }
  try {
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  }
};

// Per i catch delle route: il cancello pieno non è un errore del server ma
// un "riprova tra poco" — 503 con Retry-After, messaggio da mostrare così
// com'è. Ritorna true se ha risposto lui.
export const replyIfBcryptBusy = (res: Response, error: unknown): boolean => {
  if (!(error instanceof BcryptBusyError)) return false;
  res.set('Retry-After', '2');
  res.status(503).json({ error: 'server_busy', message: 'Troppe richieste in corso, riprova tra qualche secondo.' });
  return true;
};
