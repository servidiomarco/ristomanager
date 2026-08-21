/**
 * Stampa un documento HTML completo restando dentro l'app.
 *
 * Prima ogni stampa apriva una scheda nuova (`window.open('', '_blank')`) che
 * si stampava da sola. Su iPad e smartphone quella scheda è un vicolo cieco:
 * il CRM è installato come web app (`display: standalone` nel manifest), la
 * scheda si apre quindi in Safari **fuori** dall'app e non c'è nessun modo di
 * tornare indietro; anche nel browser normale, chiuso il foglio di stampa
 * l'utente resta sul documento a schermo pieno senza intestazione dell'app.
 * È la card #23 del dev board.
 *
 * La stampa parte invece da un iframe nascosto dentro la pagina corrente: il
 * foglio di stampa di sistema compare *sopra* l'app e, chiudendolo, si è già
 * tornati dove si era.
 */

const FRAME_ID = 'risto-print-frame';
/** Ganciata su <html> mentre l'iframe è montato: la usa il paracadute in index.css. */
const PRINTING_CLASS = 'is-printing-frame';

/**
 * Smonta l'iframe di stampa. Con `frame` valorizzato non fa nulla se nel
 * frattempo è partita una stampa nuova: un timer in ritardo non deve portarsi
 * via il documento di qualcun altro.
 */
const cleanup = (frame?: HTMLIFrameElement): void => {
  const mounted = document.getElementById(FRAME_ID);
  if (frame && mounted !== frame) return;
  document.documentElement.classList.remove(PRINTING_CLASS);
  mounted?.remove();
};

/**
 * Inietta nel documento il minimo per non intrappolare chi ci finisce dentro:
 * stampa automatica, un pulsante "Chiudi" a schermo e la chiusura della scheda
 * a stampa finita. Serve solo alla via di scampo con `window.open`.
 */
const withTabEscape = (html: string): string => {
  const extra = `
  <style>
    .print-escape {
      position: fixed; top: 12px; right: 12px; z-index: 999;
      font: 600 15px/1 'Helvetica Neue', Helvetica, Arial, sans-serif;
      padding: 12px 20px; min-height: 44px; border: 0; border-radius: 999px;
      background: #1e1b4b; color: #fff; cursor: pointer;
    }
    @media print { .print-escape { display: none !important; } }
  </style>
  <button type="button" class="print-escape" onclick="window.close()">Chiudi</button>
  <script>
    window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 200); });
    window.addEventListener('afterprint', function () { window.close(); });
  </script>
`;
  return html.includes('</body>') ? html.replace('</body>', `${extra}</body>`) : html + extra;
};

/** Via di scampo se l'iframe non è utilizzabile (contesti sandboxed). */
const printInNewTab = (html: string, popupMessage: string): void => {
  const win = window.open('', '_blank');
  if (!win) {
    alert(popupMessage);
    return;
  }
  win.document.open();
  win.document.write(withTabEscape(html));
  win.document.close();
};

export interface PrintHtmlOptions {
  /** Messaggio se anche la scheda di riserva viene bloccata dal browser. */
  popupMessage?: string;
}

/**
 * `html` deve essere un documento completo (`<!doctype html>…`) senza chiamate
 * a `window.print()` al suo interno: la stampa la lancia questa funzione.
 */
export const printHtmlDocument = (html: string, options: PrintHtmlOptions = {}): void => {
  const popupMessage = options.popupMessage ?? 'Sblocca i popup per stampare il documento.';

  // Un iframe rimasto da una stampa precedente conterrebbe il documento vecchio.
  cleanup();

  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.title = 'Documento da stampare';
  frame.setAttribute('aria-hidden', 'true');
  // Fuori vista ma *renderizzato*: con `display: none` il browser non impagina
  // il contenuto e la stampa esce bianca. Le misure A4 danno all'impaginazione
  // la stessa larghezza che avrà sul foglio.
  frame.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:210mm',
    'height:297mm',
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
    'border:0',
  ].join(';');

  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) {
    cleanup();
    printInNewTab(html, popupMessage);
    return;
  }

  let launched = false;
  const launch = (): void => {
    if (launched) return;
    launched = true;

    const win = frame.contentWindow;
    if (!win) {
      cleanup();
      printInNewTab(html, popupMessage);
      return;
    }

    document.documentElement.classList.add(PRINTING_CLASS);

    // `afterprint` scatta sia stampando sia annullando: è il momento in cui il
    // foglio di sistema si è chiuso e l'iframe può sparire. Se il browser non
    // lo emette, un tetto di due minuti evita che l'iframe (e con lui il
    // paracadute CSS) resti montato e sporchi la stampa successiva; a quel
    // punto il documento è già stato passato allo spooler.
    win.addEventListener('afterprint', () => window.setTimeout(() => cleanup(frame), 500), { once: true });
    window.setTimeout(() => cleanup(frame), 120_000);

    try {
      win.focus();
      win.print();
    } catch {
      cleanup();
      printInNewTab(html, popupMessage);
    }
  };

  frame.addEventListener('load', () => window.setTimeout(launch, 150), { once: true });

  doc.open();
  doc.write(html);
  doc.close();

  // Rete di sicurezza: su un documento scritto con document.write il `load`
  // non è garantito.
  window.setTimeout(launch, 800);
};
