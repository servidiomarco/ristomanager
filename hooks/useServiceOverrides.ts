import { useEffect, useMemo, useRef, useState } from 'react';
import type { Shift } from '../types';
import type { ServiceOverrides } from '../components/salaVivo/types';
import {
  OVERRIDES_EVENTS,
  applyEvent,
  applyFetch,
  emptyOverrides,
  fetchVerdict,
  overridesEvent,
  overridesFor,
  serviceKeyOf,
  type OverridesSnapshot,
} from '../components/salaVivo/model/overrides';
import { getRoomClosed, getTableHidden, getTableMerges } from '../services/apiService';
import { onSocketEvent } from '../services/socketEvents';
import { socketClient } from '../services/socketClient';

/* Le varianti della sala che valgono per un servizio solo (data e turno):
 * tavoli uniti, tavoli nascosti, sale chiuse. La Sala dal vivo le legge per
 * il servizio in corso, e le tiene aggiornate da sola.
 *
 * Perché non riusa gli effetti di FloorPlan: lì stanno dentro il componente,
 * legati alla data scelta in testata, e ascoltano con useSocket(), che al
 * montaggio chiama connect() e a socket giù apre una seconda connessione
 * accanto a quella che si sta riconnettendo. Qui il modello è
 * useFloorMarkers: handler con nome attraverso onSocketEvent (sopravvivono al
 * cambio d'istanza del socket a ogni token nuovo) e una rilettura al ritorno
 * della connessione, perché gli eventi persi mentre era giù non tornano. La
 * logica degli eventi è quella di FloorPlan, copiata.
 *
 * I passaggi (che risposta si applica, quale evento conta, a quale servizio)
 * stanno in model/overrides.ts, puri e provati dai test: qui restano solo la
 * rete, il socket e lo stato di React. */

/** Le unioni, i tavoli nascosti e le sale chiuse del servizio (date, shift).
 *
 * Al cambio di servizio riparte da vuoto con `ready` falso, e i dati del
 * servizio precedente non si vedono nemmeno per un render: un'unione appena
 * letta farebbe saltare i tavoli da separati a uniti sotto gli occhi. Le tre
 * letture vanno in parallelo, e vale quello che arriva: una che fallisce
 * lascia vuoto (o, in una rilettura, quello che c'era). `ready` diventa vero
 * quando hanno risposto tutte, riuscite o no. */
export function useServiceOverrides(date: string, shift: Shift): ServiceOverrides {
  const key = serviceKeyOf(date, shift);
  const [snap, setSnap] = useState<OverridesSnapshot>(() => emptyOverrides(key));
  const [reloadKey, setReloadKey] = useState(0);
  // Eventi del servizio arrivati dopo l'avvio di una lettura: la sua risposta
  // sarebbe una foto più vecchia di quello che si vede, quindi si rilegge.
  const changesRef = useRef(0);

  useEffect(() => {
    const serviceKey = serviceKeyOf(date, shift);
    let cancelled = false;
    const startedAt = changesRef.current;
    void Promise.allSettled([
      getTableMerges(date, shift),
      getTableHidden(date, shift),
      getRoomClosed(date, shift),
    ]).then(([merges, hidden, closed]) => {
      const verdict = fetchVerdict(cancelled, startedAt, changesRef.current);
      if (verdict === 'drop') return;
      if (verdict === 'refetch') {
        setReloadKey(k => k + 1);
        return;
      }
      if (merges.status === 'rejected') console.error('[sala-dal-vivo] unioni non lette', merges.reason);
      if (hidden.status === 'rejected') console.error('[sala-dal-vivo] tavoli nascosti non letti', hidden.reason);
      if (closed.status === 'rejected') console.error('[sala-dal-vivo] sale chiuse non lette', closed.reason);
      setSnap(prev => applyFetch(prev, serviceKey, { merges, hidden, closed }));
    });
    return () => { cancelled = true; };
  }, [date, shift, reloadKey]);

  useEffect(() => {
    const serviceKey = serviceKeyOf(date, shift);
    const offs = OVERRIDES_EVENTS.map(event =>
      onSocketEvent(event, (payload: unknown) => {
        const update = overridesEvent(event, payload, date, shift);
        if (!update) return;
        // Ogni evento del servizio conta come cambiamento, anche quando qui
        // non sposta niente: una lettura partita prima potrebbe non contenerlo.
        changesRef.current += 1;
        setSnap(prev => applyEvent(prev, serviceKey, update));
      }));
    // Riconnessione = passaggio da giù a su. Mai un listener su 'connect':
    // App lo stacca senza handler e si porterebbe via anche il nostro. Durante
    // la rilettura restano i valori che si hanno.
    let wasConnected = socketClient.isConnected();
    const offChange = socketClient.onSocketChange((_socket, connected) => {
      if (connected && !wasConnected) setReloadKey(k => k + 1);
      wasConnected = connected;
    });
    return () => {
      for (const off of offs) off();
      offChange();
    };
  }, [date, shift]);

  return useMemo(() => overridesFor(snap, key), [snap, key]);
}
