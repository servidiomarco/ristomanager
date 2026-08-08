import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Thermometer, Flame, Sparkles, Truck, Snowflake, Printer, CalendarDays,
  Check, X, Plus, Trash2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import {
  haccpApiService,
  HACCP_TEMPERATURE_LOCATIONS,
  HACCP_FRYERS,
  HACCP_CLEANING_POINTS,
  HACCP_OIL_ACTIONS,
  HACCP_BLAST_TEMP_RANGES,
  HACCP_BLAST_DURATIONS,
  HACCP_RECEIPT_PRODUCT_HINTS,
  HACCP_PRODUCTION_PRODUCT_HINTS,
  HaccpTemperatureReading,
  HaccpOilCheck,
  HaccpOilAction,
  HaccpCleaningCheck,
  HaccpGoodsReceipt,
  HaccpProductionLog,
} from '../services/haccpApiService';
import { printHaccpReport } from '../utils/printHaccpReport';
import { SkeletonHaccpSections } from './SkeletonCards';
import { Callout, SegmentedControl, StatusPill, dsButton, dsIconButton, dsSelect } from './ds';

const todayISO = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const parseNumber = (s: string): number | null => {
  const cleaned = s.trim().replace(',', '.');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
};

const formatNumber = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '';
  return String(n).replace('.', ',');
};

/* ── Vestizione ───────────────────────────────────────────────────────────
   Le classi condivise stanno qui in cima invece che ripetute riga per riga:
   questa pagina è cinque tabelle che chiedono la stessa cosa — un campo
   piccolo accanto a un'etichetta — e finché erano stringhe copiate le cinque
   sezioni divergevano a ogni ritocco.

   h-11, non h-9: il registro si compila col telefono in mano davanti alla
   cella frigo, e 44px è il minimo tattile del design system. */
const field =
  'h-11 w-full rounded-full bg-[var(--ds-surface-row)] px-4 text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/** Etichetta di un campo nei form di coda. Minuscolo: le maiuscole a 13px
 *  perdono la forma della parola e gli screen reader le compitano. */
const fieldLabel = 'mb-1.5 block text-[13px] text-[var(--ds-text-muted)]';

/** Firma di chi ha compilato la riga e quando. */
const stamp = 'col-span-12 -mt-0.5 text-[12px] tabular-nums text-[var(--ds-text-subtle)]';

