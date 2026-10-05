import type { HaccpLabel } from '../services/haccpApiService';
import { HACCP_LABEL_KIND_LABELS_IT } from './haccp';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/* L'etichetta dal browser, per chi non ha una termica in Impostazioni o usa
 * una stampante di etichette di sistema (le Brother QL da 62 mm sono le più
 * diffuse in cucina). Stesso contenuto del job ETICHETTA dell'agente: nome del
 * prodotto e scadenza grandi, il resto sotto. Una pagina per copia.
 *
 * Fuori dall'i18n come gli altri fogli HACCP: va sul contenitore in cella,
 * in italiano. */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

const dmy = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

const dateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const buildHaccpLabelHtml = (label: Pick<HaccpLabel, 'kind' | 'product' | 'preparedAt' | 'expiryDate' | 'lot' | 'storage' | 'allergens' | 'note' | 'copies' | 'printedByUserName'>): string => {
  // 36 mm utili: le righe piccole si accoppiano (data e chi, lotto e
  // conservazione), così anche un'etichetta con tutto non perde il fondo.
  const when = [`${HACCP_LABEL_KIND_LABELS_IT[label.kind]} ${dateTime(label.preparedAt)}`, label.printedByUserName].filter(Boolean).join(' · ');
  const lotStorage = [label.lot ? `Lotto ${label.lot}` : null, label.storage ? `Conservare ${label.storage}` : null].filter(Boolean).join(' · ');
  const one = `
  <section class="label">
    <div class="product">${escapeHtml(label.product)}</div>
    <div class="row">${escapeHtml(when)}</div>
    <div class="expiry">Scade il <b>${escapeHtml(dmy(label.expiryDate))}</b></div>
    ${lotStorage ? `<div class="row">${escapeHtml(lotStorage)}</div>` : ''}
    ${label.allergens.length ? `<div class="row allergens">Allergeni: ${escapeHtml(label.allergens.join(', '))}</div>` : ''}
    ${label.note ? `<div class="row">${escapeHtml(label.note)}</div>` : ''}
  </section>`;
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Etichetta — ${escapeHtml(label.product)}</title>
<style>
${PRINT_TOKENS_CSS}
  @page { size: 62mm 40mm; margin: 2mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #000; background: #fff; }
  .label { width: 58mm; height: 36mm; overflow: hidden; break-after: page; padding: 0.5mm; }
  .label:last-child { break-after: auto; }
  .product { font-size: 13pt; font-weight: 700; line-height: 1.1; max-height: 2.3em; overflow: hidden; }
  .expiry { font-size: 11pt; margin: 1mm 0; }
  .row { font-size: 7.5pt; line-height: 1.25; }
  .allergens { font-weight: 700; }
</style>
</head>
<body>${Array.from({ length: Math.max(1, Math.min(20, label.copies || 1)) }, () => one).join('')}</body>
</html>`;
};

export const printHaccpLabel = (label: Parameters<typeof buildHaccpLabelHtml>[0]): void => {
  printHtmlDocument(buildHaccpLabelHtml(label), { popupMessage: 'Sblocca i popup per stampare l\'etichetta.' });
};
