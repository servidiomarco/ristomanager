import { useCallback, useEffect, useRef, useState } from 'react';
import type { FloorMarker, FloorMarkerKind } from '../types';
import { getFloorMarkers } from '../services/apiService';
import type { ApiError } from '../services/apiError';
import { swrConfig } from '../services/configCache';
import { onSocketEvent } from '../services/socketEvents';
import { socketClient } from '../services/socketClient';

const KINDS: readonly FloorMarkerKind[] = ['ENTRANCE', 'PASS', 'HOST_STAND'];

// Lettura difensiva: rotta ed eventi sono nuovi, e fra un deploy e l'altro
// una riga monca o un tipo che questo client non conosce non deve arrivare
// alla piantina come NaN o come un chip senza icona.
const isFloorMarker = (m: unknown): m is FloorMarker => {
  const r = m as Partial<FloorMarker> | null;
  return !!r
    && typeof r.id === 'number'
    && typeof r.room_id === 'number'
    && KINDS.includes(r.kind as FloorMarkerKind)
    && typeof r.x === 'number' && Number.isFinite(r.x)
    && typeof r.y === 'number' && Number.isFinite(r.y);
};

// Un server più vecchio non ha la rotta: il suo 404 vale «nessun segnaposto».
// Gli altri errori risalgono a swrConfig, che tiene il valore che c'era.
const fetchFloorMarkers = (): Promise<FloorMarker[]> =>
  getFloorMarkers()
    .then(list => (Array.isArray(list) ? list.filter(isFloorMarker) : []))
    .catch((err: ApiError) => {
      if (err?.status === 404) return [];
      throw err;
    });

const stampOf = (m: FloorMarker | undefined): number | null => {
  const t = m?.updated_at ? Date.parse(m.updated_at) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Inserisce o sostituisce `m`. Uno per (sala, tipo): esce anche un altro id
 *  con la stessa coppia, eliminato e ricreato da un altro dispositivo.
 *  Una riga più vecchia di quella che si ha per lo stesso id non passa: in
 *  modalità ibrida il client in LAN riceve l'eco delle proprie scritture, e
 *  l'eco può arrivare dopo un trascinamento più recente. Con `staleOnTie`
 *  si scarta anche la stessa versione: serve agli eventi, perché la copia
 *  locale può avere una posizione ottimistica sopra quella stessa riga. */
const mergeMarker = (list: FloorMarker[], m: FloorMarker, staleOnTie: boolean): FloorMarker[] => {
  const incoming = stampOf(m);
  const local = stampOf(list.find(x => x.id === m.id));
  if (incoming !== null && local !== null && (incoming < local || (staleOnTie && incoming === local))) {
    return list;
  }
  return [...list.filter(x => x.id !== m.id && !(x.room_id === m.room_id && x.kind === m.kind)), m];
};

/**
 * Segnaposto di sala (ingresso, pass, accoglienza) di tutto il ristorante.
 * Spento (`enabled` falso: «Sala dal vivo» non attiva) non legge niente e
 * non ascolta niente. Acceso: carica dalla cache di config e rinfresca,
 * segue `floorMarker:updated` / `floorMarker:deleted` e rilegge tutto quando
 * il socket torna su, perché gli eventi persi mentre era giù non tornano.
 * I segnaposto di una sala eliminata spariscono nel database senza evento:
 * chi li mostra filtra per sala.
 *
 * `loaded` diventa vero alla prima lista applicata (anche quella in cache):
 * prima, una lista vuota vuol dire «non lo so», non «non ce ne sono», e chi
 * crea un segnaposto quando manca deve aspettarla. Dopo un fetch fallito
 * resta falso fino alla ricarica della riconnessione.
 */
export const useFloorMarkers = (enabled: boolean) => {
  const [markers, setMarkers] = useState<FloorMarker[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Cambiamenti arrivati dopo l'avvio di un fetch (trascinamento, evento):
  // la sua lista sarebbe una foto più vecchia di quello che si vede.
  const changesRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setMarkers(prev => (prev.length === 0 ? prev : []));
      setLoaded(false);
      return;
    }
    const startedAt = changesRef.current;
    // Su una ricarica la lista c'è già: il valore in cache, applicato subito
    // da swrConfig, la riporterebbe indietro per un attimo.
    const isReload = reloadKey > 0;
    let fromCache = true;
    const stop = swrConfig('floorMarkers', fetchFloorMarkers, list => {
      if (fromCache) {
        if (!isReload) {
          setMarkers(list);
          setLoaded(true);
        }
        return;
      }
      // Un fetch scavalcato da un cambiamento non si applica: si rilegge.
      if (changesRef.current !== startedAt) {
        setReloadKey(k => k + 1);
        return;
      }
      setMarkers(list);
      setLoaded(true);
    });
    fromCache = false;
    return stop;
  }, [enabled, reloadKey]);

  useEffect(() => {
    if (!enabled) return;
    const onUpdated = (payload: unknown) => {
      if (!isFloorMarker(payload)) return;
      changesRef.current += 1;
      setMarkers(prev => mergeMarker(prev, payload, true));
    };
    const onDeleted = (payload: unknown) => {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'number') return;
      changesRef.current += 1;
      setMarkers(prev => prev.filter(m => m.id !== id));
    };
    // Handler con nome, riattaccati a ogni nuova istanza del socket. Non
    // useSocket(): al montaggio chiama connect(), che a socket giù apre una
    // seconda connessione accanto a quella che si sta già riconnettendo.
    const offUpdated = onSocketEvent('floorMarker:updated', onUpdated);
    const offDeleted = onSocketEvent('floorMarker:deleted', onDeleted);
    // Riconnessione = passaggio da giù a su. Mai un listener su 'connect':
    // App lo stacca senza handler e si porterebbe via anche il nostro.
    let wasConnected = socketClient.isConnected();
    const offChange = socketClient.onSocketChange((_socket, connected) => {
      if (connected && !wasConnected) setReloadKey(k => k + 1);
      wasConnected = connected;
    });
    return () => {
      offUpdated();
      offDeleted();
      offChange();
    };
  }, [enabled]);

  /** Mette in lista la riga del server o una posizione ottimistica. La
   *  risposta del server passa dallo stesso controllo degli eventi. */
  const upsertLocal = useCallback((m: FloorMarker) => {
    if (!isFloorMarker(m)) return;
    changesRef.current += 1;
    setMarkers(prev => mergeMarker(prev, m, false));
  }, []);

  const removeLocal = useCallback((id: number) => {
    changesRef.current += 1;
    setMarkers(prev => prev.filter(m => m.id !== id));
  }, []);

  return { markers, loaded, upsertLocal, removeLocal };
};