const recordedLabel = (recordedBy: string, recordedAt: string): string =>
  `${recordedBy.split('@')[0]} · ${new Date(recordedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;

// Intestazione in cima a ogni card: icona in pastiglia, titolo, e a destra il
// contatore di completamento come pill invece che come testo sciolto.
interface CardHeaderProps {
  title: string;
  icon: React.ReactNode;
  status?: string;
}
const CardHeader: React.FC<CardHeaderProps> = ({ title, icon, status }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
        {icon}
      </span>
      <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{title}</h2>
    </div>
    {status && <StatusPill className="tabular-nums">{status}</StatusPill>}
  </div>
);

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
    {children}
  </section>
);

// Righe separate da un filetto sul token di bordo, non dalla riga legacy.
const rowList = 'divide-y divide-[var(--ds-border)]';
const row = 'grid grid-cols-12 items-center gap-2 py-2.5 sm:gap-3';

const emptyNote = 'py-6 text-center text-[14px] text-[var(--ds-text-muted)]';

const deleteButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

// =============================================================================
// HaccpPage
// =============================================================================

export const HaccpPage: React.FC = () => {
  const [date, setDate] = useState<string>(todayISO());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [temperatures, setTemperatures] = useState<HaccpTemperatureReading[]>([]);
  const [oil, setOil] = useState<HaccpOilCheck[]>([]);
  const [cleaning, setCleaning] = useState<HaccpCleaningCheck[]>([]);
  const [receipts, setReceipts] = useState<HaccpGoodsReceipt[]>([]);
  const [production, setProduction] = useState<HaccpProductionLog[]>([]);

  // Reload all five datasets when the date changes.
  const reload = useCallback(async (dateToLoad: string) => {
    setLoading(true);
    setError(null);
    try {
      const [t, o, c, r, p] = await Promise.all([
        haccpApiService.getTemperatures(dateToLoad),
        haccpApiService.getOilChecks(dateToLoad),
        haccpApiService.getCleaningChecks(dateToLoad),
        haccpApiService.getReceipts(dateToLoad),
        haccpApiService.getProductionLogs(dateToLoad),
      ]);
      setTemperatures(t);
      setOil(o);
      setCleaning(c);
      setReceipts(r);
      setProduction(p);
    } catch (e: any) {
      setError(e?.message || 'Errore nel caricamento');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(date); }, [date, reload]);

  // ---- Temperatures ---------------------------------------------------------
  const tempByLocation = useMemo(() => {
    const map = new Map<string, HaccpTemperatureReading>();
    temperatures.forEach(t => map.set(t.location, t));
    return map;
  }, [temperatures]);

  const tempCompleted = HACCP_TEMPERATURE_LOCATIONS.filter(loc =>
    tempByLocation.has(loc.location),
  ).length;

  const saveTemperature = async (location: string, targetMax: number, raw: string, note: string) => {
    const temperature = parseNumber(raw);
    if (temperature === null) return;
    try {
      const saved = await haccpApiService.upsertTemperature({
        date, location, temperature, targetMax, note: note || null,
      });
      setTemperatures(prev => {
        const others = prev.filter(t => t.location !== location);
        return [...others, saved].sort((a, b) => a.location.localeCompare(b.location));
      });
    } catch (e: any) {
      setError(e?.message || 'Errore nel salvataggio temperatura');
    }
  };

  // ---- Oil ------------------------------------------------------------------
  const oilByFryer = useMemo(() => {
    const map = new Map<string, HaccpOilCheck>();
    oil.forEach(o => map.set(o.fryerLabel, o));
    return map;
  }, [oil]);

  const oilCompleted = HACCP_FRYERS.filter(f => oilByFryer.has(f)).length;

  const saveOil = async (fryerLabel: string, action: HaccpOilAction, note: string) => {
    try {
      const saved = await haccpApiService.upsertOilCheck({
        date, fryerLabel, action, note: note || null,
      });
      setOil(prev => {
        const others = prev.filter(o => o.fryerLabel !== fryerLabel);
        return [...others, saved].sort((a, b) => a.fryerLabel.localeCompare(b.fryerLabel));
      });
    } catch (e: any) {
      setError(e?.message || 'Errore nel salvataggio friggitrice');
    }
  };

  // ---- Cleaning -------------------------------------------------------------
  const cleaningByPoint = useMemo(() => {
    const map = new Map<string, HaccpCleaningCheck>();
    cleaning.forEach(c => map.set(c.point, c));
    return map;
  }, [cleaning]);

  const cleaningCompleted = HACCP_CLEANING_POINTS.filter(p => {
    const r = cleaningByPoint.get(p);
    return r && r.done;
  }).length;

  const saveCleaning = async (point: string, done: boolean, note: string) => {
    try {
      const saved = await haccpApiService.upsertCleaningCheck({
        date, point, done, note: note || null,
      });
      setCleaning(prev => {
        const others = prev.filter(c => c.point !== point);
        return [...others, saved].sort((a, b) => a.point.localeCompare(b.point));
      });
    } catch (e: any) {
      setError(e?.message || 'Errore nel salvataggio pulizia');
    }
  };

  // ---- Receipts (ad-hoc) ----------------------------------------------------
  const addReceipt = async (input: {
    product: string; lotNumber: string; temperature: string; accepted: boolean; note: string;
  }) => {
    const product = input.product.trim();
    if (!product) return;
    try {
      const saved = await haccpApiService.createReceipt({
        date,
        product,
        lotNumber: input.lotNumber.trim() || null,
        temperature: parseNumber(input.temperature),
        accepted: input.accepted,
        note: input.note.trim() || null,
      });
      setReceipts(prev => [...prev, saved]);
    } catch (e: any) {
      setError(e?.message || 'Errore nel salvataggio ricevimento');
    }
  };

  const deleteReceipt = async (id: string) => {
    try {
      await haccpApiService.deleteReceipt(id);
      setReceipts(prev => prev.filter(r => r.id !== id));
    } catch (e: any) {
      setError(e?.message || 'Errore eliminazione');
    }
  };

  // ---- Production logs (ad-hoc) ---------------------------------------------
  const addProduction = async (input: {
    product: string; blastTempRange: string; blastDuration: string; internalLot: string; note: string;
  }) => {
    const product = input.product.trim();
    if (!product) return;
    try {
      const saved = await haccpApiService.createProductionLog({
        date,
        product,
        blastTempRange: input.blastTempRange || null,
        blastDuration: input.blastDuration || null,
        internalLot: input.internalLot.trim() || null,
        note: input.note.trim() || null,
      });
      setProduction(prev => [...prev, saved]);
    } catch (e: any) {
      setError(e?.message || 'Errore nel salvataggio produzione');
    }
  };

  const deleteProduction = async (id: string) => {
    try {
      await haccpApiService.deleteProductionLog(id);
      setProduction(prev => prev.filter(p => p.id !== id));
    } catch (e: any) {
      setError(e?.message || 'Errore eliminazione');
    }
  };

  // ---- Print ----------------------------------------------------------------
  const onPrintReport = () => {
    printHaccpReport({
      date,
      temperatures: HACCP_TEMPERATURE_LOCATIONS.map(loc => ({
        location: loc.location,
        targetMax: loc.targetMax,
        reading: tempByLocation.get(loc.location) || null,
      })),
      oil: HACCP_FRYERS.map(fryerLabel => ({
        fryerLabel,
        check: oilByFryer.get(fryerLabel) || null,
      })),
      cleaning: HACCP_CLEANING_POINTS.map(point => ({
        point,
        check: cleaningByPoint.get(point) || null,
      })),
      receipts,
      production,
    });
  };

  return (
    // Scorrimento della pagina, non del contenitore dell'app: è quello che
    // tiene il contenuto sopra la barra di navigazione flottante del telefono
    // invece di lasciarlo passare dietro e ricomparire sotto.
    <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="space-y-4">

        {/* Titolo da solo sulla sua riga, comandi sulla riga sotto: è la stessa
            impalcatura di Spesa e Pagamenti. Il giorno e la stampa stanno
            insieme a sinistra — si stampa il giorno che si sta guardando, sono
            un gesto solo — mentre Ricarica se ne va in fondo a destra: non
            cambia niente di quello che vedi, rilegge soltanto, e in mezzo agli
            altri due si prendeva un peso che non ha. */}
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
            HACCP
          </h1>
          <p className="mt-1 text-[15px] text-[var(--ds-text-muted)]">
            Controlli giornalieri di igiene e sicurezza alimentare.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Il calendario nativo si apre solo cliccando la sua iconcina, che è
              un bersaglio da pochi pixel in fondo al campo: qui la nascondiamo,
              ne disegniamo una nostra a sinistra come nel campo di ricerca, e
              apriamo il picker da qualunque punto della pillola. showPicker
              vuole un gesto dell'utente e su qualche browser non c'è: se non
              parte resta il campo nativo, che si compila comunque da tastiera. */}
          <div className="relative flex-shrink-0">
            <CalendarDays
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
              aria-hidden
            />
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              onClick={e => { try { e.currentTarget.showPicker(); } catch { /* niente picker: resta il campo nativo */ } }}
              aria-label="Giorno"
              // Bianca e con l'ombra come il campo di ricerca delle altre
              // schermate, non incassata: qui sta sulla tela, non dentro una card.
              className="h-11 w-auto min-w-0 cursor-pointer rounded-full bg-[var(--ds-surface)] pl-10 pr-4 text-[15px] tabular-nums text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-left"
            />
          </div>
          {/* Sul telefono perde la parola e resta un cerchio: la scritta si
              prendeva metà della riga. Un bottone solo, non due scambiati con
              hidden/sm:inline-flex — collide con l'inline-flex che dsButton si
              porta dentro, ed è display contro display. */}
          <button
            type="button"
            onClick={onPrintReport}
            disabled={loading}
            title="Stampa report"
            aria-label="Stampa report"
            className={`${dsButton.primary} w-11 flex-shrink-0 px-0 sm:w-auto sm:px-5`}
          >
            <Printer className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Stampa report</span>
          </button>
          <button
            type="button"
            onClick={() => reload(date)}
            className={`${dsIconButton} ml-auto`}
            title="Ricarica"
            aria-label="Ricarica"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <Callout
            tone="critical"
            icon={AlertTriangle}
            action={
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Chiudi avviso"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            }
          >
            {error}
          </Callout>
        )}

        {loading ? (
          <SkeletonHaccpSections />
        ) : (
          <>
            <Card>
              <CardHeader
                title="Temperature frigoriferi e congelatori"
                icon={<Thermometer className="h-4 w-4" />}
                status={`${tempCompleted}/${HACCP_TEMPERATURE_LOCATIONS.length} compilati`}
              />
              <TemperatureSection
                rows={HACCP_TEMPERATURE_LOCATIONS}
                byLocation={tempByLocation}
                onSave={saveTemperature}
              />
            </Card>

            <Card>
              <CardHeader
                title="Friggitrici — controllo olio"
                icon={<Flame className="h-4 w-4" />}
                status={`${oilCompleted}/${HACCP_FRYERS.length} compilati`}
              />
              <OilSection rows={HACCP_FRYERS} byFryer={oilByFryer} onSave={saveOil} />
            </Card>

            <Card>
              <CardHeader
                title="Pulizie attrezzature e superfici"
                icon={<Sparkles className="h-4 w-4" />}
                status={`${cleaningCompleted}/${HACCP_CLEANING_POINTS.length} eseguite`}
              />
              <CleaningSection rows={HACCP_CLEANING_POINTS} byPoint={cleaningByPoint} onSave={saveCleaning} />
            </Card>

            <Card>
              <CardHeader
                title="Ricevimento merci"
                icon={<Truck className="h-4 w-4" />}
                status={`${receipts.length} ${receipts.length === 1 ? 'registrazione' : 'registrazioni'}`}
              />
              <ReceiptsSection rows={receipts} onAdd={addReceipt} onDelete={deleteReceipt} />
            </Card>

            <Card>
              <CardHeader
                title="Abbattimento / produzione"
                icon={<Snowflake className="h-4 w-4" />}
                status={`${production.length} ${production.length === 1 ? 'registrazione' : 'registrazioni'}`}
              />
              <ProductionSection rows={production} onAdd={addProduction} onDelete={deleteProduction} />
            </Card>
          </>
        )}
      </div>
    </div>
    </div>
  );
};

// =============================================================================
// Section: Temperatures
// =============================================================================

interface TempSectionProps {
  rows: typeof HACCP_TEMPERATURE_LOCATIONS;
  byLocation: Map<string, HaccpTemperatureReading>;
  onSave: (location: string, targetMax: number, raw: string, note: string) => void;
}

const TemperatureSection: React.FC<TempSectionProps> = ({ rows, byLocation, onSave }) => {
  return (
    <div className={rowList}>
      {rows.map(({ location, targetMax }) => {
        const r = byLocation.get(location);
        return (
          <TemperatureRow
            key={location}
            location={location}
            targetMax={targetMax}
            initialTemperature={r?.temperature ?? null}
            initialNote={r?.note ?? ''}
            recordedAt={r?.recordedAt}
            recordedBy={r?.recordedByUserName ?? null}
            onSave={(raw, note) => onSave(location, targetMax, raw, note)}
          />
        );
      })}
    </div>
  );
};

interface TempRowProps {
  location: string;
  targetMax: number;
  initialTemperature: number | null;
  initialNote: string;
  recordedAt?: string;
  recordedBy: string | null;
  onSave: (raw: string, note: string) => void;
}

const TemperatureRow: React.FC<TempRowProps> = ({
  location, targetMax, initialTemperature, initialNote, recordedAt, recordedBy, onSave,
}) => {
  // Seed the field with the limit so the operator can either confirm it or
  // type over it. "touched" tracks whether the operator has actually focused
  // the field — without it, tabbing past 11 untouched rows would record 11
  // phantom readings equal to the limit.
  const isSaved = initialTemperature !== null;
  const [temp, setTemp] = useState(formatNumber(initialTemperature ?? targetMax));
  const [note, setNote] = useState(initialNote);
  const [touched, setTouched] = useState(isSaved);

  useEffect(() => {
    setTemp(formatNumber(initialTemperature ?? targetMax));
    setTouched(initialTemperature !== null);
  }, [initialTemperature, targetMax]);
  useEffect(() => { setNote(initialNote); }, [initialNote]);

  const parsed = parseNumber(temp);
  const overTarget = touched && parsed !== null && parsed > targetMax;
  const filled = touched && parsed !== null;

  const commit = () => {
    if (!touched) return;
    const next = parseNumber(temp);
    if (next === null) return;
    if (next === initialTemperature && note === initialNote) return;
    onSave(temp, note);
  };

  // Tre stati, tre famiglie di colore del design system: fuori limite critico,
  // ancora da confermare pending, confermato la pillola incassata neutra. Le
  // classi sono scritte per esteso in ogni ramo perché Tailwind estrae i nomi
  // staticamente e una stringa composta non arriverebbe mai nel bundle.
  const tempFieldTone = overTarget
    ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ring-1 ring-inset ring-[var(--ds-critical-solid)]'
    : touched
      ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
      : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ring-1 ring-inset ring-[var(--ds-pending-solid)]';

  return (
    <div className={row}>
      <div className="col-span-12 min-w-0 sm:col-span-4">
        <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">{location}</div>
        <div className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">
          Limite ≤ {formatNumber(targetMax)}°C
        </div>
      </div>
      <div className="col-span-4 sm:col-span-2">
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={temp}
            placeholder="—"
            aria-label={`Temperatura ${location}`}
            onChange={e => { setTemp(e.target.value); setTouched(true); }}
            onFocus={e => { setTouched(true); e.target.select(); }}
            onBlur={commit}
            className={`h-11 w-full rounded-full pl-3 pr-9 text-right text-[15px] tabular-nums transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${tempFieldTone}`}
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">°C</span>
        </div>
      </div>
      <div className="col-span-8 sm:col-span-5">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          aria-label={`Note ${location}`}
          onChange={e => setNote(e.target.value)}
          onBlur={commit}
          className={field}
        />
      </div>
      <div className="col-span-12 text-right sm:col-span-1">
        {overTarget ? (
          <AlertTriangle className="inline-block h-4 w-4 text-[var(--ds-critical-text)]" />
        ) : filled ? (
          <Check className="inline-block h-4 w-4 text-[var(--ds-seated-text)]" />
        ) : parsed !== null ? (
          <span
            className="inline-block h-2 w-2 rounded-full bg-[var(--ds-pending-solid)]"
            title="Suggerimento — non confermato"
          />
        ) : null}
      </div>
      {(recordedAt && recordedBy) && (
        <div className={stamp}>{recordedLabel(recordedBy, recordedAt)}</div>
      )}
    </div>
  );
};

// =============================================================================
// Section: Oil
// =============================================================================

interface OilSectionProps {
  rows: string[];
  byFryer: Map<string, HaccpOilCheck>;
  onSave: (fryerLabel: string, action: HaccpOilAction, note: string) => void;
}

const OIL_ACTION_LABELS: Record<HaccpOilAction, string> = {
  SOSTITUITO: 'Sostituito',
  FILTRATO: 'Filtrato',
  UTILIZZABILE: 'Utilizzabile',
};

const OilSection: React.FC<OilSectionProps> = ({ rows, byFryer, onSave }) => {
  return (
    <div className={rowList}>
      {rows.map(fryerLabel => {
        const r = byFryer.get(fryerLabel);
        return (
          <OilRow
            key={fryerLabel}
            fryerLabel={fryerLabel}
            initialAction={r?.action ?? null}
            initialNote={r?.note ?? ''}
            recordedAt={r?.recordedAt}
            recordedBy={r?.recordedByUserName ?? null}
            onSave={(action, note) => onSave(fryerLabel, action, note)}
          />
        );
      })}
    </div>
  );
};

interface OilRowProps {
  fryerLabel: string;
  initialAction: HaccpOilAction | null;
  initialNote: string;
  recordedAt?: string;
  recordedBy: string | null;
  onSave: (action: HaccpOilAction, note: string) => void;
}

const OilRow: React.FC<OilRowProps> = ({
  fryerLabel, initialAction, initialNote, recordedAt, recordedBy, onSave,
}) => {
  const [action, setAction] = useState<HaccpOilAction | null>(initialAction);
  const [note, setNote] = useState(initialNote);
  useEffect(() => { setAction(initialAction); }, [initialAction]);
  useEffect(() => { setNote(initialNote); }, [initialNote]);

  const pick = (a: HaccpOilAction) => {
    setAction(a);
    onSave(a, note);
  };
  const commitNote = () => {
    if (action && note !== initialNote) onSave(action, note);
  };

  return (
    <div className={row}>
      <div className="col-span-12 text-[15px] font-medium text-[var(--ds-text-primary)] sm:col-span-3">
        {fryerLabel}
      </div>
      {/* Tre scelte che si escludono: il controllo segmentato del design
          system. Finché nessuna è stata presa il valore non corrisponde a
          nessun segmento e la traccia resta vuota — che è esattamente lo stato
          "friggitrice non ancora controllata". */}
      <div className="col-span-12 min-w-0 sm:col-span-5">
        <SegmentedControl<HaccpOilAction>
          value={(action ?? '') as HaccpOilAction}
          onChange={pick}
          ariaLabel={`Controllo olio ${fryerLabel}`}
          size="sm"
          equalWidth={false}
          options={HACCP_OIL_ACTIONS.map(a => ({ value: a, label: OIL_ACTION_LABELS[a] }))}
        />
      </div>
      <div className="col-span-12 sm:col-span-4">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          aria-label={`Note ${fryerLabel}`}
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          disabled={!action}
          className={`${field} disabled:opacity-50`}
        />
      </div>
      {(recordedAt && recordedBy) && (
        <div className={stamp}>{recordedLabel(recordedBy, recordedAt)}</div>
      )}
    </div>
  );
};

// =============================================================================
// Section: Cleaning
// =============================================================================

interface CleaningSectionProps {
  rows: string[];
  byPoint: Map<string, HaccpCleaningCheck>;
  onSave: (point: string, done: boolean, note: string) => void;
}

const CleaningSection: React.FC<CleaningSectionProps> = ({ rows, byPoint, onSave }) => {
  return (
    <div className={rowList}>
      {rows.map(point => {
        const r = byPoint.get(point);
        return (
          <CleaningRow
            key={point}
            point={point}
            initialDone={r?.done ?? false}
            initialNote={r?.note ?? ''}
            recordedAt={r?.recordedAt}
            recordedBy={r?.recordedByUserName ?? null}
            onSave={(done, note) => onSave(point, done, note)}
          />
        );
      })}
    </div>
  );
};

interface CleaningRowProps {
  point: string;
  initialDone: boolean;
  initialNote: string;
  recordedAt?: string;
  recordedBy: string | null;
  onSave: (done: boolean, note: string) => void;
}

const CleaningRow: React.FC<CleaningRowProps> = ({
  point, initialDone, initialNote, recordedAt, recordedBy, onSave,
}) => {
  const [done, setDone] = useState(initialDone);
  const [note, setNote] = useState(initialNote);
  useEffect(() => { setDone(initialDone); }, [initialDone]);
  useEffect(() => { setNote(initialNote); }, [initialNote]);

  const toggle = () => {
    const next = !done;
    setDone(next);
    onSave(next, note);
  };
  const commitNote = () => {
    if (note !== initialNote) onSave(done, note);
  };

  return (
    <div className={row}>
      <div className="col-span-8 flex items-center gap-2.5 sm:col-span-4">
        {/* La casella disegnata resta 24px, ma il bottone che la contiene è
            44: sotto il dito questa è la riga che si tocca più spesso di
            tutta la pagina. */}
        <button
          type="button"
          onClick={toggle}
          className="-my-2 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          aria-pressed={done}
          aria-label={done ? 'Segna come non eseguito' : 'Segna come eseguito'}
        >
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-[8px] transition-colors ${
              done
                ? 'bg-[var(--ds-seated-solid)] text-white'
                : 'bg-[var(--ds-surface-row)] text-transparent ring-1 ring-inset ring-[var(--ds-border-strong)]'
            }`}
          >
            <Check className="h-4 w-4" />
          </span>
        </button>
        <span className="min-w-0 text-[15px] font-medium text-[var(--ds-text-primary)]">{point}</span>
      </div>
      <div className="col-span-4 sm:col-span-7">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          aria-label={`Note ${point}`}
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          className={field}
        />
      </div>
      <div className="col-span-12 text-right sm:col-span-1">
        {done && <Check className="inline-block h-4 w-4 text-[var(--ds-seated-text)]" />}
      </div>
      {(recordedAt && recordedBy) && (
        <div className={stamp}>{recordedLabel(recordedBy, recordedAt)}</div>
      )}
    </div>
  );
};

