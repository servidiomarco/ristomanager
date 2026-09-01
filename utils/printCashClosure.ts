import type { CashSessionView } from '../types';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/* ── Il riepilogo di cassa, stampato ──────────────────────────────────────
   Il foglio che si mette nel raccoglitore a fine servizio, accanto al
   cassetto contato.

   Quarto foglio browser dopo HACCP, spesa e banchetti — NON una stampa
   termica: quella è per il preconto e passa dal print agent. Qui si stampa
   dalla stampante dell'ufficio, o si salva in PDF.

   `PRINT_TOKENS_CSS` va incluso a mano come negli altri tre: il foglio vive
   in un iframe nuovo scritto con doc.write(), che non carica index.css — un
   `var(--ds-print-*)` senza questa riga non risolve niente (§17 del design
   system). E i token di stampa non esistono in dark: un foglio nero non deve
   uscire dal cassetto della carta. */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const euro = (cents: number): string =>
  `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const METHOD_LABELS: Record<string, string> = {
  CONTANTI: 'Contanti',
  POS_FISICO: 'POS · Carta',
  SATISPAY: 'Satispay',
  BUONO_PASTO: 'Buoni pasto',
  GIFT_CARD: 'Gift card',
  SOSPESO: 'Sospeso',
  OMAGGIO: 'Omaggio',
  LINK_ONLINE: 'Online · QR e link',
};

const formatDay = (day: string): string => {
  const d = new Date(`${day}T12:00:00`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString('it-IT', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
};

const time = (iso: string | null): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('it-IT', {
      timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
};

export const printCashClosure = (view: CashSessionView, restaurantName?: string): void => {
  const s = view.session;
  const turno = view.service.shift === 'LUNCH' ? 'Pranzo' : 'Cena';
  const out = view.out_of_totals;

  const rows = view.methods.map(m => `
    <tr>
      <td>${escapeHtml(METHOD_LABELS[m.method] ?? m.method)}<span class="muted"> · ${m.movements}</span></td>
      <td class="num">${euro(m.amount_cents)}</td>
    </tr>`).join('');

  const fuori = [
    ['Caparre a credito', out.deposits_cents, out.deposits_count],
    ['Omaggio', out.omaggio_cents, null],
    ['Sospeso', out.sospeso_cents, null],
    ['Storni', -out.voided_cents, out.voided_count],
  ].filter(([, v]) => Number(v) !== 0).map(([label, value, count]) => `
    <tr>
      <td>${escapeHtml(String(label))}${count != null ? `<span class="muted"> · ${count}</span>` : ''}</td>
      <td class="num">${euro(Number(value))}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Riepilogo di cassa — ${escapeHtml(view.service.service_date)} ${turno}</title>
<style>
${PRINT_TOKENS_CSS}
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         color: var(--ds-print-ink); margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { font-size: 13px; color: var(--ds-print-ink-muted); margin-bottom: 18px; }
  .grid { display: flex; gap: 24px; align-items: flex-start; }
  .col { flex: 1; }
  h2 { font-size: 13px; text-transform: none; margin: 0 0 6px;
       color: var(--ds-print-ink-muted); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  td { padding: 4px 0; border-bottom: 1px solid var(--ds-print-rule); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total td { font-weight: 700; font-size: 15px; border-bottom: none; padding-top: 8px; }
  .muted { color: var(--ds-print-ink-muted); font-weight: 400; }
  .box { border: 1px solid var(--ds-print-rule); border-radius: 8px; padding: 10px 12px;
         font-size: 13px; margin-bottom: 12px; }
  .diff { font-size: 17px; font-weight: 700; }
  .sign { margin-top: 28px; font-size: 12px; color: var(--ds-print-ink-muted); }
  .line { margin-top: 26px; border-top: 1px solid var(--ds-print-ink); width: 220px; }
</style>
</head>
<body>

<h1>Riepilogo di cassa${restaurantName ? ` — ${escapeHtml(restaurantName)}` : ''}</h1>
<div class="sub">${turno} · ${formatDay(view.service.service_date)}</div>

<div class="grid">
  <div class="col">
    <h2>Incassi per metodo</h2>
    <table>
      ${rows || '<tr><td colspan="2" class="muted">Nessun incasso</td></tr>'}
      <tr class="total">
        <td>Incassato<span class="muted"> · ${view.movements} movimenti</span></td>
        <td class="num">${euro(view.collected_cents)}</td>
      </tr>
    </table>

    ${fuori ? `<h2>Fuori dai totali</h2><table>${fuori}</table>` : ''}
  </div>

  <div class="col">
    <h2>Contante in cassa</h2>
    <table>
      <tr><td>Fondo di apertura</td><td class="num">${euro(s?.opening_float_cents ?? 0)}</td></tr>
      <tr><td>Incassi in contanti</td><td class="num">${euro(view.cash_cents)}</td></tr>
      <tr class="total"><td>Atteso</td><td class="num">${euro(view.expected_cents)}</td></tr>
    </table>

    ${s?.closed_at ? `
      <div class="box">
        <div>Contato <strong class="num">${euro(s.counted_cents ?? 0)}</strong></div>
        <div class="diff">Differenza ${(s.difference_cents ?? 0) > 0 ? '+' : ''}${euro(s.difference_cents ?? 0)}</div>
        ${s.note ? `<div class="muted">${escapeHtml(s.note)}</div>` : ''}
      </div>
      <div class="muted">
        Aperta da ${escapeHtml(s.opened_by_name)} alle ${time(s.opened_at)} ·
        chiusa da ${escapeHtml(s.closed_by_name ?? '')} alle ${time(s.closed_at)}
      </div>
    ` : `
      <div class="box muted">Cassa non ancora chiusa.</div>
      <div class="sign">Contato</div>
      <div class="line"></div>
      <div class="sign">Firma</div>
      <div class="line"></div>
    `}

    ${view.open_bills.count > 0 ? `
      <div class="box">
        ${view.open_bills.count === 1 ? '1 conto ancora' : `${view.open_bills.count} conti ancora`}
        da incassare per <strong>${euro(view.open_bills.residual_cents)}</strong>.
      </div>` : ''}
  </div>
</div>
</body>
</html>`;

  printHtmlDocument(html, { popupMessage: 'Sblocca i popup per stampare il riepilogo di cassa.' });
};
