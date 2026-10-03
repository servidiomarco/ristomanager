/* La sonda WebGL2 della Sala dal vivo: decide, PRIMA di scaricare il chunk 3D,
 * se questo dispositivo la vista 3D la può disegnare.
 *
 * - 'ok': WebGL2 con accelerazione.
 * - 'slow': WebGL2 solo senza failIfMajorPerformanceCaveat, cioè disegnato in
 *   software (GPU in lista nera, driver vecchio). La scena va lo stesso, a
 *   DPR 1 e con pochi fotogrammi, e la pagina lo dice.
 * - 'none': niente WebGL2 (three non disegna più su WebGL1). Il chunk del
 *   canvas, con three dentro, non si chiede mai: il dispositivo non scarica
 *   un quarto di mega che non potrebbe usare.
 *
 * Una volta per caricamento della pagina, in cache nel modulo: rientrare
 * nella vista non apre altri contesti. Ogni contesto di prova si rilascia
 * subito con WEBGL_lose_context: Safari ne regge pochi insieme, e una sonda
 * dimenticata ruberebbe il posto a quello vero.
 *
 * Niente three qui, solo le API del browser: la pagina importa questo file, e
 * tutto quello che la pagina importa finisce nel suo chunk. */

export type WebglSupport = 'ok' | 'slow' | 'none';

let cached: WebglSupport | null = null;

const tryWebgl2 = (attributes: WebGLContextAttributes): boolean => {
  let canvas: HTMLCanvasElement | null = null;
  try {
    // Un canvas per tentativo: un getContext fallito su un canvas non deve
    // condizionare il secondo.
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', attributes);
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
};

/** Il risultato già noto, o null se la sonda non è ancora partita. */
export const cachedWebglSupport = (): WebglSupport | null => cached;

export const probeWebgl2 = (): WebglSupport => {
  if (cached) return cached;
  if (typeof document === 'undefined') return 'none';
  cached = tryWebgl2({ failIfMajorPerformanceCaveat: true })
    ? 'ok'
    : tryWebgl2({})
      ? 'slow'
      : 'none';
  return cached;
};
