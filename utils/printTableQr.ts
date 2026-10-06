import QRCode from 'qrcode';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/**
 * I cartellini del QR unico al tavolo: uno per tavolo, impaginati sul foglio
 * scelto dal ristoratore, col filetto tratteggiato da seguire con le forbici.
 * Il QR porta /t/<token> — menu sempre, «Paga il conto» a conto aperto — e
 * il cartellino resta sul tavolo per anni: per questo la stampa la decide chi
 * conosce l'indirizzo (vedi il controllo sul dominio nel modal).
 *
 * Il foglio decide quanti cartellini ci stanno, e ogni cartellino è una
 * divisione esatta del foglio (stesse proporzioni √2 della carta): si taglia
 * a filo, senza sfridi da misurare.
 *   A5 → 1 per foglio, 148×210 mm: il cartello per l'espositore da tavolo
 *   A4 → 4 per foglio, 105×148 mm: il formato A6 degli espositori piccoli
 *   A3 → 9 per foglio,  99×140 mm: quasi A6, per chi stampa in copisteria
 */

export type QrPaper = 'A3' | 'A4' | 'A5';

interface PaperLayout {
  /** Il foglio, in mm, verticale. */
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export const QR_PAPERS: Record<QrPaper, PaperLayout> = {
  A5: { width: 148, height: 210, cols: 1, rows: 1 },
  A4: { width: 210, height: 297, cols: 2, rows: 2 },
  A3: { width: 297, height: 420, cols: 3, rows: 3 },
};

export const QR_PAPER_ORDER: QrPaper[] = ['A3', 'A4', 'A5'];

export const cardsPerSheet = (paper: QrPaper): number => QR_PAPERS[paper].cols * QR_PAPERS[paper].rows;

/** Misura del cartellino in cm, al millimetro per difetto: l'A6 si scrive
 *  10,5 × 14,8, non 14,9. */
export const cardSizeCm = (paper: QrPaper): { width: number; height: number } => {
  const p = QR_PAPERS[paper];
  return { width: Math.floor(p.width / p.cols) / 10, height: Math.floor(p.height / p.rows) / 10 };
};

/** La frase sotto il QR: la scrive il ristoratore, una per tutti i tavoli.
 *  Le stesse regole del server (cleanTableQrText in server.ts): al massimo
 *  quattro righe e 160 caratteri, oltre il cartellino A3 non la contiene. */
export const TABLE_QR_TEXT_MAX = 160;
export const TABLE_QR_TEXT_MAX_LINES = 4;

export const cleanTableQrText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, TABLE_QR_TEXT_MAX_LINES)
    .join('\n')
    .slice(0, TABLE_QR_TEXT_MAX);

export interface TableQrCard {
  tableName: string;
  roomName: string | null;
  url: string;
}

export interface TableQrSheetOptions {
  restaurant: string;
  cards: TableQrCard[];
  paper: QrPaper;
  text: string;
  /** Anteprima a schermo: solo il primo foglio, su fondo grigio. */
  preview?: boolean;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

// Il cartellino di riferimento è l'A6 del foglio A4 (105 mm di larghezza):
// le misure del CSS sono le sue, e --k le porta alla cella del foglio scelto.
const BASE_CARD_WIDTH_MM = 105;

export const buildTableQrSheetHtml = async ({ restaurant, cards, paper, text, preview = false }: TableQrSheetOptions): Promise<string> => {
  const layout = QR_PAPERS[paper];
  const perSheet = layout.cols * layout.rows;
  const shown = preview ? cards.slice(0, perSheet) : cards;

  // SVG vettoriale: sulla carta resta nitido a qualunque dimensione, e la
  // libreria è la stessa che il backend usa per il PNG del conto.
  const svgs = await Promise.all(shown.map(c =>
    QRCode.toString(c.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 })
  ));

