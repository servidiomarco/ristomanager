import {
  ReservationsReport, RevenueReport, DishesReport, CommunicationsReport,
} from '../services/reportsApiService';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/* Foglio unico della Reportistica: KPI e tabelle, niente grafici — la carta
   serve alla riunione e al commercialista, non allo schermo. La serie per
   giorno va su carta solo con range fino a 31 giorni: due mesi di righe
   sono rumore, i totali bastano. Stessa struttura di printHaccpReport. */

const ACCENT = '#1d4ed8'; // blue-700 — distinto da HACCP teal e spesa indigo

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const nf = new Intl.NumberFormat('it-IT');
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const money = (cents: number | null | undefined): string => euro.format((cents ?? 0) / 100);
const int = (n: number | null | undefined): string => nf.format(Math.round(n ?? 0));

const dayLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
};
const shortDay = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

const CHANNEL_LABELS: Record<string, string> = {
  MANUAL: 'Inserite dallo staff',
  WHATSAPP: 'WhatsApp',
  VOICE: 'Sofia (telefono)',
  GOOGLE: 'Pagina di prenotazione',
};
const METHOD_LABELS: Record<string, string> = {
  CONTANTI: 'Contanti', POS_FISICO: 'Pos', SATISPAY: 'Satispay', BUONO_PASTO: 'Buoni pasto',
  GIFT_CARD: 'Gift card', SOSPESO: 'Sospeso', OMAGGIO: 'Omaggio', LINK_ONLINE: 'Link online',
};

const pill = (label: string): string => `<span class="pill">${label}</span>`;
const emptyRow = (cols: number, label = 'Nessun dato nel periodo.'): string =>
  `<tr><td colspan="${cols}" class="empty">${escapeHtml(label)}</td></tr>`;

export interface PrintReportisticaInput {
  from: string;
  to: string;
  prenotazioni: ReservationsReport | null;
  incassi: RevenueReport | null;
  cucina: DishesReport | null;
  comunicazioni: CommunicationsReport | null;
}

