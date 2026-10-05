import type {
  HaccpCalibration,
  HaccpChange,
  HaccpCleaningCheck,
  HaccpGoodsReceipt,
  HaccpNonConformity,
  HaccpOilAction,
  HaccpOilCheck,
  HaccpProductionLog,
  HaccpReportData,
  HaccpTemperatureReading,
} from '../services/haccpApiService';
import type { HaccpLimits, HaccpPoint, HaccpProcess } from './haccp';
import {
  HACCP_PROCESS_LABELS_IT, HACCP_RECEIPT_CATEGORIES, HACCP_RECEIPT_CATEGORY_LABELS_IT, HACCP_TWO_STEP_PROCESSES,
  formatHaccpDuration, formatHaccpLimit, haccpCalibrationDeviation, haccpDaysBetween, isOutOfRange,
} from './haccp';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/* Il registro HACCP stampato, per un giorno o per un periodo.
 *
 * Il giorno singolo è il foglio di sempre: una tabella per registro. Un
 * periodo è quello che chiede l'ispettore — mesi, non giorni — e lì la forma
 * giusta è la scheda mensile dei fogli di carta: postazioni in riga, giorni
 * in colonna, il valore fuori soglia in rosso. Dopo le griglie, le liste che
 * su carta non c'erano: le non conformità con la loro azione correttiva, le
 * correzioni con l'originale e il motivo, le righe scritte in un giorno
 * diverso da quello del registro. Un foglio che le mostra è più credibile di
 * uno perfetto.
 *
 * Fuori dall'i18n come gli altri fogli: è un documento per l'ASL, in italiano.
 */

const ACCENT = '#0f766e'; // teal-700 — distinto da spesa indigo e reportistica blue

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const longDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

const shortDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

const monthLabel = (isoMonth: string): string => {
  const d = new Date(`${isoMonth}-01T00:00:00`);
  return d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
};

const time = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
};

const dateTime = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : String(Math.round(n * 10) / 10).replace('.', ',');

const person = (s: string | null | undefined): string => (!s ? '' : s.includes('@') ? s.split('@')[0] : s);

const localDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Il giorno in cui la riga è stata scritta, se diverso dal giorno di registro. */
const writtenOther = (r: { date: string; recordedAt?: string }): string | null => {
  if (!r.recordedAt) return null;
  const w = localDay(r.recordedAt);
  return w !== r.date ? w : null;
};

const WEEKDAYS = ['do', 'lu', 'ma', 'me', 'gi', 've', 'sa'];
const weekday = (iso: string): string => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

const OIL_LABELS: Record<HaccpOilAction, string> = { SOSTITUITO: 'Sostituito', FILTRATO: 'Filtrato', UTILIZZABILE: 'Utilizzabile' };
const OIL_CODES: Record<HaccpOilAction, string> = { SOSTITUITO: 's', FILTRATO: 'f', UTILIZZABILE: 'u' };

const FREQ_LABELS: Record<string, string> = { DAILY: 'ogni giorno', WEEKLY: 'ogni settimana', MONTHLY: 'ogni mese', ON_DEMAND: 'su richiesta' };

const ENTITY_LABELS: Record<string, string> = {
  temperature: 'Temperatura',
  oil: 'Olio',
  cleaning: 'Pulizia',
  receipt: 'Ricevimento',
  production: 'Processo',
  calibration: 'Taratura',
};

const FIELD_LABELS: Record<string, string> = {
  temperature: 'temperatura',
  note: 'note',
  action: 'olio',
  done: 'eseguita',
  product: 'prodotto',
  lotNumber: 'lotto',
  accepted: 'esito',
  internalLot: 'lotto interno',
  blastTempRange: 'range',
  blastDuration: 'durata',
  polarCompounds: 'composti polari',
  oilTemp: 'temperatura olio',
  startTemp: 'temperatura iniziale',
  endTemp: 'temperatura finale',
  endedAt: 'fine',
  supplierName: 'fornitore',
  ddtNumber: 'documento',
  expiryDate: 'scadenza',
  measuredTemp: 'lettura',
  outcome: 'esito',
};

const live = <T extends { voidedAt?: string | null }>(rows: T[]): T[] => rows.filter(r => !r.voidedAt);

/** I punti da mostrare: gli attivi, più gli archiviati che hanno righe nel
 *  periodo (la cella dismessa a metà mese ha ancora i suoi valori). */
const pointsFor = (data: HaccpReportData, register: HaccpPoint['register'], used: Set<number>): HaccpPoint[] =>
  data.points
    .filter(p => p.register === register && (p.active || used.has(p.id)))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

