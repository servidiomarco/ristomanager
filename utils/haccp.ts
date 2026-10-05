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
export type HaccpFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL' | 'ON_DEMAND';

/** I registri a punti che si configurano e si compilano. EQUIPMENT sono le
 *  attrezzature dei processi (abbattitori, forni): non si compilano da sole,
 *  si scelgono nel processo. */
export const HACCP_POINT_REGISTERS: HaccpRegister[] = ['TEMPERATURE', 'OIL', 'CLEANING', 'THERMOMETER', 'EQUIPMENT'];
export const HACCP_FREQUENCIES: HaccpFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ON_DEMAND'];
/** Le frequenze che un registro a periodi ammette. */
export const HACCP_REGISTER_FREQUENCIES: Partial<Record<HaccpRegister, HaccpFrequency[]>> = {
  CLEANING: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ON_DEMAND'],
  THERMOMETER: ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'],
};

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
  // Mese, trimestre, semestre e anno solari: la taratura «semestrale» fatta a
  // marzo copre gennaio–giugno, come la intende il manuale.
  const months = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : frequency === 'SEMIANNUAL' ? 6 : frequency === 'ANNUAL' ? 12 : 0;
  if (months > 0) {
    const year = Number(date.slice(0, 4));
    const month0 = Number(date.slice(5, 7)) - 1;
    const startMonth0 = Math.floor(month0 / months) * months;
    const from = utcToIso(new Date(Date.UTC(year, startMonth0, 1)));
    const to = utcToIso(new Date(Date.UTC(year, startMonth0 + months, 0)));
    return { from, to };
  }
  return { from: date, to: date };
};

/** I giorni da `from` a `to` compresi. */
export const haccpDaysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysToIso(d, 1)) out.push(d);
  return out;
};

// =============================================================================
// Limiti del locale (Fase 2)
// =============================================================================
// I valori di riferimento dei manuali correnti. Il limite che conta è quello
// del manuale del locale: si cambiano in HACCP → Configura (haccp_settings),
// e una chiave assente vale il riferimento — un ristorante nuovo parte coperto.

export type HaccpProcess =
  | 'LEGACY' | 'ABBATTIMENTO' | 'SURGELAZIONE' | 'ANISAKIS' | 'COTTURA' | 'RINVENIMENTO'
  | 'MANTENIMENTO_CALDO' | 'SCONGELAMENTO' | 'SANIFICAZIONE' | 'CAMPIONE';

/** I processi che si registrano oggi (LEGACY è il vecchio «range/durata»). */
export const HACCP_PROCESSES: Exclude<HaccpProcess, 'LEGACY'>[] = [
  'ABBATTIMENTO', 'SURGELAZIONE', 'ANISAKIS', 'COTTURA', 'RINVENIMENTO',
  'MANTENIMENTO_CALDO', 'SCONGELAMENTO', 'SANIFICAZIONE', 'CAMPIONE',
];

/** I nomi dei processi sul foglio e nelle non conformità (il foglio è in
 *  italiano: è un documento per l'ASL). */
export const HACCP_PROCESS_LABELS_IT: Record<HaccpProcess, string> = {
  LEGACY: 'Abbattimento',
  ABBATTIMENTO: 'Abbattimento',
  SURGELAZIONE: 'Surgelazione',
  ANISAKIS: 'Bonifica anti-Anisakis',
  COTTURA: 'Cottura',
  RINVENIMENTO: 'Rinvenimento',
  MANTENIMENTO_CALDO: 'Mantenimento a caldo',
  SCONGELAMENTO: 'Scongelamento',
  SANIFICAZIONE: 'Sanificazione verdure',
  CAMPIONE: 'Campione testimone',
};

export const HACCP_RECEIPT_CATEGORY_LABELS_IT: Record<string, string> = {
  REFRIGERATO: 'Refrigerato',
  CARNE: 'Carne',
  POLLAME: 'Pollame',
  PESCE: 'Pesce',
  LATTICINI: 'Latticini',
  SURGELATO: 'Surgelato',
  ORTOFRUTTA: 'Ortofrutta',
  SECCO: 'Secco',
  ALTRO: 'Altro',
};

