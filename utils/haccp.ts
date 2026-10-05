/* Regole del registro HACCP che servono a tutt'e due i lati.
 *
 * Vive in utils/ perché la leggono sia il frontend (il modulo del giorno, il
 * report) sia il server (avviso fuori soglia, promemoria, non conformità).
 * Due copie della regola «fuori soglia» divergerebbero al primo ritocco, e il
 * modulo direbbe verde una lettura per cui il server apre una non conformità.
 *
 * Le postazioni NON stanno più qui: sono dati del singolo ristorante
 * (haccp_points, migration haccp-fondamenta). Erano la cucina del Vecchio
 * Frantoio scritta nel codice, e ogni ristorante nuovo se la ritrovava. */

export type HaccpRegister = 'TEMPERATURE' | 'OIL' | 'CLEANING' | 'THERMOMETER' | 'EQUIPMENT';
export type HaccpFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ON_DEMAND';

/** I registri a punti che la Fase 1 sa configurare e compilare. */
export const HACCP_POINT_REGISTERS: HaccpRegister[] = ['TEMPERATURE', 'OIL', 'CLEANING'];
export const HACCP_FREQUENCIES: HaccpFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND'];

export interface HaccpPoint {
  id: number;
  register: HaccpRegister;
  label: string;
  minTemp: number | null;
  maxTemp: number | null;
  checksPerDay: number;
  frequency: HaccpFrequency;
  instructions: string | null;
  sortOrder: number;
  active: boolean;
}

/** Entro quanti minuti chi ha scritto una registrazione la corregge senza
 *  motivarlo. È il refuso mentre si compila (il modulo salva a ogni uscita dal
 *  campo): dopo, o sulla riga di un altro, la correzione chiede il perché. */
export const HACCP_CORRECTION_GRACE_MINUTES = 15;

/** Fuori soglia: sopra il massimo o sotto il minimo. Un limite assente non
 *  vincola — una cella frigo ha solo il massimo, un banco caldo solo il
 *  minimo. */
export const isOutOfRange = (value: number, min: number | null, max: number | null): boolean =>
  (typeof max === 'number' && value > max) || (typeof min === 'number' && value < min);

const formatDegrees = (n: number): string => String(Math.round(n * 10) / 10).replace('.', ',');

/** «≤ 4 °C», «≥ 65 °C», «0 / 4 °C». Stringa vuota se il punto non ha limiti. */
export const formatHaccpLimit = (min: number | null, max: number | null): string => {
  const hasMin = typeof min === 'number';
  const hasMax = typeof max === 'number';
  if (hasMin && hasMax) return `${formatDegrees(min as number)} / ${formatDegrees(max as number)} °C`;
  if (hasMax) return `≤ ${formatDegrees(max as number)} °C`;
  if (hasMin) return `≥ ${formatDegrees(min as number)} °C`;
  return '';
};

export const formatHaccpTemperature = (n: number): string => `${formatDegrees(n)} °C`;

/** Il tag della push «fuori soglia» di una postazione in un giorno (e in una
 *  rilevazione, dalla seconda in poi). Senza spazi: finisce nell'URL (?ntag=)
 *  quando si tocca la notifica. */
export const haccpTemperatureTag = (date: string, location: string, slot = 1): string =>
  `haccp-temp-${date}-${location.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${slot > 1 ? `-s${slot}` : ''}`;

/** Il tag della push «rilevazioni mancanti» di un giorno. */
export const haccpMissingTag = (date: string): string => `haccp-missing-${date}`;

// ---- Date di registro --------------------------------------------------------
// Tutto in giorni ISO (YYYY-MM-DD) e aritmetica in UTC: il giorno di registro
// è già il giorno del ristorante, e passare da Date locali lo sposterebbe di
// uno al cambio dell'ora.

const isoToUtc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const utcToIso = (d: Date): string => d.toISOString().slice(0, 10);

export const addDaysToIso = (iso: string, days: number): string => {
  const d = isoToUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToIso(d);
};

/** Il periodo a cui appartiene un giorno per una frequenza: la settimana va
 *  da lunedì a domenica, il mese dal primo all'ultimo. Una pulizia
 *  settimanale fatta mercoledì copre tutta la sua settimana. */
export const haccpPeriodRange = (frequency: HaccpFrequency, date: string): { from: string; to: string } => {
  if (frequency === 'WEEKLY') {
    const dow = isoToUtc(date).getUTCDay(); // 0 = domenica
    const back = (dow + 6) % 7;
    const from = addDaysToIso(date, -back);
    return { from, to: addDaysToIso(from, 6) };
  }
  if (frequency === 'MONTHLY') {
    const from = `${date.slice(0, 7)}-01`;
    const d = isoToUtc(from);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return { from, to: utcToIso(d) };
  }
  return { from: date, to: date };
};

/** I giorni da `from` a `to` compresi. */
export const haccpDaysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysToIso(d, 1)) out.push(d);
  return out;
};
