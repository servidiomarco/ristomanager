import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';
import type { FiscalRegistryResponse, FiscalVatSummaryResponse } from '../services/billsApiService';

/* ── Il riepilogo fiscale di periodo, stampato ────────────────────────────
   Il foglio per il commercialista o il raccoglitore: totali per tipo di
   documento e riepilogo IVA del periodo. Quinto foglio browser dopo HACCP,
   spesa, banchetti e cassa — stessa infrastruttura: iframe nuovo via
   doc.write(), quindi PRINT_TOKENS_CSS incluso a mano (index.css non c'è, e
   i token di stampa non esistono in dark: dal cassetto esce carta bianca).

   I numeri sono GLI STESSI della pagina (registry + vat-summary): il foglio
   non ricalcola niente, impagina. */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const euro = (cents: number): string =>
  `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const formatDay = (day: string): string => {
  const d = new Date(`${day}T12:00:00`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
};

const vatLabel = (code: string, nature: boolean): string =>
  nature ? `Natura ${code}` : `Iva ${code.replace('.', ',').replace(',00', '')}%`;

export const printFiscalRegistry = (input: {
  businessName: string;
  vatNumber: string;
  from: string;
  to: string;
  registry: FiscalRegistryResponse;
  vat: FiscalVatSummaryResponse;
}): void => {
  const { registry, vat } = input;
  const t = registry.totals;

  // Serie numerica delle fatture del periodo: min–max dai numeri "N/ANNO"
  // presenti in pagina. Indicativa (il registro completo è il CSV), ma è la
  // riga che il commercialista cerca per capire se gli manca qualcosa.
  const invoiceNumbers = registry.documents
    .filter(d => (d.doc_type === 'INVOICE' || d.doc_type === 'CREDIT_NOTE') && d.doc_number)
    .map(d => d.doc_number as string);
  const serie = invoiceNumbers.length > 0
    ? `${invoiceNumbers[invoiceNumbers.length - 1]} – ${invoiceNumbers[0]}`
    : null;

  const tipoRow = (label: string, count: number, cents: number, sign = '') => count > 0 ? `
    <tr>
      <td>${escapeHtml(label)}<span class="muted"> · ${count}</span></td>
      <td class="num">${sign}${euro(cents)}</td>
    </tr>` : '';

  // Riepilogo IVA aggregato sull'intero periodo (le righe API sono per
  // giorno: qui si sommano per aliquota/natura).
  const byVat = new Map<string, { nature: boolean; gross: number; net: number; tax: number }>();
  for (const r of vat.rows) {
    const cur = byVat.get(r.vat_rate_code) ?? { nature: r.is_nature, gross: 0, net: 0, tax: 0 };
    cur.gross += r.gross_cents; cur.net += r.net_cents; cur.tax += r.tax_cents;
    byVat.set(r.vat_rate_code, cur);
  }
  const discountTotal = vat.discounts.reduce((n, d) => n + d.discount_cents, 0);
  const vatRows = [...byVat.entries()].map(([code, v]) => `
    <tr>
      <td>${escapeHtml(vatLabel(code, v.nature))}</td>
      <td class="num">${euro(v.net)}</td>
      <td class="num">${euro(v.tax)}</td>
      <td class="num">${euro(v.gross)}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Riepilogo fiscale — ${escapeHtml(input.from)} · ${escapeHtml(input.to)}</title>
<style>
${PRINT_TOKENS_CSS}
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         color: var(--ds-print-ink); margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { font-size: 13px; color: var(--ds-print-ink-muted); margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 18px 0 6px; color: var(--ds-print-ink-muted); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 4px 0; border-bottom: 1px solid var(--ds-print-rule); }
  th { text-align: left; font-size: 12px; color: var(--ds-print-ink-muted); font-weight: 600; }
  th.num { text-align: right; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total td { font-weight: 700; font-size: 15px; border-bottom: none; padding-top: 8px; }
  .muted { color: var(--ds-print-ink-muted); font-weight: 400; }
  .note { font-size: 12px; color: var(--ds-print-ink-muted); margin-top: 10px; }
</style>
</head>
<body>

<h1>Riepilogo fiscale${input.businessName ? ` — ${escapeHtml(input.businessName)}` : ''}</h1>
<div class="sub">${formatDay(input.from)} – ${formatDay(input.to)}${input.vatNumber ? ` · P.iva ${escapeHtml(input.vatNumber)}` : ''}</div>

<h2>Documenti emessi</h2>
<table>
  ${tipoRow('Scontrini', t.receipts.count, t.receipts.total_cents)}
  ${tipoRow('Fatture', t.invoices.count, t.invoices.total_cents)}
  ${tipoRow('Note di credito', t.credit_notes.count, t.credit_notes.total_cents, '−')}
  <tr class="total">
    <td>Documentato</td>
    <td class="num">${euro(t.documented_total_cents)}</td>
  </tr>
</table>
${serie ? `<div class="note">Serie fatture e note di credito nel periodo: ${escapeHtml(serie)}.</div>` : ''}
${t.voided_count + t.failed_count + t.proforma.count > 0 ? `
<div class="note">
  Fuori dai totali:
  ${t.voided_count > 0 ? `${t.voided_count} annullati/stornati` : ''}
  ${t.failed_count > 0 ? ` · ${t.failed_count} in errore` : ''}
  ${t.proforma.count > 0 ? ` · ${t.proforma.count} proforma (non fiscali, ${euro(t.proforma.total_cents)})` : ''}
</div>` : ''}

<h2>Riepilogo iva dei corrispettivi</h2>
<table>
  <tr><th>Aliquota</th><th class="num">Imponibile</th><th class="num">Imposta</th><th class="num">Lordo</th></tr>
  ${vatRows || '<tr><td colspan="4" class="muted">Nessun corrispettivo nel periodo</td></tr>'}
</table>
${discountTotal > 0 ? `<div class="note">Sconti e omaggi fuori riparto: −${euro(discountTotal)}.</div>` : ''}
${vat.excluded.passepartout_docs > 0 ? `<div class="note">${vat.excluded.passepartout_docs} scontrini emessi dall'RT di cassa (${euro(vat.excluded.passepartout_total_cents)}): i loro corrispettivi sono nel registratore, non in questo riepilogo.</div>` : ''}

</body>
</html>`;

  printHtmlDocument(html, { popupMessage: 'Sblocca i popup per stampare il riepilogo fiscale.' });
};