// =============================================================================
// Giorno singolo
// =============================================================================

const dayTemperatures = (data: HaccpReportData): string => {
  const rows = live(data.temperatures);
  const points = pointsFor(data, 'TEMPERATURE', new Set(rows.map(r => r.pointId ?? -1)));
  const maxSlots = Math.max(1, ...points.map(p => p.checksPerDay));
  const head = Array.from({ length: maxSlots }, (_, i) => `<th class="num">${maxSlots > 1 ? `${i + 1}ª` : 'Rilevata'}</th>`).join('');
  const body = points.map(p => {
    const cells = Array.from({ length: maxSlots }, (_, i) => {
      if (i >= p.checksPerDay) return '<td class="muted"></td>';
      const r = rows.find(x => x.pointId === p.id && x.slot === i + 1);
      if (!r) return '<td class="num muted">—</td>';
      const out = isOutOfRange(r.temperature, r.targetMin, r.targetMax);
      return `<td class="num ${out ? 'alert' : 'ok'}">${num(r.temperature)} °C${r.updatedAt ? '<sup>c</sup>' : ''}</td>`;
    }).join('');
    const mine = rows.filter(x => x.pointId === p.id);
    const notes = mine.map(r => r.note).filter(Boolean).join(' · ');
    const who = mine.map(r => `${escapeHtml(person(r.recordedByUserName))} ${time(r.recordedAt)}${writtenOther(r) ? ` (scritta il ${shortDate(writtenOther(r)!)})` : ''}`).join('<br>');
    return `<tr><td>${escapeHtml(p.label)}</td><td class="small muted">${escapeHtml(formatHaccpLimit(p.minTemp, p.maxTemp))}</td>${cells}<td class="small muted">${escapeHtml(notes)}</td><td class="small muted">${who}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Postazione</th><th class="small">Limite</th>${head}<th class="small">Note</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(4 + maxSlots)}</tbody></table>`;
};

const dayOil = (data: HaccpReportData): string => {
  const rows = live(data.oil);
  const points = pointsFor(data, 'OIL', new Set(rows.map(r => r.pointId ?? -1)));
  const body = points.map(p => {
    const r = rows.find(x => x.pointId === p.id);
    const polar = typeof r?.polarCompounds === 'number' ? `${num(r.polarCompounds)}%` : '—';
    const temp = typeof r?.oilTemp === 'number' ? `${num(r.oilTemp)} °C` : '—';
    return `<tr><td>${escapeHtml(p.label)}</td><td>${r ? `<span class="badge">${OIL_LABELS[r.action]}</span>` : '<span class="muted">—</span>'}</td><td class="num small">${polar}</td><td class="num small">${temp}</td><td class="small muted">${escapeHtml(r?.note ?? '')}</td><td class="small muted">${r ? `${escapeHtml(person(r.recordedByUserName))} ${time(r.recordedAt)}` : ''}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Friggitrice</th><th>Olio</th><th class="small num">Polari</th><th class="small num">Temp.</th><th class="small">Note</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(6)}</tbody></table>`;
};

const dayCleaning = (data: HaccpReportData): string => {
  const rows = live(data.cleaning).filter(r => r.done);
  const points = pointsFor(data, 'CLEANING', new Set(rows.map(r => r.pointId ?? -1)));
  const body = points.map(p => {
    const r = rows.find(x => x.pointId === p.id);
    const freq = p.frequency !== 'DAILY' ? ` <span class="muted small">(${FREQ_LABELS[p.frequency]})</span>` : '';
    return `<tr><td>${r ? '<span class="check ok">&#10003;</span>' : '<span class="muted">—</span>'}</td><td>${escapeHtml(p.label)}${freq}</td><td class="small muted">${escapeHtml(r?.note ?? '')}</td><td class="small muted">${r ? `${escapeHtml(person(r.recordedByUserName))} ${time(r.recordedAt)}` : ''}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th style="width:24px"></th><th>Punto</th><th class="small">Note</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(4)}</tbody></table>`;
};

// =============================================================================
// Periodo: le schede mensili
// =============================================================================

const monthsOf = (days: string[]): string[] => Array.from(new Set(days.map(d => d.slice(0, 7))));

const gridHead = (days: string[]): string =>
  `<tr><th class="label-col">Punto</th>${days.map(d => `<th class="day${weekday(d) === 'do' ? ' sunday' : ''}">${Number(d.slice(8))}<br><span class="wd">${weekday(d)}</span></th>`).join('')}</tr>`;

const temperatureGrid = (data: HaccpReportData, days: string[], flags: Set<string>): string => {
  const rows = live(data.temperatures);
  const points = pointsFor(data, 'TEMPERATURE', new Set(rows.map(r => r.pointId ?? -1)));
  const index = new Map<string, HaccpTemperatureReading>();
  rows.forEach(r => index.set(`${r.pointId}:${r.slot}:${r.date}`, r));
  return monthsOf(days).map(month => {
    const mdays = days.filter(d => d.startsWith(month));
    const body = points.flatMap(p => Array.from({ length: p.checksPerDay }, (_, i) => {
      const slot = i + 1;
      const label = `${escapeHtml(p.label)}${p.checksPerDay > 1 ? ` <span class="muted">${slot}ª</span>` : ''}<div class="limit">${escapeHtml(formatHaccpLimit(p.minTemp, p.maxTemp))}</div>`;
      const cells = mdays.map(d => {
        const r = index.get(`${p.id}:${slot}:${d}`);
        if (!r) return '<td class="cell empty"></td>';
        const out = isOutOfRange(r.temperature, r.targetMin, r.targetMax);
        const mark = r.updatedAt || writtenOther(r) ? '<sup>*</sup>' : '';
        if (mark) flags.add('temperature');
        return `<td class="cell ${out ? 'alert' : ''}">${num(r.temperature)}${mark}</td>`;
      }).join('');
      return `<tr><td class="label-col">${label}</td>${cells}</tr>`;
    })).join('');
    return `<h3>${escapeHtml(monthLabel(month))}</h3><table class="grid"><thead>${gridHead(mdays)}</thead><tbody>${body || emptyRow(mdays.length + 1)}</tbody></table>`;
  }).join('');
};

const oilGrid = (data: HaccpReportData, days: string[]): string => {
  const rows = live(data.oil);
  const points = pointsFor(data, 'OIL', new Set(rows.map(r => r.pointId ?? -1)));
  const index = new Map<string, HaccpOilCheck>();
  rows.forEach(r => index.set(`${r.pointId}:${r.date}`, r));
  return monthsOf(days).map(month => {
    const mdays = days.filter(d => d.startsWith(month));
    const body = points.map(p => {
      const cells = mdays.map(d => {
        const r = index.get(`${p.id}:${d}`);
        if (!r) return '<td class="cell empty"></td>';
        const polar = typeof r.polarCompounds === 'number' ? `<div class="polar">${num(r.polarCompounds)}%</div>` : '';
        return `<td class="cell${r.action === 'SOSTITUITO' ? ' strong' : ''}">${OIL_CODES[r.action]}${polar}</td>`;
      }).join('');
      return `<tr><td class="label-col">${escapeHtml(p.label)}</td>${cells}</tr>`;
    }).join('');
    return `<h3>${escapeHtml(monthLabel(month))}</h3><table class="grid"><thead>${gridHead(mdays)}</thead><tbody>${body || emptyRow(mdays.length + 1)}</tbody></table>`;
  }).join('') + '<p class="legend">s = olio sostituito · f = filtrato · u = utilizzabile · sotto, i composti polari misurati</p>';
};

const cleaningGrid = (data: HaccpReportData, days: string[]): string => {
  const rows = live(data.cleaning).filter(r => r.done);
  const points = pointsFor(data, 'CLEANING', new Set(rows.map(r => r.pointId ?? -1)));
  const index = new Set(rows.map(r => `${r.pointId}:${r.date}`));
  return monthsOf(days).map(month => {
    const mdays = days.filter(d => d.startsWith(month));
    const body = points.map(p => {
      const freq = p.frequency !== 'DAILY' ? `<div class="limit">${FREQ_LABELS[p.frequency]}</div>` : '';
      const cells = mdays.map(d => index.has(`${p.id}:${d}`) ? '<td class="cell ok">&#10003;</td>' : '<td class="cell empty"></td>').join('');
      return `<tr><td class="label-col">${escapeHtml(p.label)}${freq}</td>${cells}</tr>`;
    }).join('');
    return `<h3>${escapeHtml(monthLabel(month))}</h3><table class="grid"><thead>${gridHead(mdays)}</thead><tbody>${body || emptyRow(mdays.length + 1)}</tbody></table>`;
  }).join('');
};

// =============================================================================
// Liste comuni
// =============================================================================

const emptyRow = (cols: number, label = 'Nessuna registrazione.'): string =>
  `<tr><td colspan="${cols}" class="empty">${escapeHtml(label)}</td></tr>`;

const receiptsTable = (rows: HaccpGoodsReceipt[], multiDay: boolean): string => {
  const body = live(rows).map(r => {
    const origin = [r.supplierName, r.ddtNumber ? `DDT ${r.ddtNumber}` : ''].filter(Boolean).join(' · ');
    const lot = [r.lotNumber, r.expiryDate ? `scad. ${shortDate(r.expiryDate)}` : ''].filter(Boolean).join(' · ');
    const kind = r.category ? HACCP_RECEIPT_CATEGORY_LABELS_IT[r.category] : '';
    return `
    <tr>
      ${multiDay ? `<td class="small">${shortDate(r.date)}</td>` : ''}
      <td>${escapeHtml(r.product)}${kind ? `<div class="small muted">${escapeHtml(kind)}</div>` : ''}</td>
      <td class="small">${escapeHtml(origin)}</td>
      <td class="small muted">${escapeHtml(lot)}</td>
      <td class="num small">${r.temperature !== null ? `${num(r.temperature)} °C` : '—'}</td>
      <td>${r.accepted ? '<span class="badge ok">Accettato</span>' : '<span class="badge alert">Respinto</span>'}${r.packagingOk === false ? '<div class="small">imballo non integro</div>' : ''}</td>
      <td class="small muted">${escapeHtml(r.note ?? '')}</td>
      <td class="small muted">${escapeHtml(person(r.recordedByUserName))} ${time(r.recordedAt)}</td>
    </tr>`;
  }).join('');
  const cols = multiDay ? 8 : 7;
  return `<table><thead><tr>${multiDay ? '<th class="small">Giorno</th>' : ''}<th>Prodotto</th><th class="small">Fornitore e documento</th><th class="small">Lotto e scadenza</th><th class="small num">Temp.</th><th>Esito</th><th class="small">Note</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(cols)}</tbody></table>`;
};

const signedNum = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n > 0 ? '+' : ''}${num(n)} °C` : '—';

/** Il dettaglio di un processo sul foglio: da quanto a quanto e in quanto
 *  tempo, la temperatura al cuore, il prodotto sanificante, l'evento. */
const processDetail = (p: HaccpProductionLog): string => {
  const process = (p.process ?? 'LEGACY') as HaccpProcess;
  if (process === 'LEGACY') return [p.blastTempRange, p.blastDuration].filter(Boolean).join(' · ');
  if (HACCP_TWO_STEP_PROCESSES.includes(process)) {
    const start = p.startedAt ? `${time(p.startedAt)} ${signedNum(p.startTemp)}` : '';
    if (!p.endedAt) return `${start} → in corso`;
    const mins = p.startedAt ? Math.round((new Date(p.endedAt).getTime() - new Date(p.startedAt).getTime()) / 60000) : null;
    return `${start} → ${dateTime(p.endedAt)} ${signedNum(p.endTemp)}${mins !== null ? ` (${formatHaccpDuration(mins)})` : ''}`;
  }
  if (process === 'SANIFICAZIONE') {
    return [p.sanitizer, p.concentration, typeof p.contactMinutes === 'number' ? `${p.contactMinutes} minuti` : ''].filter(Boolean).join(' · ');
  }
  if (process === 'CAMPIONE') {
    return [p.eventLabel, p.keepUntil ? `conservare fino a ${dateTime(p.keepUntil)}` : ''].filter(Boolean).join(' · ');
  }
  return `al cuore ${signedNum(p.endTemp)} alle ${time(p.endedAt)}`;
};

const productionTable = (rows: HaccpProductionLog[], multiDay: boolean): string => {
  const body = live(rows).map(p => {
    const process = (p.process ?? 'LEGACY') as HaccpProcess;
    const extra = [
      p.equipmentLabel,
      p.quantity,
      p.sourceLots ? `ingredienti ${p.sourceLots}` : '',
      p.expiryDate ? `scad. ${shortDate(p.expiryDate)}` : '',
    ].filter(Boolean).join(' · ');
    const outcome = p.compliant === true ? '<span class="badge ok">Conforme</span>'
      : p.compliant === false ? `<span class="badge alert">Fuori limite</span><div class="small">${escapeHtml(p.problem ?? '')}</div>`
        : '';
    return `
    <tr>
      ${multiDay ? `<td class="small">${shortDate(p.date)}</td>` : ''}
      <td class="small">${escapeHtml(HACCP_PROCESS_LABELS_IT[process])}</td>
      <td>${escapeHtml(p.product)}${p.internalLot ? ` <span class="small muted">lotto ${escapeHtml(p.internalLot)}</span>` : ''}${extra ? `<div class="small muted">${escapeHtml(extra)}</div>` : ''}</td>
      <td class="small">${escapeHtml(processDetail(p))}</td>
      <td>${outcome}</td>
      <td class="small muted">${escapeHtml(p.note ?? '')}</td>
      <td class="small muted">${escapeHtml(person(p.recordedByUserName))} ${time(p.recordedAt)}</td>
    </tr>`;
  }).join('');
  const cols = multiDay ? 7 : 6;
  return `<table><thead><tr>${multiDay ? '<th class="small">Giorno</th>' : ''}<th class="small">Processo</th><th>Prodotto</th><th class="small">Dettaglio</th><th>Esito</th><th class="small">Note</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(cols)}</tbody></table>`;
};

const CAL_METHODS: Record<string, string> = { GHIACCIO: 'ghiaccio fondente', EBOLLIZIONE: 'ebollizione', RIFERIMENTO: 'termometro di riferimento' };
const CAL_OUTCOMES: Record<string, string> = { OK: 'Nei limiti', CORRETTO: 'Ricalibrato', SOSTITUITO: 'Sostituito' };

const calibrationsTable = (rows: HaccpCalibration[]): string => {
  const body = live(rows).map(c => {
    const dev = haccpCalibrationDeviation(c.referenceTemp, c.measuredTemp);
    const over = dev > c.maxDeviation;
    return `
    <tr>
      <td class="small">${shortDate(c.date)}</td>
      <td>${escapeHtml(c.instrument)}</td>
      <td class="small">${escapeHtml(CAL_METHODS[c.method] ?? c.method)}</td>
      <td class="num small">${num(c.referenceTemp)} °C</td>
      <td class="num small">${num(c.measuredTemp)} °C</td>
      <td class="num small ${over ? 'alert' : ''}">${num(dev)} °C <span class="muted">(max ${num(c.maxDeviation)})</span></td>
      <td class="small">${escapeHtml(CAL_OUTCOMES[c.outcome] ?? c.outcome)}</td>
      <td class="small muted">${escapeHtml(person(c.recordedByUserName))}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th class="small">Giorno</th><th>Termometro</th><th class="small">Metodo</th><th class="small num">Riferimento</th><th class="small num">Letto</th><th class="small num">Scarto</th><th class="small">Esito</th><th class="small">Operatore</th></tr></thead><tbody>${body || emptyRow(8, 'Nessuna taratura nel periodo.')}</tbody></table>`;
};

/** I limiti con cui sono stati calcolati gli esiti: l'ispettore li confronta
 *  con il manuale del locale. */
const limitsTable = (l: HaccpLimits): string => {
  const receipt = HACCP_RECEIPT_CATEGORIES
    .filter(c => typeof l.receipt[c] === 'number')
    .map(c => `${HACCP_RECEIPT_CATEGORY_LABELS_IT[c].toLowerCase()} ≤ ${num(l.receipt[c])} °C`)
    .join(', ');
  const rows: Array<[string, string]> = [
    ['Abbattimento', `al cuore ≤ ${signedNum(l.blastChill.targetTemp)} entro ${formatHaccpDuration(l.blastChill.maxMinutes)}`],
    ['Surgelazione', `al cuore ≤ ${signedNum(l.deepFreeze.targetTemp)} entro ${formatHaccpDuration(l.deepFreeze.maxMinutes)}`],
    ['Bonifica anti-Anisakis', l.anisakis.map(r => `≤ ${signedNum(r.temp)} per ${r.hours} ore`).join(' oppure ')],
    ['Cottura / rinvenimento', `al cuore ≥ ${num(l.cooking.minCore)} °C / ≥ ${num(l.reheating.minCore)} °C`],
    ['Mantenimento a caldo', `≥ ${num(l.hotHolding.minTemp)} °C`],
    ['Scongelamento', `a fine ciclo ≤ ${signedNum(l.thawing.maxTemp)}`],
    ['Olio di frittura', `composti polari ≤ ${num(l.oil.maxPolar)}%, olio ≤ ${num(l.oil.maxTemp)} °C`],
    ['Ricevimento', receipt || '—'],
    ['Taratura termometri', `scarto ≤ ${num(l.calibration.maxDeviation)} °C`],
    ['Campione testimone', `conservato ${num(l.sample.keepHours)} ore`],
  ];
  return `<table><tbody>${rows.map(([k, v]) => `<tr><td style="width:45mm">${escapeHtml(k)}</td><td class="small">${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
};

const NC_STATUS: Record<HaccpNonConformity['status'], string> = { OPEN: 'Aperta', CLOSED: 'Chiusa', VOID: 'Annullata' };

const ncTable = (rows: HaccpNonConformity[]): string => {
  const body = rows.map(nc => `
    <tr class="${nc.status === 'VOID' ? 'voided' : ''}">
      <td class="small">${shortDate(nc.date)}</td>
      <td>${escapeHtml(nc.title)}${nc.detail ? `<div class="small muted">${escapeHtml(nc.detail)}</div>` : ''}</td>
      <td>${nc.status === 'CLOSED'
        ? escapeHtml(nc.correctiveAction ?? '')
        : nc.status === 'VOID'
          ? `<span class="muted">Annullata: ${escapeHtml(nc.voidReason ?? '')}</span>`
          : '<span class="badge alert">Azione da scrivere</span>'}</td>
      <td class="small muted">${escapeHtml(person(nc.openedByUserName))} ${dateTime(nc.openedAt)}</td>
      <td class="small muted">${nc.closedAt ? `${escapeHtml(person(nc.closedByUserName))} ${dateTime(nc.closedAt)}` : ''}</td>
      <td class="small">${NC_STATUS[nc.status]}</td>
    </tr>`).join('');
  return `<table><thead><tr><th class="small">Giorno</th><th>Non conformità</th><th>Azione correttiva</th><th class="small">Aperta da</th><th class="small">Chiusa da</th><th class="small">Stato</th></tr></thead><tbody>${body || emptyRow(6, 'Nessuna non conformità nel periodo.')}</tbody></table>`;
};

const showValue = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'sì' : 'no';
  if (typeof v === 'number') return num(v);
  return String(v);
};

const changeSubject = (c: HaccpChange): string => {
  const s = (c.before ?? c.after ?? {}) as Record<string, unknown>;
  const name = s.location ?? s.fryerLabel ?? s.point ?? s.product ?? s.instrument ?? '';
  const slot = typeof s.slot === 'number' && s.slot > 1 ? ` (${s.slot}ª)` : '';
  return `${ENTITY_LABELS[c.entity] ?? c.entity} · ${String(name)}${slot}`;
};

const changeDiff = (c: HaccpChange): string => {
  if (c.action === 'VOID') {
    const b = (c.before ?? {}) as Record<string, unknown>;
    const main = b.temperature !== undefined ? `${num(b.temperature as number)} °C` : b.action ? OIL_LABELS[b.action as HaccpOilAction] : b.product ?? '';
    return `annullata (era: ${escapeHtml(showValue(main))})`;
  }
  const b = (c.before ?? {}) as Record<string, unknown>;
  const a = (c.after ?? {}) as Record<string, unknown>;
  return Object.keys(FIELD_LABELS)
    .filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]) && (k in a || k in b))
    .map(k => `${FIELD_LABELS[k]}: <s>${escapeHtml(showValue(b[k]))}</s> → <b>${escapeHtml(showValue(a[k]))}</b>`)
    .join('<br>');
};

const changesTable = (rows: HaccpChange[]): string => {
  const body = rows.map(c => `
    <tr>
      <td class="small">${c.recordDate ? shortDate(c.recordDate) : ''}</td>
      <td>${escapeHtml(changeSubject(c))}</td>
      <td class="small">${changeDiff(c)}</td>
      <td class="small">${escapeHtml(c.reason ?? 'entro 15 minuti da chi l\'aveva scritta')}</td>
      <td class="small muted">${escapeHtml(person(c.userName))} ${dateTime(c.createdAt)}</td>
    </tr>`).join('');
  return `<table><thead><tr><th class="small">Giorno</th><th>Registrazione</th><th class="small">Cosa</th><th class="small">Motivo</th><th class="small">Chi e quando</th></tr></thead><tbody>${body || emptyRow(5, 'Nessuna correzione nel periodo.')}</tbody></table>`;
};

const backdatedTable = (data: HaccpReportData): string => {
  type Row = { date: string; recordedAt?: string; recordedByUserName?: string | null; what: string };
  const all: Row[] = [
    ...live(data.temperatures).map(r => ({ ...r, what: `Temperatura · ${r.location}${r.slot > 1 ? ` (${r.slot}ª)` : ''} · ${num(r.temperature)} °C` })),
    ...live(data.oil).map(r => ({ ...r, what: `Olio · ${r.fryerLabel} · ${OIL_LABELS[r.action]}` })),
    ...live(data.cleaning).filter(r => r.done).map((r: HaccpCleaningCheck) => ({ ...r, what: `Pulizia · ${r.point}` })),
    ...live(data.receipts).map(r => ({ ...r, what: `Ricevimento · ${r.product}` })),
    ...live(data.production).map(r => ({ ...r, what: `${HACCP_PROCESS_LABELS_IT[(r.process ?? 'LEGACY') as HaccpProcess]} · ${r.product}` })),
    ...live(data.calibrations ?? []).map(r => ({ ...r, what: `Taratura · ${r.instrument}` })),
  ].filter(r => writtenOther(r));
  if (all.length === 0) return '';
  all.sort((a, b) => a.date.localeCompare(b.date));
  const body = all.map(r => `<tr><td class="small">${shortDate(r.date)}</td><td>${escapeHtml(r.what)}</td><td class="small">${dateTime(r.recordedAt)}</td><td class="small muted">${escapeHtml(person(r.recordedByUserName))}</td></tr>`).join('');
  return `<section><h2>Registrazioni scritte in un giorno diverso</h2><table><thead><tr><th class="small">Giorno di registro</th><th>Registrazione</th><th class="small">Scritta il</th><th class="small">Da</th></tr></thead><tbody>${body}</tbody></table></section>`;
};

// =============================================================================
// Il foglio
// =============================================================================

/** L'HTML del foglio, separato dalla stampa: si può guardare senza aprire il
 *  dialogo di stampa del sistema. */
export const buildHaccpReportHtml = (data: HaccpReportData): string => {
  const singleDay = data.from === data.to;
  const days = haccpDaysBetween(data.from, data.to);
  const flags = new Set<string>();

  const temps = live(data.temperatures);
  const outCount = temps.filter(r => isOutOfRange(r.temperature, r.targetMin, r.targetMax)).length;
  const openNc = data.nonconformities.filter(n => n.status === 'OPEN').length;
  const closedNc = data.nonconformities.filter(n => n.status === 'CLOSED').length;

  const periodTitle = singleDay
    ? `Controlli del ${longDate(data.from)}`
    : `Dal ${longDate(data.from)} al ${longDate(data.to)}`;

  const temperatureSection = singleDay ? dayTemperatures(data) : temperatureGrid(data, days, flags);
  const oilSection = singleDay ? dayOil(data) : oilGrid(data, days);
  const cleaningSection = singleDay ? dayCleaning(data) : cleaningGrid(data, days);

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Registro HACCP — ${escapeHtml(singleDay ? shortDate(data.from) : `${shortDate(data.from)}–${shortDate(data.to)}`)}</title>
<style>
${PRINT_TOKENS_CSS}
  @page { size: A4 ${singleDay ? 'portrait' : 'landscape'}; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: var(--ds-print-ink);
    margin: 0;
    padding: 24px;
    background: #fff;
    line-height: 1.4;
    font-size: 11px;
  }
  header { border-bottom: 2px solid ${ACCENT}; padding-bottom: 10px; margin-bottom: 16px; }
  .eyebrow { color: ${ACCENT}; font-size: 12px; font-weight: 700; }
  h1 { margin: 2px 0 4px; font-size: 20px; }
  .restaurant { color: var(--ds-print-ink-secondary); font-size: 13px; }
  .summary { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .pill { padding: 2px 9px; background: var(--ds-print-fill); color: var(--ds-print-ink-secondary); border-radius: 999px; font-size: 10px; font-weight: 600; }
  .pill.alert { background: #fee2e2; color: #991b1b; }
  section { margin-top: 16px; }
  h2 { margin: 0 0 6px; font-size: 13px; font-weight: 700; border-left: 3px solid ${ACCENT}; padding-left: 8px; break-after: avoid; }
  h3 { margin: 10px 0 4px; font-size: 11px; font-weight: 600; color: var(--ds-print-ink-secondary); text-transform: capitalize; break-after: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--ds-print-rule); vertical-align: top; }
  th { background: var(--ds-print-fill); color: var(--ds-print-ink-secondary); font-size: 9px; font-weight: 600; border-bottom: 1px solid var(--ds-print-rule-strong); }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  td.num, th.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.num.ok { color: #047857; font-weight: 600; }
  td.alert, td.num.alert { color: #b91c1c; font-weight: 700; background: #fef2f2; }
  .small { font-size: 9px; }
  .muted { color: var(--ds-print-ink-muted); }
  td.empty { text-align: center; padding: 10px; color: var(--ds-print-ink-subtle); font-style: italic; }
  tr.voided td { color: var(--ds-print-ink-subtle); }
  .check.ok { color: #047857; font-weight: 700; font-size: 13px; }
  .badge { display: inline-block; padding: 1px 7px; background: #eef2ff; color: #4338ca; border-radius: 999px; font-size: 9px; font-weight: 600; }
  .badge.ok { background: #d1fae5; color: #065f46; }
  .badge.alert { background: #fee2e2; color: #991b1b; }
  /* Colonne del giorno a larghezza fissa: un mese intero sta in un A4
     orizzontale (34 + 31 × 7 mm), e un mese a metà non stira cinque giorni
     su tutta la pagina. */
  table.grid { table-layout: fixed; width: auto; }
  table.grid th, table.grid td { width: 7mm; padding: 2px 1px; text-align: center; border: 1px solid var(--ds-print-rule); }
  table.grid th.label-col, table.grid td.label-col { width: 34mm; text-align: left; padding: 2px 4px; }
  table.grid th.day { font-size: 8px; font-variant-numeric: tabular-nums; }
  table.grid th.sunday { background: #e2e8f0; }
  table.grid .wd { font-weight: 400; color: var(--ds-print-ink-muted); }
  table.grid td.cell { font-size: 8px; font-variant-numeric: tabular-nums; }
  table.grid td.cell.ok { color: #047857; font-weight: 700; }
  table.grid td.cell.strong { font-weight: 700; }
  .limit { font-size: 8px; color: var(--ds-print-ink-muted); }
  .polar { font-size: 7px; font-weight: 400; color: var(--ds-print-ink-muted); }
  .legend { margin: 4px 0 0; font-size: 9px; color: var(--ds-print-ink-muted); }
  sup { font-size: 7px; }
  .sign-grid { margin-top: 26px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; break-inside: avoid; }
  .sign-box { border-top: 1px solid var(--ds-print-ink-subtle); padding-top: 4px; font-size: 10px; color: var(--ds-print-ink-secondary); }
  footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid var(--ds-print-rule); color: var(--ds-print-ink-subtle); font-size: 9px; text-align: center; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <header>
    <div class="eyebrow">Registro HACCP</div>
    <h1>${escapeHtml(periodTitle)}</h1>
    ${data.restaurantName ? `<div class="restaurant">${escapeHtml(data.restaurantName)}</div>` : ''}
    <div class="summary">
      <span class="pill">Temperature: ${temps.length}</span>
      <span class="pill${outCount ? ' alert' : ''}">Fuori soglia: ${outCount}</span>
      <span class="pill">Ricevimenti: ${live(data.receipts).length}</span>
      <span class="pill">Processi: ${live(data.production).length}</span>
      <span class="pill${openNc ? ' alert' : ''}">Non conformità: ${closedNc} chiuse${openNc ? `, ${openNc} aperte` : ''}</span>
      <span class="pill">Correzioni e annullamenti: ${data.changes.length}</span>
    </div>
  </header>

  <section>
    <h2>Temperature</h2>
    ${temperatureSection}
    ${!singleDay ? `<p class="legend">Valori in °C. In rosso i fuori soglia. ${flags.has('temperature') ? '* corretta dopo la prima scrittura o scritta in un altro giorno: vedi le liste in fondo.' : ''}</p>` : '<p class="legend"><sup>c</sup> corretta dopo la prima scrittura: vedi le correzioni in fondo.</p>'}
  </section>

  <section>
    <h2>Friggitrici — controllo olio</h2>
    ${oilSection}
  </section>

  <section>
    <h2>Pulizie</h2>
    ${cleaningSection}
  </section>

  <section>
    <h2>Ricevimento merci</h2>
    ${receiptsTable(data.receipts, !singleDay)}
  </section>

  <section>
    <h2>Processi: abbattimento, cottura, bonifica, scongelamento</h2>
    ${productionTable(data.production, !singleDay)}
  </section>

  ${data.calibrations && data.calibrations.length > 0 ? `<section>
    <h2>Taratura termometri</h2>
    ${calibrationsTable(data.calibrations)}
  </section>` : ''}

  <section>
    <h2>Non conformità e azioni correttive</h2>
    ${ncTable(data.nonconformities)}
  </section>

  <section>
    <h2>Correzioni e annullamenti</h2>
    ${changesTable(data.changes)}
  </section>

  ${backdatedTable(data)}

  ${data.limits ? `<section>
    <h2>Limiti applicati</h2>
    ${limitsTable(data.limits)}
  </section>` : ''}

  <div class="sign-grid">
    <div class="sign-box">Responsabile HACCP</div>
    <div class="sign-box">Data e firma</div>
  </div>

  <footer>Generato il ${escapeHtml(new Date(data.generatedAt).toLocaleString('it-IT'))} · ${days.length} ${days.length === 1 ? 'giorno' : 'giorni'}</footer>
</body>
</html>`;
  return html;
};

export const printHaccpReport = (data: HaccpReportData): void => {
  printHtmlDocument(buildHaccpReportHtml(data), { popupMessage: 'Sblocca i popup per stampare il registro.' });
};
