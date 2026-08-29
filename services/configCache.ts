// Cache modulo-level per le configurazioni semi-statiche (impostazioni
// legali, feature flags, orari di apertura, preset…). ReservationList viene
// smontata a ogni cambio vista e al rientro rifaceva sei fetch di config —
// ognuno ~mezzo secondo di rete verso Railway — per dati che cambiano quasi
// mai: gli aggiornamenti che gocciolavano dietro ri-renderizzavano più volte
// una pagina da 7.700 righe. Stesso schema stale-while-revalidate delle
// cache di Messaggi/Chiamate/Email: si applica subito l'ultimo valore noto,
// il fetch rinfresca in background. App svuota la cache al logout.
const cache = new Map<string, unknown>();

/**
 * Da usare come corpo di un useEffect: applica subito l'eventuale valore in
 * cache, poi fa il fetch e ri-applica il valore fresco. Ritorna la cleanup
 * (annulla l'apply del fetch in volo dopo lo smontaggio; la cache si
 * aggiorna comunque). In caso di errore chi chiama tiene i default o il
 * valore in cache già applicato.
 */
export const swrConfig = <T>(
  key: string,
  fetcher: () => Promise<T>,
  apply: (value: T) => void,
): (() => void) => {
  let cancelled = false;
  const cached = cache.get(key) as T | undefined;
  if (cached !== undefined) apply(cached);
  fetcher()
    .then(value => {
      cache.set(key, value);
      if (!cancelled) apply(value);
    })
    .catch(() => { /* niente: default o valore in cache restano validi */ });
  return () => { cancelled = true; };
};

export const clearConfigCache = (): void => { cache.clear(); };