  const phrase = cleanTableQrText(text);
  const cardHtml = (c: TableQrCard, i: number): string => {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols) % layout.rows;
    // Il filetto da tagliare solo fra le celle: sul bordo del foglio c'è già
    // la carta.
    const cut = [col < layout.cols - 1 ? 'cut-r' : '', row < layout.rows - 1 ? 'cut-b' : ''].filter(Boolean).join(' ');
    return `
      <section class="card ${cut}">
        ${restaurant ? `<div class="restaurant">${escapeHtml(restaurant)}</div>` : ''}
        <div class="table">Tavolo ${escapeHtml(c.tableName)}</div>
        ${c.roomName ? `<div class="room">${escapeHtml(c.roomName)}</div>` : ''}
        <div class="qr">${svgs[i]}</div>
        ${phrase ? `<div class="phrase">${escapeHtml(phrase)}</div>` : ''}
      </section>`;
  };

  const sheets: string[] = [];
  for (let start = 0; start < shown.length; start += perSheet) {
    const slice = shown.slice(start, start + perSheet);
    sheets.push(`<div class="sheet">${slice.map((c, j) => cardHtml(c, start + j)).join('')}</div>`);
  }

  const k = (layout.width / layout.cols) / BASE_CARD_WIDTH_MM;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>QR dei tavoli — ${escapeHtml(restaurant)}</title>
<style>
  ${PRINT_TOKENS_CSS}
  /* Margine zero: le celle dividono il foglio a filo. Il bordo che la
     stampante non raggiunge cade nell'imbottitura dei cartellini. */
  @page { size: ${paper} portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: var(--ds-print-ink);
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    --k: ${k.toFixed(4)};
  }
  .sheet {
    width: ${layout.width}mm;
    /* Un soffio sotto il foglio: un'altezza esatta, arrotondata in su dal
       motore di stampa, spingerebbe una pagina bianca dopo ogni foglio. */
    height: calc(${layout.height}mm - 0.5mm);
    overflow: hidden;
    display: grid;
    grid-template-columns: repeat(${layout.cols}, 1fr);
    grid-template-rows: repeat(${layout.rows}, 1fr);
    break-after: page;
    page-break-after: always;
    background: #ffffff;
  }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .card {
    min-width: 0; min-height: 0;
    padding: calc(9mm * var(--k)) calc(8mm * var(--k));
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  }
  .cut-r { border-right: 0.3mm dashed var(--ds-print-rule-strong); }
  .cut-b { border-bottom: 0.3mm dashed var(--ds-print-rule-strong); }
  .restaurant {
    font-size: calc(10pt * var(--k)); color: var(--ds-print-ink-secondary);
    max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .table { font-size: calc(24pt * var(--k)); font-weight: 700; line-height: 1.1; margin-top: calc(1.5mm * var(--k)); }
  .room { font-size: calc(9pt * var(--k)); color: var(--ds-print-ink-muted); margin-top: calc(0.5mm * var(--k)); }
  .qr { width: calc(60mm * var(--k)); height: calc(60mm * var(--k)); margin: calc(5mm * var(--k)) 0 calc(4mm * var(--k)); flex: none; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .phrase {
    font-size: calc(11.5pt * var(--k)); font-weight: 600; line-height: 1.3;
    color: var(--ds-print-ink);
    white-space: pre-line; overflow-wrap: anywhere;
    /* Righe pari invece di una parola sola a capo («…pagare il / conto»). */
    text-wrap: balance;
    max-width: 100%;
  }
  ${preview ? `
  html { background: transparent; }
  .sheet { box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18), 0 8px 24px -12px rgba(15, 23, 42, 0.25); }` : ''}
</style>
</head>
<body>
  ${sheets.join('\n')}
</body>
</html>`;
};

export const printTableQrSheet = async (options: Omit<TableQrSheetOptions, 'preview'>): Promise<void> => {
  const html = await buildTableQrSheetHtml(options);
  printHtmlDocument(html, { popupMessage: 'Sblocca i popup per stampare i QR dei tavoli.' });
};
