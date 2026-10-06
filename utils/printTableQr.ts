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
 *
 * Con «supporto» il cartellino è invece il cavaliere del portaQR in plastica
 * del locale: un foglietto da 12 × 9,3 cm che si piega a metà sul lato lungo
 * e mostra la stessa faccia ai due lati del tavolo — QR a sinistra, tavolo e
 * frase a destra, la faccia di sopra stampata capovolta perché, piegata,
 * torni dritta. Il foglio decide solo quanti ne stanno, centrati, ciascuno
 * col suo tratteggio; per farcene stare di più si girano di 90° sul foglio.
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

/** Il cavaliere del portaQR in plastica, in mm: il lato corto (la piega lo
 *  divide a metà) e il lato lungo (la piega gli corre parallela). */
export const QR_HOLDER_MM = { width: 93, height: 120 };
// Dal bordo del foglio: la fascia che la stampante non raggiunge. Fra un
// cartellino e l'altro: ognuno ha il suo tratteggio, e le forbici ci passano.
const HOLDER_MARGIN_MM = 5;
const HOLDER_GAP_MM = 3;

export interface SheetLayout extends PaperLayout {
  /** La cella del cartellino sul foglio, in mm. */
  cardWidth: number;
  cardHeight: number;
  holder: boolean;
  /** Il cavaliere girato di 90° sul foglio: ce ne stanno di più. */
  rotated: boolean;
}

export const sheetLayout = (paper: QrPaper, holder = false): SheetLayout => {
  const p = QR_PAPERS[paper];
  if (!holder) return { ...p, cardWidth: p.width / p.cols, cardHeight: p.height / p.rows, holder: false, rotated: false };
  const fit = (sheet: number, card: number): number =>
    Math.max(1, Math.floor((sheet - 2 * HOLDER_MARGIN_MM + HOLDER_GAP_MM) / (card + HOLDER_GAP_MM)));
  const long = QR_HOLDER_MM.height;
  const short = QR_HOLDER_MM.width;
  // Dritto: lato lungo in orizzontale, come si legge sul tavolo. Girato: in
  // verticale. A parità vince il dritto.
  const straight = { cols: fit(p.width, long), rows: fit(p.height, short) };
  const turned = { cols: fit(p.width, short), rows: fit(p.height, long) };
  const rotated = turned.cols * turned.rows > straight.cols * straight.rows;
  const grid = rotated ? turned : straight;
  return {
    width: p.width,
    height: p.height,
    cols: grid.cols,
    rows: grid.rows,
    cardWidth: rotated ? short : long,
    cardHeight: rotated ? long : short,
    holder: true,
    rotated,
  };
};

export const cardsPerSheet = (paper: QrPaper, holder = false): number => {
  const l = sheetLayout(paper, holder);
  return l.cols * l.rows;
};

/** Misura del cartellino in cm, al millimetro per difetto: l'A6 si scrive
 *  10,5 × 14,8, non 14,9. Il cavaliere si dice come lo dice il locale,
 *  9,3 × 12, qualunque verso abbia sul foglio. */
export const cardSizeCm = (paper: QrPaper, holder = false): { width: number; height: number } => {
  if (holder) return { width: QR_HOLDER_MM.width / 10, height: QR_HOLDER_MM.height / 10 };
  const l = sheetLayout(paper, holder);
  return { width: Math.floor(l.cardWidth) / 10, height: Math.floor(l.cardHeight) / 10 };
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
  /** Il cavaliere del portaQR in plastica (QR_HOLDER_MM), da piegare. */
  holder?: boolean;
  /** Anteprima a schermo: solo il primo foglio, su fondo grigio. */
  preview?: boolean;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

// Il cartellino di riferimento è l'A6 del foglio A4 (105 mm di larghezza):
// le misure del CSS sono le sue, e --k le porta al cartellino scelto.
const BASE_CARD_WIDTH_MM = 105;

// La faccia del cavaliere: metà del foglietto, 120 × 46,5 mm, divisa in
// due come il cavaliere del locale — il QR al centro della metà sinistra, il
// tavolo al centro della destra, col numero grande che si legge da lontano.
const TENT_FACE_PAD_MM = 4;
const TENT_QR_MM = 35;
const TENT_NUMBER_PT = 56;
const TENT_NUMBER_MIN_PT = 16;
const MM_PER_PT = 25.4 / 72;
// La colonna del testo (metà faccia meno i margini) e l'altezza utile.
const TENT_TEXT_W_MM = QR_HOLDER_MM.height / 2 - 2 * TENT_FACE_PAD_MM;
const TENT_TEXT_H_MM = QR_HOLDER_MM.width / 2 - 2 * TENT_FACE_PAD_MM;
// Le righe fisse sopra e sotto il numero: luogo (7,5 pt), «Tavolo» (9 pt),
// le spaziature; la frase a 8 pt con interlinea 1,25.
const TENT_FIXED_MM = 3.3 + 3.8 + 3;
const TENT_PHRASE_LINE_MM = 8 * 1.25 * MM_PER_PT;
// Caratteri per riga della frase a 8 pt nella colonna (≈0,5 em a lettera).
const TENT_PHRASE_CHARS = Math.floor(TENT_TEXT_W_MM / (8 * 0.5 * MM_PER_PT));

/** Corpo del numero del tavolo sulla faccia: grande come nella foto del
 *  locale, ma mai più largo della colonna (≈0,62 em a cifra, in grassetto)
 *  né più alto di quello che la frase lascia libero. */
const tentNumberPt = (name: string, phrase: string): number => {
  const chars = Math.max(1, [...name].length);
  const byWidth = TENT_TEXT_W_MM / (chars * 0.62) / MM_PER_PT;
  const lines = phrase
    ? phrase.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / TENT_PHRASE_CHARS)), 0)
    : 0;
  const byHeight = (TENT_TEXT_H_MM - TENT_FIXED_MM - lines * TENT_PHRASE_LINE_MM) / MM_PER_PT;
  return Math.max(TENT_NUMBER_MIN_PT, Math.min(TENT_NUMBER_PT, Math.floor(byWidth), Math.floor(byHeight)));
};

