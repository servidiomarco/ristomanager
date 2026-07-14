import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Thermometer, Flame, Sparkles, Truck, Snowflake, Printer, Loader2,
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
import { CookingPotLoader } from './CookingPotLoader';

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

// Single-section heading row used at the top of each card.
interface SectionHeaderProps {
  title: string;
  icon: React.ReactNode;
  status?: string;
}
const SectionHeader: React.FC<SectionHeaderProps> = ({ title, icon, status }) => (
  <div className="flex items-center justify-between mb-3">
    <div className="flex items-center gap-2">
      <span className="text-[var(--color-fg-muted)]">{icon}</span>
      <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{title}</h2>
    </div>
    {status && (
      <span className="text-[11px] tabular text-[var(--color-fg-subtle)] font-medium">{status}</span>
    )}
  </div>
);

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
    {children}
  </section>
);

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
    <div className="p-4 sm:p-6 lg:p-8 bg-[var(--color-surface-2)] min-h-full">
      <div className="max-w-5xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h1 className="text-[22px] sm:text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
              HACCP
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)] mt-1">
              Controlli giornalieri di igiene e sicurezza alimentare.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-fg)] tabular"
            />
            <button
              type="button"
              onClick={() => reload(date)}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              title="Ricarica"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onPrintReport}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-fg)] text-[var(--color-surface)] hover:opacity-90 disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" />
              Stampa report
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-800 dark:text-rose-200 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-[var(--color-fg-muted)]">
            <CookingPotLoader label="Caricamento…" size={40} />
          </div>
        ) : (
          <>
            <Card>
              <SectionHeader
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
              <SectionHeader
                title="Friggitrici — controllo olio"
                icon={<Flame className="h-4 w-4" />}
                status={`${oilCompleted}/${HACCP_FRYERS.length} compilati`}
              />
              <OilSection rows={HACCP_FRYERS} byFryer={oilByFryer} onSave={saveOil} />
            </Card>

            <Card>
              <SectionHeader
                title="Pulizie attrezzature e superfici"
                icon={<Sparkles className="h-4 w-4" />}
                status={`${cleaningCompleted}/${HACCP_CLEANING_POINTS.length} eseguite`}
              />
              <CleaningSection rows={HACCP_CLEANING_POINTS} byPoint={cleaningByPoint} onSave={saveCleaning} />
            </Card>

            <Card>
              <SectionHeader
                title="Ricevimento merci"
                icon={<Truck className="h-4 w-4" />}
                status={`${receipts.length} ${receipts.length === 1 ? 'registrazione' : 'registrazioni'}`}
              />
              <ReceiptsSection rows={receipts} onAdd={addReceipt} onDelete={deleteReceipt} />
            </Card>

            <Card>
              <SectionHeader
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
    <div className="divide-y divide-[var(--color-line)]">
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

  return (
    <div className="grid grid-cols-12 gap-2 sm:gap-3 items-center py-2">
      <div className="col-span-12 sm:col-span-4">
        <div className="text-sm font-medium text-[var(--color-fg)]">{location}</div>
        <div className="text-[11px] tabular text-[var(--color-fg-subtle)]">
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
            onChange={e => { setTemp(e.target.value); setTouched(true); }}
            onFocus={e => { setTouched(true); e.target.select(); }}
            onBlur={commit}
            className={`w-full pl-2 pr-7 py-1.5 text-sm rounded-md tabular text-right border bg-[var(--color-surface)] text-[var(--color-fg)] ${
              overTarget
                ? 'border-rose-400 dark:border-rose-500/60 bg-rose-50 dark:bg-rose-500/10'
                : touched
                  ? 'border-[var(--color-line)]'
                  : 'border-amber-400 dark:border-amber-500/60 bg-amber-50/40 dark:bg-amber-500/[0.06]'
            }`}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-fg-subtle)] pointer-events-none">°C</span>
        </div>
      </div>
      <div className="col-span-8 sm:col-span-5">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          onChange={e => setNote(e.target.value)}
          onBlur={commit}
          className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
        />
      </div>
      <div className="col-span-12 sm:col-span-1 text-right">
        {overTarget ? (
          <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 inline-block" />
        ) : filled ? (
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 inline-block" />
        ) : parsed !== null ? (
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" title="Suggerimento — non confermato" />
        ) : null}
      </div>
      {(recordedAt && recordedBy) && (
        <div className="col-span-12 text-[10px] text-[var(--color-fg-subtle)] -mt-1 tabular">
          {recordedBy.split('@')[0]} · {new Date(recordedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
        </div>
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

const OIL_ACTION_STYLES: Record<HaccpOilAction, string> = {
  SOSTITUITO: 'bg-emerald-600 text-white border-emerald-600',
  FILTRATO: 'bg-amber-500 text-white border-amber-500',
  UTILIZZABILE: 'bg-sky-600 text-white border-sky-600',
};

const OilSection: React.FC<OilSectionProps> = ({ rows, byFryer, onSave }) => {
  return (
    <div className="divide-y divide-[var(--color-line)]">
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
    <div className="grid grid-cols-12 gap-2 sm:gap-3 items-center py-2">
      <div className="col-span-12 sm:col-span-3 text-sm font-medium text-[var(--color-fg)]">
        {fryerLabel}
      </div>
      <div className="col-span-12 sm:col-span-5 flex flex-wrap gap-1">
        {HACCP_OIL_ACTIONS.map(a => (
          <button
            key={a}
            type="button"
            onClick={() => pick(a)}
            className={`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors ${
              action === a
                ? OIL_ACTION_STYLES[a]
                : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
            }`}
          >
            {OIL_ACTION_LABELS[a]}
          </button>
        ))}
      </div>
      <div className="col-span-12 sm:col-span-4">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          disabled={!action}
          className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] disabled:opacity-60"
        />
      </div>
      {(recordedAt && recordedBy) && (
        <div className="col-span-12 text-[10px] text-[var(--color-fg-subtle)] -mt-1 tabular">
          {recordedBy.split('@')[0]} · {new Date(recordedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
        </div>
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
    <div className="divide-y divide-[var(--color-line)]">
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
    <div className="grid grid-cols-12 gap-2 sm:gap-3 items-center py-2">
      <div className="col-span-8 sm:col-span-4 flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className={`h-6 w-6 rounded-md border flex items-center justify-center flex-shrink-0 transition-colors ${
            done
              ? 'bg-emerald-600 border-emerald-600 text-white'
              : 'bg-[var(--color-surface)] border-[var(--color-line-strong)] text-transparent hover:border-[var(--color-fg-muted)]'
          }`}
          aria-pressed={done}
          aria-label={done ? 'Segna come non eseguito' : 'Segna come eseguito'}
        >
          <Check className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-fg)]">{point}</span>
      </div>
      <div className="col-span-4 sm:col-span-7">
        <input
          type="text"
          value={note}
          placeholder="Note (opzionale)"
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
        />
      </div>
      <div className="col-span-12 sm:col-span-1 text-right">
        {done && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 inline-block" />}
      </div>
      {(recordedAt && recordedBy) && (
        <div className="col-span-12 text-[10px] text-[var(--color-fg-subtle)] -mt-1 tabular">
          {recordedBy.split('@')[0]} · {new Date(recordedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
        </div>
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
      <form onSubmit={submit} className="grid grid-cols-12 gap-2 items-end pb-2 border-b border-[var(--color-line)]">
        <div className="col-span-12 sm:col-span-4">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Prodotto</label>
          <input
            ref={productInputRef}
            type="text"
            value={product}
            onChange={e => setProduct(e.target.value)}
            list="haccp-receipt-products"
            placeholder="es. Filetto V.One"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          />
          <datalist id="haccp-receipt-products">
            {HACCP_RECEIPT_PRODUCT_HINTS.map(h => <option key={h} value={h} />)}
          </datalist>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Lotto</label>
          <input
            type="text"
            value={lotNumber}
            onChange={e => setLotNumber(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular"
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Temp. (°C)</label>
          <input
            type="text"
            inputMode="decimal"
            value={temperature}
            onChange={e => setTemperature(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular text-right"
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Esito</label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setAccepted(true)}
              className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-md border transition-colors ${
                accepted
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
              }`}
            >
              Accettato
            </button>
            <button
              type="button"
              onClick={() => setAccepted(false)}
              className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded-md border transition-colors ${
                !accepted
                  ? 'bg-rose-600 text-white border-rose-600'
                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
              }`}
            >
              Respinto
            </button>
          </div>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <button
            type="submit"
            disabled={!product.trim()}
            className="w-full px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-fg)] text-[var(--color-surface)] hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Aggiungi
          </button>
        </div>
        <div className="col-span-12">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (opzionale)"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          />
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="text-[12px] text-[var(--color-fg-subtle)] py-3 text-center">
          Nessuna registrazione per oggi.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.map(r => (
            <li key={r.id} className="grid grid-cols-12 gap-2 items-center py-2 text-sm">
              <div className="col-span-12 sm:col-span-4 font-medium text-[var(--color-fg)] truncate">
                {r.product}
                {r.lotNumber && (
                  <span className="ml-1 text-[11px] text-[var(--color-fg-subtle)] tabular">· lotto {r.lotNumber}</span>
                )}
              </div>
              <div className="col-span-4 sm:col-span-2 tabular text-right text-[var(--color-fg-muted)]">
                {r.temperature !== null ? `${formatNumber(r.temperature)} °C` : '—'}
              </div>
              <div className="col-span-4 sm:col-span-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${
                  r.accepted
                    ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                    : 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300'
                }`}>
                  {r.accepted ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  {r.accepted ? 'Accettato' : 'Respinto'}
                </span>
              </div>
              <div className="col-span-4 sm:col-span-3 text-[12px] text-[var(--color-fg-subtle)] truncate">
                {r.note || ''}
              </div>
              <div className="col-span-12 sm:col-span-1 text-right">
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  className="p-1 rounded text-[var(--color-fg-subtle)] hover:text-rose-600"
                  title="Elimina"
                >
                  <Trash2 className="h-3.5 w-3.5" />
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
      <form onSubmit={submit} className="grid grid-cols-12 gap-2 items-end pb-2 border-b border-[var(--color-line)]">
        <div className="col-span-12 sm:col-span-4">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Prodotto</label>
          <input
            ref={productInputRef}
            type="text"
            value={product}
            onChange={e => setProduct(e.target.value)}
            list="haccp-production-products"
            placeholder="es. Salsa porcini"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          />
          <datalist id="haccp-production-products">
            {HACCP_PRODUCTION_PRODUCT_HINTS.map(h => <option key={h} value={h} />)}
          </datalist>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Range temp.</label>
          <select
            value={blastTempRange}
            onChange={e => setBlastTempRange(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          >
            {HACCP_BLAST_TEMP_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Durata</label>
          <select
            value={blastDuration}
            onChange={e => setBlastDuration(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          >
            {HACCP_BLAST_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="col-span-6 sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)] mb-1">Lotto interno</label>
          <input
            type="text"
            value={internalLot}
            onChange={e => setInternalLot(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] tabular"
          />
        </div>
        <div className="col-span-6 sm:col-span-2">
          <button
            type="submit"
            disabled={!product.trim()}
            className="w-full px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-fg)] text-[var(--color-surface)] hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Aggiungi
          </button>
        </div>
        <div className="col-span-12">
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (opzionale)"
            className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          />
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="text-[12px] text-[var(--color-fg-subtle)] py-3 text-center">
          Nessuna registrazione per oggi.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.map(r => (
            <li key={r.id} className="grid grid-cols-12 gap-2 items-center py-2 text-sm">
              <div className="col-span-12 sm:col-span-4 font-medium text-[var(--color-fg)] truncate">
                {r.product}
                {r.internalLot && (
                  <span className="ml-1 text-[11px] text-[var(--color-fg-subtle)] tabular">· lotto {r.internalLot}</span>
                )}
              </div>
              <div className="col-span-4 sm:col-span-2 tabular text-[var(--color-fg-muted)]">
                {r.blastTempRange || '—'}
              </div>
              <div className="col-span-4 sm:col-span-2 tabular text-[var(--color-fg-muted)]">
                {r.blastDuration || '—'}
              </div>
              <div className="col-span-4 sm:col-span-3 text-[12px] text-[var(--color-fg-subtle)] truncate">
                {r.note || ''}
              </div>
              <div className="col-span-12 sm:col-span-1 text-right">
                <button
                  type="button"
                  onClick={() => onDelete(r.id)}
                  className="p-1 rounded text-[var(--color-fg-subtle)] hover:text-rose-600"
                  title="Elimina"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
