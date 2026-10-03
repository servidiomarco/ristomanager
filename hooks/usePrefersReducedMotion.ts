import { useMediaQuery } from '../components/ds';

/** prefers-reduced-motion del dispositivo, e i suoi cambi mentre la pagina è
 *  aperta (lo si accende dalle impostazioni di accessibilità senza
 *  ricaricare). Un hook a sé, sopra useMediaQuery, perché la Sala dal vivo lo
 *  passa alla scena come dato: l'anello «in arrivo» resta fermo e «Centra»
 *  salta all'inquadratura invece di animare, e nella scena non c'è CSS che
 *  possa farlo con motion-safe. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