export const buildTableQrSheetHtml = async ({ restaurant, cards, paper, text, holder = false, preview = false }: TableQrSheetOptions): Promise<string> => {
  const layout = sheetLayout(paper, holder);
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

  // Il cavaliere: due facce uguali, quella di sopra capovolta. La piega è
  // il bordo comune, segnata da un puntinato leggero che finisce sullo
  // spigolo; il tratteggio da tagliare gira tutto intorno.
  const tentHtml = (c: TableQrCard, i: number): string => {
    const place = [restaurant, c.roomName].filter(Boolean).join(' · ');
    const face = `
          <div class="face__half"><div class="face__qr">${svgs[i]}</div></div>
          <div class="face__half face__text">
            ${place ? `<div class="face__place">${escapeHtml(place)}</div>` : ''}
            <div class="face__label">Tavolo</div>
            <div class="face__number" style="font-size:${tentNumberPt(c.tableName, phrase)}pt">${escapeHtml(c.tableName)}</div>
            ${phrase ? `<div class="face__phrase">${escapeHtml(phrase)}</div>` : ''}
          </div>`;
    return `
      <section class="tent-cell">
        <div class="tent">
          <div class="face face--top">${face}</div>
          <div class="face">${face}</div>
        </div>
      </section>`;
  };

  const sheets: string[] = [];
  for (let start = 0; start < shown.length; start += perSheet) {
    const slice = shown.slice(start, start + perSheet);
    const body = slice.map((c, j) => (layout.holder ? tentHtml : cardHtml)(c, start + j)).join('');
    sheets.push(`<div class="sheet${layout.holder ? ' is-holder' : ''}">${body}</div>`);
  }

  const k = layout.cardWidth / BASE_CARD_WIDTH_MM;
  const long = QR_HOLDER_MM.height;
  const short = QR_HOLDER_MM.width;

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
  .qr svg, .face__qr svg { width: 100%; height: 100%; display: block; }
  .phrase {
    font-size: calc(11.5pt * var(--k)); font-weight: 600; line-height: 1.3;
    color: var(--ds-print-ink);
    white-space: pre-line; overflow-wrap: anywhere;
    /* Righe pari invece di una parola sola a capo («…pagare il / conto»). */
    text-wrap: balance;
    max-width: 100%;
  }

  /* --- Cavaliere del portaQR ---------------------------------------------
     Celle in mm esatti, il blocco al centro del foglio. Stampato al 100% il
     foglietto esce di ${long}×${short} mm; girato sul foglio quando ce ne
     stanno di più (la cella è allora ${short}×${long}). */
  .sheet.is-holder {
    grid-template-columns: repeat(${layout.cols}, ${layout.cardWidth}mm);
    grid-template-rows: repeat(${layout.rows}, ${layout.cardHeight}mm);
    gap: ${HOLDER_GAP_MM}mm;
    justify-content: center;
    align-content: center;
  }
  .tent-cell { position: relative; width: ${layout.cardWidth}mm; height: ${layout.cardHeight}mm; }
  .tent {
    position: absolute; top: 0; left: 0;
    width: ${long}mm; height: ${short}mm;
    border: 0.3mm dashed var(--ds-print-rule-strong);
    display: flex; flex-direction: column;
    ${layout.rotated ? `transform-origin: 0 0; transform: translateX(${short}mm) rotate(90deg);` : ''}
  }
  .face {
    flex: 1 1 0; min-height: 0;
    display: grid; grid-template-columns: 1fr 1fr;
  }
  .face__half {
    min-width: 0; min-height: 0; padding: ${TENT_FACE_PAD_MM}mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  }
  /* La faccia di sopra si legge dall'altra parte del tavolo: capovolta qui,
     dritta una volta piegato. Il puntinato è la piega. */
  .face--top { transform: rotate(180deg); border-top: 0.3mm dotted var(--ds-print-rule-strong); }
  .face__qr { width: ${TENT_QR_MM}mm; height: ${TENT_QR_MM}mm; flex: none; }
  .face__place {
    font-size: 7.5pt; line-height: 1.25; color: var(--ds-print-ink-secondary);
    max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .face__label { margin-top: 1mm; font-size: 9pt; line-height: 1.2; font-weight: 600; color: var(--ds-print-ink-secondary); }
  .face__number {
    font-weight: 700; line-height: 1; letter-spacing: -0.01em;
    max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .face__phrase {
    margin-top: 1.5mm; max-width: 100%;
    font-size: 8pt; font-weight: 600; line-height: 1.25;
    white-space: pre-line; overflow-wrap: anywhere; text-wrap: balance;
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
