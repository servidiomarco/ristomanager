import { useEffect, useSyncExternalStore } from 'react';
import type { Socket } from 'socket.io-client';
import { socketClient } from '../services/socketClient';
import { getTavoliAperti, type TavoloApertoInCassa } from '../services/passepartoutApiService';

/* I tavoli aperti nella cassa Passepartout, per la sala (FloorPlan,
   Reception, mappa delle Prenotazioni). Uno store di modulo: una lettura
   iniziale e un solo ascoltatore socket ('passepartout:tavoli-aperti') per
   tutta l'app, qualunque sia il numero di schermate che lo usano. Il server
   avvisa solo quando qualcosa cambia; a interruttore spento manda la lista
   vuota. */

type Elenco = ReadonlyMap<number, TavoloApertoInCassa>;
const VUOTO: Elenco = new Map();

let stato: Elenco = VUOTO;
let avviato = false;
const ascoltatori = new Set<() => void>();

const imposta = (tavoli: TavoloApertoInCassa[]) => {
  stato = new Map(tavoli.map((t) => [t.table_id, t]));
  ascoltatori.forEach((l) => l());
};

const avvia = () => {
  if (avviato) return;
  avviato = true;
  getTavoliAperti().then((r) => imposta(r.tavoli)).catch(() => { /* la sala resta com'era */ });
  const onEvento = (payload: { tavoli?: TavoloApertoInCassa[] }) => imposta(payload?.tavoli ?? []);
  let attaccato: Socket | null = null;
  const attacca = (s: Socket | null) => {
    if (attaccato === s) return;
    attaccato?.off('passepartout:tavoli-aperti', onEvento);
    attaccato = s;
    attaccato?.on('passepartout:tavoli-aperti', onEvento);
  };
  attacca(socketClient.getSocket());
  socketClient.onSocketChange((s) => attacca(s));
};

const iscrivi = (l: () => void) => {
  ascoltatori.add(l);
  return () => { ascoltatori.delete(l); };
};

/** I tavoli aperti in cassa per id del tavolo CRM; vuoto senza il modulo. */
export function useTavoliApertiInCassa(attivo: boolean): Elenco {
  useEffect(() => { if (attivo) avvia(); }, [attivo]);
  const elenco = useSyncExternalStore(iscrivi, () => stato, () => VUOTO);
  return attivo ? elenco : VUOTO;
}