/** Processi a due tempi: si avviano e si chiudono, anche a ore di distanza. */
export const HACCP_TWO_STEP_PROCESSES: HaccpProcess[] = ['ABBATTIMENTO', 'SURGELAZIONE', 'ANISAKIS', 'SCONGELAMENTO'];

export type HaccpReceiptCategory =
  | 'REFRIGERATO' | 'CARNE' | 'POLLAME' | 'PESCE' | 'LATTICINI' | 'SURGELATO' | 'ORTOFRUTTA' | 'SECCO' | 'ALTRO';
export const HACCP_RECEIPT_CATEGORIES: HaccpReceiptCategory[] = [
  'REFRIGERATO', 'CARNE', 'POLLAME', 'PESCE', 'LATTICINI', 'SURGELATO', 'ORTOFRUTTA', 'SECCO', 'ALTRO',
];

export interface HaccpLimits {
  /** Abbattimento positivo: al cuore ≤ targetTemp entro maxMinutes. */
  blastChill: { targetTemp: number; maxMinutes: number };
  /** Abbattimento negativo (surgelazione): al cuore ≤ targetTemp entro maxMinutes. */
  deepFreeze: { targetTemp: number; maxMinutes: number };
  /** Bonifica anti-Anisakis (Reg. CE 853/2004, All. III, Sez. VIII): basta
   *  una delle combinazioni — ≤ temp in ogni parte per almeno hours. */
  anisakis: Array<{ temp: number; hours: number }>;
  cooking: { minCore: number };
  reheating: { minCore: number };
  hotHolding: { minTemp: number };
  /** Scongelamento in frigo: a fine ciclo il prodotto non supera maxTemp. */
  thawing: { maxTemp: number };
  /** Olio di frittura: composti polari (Circ. Min. Sanità 1/1991) e
   *  temperatura (acrilammide, Reg. UE 2017/2158). */
  oil: { maxPolar: number; maxTemp: number };
  /** Ricevimento: temperatura massima per tipo di merce (null = nessuna). */
  receipt: Record<HaccpReceiptCategory, number | null>;
  calibration: { maxDeviation: number };
  /** Campione testimone: quante ore si conserva. */
  sample: { keepHours: number };
  /** Sensori: in quali fasce orarie compilano le rilevazioni del giorno
   *  (una per rilevazione prevista dalla postazione), dopo quanti minuti
   *  fuori soglia aprono una non conformità, dopo quanti di silenzio
   *  avvisano. */
  sensors: { slotTimes: string[]; outMinutes: number; offlineMinutes: number };
}

export const HACCP_DEFAULT_LIMITS: HaccpLimits = {
  blastChill: { targetTemp: 3, maxMinutes: 90 },
  deepFreeze: { targetTemp: -18, maxMinutes: 240 },
  anisakis: [{ temp: -20, hours: 24 }, { temp: -35, hours: 15 }],
  cooking: { minCore: 75 },
  reheating: { minCore: 75 },
  hotHolding: { minTemp: 65 },
  thawing: { maxTemp: 4 },
  oil: { maxPolar: 25, maxTemp: 175 },
  receipt: {
    REFRIGERATO: 4, CARNE: 7, POLLAME: 4, PESCE: 2, LATTICINI: 4, SURGELATO: -15,
    ORTOFRUTTA: null, SECCO: null, ALTRO: null,
  },
  calibration: { maxDeviation: 1 },
  sample: { keepHours: 72 },
  sensors: { slotTimes: ['09:00', '16:00', '21:00'], outMinutes: 30, offlineMinutes: 60 },
};

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown, fallback: number | null): number | null =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** I limiti effettivi: quelli salvati sopra i riferimenti, chiave per
 *  chiave. Un valore non numerico (un JSON scritto a mano, una versione
 *  vecchia) torna al riferimento invece di rompere il calcolo. */
