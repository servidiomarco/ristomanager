import { useEffect } from 'react';

/** Tiene acceso lo schermo finché `active` è vero e la pagina è visibile: un
 *  tablet all'ingresso o una TV con la Sala dal vivo fissata non deve
 *  spegnersi a metà servizio.
 *
 *  Il browser lascia il blocco da solo quando la pagina si nasconde (un'altra
 *  app, lo schermo spento a mano): si riprende al ritorno, su
 *  visibilitychange. Dove la Screen Wake Lock API non c'è (Safari prima di
 *  16.4, i browser delle TV) non fa niente, e una richiesta rifiutata (batteria
 *  scarica, permesso negato) non è un errore da mostrare: lo schermo farà
 *  quello che fa sempre. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || typeof document === 'undefined') return;
    if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
    const wakeLock = navigator.wakeLock;

    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let disposed = false;

    const acquire = async () => {
      if (disposed || requesting || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      requesting = true;
      try {
        const s = await wakeLock.request('screen');
        // Smontato mentre la richiesta era in volo: si lascia subito.
        if (disposed) {
          s.release().catch(() => {});
          return;
        }
        sentinel = s;
      } catch {
        // NotAllowedError, batteria scarica, pagina nascosta nel frattempo.
      } finally {
        requesting = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) s.release().catch(() => {});
    };
  }, [active]);
}
