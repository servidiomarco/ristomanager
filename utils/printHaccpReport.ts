import {
  HaccpTemperatureReading,
  HaccpOilCheck,
  HaccpCleaningCheck,
  HaccpGoodsReceipt,
  HaccpProductionLog,
  HaccpOilAction,
} from '../services/haccpApiService';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

const ITALIAN_DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
};

const ACCENT = '#0f766e'; // teal-700 — distinct from shopping list indigo

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const formatDate = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('it-IT', ITALIAN_DATE_OPTS);
};

const formatTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
};

const formatNumber = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  return String(n).replace('.', ',');
};

const formatUser = (email: string | null | undefined): string => {
  if (!email) return '';
  return email.split('@')[0];
};

const OIL_ACTION_LABELS: Record<HaccpOilAction, string> = {
  SOSTITUITO: 'Sostituito',
  FILTRATO: 'Filtrato',
  UTILIZZABILE: 'Utilizzabile',
};

// Each section gives the print utility one preset (location/fryer/point) plus
// the actual recorded check (or null when nothing was entered). The renderer
// shows a dash for missing rows so the printout makes the gap obvious.
export interface PrintHaccpInput {
  date: string;
  temperatures: Array<{ location: string; targetMax: number; reading: HaccpTemperatureReading | null }>;
  oil: Array<{ fryerLabel: string; check: HaccpOilCheck | null }>;
  cleaning: Array<{ point: string; check: HaccpCleaningCheck | null }>;
  receipts: HaccpGoodsReceipt[];
  production: HaccpProductionLog[];
}

const tempRow = (row: PrintHaccpInput['temperatures'][number]): string => {
  const t = row.reading?.temperature ?? null;
  const overTarget = t !== null && t > row.targetMax;
  const tempCell = t === null
    ? '<td class="muted">—</td>'
    : `<td class="num ${overTarget ? 'alert' : 'ok'}">${formatNumber(t)} °C</td>`;
  return `
    <tr>
      <td>${escapeHtml(row.location)}</td>
      <td class="num small muted">≤ ${formatNumber(row.targetMax)} °C</td>
      ${tempCell}
      <td class="small muted">${escapeHtml(row.reading?.note ?? '')}</td>
      <td class="small muted">${escapeHtml(formatUser(row.reading?.recordedByUserName))} ${escapeHtml(formatTime(row.reading?.recordedAt))}</td>
    </tr>
  `;
};

const oilRow = (row: PrintHaccpInput['oil'][number]): string => {
  const action = row.check?.action ?? null;
  return `
    <tr>
      <td>${escapeHtml(row.fryerLabel)}</td>
      <td>${action ? `<span class="badge">${escapeHtml(OIL_ACTION_LABELS[action])}</span>` : '<span class="muted">—</span>'}</td>
      <td class="small muted">${escapeHtml(row.check?.note ?? '')}</td>
      <td class="small muted">${escapeHtml(formatUser(row.check?.recordedByUserName))} ${escapeHtml(formatTime(row.check?.recordedAt))}</td>
    </tr>
  `;
};

const cleaningRow = (row: PrintHaccpInput['cleaning'][number]): string => {
  const done = !!row.check?.done;
  const cell = row.check === null
    ? '<span class="muted">—</span>'
    : done
      ? '<span class="check ok">&#10003;</span>'
      : '<span class="check pending">○</span>';
  return `
    <tr>
      <td>${cell}</td>
      <td>${escapeHtml(row.point)}</td>
      <td class="small muted">${escapeHtml(row.check?.note ?? '')}</td>
      <td class="small muted">${escapeHtml(formatUser(row.check?.recordedByUserName))} ${escapeHtml(formatTime(row.check?.recordedAt))}</td>
    </tr>
  `;
};

const receiptRow = (r: HaccpGoodsReceipt): string => `
  <tr>
    <td>${escapeHtml(r.product)}</td>
    <td class="small muted">${escapeHtml(r.lotNumber ?? '')}</td>
    <td class="num small">${r.temperature !== null ? formatNumber(r.temperature) + ' °C' : '—'}</td>
    <td>${r.accepted
      ? '<span class="badge ok">Accettato</span>'
      : '<span class="badge alert">Respinto</span>'}</td>
    <td class="small muted">${escapeHtml(r.note ?? '')}</td>
    <td class="small muted">${escapeHtml(formatUser(r.recordedByUserName))} ${escapeHtml(formatTime(r.recordedAt))}</td>
  </tr>
`;

const productionRow = (p: HaccpProductionLog): string => `
  <tr>
    <td>${escapeHtml(p.product)}</td>
    <td class="small muted">${escapeHtml(p.internalLot ?? '')}</td>
    <td class="small">${escapeHtml(p.blastTempRange ?? '—')}</td>
    <td class="small">${escapeHtml(p.blastDuration ?? '—')}</td>
    <td class="small muted">${escapeHtml(p.note ?? '')}</td>
    <td class="small muted">${escapeHtml(formatUser(p.recordedByUserName))} ${escapeHtml(formatTime(p.recordedAt))}</td>
  </tr>
`;

const emptyRow = (cols: number, label = 'Nessuna registrazione.'): string =>
  `<tr><td colspan="${cols}" class="empty">${escapeHtml(label)}</td></tr>`;