export const mergeHaccpLimits = (stored: unknown): HaccpLimits => {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  const d = HACCP_DEFAULT_LIMITS;
  const anisakis = Array.isArray(s.anisakis)
    ? s.anisakis
      .map((r: any) => ({ temp: num(r?.temp, NaN), hours: num(r?.hours, NaN) }))
      .filter((r: { temp: number; hours: number }) => Number.isFinite(r.temp) && Number.isFinite(r.hours) && r.hours > 0)
    : [];
  const receipt = { ...d.receipt };
  for (const c of HACCP_RECEIPT_CATEGORIES) {
    if (s.receipt && c in s.receipt) receipt[c] = numOrNull(s.receipt[c], d.receipt[c]);
  }
  return {
    blastChill: { targetTemp: num(s.blastChill?.targetTemp, d.blastChill.targetTemp), maxMinutes: num(s.blastChill?.maxMinutes, d.blastChill.maxMinutes) },
    deepFreeze: { targetTemp: num(s.deepFreeze?.targetTemp, d.deepFreeze.targetTemp), maxMinutes: num(s.deepFreeze?.maxMinutes, d.deepFreeze.maxMinutes) },
    anisakis: anisakis.length > 0 ? anisakis : d.anisakis,
    cooking: { minCore: num(s.cooking?.minCore, d.cooking.minCore) },
    reheating: { minCore: num(s.reheating?.minCore, d.reheating.minCore) },
    hotHolding: { minTemp: num(s.hotHolding?.minTemp, d.hotHolding.minTemp) },
    thawing: { maxTemp: num(s.thawing?.maxTemp, d.thawing.maxTemp) },
    oil: { maxPolar: num(s.oil?.maxPolar, d.oil.maxPolar), maxTemp: num(s.oil?.maxTemp, d.oil.maxTemp) },
    receipt,
    calibration: { maxDeviation: num(s.calibration?.maxDeviation, d.calibration.maxDeviation) },
    sample: { keepHours: num(s.sample?.keepHours, d.sample.keepHours) },
    sensors: {
      slotTimes: d.sensors.slotTimes.map((def, i) => {
        const v = Array.isArray(s.sensors?.slotTimes) ? s.sensors.slotTimes[i] : undefined;
        return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : def;
      }),
      outMinutes: num(s.sensors?.outMinutes, d.sensors.outMinutes),
      offlineMinutes: num(s.sensors?.offlineMinutes, d.sensors.offlineMinutes),
    },
  };
};

// ---- Esiti --------------------------------------------------------------------

