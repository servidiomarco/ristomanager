import { useEffect, useState } from 'react';
import { healthApiService } from '../services/healthApiService';
import { onSocketEvent } from '../services/socketEvents';
import type { ActiveIncident } from '../services/healthShared';

const REFRESH_MS = 5 * 60_000;

/** I banner «problema noto» attivi per il ristorante di chi guarda. Si
 *  rileggono quando la piattaforma ne apre o chiude uno (socket), al rientro
 *  in primo piano e ogni 5 minuti come rete di sicurezza. Un errore lascia
 *  l'ultimo stato noto: il banner è un'informazione, non un blocco. */
export const useActiveIncidents = (enabled: boolean): ActiveIncident[] => {
  const [incidents, setIncidents] = useState<ActiveIncident[]>([]);

  useEffect(() => {
    if (!enabled) { setIncidents([]); return; }
    let cancelled = false;
    const load = () => {
      healthApiService.activeIncidents()
        .then(list => { if (!cancelled) setIncidents(list); })
        .catch(() => { /* backend più vecchio o rete giù: resta com'era */ });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    const unsub = onSocketEvent('incident:changed', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      unsub();
    };
  }, [enabled]);

  return incidents;
};