export const printHaccpReport = (input: PrintHaccpInput): void => {
  const dateLabel = formatDate(input.date);

  const tempCompleted = input.temperatures.filter(t => t.reading).length;
  const oilCompleted = input.oil.filter(o => o.check).length;
  const cleaningCompleted = input.cleaning.filter(c => c.check?.done).length;

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>HACCP — Report ${escapeHtml(dateLabel || input.date)}</title>
<style>
${PRINT_TOKENS_CSS}
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #1e293b;
    margin: 0;
    padding: 24px;
    background: #fff;
    line-height: 1.4;
    font-size: 12px;
  }
  header {
    border-bottom: 2px solid ${ACCENT};
    padding-bottom: 12px;
    margin-bottom: 20px;
  }
  h1 { margin: 0 0 4px; font-size: 22px; color: var(--ds-print-ink); }
  .eyebrow { color: ${ACCENT}; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .date { color: var(--ds-print-ink-secondary); font-size: 12px; margin-top: 4px; text-transform: capitalize; }
  .summary {
    margin-top: 8px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pill {
    padding: 3px 10px;
    background: var(--ds-print-fill);
    color: var(--ds-print-ink-secondary);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  section { margin-top: 18px; page-break-inside: avoid; }
  h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ds-print-ink);
    border-left: 3px solid ${ACCENT};
    padding-left: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  th, td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--ds-print-rule);
    vertical-align: top;
  }
  th {
    background: #f8fafc;
    color: var(--ds-print-ink-secondary);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--ds-print-rule-strong);
  }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.num.ok { color: #047857; font-weight: 600; }
  td.num.alert { color: #b91c1c; font-weight: 700; background: #fef2f2; }
  td.small, th.small { font-size: 10px; }
  td.muted { color: var(--ds-print-ink-subtle); }
  td.empty { text-align: center; padding: 12px; color: var(--ds-print-ink-subtle); font-style: italic; }
  .check { font-weight: 700; font-size: 14px; }
  .check.ok { color: #047857; }
  .check.pending { color: var(--ds-print-rule-strong); }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    background: #eef2ff;
    color: #4338ca;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
  }
  .badge.ok { background: #d1fae5; color: #065f46; }
  .badge.alert { background: #fee2e2; color: #991b1b; }
  .sign-grid {
    margin-top: 30px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    page-break-inside: avoid;
  }
  .sign-box {
    border-top: 1px solid var(--ds-print-ink-subtle);
    padding-top: 4px;
    font-size: 10px;
    color: var(--ds-print-ink-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  footer {
    margin-top: 24px;
    padding-top: 10px;
    border-top: 1px solid var(--ds-print-rule);
    color: var(--ds-print-ink-subtle);
    font-size: 10px;
    text-align: center;
  }
  @media print {
    body { padding: 14mm; }
    header { break-after: avoid; }
    h2 { break-after: avoid; }
  }
</style>
</head>
<body>
  <header>
    <div class="eyebrow">HACCP — Report giornaliero</div>
    <h1>Controlli del ${escapeHtml(dateLabel || input.date)}</h1>
    <div class="summary">
      <span class="pill">Temperature: ${tempCompleted}/${input.temperatures.length}</span>
      <span class="pill">Friggitrici: ${oilCompleted}/${input.oil.length}</span>
      <span class="pill">Pulizie: ${cleaningCompleted}/${input.cleaning.length}</span>
      <span class="pill">Ricevimenti: ${input.receipts.length}</span>
      <span class="pill">Produzioni: ${input.production.length}</span>
    </div>
  </header>

  <section>
    <h2>1 · Temperature frigoriferi e congelatori</h2>
    <table>
      <thead>
        <tr>
          <th>Punto</th>
          <th class="small">Limite</th>
          <th class="small">Temp. rilevata</th>
          <th class="small">Note</th>
          <th class="small">Operatore</th>
        </tr>
      </thead>
      <tbody>
        ${input.temperatures.map(tempRow).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>2 · Friggitrici — controllo olio</h2>
    <table>
      <thead>
        <tr>
          <th>Friggitrice</th>
          <th>Azione</th>
          <th class="small">Note</th>
          <th class="small">Operatore</th>
        </tr>
      </thead>
      <tbody>
        ${input.oil.map(oilRow).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>3 · Pulizie attrezzature e superfici</h2>
    <table>
      <thead>
        <tr>
          <th style="width:30px"></th>
          <th>Punto</th>
          <th class="small">Note</th>
          <th class="small">Operatore</th>
        </tr>
      </thead>
      <tbody>
        ${input.cleaning.map(cleaningRow).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>4 · Ricevimento merci</h2>
    <table>
      <thead>
        <tr>
          <th>Prodotto</th>
          <th class="small">Lotto</th>
          <th class="small">Temp.</th>
          <th>Esito</th>
          <th class="small">Note</th>
          <th class="small">Operatore</th>
        </tr>
      </thead>
      <tbody>
        ${input.receipts.length === 0 ? emptyRow(6) : input.receipts.map(receiptRow).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>5 · Abbattimento / produzione</h2>
    <table>
      <thead>
        <tr>
          <th>Prodotto</th>
          <th class="small">Lotto interno</th>
          <th class="small">Range temp.</th>
          <th class="small">Durata</th>
          <th class="small">Note</th>
          <th class="small">Operatore</th>
        </tr>
      </thead>
      <tbody>
        ${input.production.length === 0 ? emptyRow(6) : input.production.map(productionRow).join('')}
      </tbody>
    </table>
  </section>

  <div class="sign-grid">
    <div class="sign-box">Responsabile HACCP</div>
    <div class="sign-box">Data e firma</div>
  </div>

  <footer>Documento generato il ${escapeHtml(new Date().toLocaleString('it-IT'))}</footer>
</body>
</html>`;

  printHtmlDocument(html, { popupMessage: 'Sblocca i popup per stampare il report.' });
};