const deg = (n: number): string => `${formatDegrees(n)} °C`;
const signedDeg = (n: number): string => `${n > 0 ? '+' : ''}${formatDegrees(n)} °C`;
const minutesBetween = (from: string | null | undefined, to: string | null | undefined): number | null => {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
};
export const formatHaccpDuration = (minutes: number): string => {
  if (minutes < 120) return `${minutes} minuti`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} ore`;
};

export interface HaccpProcessInput {
  process: HaccpProcess;
  startedAt?: string | null;
  startTemp?: number | null;
  endedAt?: string | null;
  endTemp?: number | null;
}

/** L'esito di un processo sui limiti del locale. compliant null = non
 *  valutabile (ciclo in corso, processo senza soglia, vecchio registro). Il
 *  problema è scritto per il foglio dell'ispettore: cosa è successo e il
 *  limite che non è stato rispettato. */
export const evaluateHaccpProcess = (p: HaccpProcessInput, limits: HaccpLimits): { compliant: boolean | null; problem: string | null } => {
  const end = typeof p.endTemp === 'number' ? p.endTemp : null;
  const start = typeof p.startTemp === 'number' ? p.startTemp : null;
  const minutes = minutesBetween(p.startedAt, p.endedAt);
  switch (p.process) {
    case 'ABBATTIMENTO':
    case 'SURGELAZIONE': {
      if (end === null || !p.endedAt) return { compliant: null, problem: null };
      const l = p.process === 'ABBATTIMENTO' ? limits.blastChill : limits.deepFreeze;
      const tempOk = end <= l.targetTemp;
      const timeOk = minutes === null || minutes <= l.maxMinutes;
      if (tempOk && timeOk) return { compliant: true, problem: null };
      const when = minutes !== null ? ` dopo ${formatHaccpDuration(minutes)}` : '';
      return {
        compliant: false,
        problem: `al cuore ${signedDeg(end)}${when} (limite ${signedDeg(l.targetTemp)} entro ${formatHaccpDuration(l.maxMinutes)})`,
      };
    }
    case 'ANISAKIS': {
      if (end === null || !p.endedAt || minutes === null) return { compliant: null, problem: null };
      const warmest = start === null ? end : Math.max(start, end);
      const hours = minutes / 60;
      const ok = limits.anisakis.some(r => warmest <= r.temp && hours >= r.hours);
      if (ok) return { compliant: true, problem: null };
      const rules = limits.anisakis.map(r => `${signedDeg(r.temp)} per ${r.hours} ore`).join(' o ');
      return { compliant: false, problem: `${signedDeg(warmest)} per ${formatHaccpDuration(minutes)} (serve ${rules})` };
    }
    case 'COTTURA':
    case 'RINVENIMENTO': {
      if (end === null) return { compliant: null, problem: null };
      const min = p.process === 'COTTURA' ? limits.cooking.minCore : limits.reheating.minCore;
      return end >= min
        ? { compliant: true, problem: null }
        : { compliant: false, problem: `al cuore ${deg(end)} (minimo ${deg(min)})` };
    }
    case 'MANTENIMENTO_CALDO': {
      if (end === null) return { compliant: null, problem: null };
      return end >= limits.hotHolding.minTemp
        ? { compliant: true, problem: null }
        : { compliant: false, problem: `${deg(end)} (minimo ${deg(limits.hotHolding.minTemp)})` };
    }
    case 'SCONGELAMENTO': {
      if (end === null || !p.endedAt) return { compliant: null, problem: null };
      return end <= limits.thawing.maxTemp
        ? { compliant: true, problem: null }
        : { compliant: false, problem: `${signedDeg(end)} a fine scongelamento (massimo ${signedDeg(limits.thawing.maxTemp)})` };
    }
    default:
      return { compliant: null, problem: null };
  }
};

/** I problemi di un controllo dell'olio. Oltre il limite di composti polari
 *  l'olio va cambiato: se è stato sostituito, la misura era quella dell'olio
 *  tolto e non c'è niente da rimediare. */
export const evaluateHaccpOil = (
  o: { action: string; polarCompounds?: number | null; oilTemp?: number | null },
  limits: HaccpLimits,
): string[] => {
  const problems: string[] = [];
  if (typeof o.polarCompounds === 'number' && o.polarCompounds > limits.oil.maxPolar && o.action !== 'SOSTITUITO') {
    problems.push(`composti polari ${formatDegrees(o.polarCompounds)}% (limite ${formatDegrees(limits.oil.maxPolar)}%)`);
  }
  if (typeof o.oilTemp === 'number' && o.oilTemp > limits.oil.maxTemp) {
    problems.push(`olio a ${deg(o.oilTemp)} (massimo ${deg(limits.oil.maxTemp)})`);
  }
  return problems;
};

/** I problemi di un ricevimento: fuori temperatura per il tipo di merce,
 *  scaduto, imballo non integro. */
export const evaluateHaccpReceipt = (
  r: { date: string; category?: HaccpReceiptCategory | null; temperature?: number | null; expiryDate?: string | null; packagingOk?: boolean | null },
  limits: HaccpLimits,
): string[] => {
  const problems: string[] = [];
  const max = r.category ? limits.receipt[r.category] : null;
  if (typeof max === 'number' && typeof r.temperature === 'number' && r.temperature > max) {
    problems.push(`arrivata a ${signedDeg(r.temperature)} (massimo ${signedDeg(max)})`);
  }
  if (r.expiryDate && r.expiryDate < r.date) problems.push('scaduta');
  if (r.packagingOk === false) problems.push('imballo non integro');
  return problems;
};

export const haccpCalibrationDeviation = (reference: number, measured: number): number =>
  Math.round(Math.abs(measured - reference) * 10) / 10;

// =============================================================================
// Persone, documenti, interventi (Fase 3)
// =============================================================================

export type HaccpInterventionType =
  | 'DISINFESTAZIONE' | 'RITIRO_OLIO' | 'MANUTENZIONE' | 'ANALISI_ACQUA' | 'ANALISI_LAB' | 'TARATURA' | 'SANIFICAZIONE' | 'ALTRO';
export const HACCP_INTERVENTION_TYPES: HaccpInterventionType[] = [
  'DISINFESTAZIONE', 'RITIRO_OLIO', 'MANUTENZIONE', 'ANALISI_ACQUA', 'ANALISI_LAB', 'TARATURA', 'SANIFICAZIONE', 'ALTRO',
];
export const HACCP_INTERVENTION_LABELS_IT: Record<HaccpInterventionType, string> = {
  DISINFESTAZIONE: 'Disinfestazione',
  RITIRO_OLIO: 'Ritiro olio esausto',
  MANUTENZIONE: 'Manutenzione',
  ANALISI_ACQUA: 'Analisi dell\'acqua',
  ANALISI_LAB: 'Analisi di laboratorio',
  TARATURA: 'Taratura esterna',
  SANIFICAZIONE: 'Sanificazione straordinaria',
  ALTRO: 'Altro intervento',
};

export type HaccpTrainingCourse = 'ALIMENTARISTA' | 'RESPONSABILE' | 'ALLERGENI' | 'CELIACHIA' | 'AGGIORNAMENTO' | 'ALTRO';
export const HACCP_TRAINING_COURSES: HaccpTrainingCourse[] = ['ALIMENTARISTA', 'RESPONSABILE', 'ALLERGENI', 'CELIACHIA', 'AGGIORNAMENTO', 'ALTRO'];
export const HACCP_TRAINING_LABELS_IT: Record<HaccpTrainingCourse, string> = {
  ALIMENTARISTA: 'Alimentarista (ex libretto sanitario)',
  RESPONSABILE: 'Responsabile HACCP',
  ALLERGENI: 'Allergeni',
  CELIACHIA: 'Senza glutine / celiachia',
  AGGIORNAMENTO: 'Aggiornamento',
  ALTRO: 'Altro corso',
};

export type HaccpDocumentCategory =
  | 'MANUALE' | 'REGISTRAZIONE' | 'SCHEDA_TECNICA' | 'SCHEDA_SICUREZZA' | 'CONTRATTO'
  | 'ANALISI' | 'PLANIMETRIA' | 'ATTESTATO' | 'RAPPORTO' | 'DICHIARAZIONE' | 'ALTRO';
export const HACCP_DOCUMENT_CATEGORIES: HaccpDocumentCategory[] = [
  'MANUALE', 'REGISTRAZIONE', 'SCHEDA_TECNICA', 'SCHEDA_SICUREZZA', 'CONTRATTO',
  'ANALISI', 'PLANIMETRIA', 'ATTESTATO', 'RAPPORTO', 'DICHIARAZIONE', 'ALTRO',
];
export const HACCP_DOCUMENT_LABELS_IT: Record<HaccpDocumentCategory, string> = {
  MANUALE: 'Manuale di autocontrollo',
  REGISTRAZIONE: 'Registrazione sanitaria (SCIA)',
  SCHEDA_TECNICA: 'Scheda tecnica',
  SCHEDA_SICUREZZA: 'Scheda di sicurezza',
  CONTRATTO: 'Contratto',
  ANALISI: 'Analisi',
  PLANIMETRIA: 'Planimetria',
  ATTESTATO: 'Attestato',
  RAPPORTO: 'Rapporto di intervento',
  DICHIARAZIONE: 'Dichiarazione di conformità',
  ALTRO: 'Altro documento',
};

/** I 14 allergeni del Reg. UE 1169/2011 (All. II), con gli stessi nomi che il
 *  menu salva sui piatti (COMMON_ALLERGENS in types.ts): il libro allergeni
 *  incrocia per nome. */
export const HACCP_EU_ALLERGENS = [
  'Glutine', 'Crostacei', 'Uova', 'Pesce', 'Arachidi', 'Soia', 'Latte',
  'Frutta a guscio', 'Sedano', 'Senape', 'Sesamo', 'Solfiti', 'Lupini', 'Molluschi',
];

export interface HaccpDeadline {
  kind: 'training' | 'document' | 'intervention';
  id: string;
  title: string;
  due: string;
  status: 'expired' | 'soon';
}

// =============================================================================
// Etichette (Fase 4)
// =============================================================================

export type HaccpLabelKind = 'PRODUZIONE' | 'APERTURA' | 'SCONGELAMENTO';
export const HACCP_LABEL_KINDS: HaccpLabelKind[] = ['PRODUZIONE', 'APERTURA', 'SCONGELAMENTO'];
/** Come l'etichetta dice la data di partenza: «Prodotto il», «Aperto il». */
export const HACCP_LABEL_KIND_LABELS_IT: Record<HaccpLabelKind, string> = {
  PRODUZIONE: 'Prodotto il',
  APERTURA: 'Aperto il',
  SCONGELAMENTO: 'Scongelato il',
};