// =============================================================================
// Section: Receipts
// =============================================================================

interface ReceiptsSectionProps {
  rows: HaccpGoodsReceipt[];
  onAdd: (input: { product: string; lotNumber: string; temperature: string; accepted: boolean; note: string }) => void;
  onDelete: (id: string) => void;
}

/* Accettato / Respinto restano due pastiglie colorate invece di un controllo
   segmentato: qui il colore è il dato: su un registro sanitario il verde e il
   rosso si leggono prima della parola. L'anello marca la scelta fatta, la
   coppia tinta+testo è quella già verificata a contrasto dal design system. */
const outcomeChip = (active: boolean, tone: 'positive' | 'critical'): string => {
  const base =
    'inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
  if (!active) return `${base} bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]`;
  return tone === 'positive'
    ? `${base} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] ring-2 ring-inset ring-[var(--ds-seated-solid)]`
    : `${base} bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ring-2 ring-inset ring-[var(--ds-critical-solid)]`;
};

const ReceiptsSection: React.FC<ReceiptsSectionProps> = ({ rows, onAdd, onDelete }) => {
  const [product, setProduct] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [temperature, setTemperature] = useState('');
  const [accepted, setAccepted] = useState(true);
  const [note, setNote] = useState('');

  const productInputRef = useRef<HTMLInputElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!product.trim()) return;
    onAdd({ product, lotNumber, temperature, accepted, note });
    setProduct(''); setLotNumber(''); setTemperature(''); setAccepted(true); setNote('');
    productInputRef.current?.focus();
  };

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="grid grid-cols-12 items-end gap-2 border-b border-[var(--ds-border)] pb-4">
        <div className="col-span-12 sm:col-span-4">
          <label className={fieldLabel} htmlFor="haccp-receipt-product">Prodotto</label>
          <input
            id="haccp-receipt-product"
            ref={productInputRef}
            type="text"
            value={product}
            onChange={e => setProduct(e.target.value)}
            list="haccp-receipt-products"
            placeholder="es. Filetto V.One"
            className={field}
          />
          <datalist id="haccp-receipt-products">
            {HACCP_RECEIPT_PRODUCT_HINTS.map(h => <option key={h} value={h} />)}
          </datalist>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className={fieldLabel} htmlFor="haccp-receipt-lot">Lotto</label>
          <input
            id="haccp-receipt-lot"
            type="text"
            value={lotNumber}
            onChange={e => setLotNumber(e.target.value)}
            className={`${field} tabular-nums`}
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className={fieldLabel} htmlFor="haccp-receipt-temp">Temp. (°C)</label>
          <input
            id="haccp-receipt-temp"
            type="text"
            inputMode="decimal"
            value={temperature}
            onChange={e => setTemperature(e.target.value)}
            className={`${field} text-right tabular-nums`}
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <span className={fieldLabel}>Esito</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setAccepted(true)}
              aria-pressed={accepted}
              className={outcomeChip(accepted, 'positive')}
            >
              Accettato
            </button>
            <button
              type="button"
              onClick={() => setAccepted(false)}
              aria-pressed={!accepted}
              className={outcomeChip(!accepted, 'critical')}
            >
              Respinto
            </button>
          </div>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <button
            type="submit"
            disabled={!product.trim()}
            className={`w-full ${dsButton.primary}`}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Aggiungi
          </button>
        </div>
        <div className="col-span-12">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (opzionale)"
            aria-label="Note ricevimento"
            className={field}
          />
        </div>
      </form>

      {rows.length === 0 ? (
        <div className={emptyNote}>Nessuna registrazione per oggi.</div>
      ) : (
        <ul className={rowList}>
          {rows.map(r => (
            <li key={r.id} className={row}>
              <div className="col-span-12 min-w-0 truncate text-[15px] font-medium text-[var(--ds-text-primary)] sm:col-span-4">
                {r.product}
                {r.lotNumber && (
                  <span className="ml-1.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">· lotto {r.lotNumber}</span>
                )}
              </div>
              <div className="col-span-4 text-right text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:col-span-2">
                {r.temperature !== null ? `${formatNumber(r.temperature)} °C` : '—'}
              </div>
              <div className="col-span-4 sm:col-span-2">
                <StatusPill tone={r.accepted ? 'positive' : 'critical'}>
                  {r.accepted ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {r.accepted ? 'Accettato' : 'Respinto'}
                </StatusPill>
              </div>
              <div className="col-span-4 truncate text-[14px] text-[var(--ds-text-muted)] sm:col-span-3">
                {r.note || ''}
              </div>
              <div className="col-span-12 text-right sm:col-span-1">
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  className={deleteButton}
                  title="Elimina"
                  aria-label={`Elimina ${r.product}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// =============================================================================
// Section: Production
// =============================================================================

interface ProductionSectionProps {
  rows: HaccpProductionLog[];
  onAdd: (input: { product: string; blastTempRange: string; blastDuration: string; internalLot: string; note: string }) => void;
  onDelete: (id: string) => void;
}

const ProductionSection: React.FC<ProductionSectionProps> = ({ rows, onAdd, onDelete }) => {
  const [product, setProduct] = useState('');
  const [blastTempRange, setBlastTempRange] = useState<string>(HACCP_BLAST_TEMP_RANGES[0]);
  const [blastDuration, setBlastDuration] = useState<string>(HACCP_BLAST_DURATIONS[0]);
  const [internalLot, setInternalLot] = useState('');
  const [note, setNote] = useState('');

  const productInputRef = useRef<HTMLInputElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!product.trim()) return;
    onAdd({ product, blastTempRange, blastDuration, internalLot, note });
    setProduct(''); setInternalLot(''); setNote('');
    productInputRef.current?.focus();
  };

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="grid grid-cols-12 items-end gap-2 border-b border-[var(--ds-border)] pb-4">
        <div className="col-span-12 sm:col-span-4">
          <label className={fieldLabel} htmlFor="haccp-production-product">Prodotto</label>
          <input
            id="haccp-production-product"
            ref={productInputRef}
            type="text"
            value={product}
            onChange={e => setProduct(e.target.value)}
            list="haccp-production-products"
            placeholder="es. Salsa porcini"
            className={field}
          />
          <datalist id="haccp-production-products">
            {HACCP_PRODUCTION_PRODUCT_HINTS.map(h => <option key={h} value={h} />)}
          </datalist>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className={fieldLabel} htmlFor="haccp-production-range">Range temp.</label>
          <select
            id="haccp-production-range"
            value={blastTempRange}
            onChange={e => setBlastTempRange(e.target.value)}
            className={dsSelect}
          >
            {HACCP_BLAST_TEMP_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className={fieldLabel} htmlFor="haccp-production-duration">Durata</label>
          <select
            id="haccp-production-duration"
            value={blastDuration}
            onChange={e => setBlastDuration(e.target.value)}
            className={dsSelect}
          >
            {HACCP_BLAST_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className={fieldLabel} htmlFor="haccp-production-lot">Lotto interno</label>
          <input
            id="haccp-production-lot"
            type="text"
            value={internalLot}
            onChange={e => setInternalLot(e.target.value)}
            className={`${field} tabular-nums`}
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <button
            type="submit"
            disabled={!product.trim()}
            className={`w-full ${dsButton.primary}`}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Aggiungi
          </button>
        </div>
        <div className="col-span-12">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (opzionale)"
            aria-label="Note produzione"
            className={field}
          />
        </div>
      </form>

      {rows.length === 0 ? (
        <div className={emptyNote}>Nessuna registrazione per oggi.</div>
      ) : (
        <ul className={rowList}>
          {rows.map(r => (
            <li key={r.id} className={row}>
              <div className="col-span-12 min-w-0 truncate text-[15px] font-medium text-[var(--ds-text-primary)] sm:col-span-4">
                {r.product}
                {r.internalLot && (
                  <span className="ml-1.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">· lotto {r.internalLot}</span>
                )}
              </div>
              <div className="col-span-4 text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:col-span-2">
                {r.blastTempRange || '—'}
              </div>
              <div className="col-span-4 text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:col-span-2">
                {r.blastDuration || '—'}
              </div>
              <div className="col-span-4 truncate text-[14px] text-[var(--ds-text-muted)] sm:col-span-3">
                {r.note || ''}
              </div>
              <div className="col-span-12 text-right sm:col-span-1">
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  className={deleteButton}
                  title="Elimina"
                  aria-label={`Elimina ${r.product}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