export const printReportistica = (input: PrintReportisticaInput): void => {
  const { prenotazioni: p, incassi: i, cucina: c, comunicazioni: co } = input;
  const rangeDays = Math.round((Date.parse(input.to) - Date.parse(input.from)) / 86400000) + 1;

  const sezioni: string[] = [];
  let n = 0;

  if (p) {
    n += 1;
    const perGiorno = rangeDays <= 31 && p.per_giorno.length > 0 ? `
      <table>
        <thead><tr><th>Giorno</th><th class="num">Prenotazioni</th><th class="num">Coperti</th></tr></thead>
        <tbody>
          ${p.per_giorno.map(g => `<tr><td>${shortDay(g.giorno)}</td><td class="num">${int(g.prenotazioni)}</td><td class="num">${int(g.coperti)}</td></tr>`).join('')}
        </tbody>
      </table>` : '';
    sezioni.push(`
  <section>
    <h2>${n} · Prenotazioni e canali</h2>
    <div class="summary">
      ${pill(`Prenotazioni: ${int(p.totali.prenotazioni)} (prima ${int(p.precedente.prenotazioni)})`)}
      ${pill(`Coperti: ${int(p.totali.coperti)} (prima ${int(p.precedente.coperti)})`)}
      ${pill(`No-show: ${int(p.totali.no_show)}`)}
      ${pill(`Cancellate: ${int(p.totali.cancellate)}`)}
    </div>
    <table>
      <thead><tr><th>Canale</th><th class="num">Prenotazioni</th><th class="num">Coperti</th></tr></thead>
      <tbody>
        ${p.per_canale.length > 0
          ? p.per_canale.map(cn => `<tr><td>${escapeHtml(CHANNEL_LABELS[cn.canale] ?? cn.canale)}</td><td class="num">${int(cn.prenotazioni)}</td><td class="num">${int(cn.coperti)}</td></tr>`).join('')
          : emptyRow(3)}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Sala</th><th class="num">Prenotazioni</th><th class="num">Coperti</th></tr></thead>
      <tbody>
        ${p.per_sala.length > 0
          ? p.per_sala.map(s => `<tr><td>${escapeHtml(s.sala)}</td><td class="num">${int(s.prenotazioni)}</td><td class="num">${int(s.coperti)}</td></tr>`).join('')
          : emptyRow(3)}
      </tbody>
    </table>
    ${perGiorno}
  </section>`);
  }

  if (i) {
    n += 1;
    sezioni.push(`
  <section>
    <h2>${n} · Incassi e cassa</h2>
    <div class="summary">
      ${pill(`Incassato: ${money(i.totali.incassato_cents)} (prima ${money(i.precedente.incassato_cents)})`)}
      ${pill(`Scontrino medio: ${money(i.totali.scontrino_medio_cents)}`)}
      ${pill(`Coperto medio: ${money(i.totali.coperto_medio_cents)}`)}
      ${pill(`Mance: ${money(i.totali.mance_cents)}`)}
      ${pill(`Casse chiuse: ${int(i.casse.chiuse)}/${int(i.casse.sessioni)} · differenze ${money(i.casse.differenza_totale_cents)}`)}
    </div>
    <table>
      <thead><tr><th>Metodo</th><th class="num">Importo</th><th class="num">Movimenti</th></tr></thead>
      <tbody>
        ${i.per_metodo.length > 0
          ? i.per_metodo.map(m => `<tr><td>${escapeHtml(METHOD_LABELS[m.metodo] ?? m.metodo)}${m.non_cash ? ' <span class="muted">(fuori incassato)</span>' : ''}</td><td class="num">${money(m.amount_cents)}</td><td class="num">${int(m.movimenti)}</td></tr>`).join('')
          : emptyRow(3)}
      </tbody>
    </table>
    ${i.differenze.length > 0 ? `
    <table>
      <thead><tr><th>Differenze di cassa</th><th class="num">Importo</th><th>Nota</th></tr></thead>
      <tbody>
        ${i.differenze.map(d => `<tr><td>${shortDay(d.giorno)} · ${d.turno === 'LUNCH' ? 'pranzo' : 'cena'}</td><td class="num ${d.differenza_cents < 0 ? 'alert' : ''}">${money(d.differenza_cents)}</td><td class="muted">${escapeHtml(d.note ?? '')}</td></tr>`).join('')}
      </tbody>
    </table>` : ''}
  </section>`);
  }

  if (c?.enabled) {
    n += 1;
    const top = (c.top_piatti ?? []).slice(0, 10);
    sezioni.push(`
  <section>
    <h2>${n} · Cucina e piatti</h2>
    <table>
      <thead><tr><th>Piatto</th><th class="num">Quantità</th><th class="num">Ricavo</th></tr></thead>
      <tbody>
        ${top.length > 0
          ? top.map(pt => `<tr><td>${escapeHtml(pt.piatto)}</td><td class="num">${int(pt.qty)}</td><td class="num">${money(pt.ricavo_cents)}</td></tr>`).join('')
          : emptyRow(3)}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Partita</th><th class="num">Righe</th><th class="num">Media (min)</th><th class="num">Mediana (min)</th><th class="num">Stornate</th></tr></thead>
      <tbody>
        ${(c.partite ?? []).length > 0
          ? (c.partite ?? []).map(st => `<tr><td>${escapeHtml(st.station_name ?? 'Senza partita')}</td><td class="num">${int(st.righe)}</td><td class="num">${st.media_min ?? '—'}</td><td class="num">${st.mediana_min ?? '—'}</td><td class="num">${int(st.stornate)}</td></tr>`).join('')
          : emptyRow(5)}
      </tbody>
    </table>
    ${(c.scarti ?? []).length > 0 ? `
    <table>
      <thead><tr><th>Scarti per motivo</th><th class="num">Righe</th><th class="num">Valore</th></tr></thead>
      <tbody>
        ${(c.scarti ?? []).map(s => `<tr><td>${escapeHtml(s.motivo || 'Senza motivo')}</td><td class="num">${int(s.righe)}</td><td class="num">${money(s.valore_cents)}</td></tr>`).join('')}
      </tbody>
    </table>` : ''}
  </section>`);
  }

  if (co) {
    n += 1;
    const conv = co.voce.chiamate > 0 ? Math.round((co.voce.con_prenotazione / co.voce.chiamate) * 100) : 0;
    sezioni.push(`
  <section>
    <h2>${n} · Sofia e comunicazioni</h2>
    <div class="summary">
      ${pill(`Chiamate: ${int(co.voce.chiamate)} (prima ${int(co.voce_precedente.chiamate)})`)}
      ${pill(`Minuti: ${int(co.voce.secondi / 60)}`)}
      ${pill(`Convertite: ${conv}% (${int(co.voce.con_prenotazione)})`)}
      ${pill(`Phantom: ${int(co.voce.phantom)} · gruppi grandi: ${int(co.voce.gruppi_grandi)}`)}
    </div>
    <table>
      <thead><tr><th>Canale messaggi</th><th class="num">Inviati</th><th class="num">Consegnati</th><th class="num">Falliti</th></tr></thead>
      <tbody>
        ${co.messaggi.length > 0
          ? co.messaggi.map(m => `<tr><td>${escapeHtml(m.canale)}</td><td class="num">${int(m.inviati)}</td><td class="num">${int(m.consegnati)}</td><td class="num ${m.falliti > 0 ? 'alert' : ''}">${int(m.falliti)}</td></tr>`).join('')
          : emptyRow(4)}
      </tbody>
    </table>
  </section>`);
  }

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Reportistica — dal ${escapeHtml(input.from)} al ${escapeHtml(input.to)}</title>
<style>
${PRINT_TOKENS_CSS}
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: var(--ds-print-ink);
    margin: 0;
    padding: 24px;
    background: #fff;
    line-height: 1.4;
    font-size: 12px;
  }
  header { border-bottom: 2px solid ${ACCENT}; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { margin: 0 0 4px; font-size: 22px; color: var(--ds-print-ink); }
  .eyebrow { color: ${ACCENT}; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .date { color: var(--ds-print-ink-secondary); font-size: 12px; margin-top: 4px; }
  .summary { margin: 8px 0 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { padding: 3px 10px; background: var(--ds-print-fill); color: var(--ds-print-ink-secondary); border-radius: 999px; font-size: 11px; font-weight: 600; }
  section { margin-top: 18px; page-break-inside: avoid; }
  h2 {
    margin: 0 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--ds-print-ink);
    border-left: 3px solid ${ACCENT}; padding-left: 8px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--ds-print-rule); vertical-align: top; }
  th {
    background: var(--ds-print-fill); color: var(--ds-print-ink-secondary); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.04em;
    border-bottom: 1px solid var(--ds-print-rule-strong);
  }
  th.num, td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.alert { color: #b91c1c; font-weight: 700; }
  td.muted, span.muted { color: var(--ds-print-ink-subtle); font-weight: 400; }
  td.empty { text-align: center; padding: 12px; color: var(--ds-print-ink-subtle); font-style: italic; }
  footer {
    margin-top: 24px; padding-top: 10px; border-top: 1px solid var(--ds-print-rule);
    color: var(--ds-print-ink-subtle); font-size: 10px; text-align: center;
  }
  @media print {
    body { padding: 14mm; }
    header, h2 { break-after: avoid; }
  }
</style>
</head>
<body>
  <header>
    <div class="eyebrow">Reportistica</div>
    <h1>Dal ${escapeHtml(dayLabel(input.from))} al ${escapeHtml(dayLabel(input.to))}</h1>
    <div class="date">Confronto col periodo precedente di pari durata ("prima"). Incassi per giorno di servizio, prenotazioni per giorno solare.</div>
  </header>
  ${sezioni.join('\n')}
  <footer>Generato da RistoManager · ${escapeHtml(new Date().toLocaleString('it-IT', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</footer>
</body>
</html>`;

  printHtmlDocument(html, { popupMessage: 'Consenti i popup per stampare il report.' });
};
