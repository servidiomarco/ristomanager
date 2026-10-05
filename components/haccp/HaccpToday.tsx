import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Thermometer, Flame, Sparkles, Truck, Timer, Gauge, Printer, CalendarDays,
  Check, X, AlertTriangle, RefreshCw, ShieldAlert, Settings2,
} from 'lucide-react';
import {
  haccpApiService,
  HACCP_OIL_ACTIONS,
  HaccpCalibration,
  HaccpDay,
  HaccpLimits,
  HaccpPoint,
  HaccpTemperatureReading,
  HaccpOilCheck,
  HaccpOilAction,
  HaccpCleaningCheck,
  HaccpNonConformity,
  HaccpAuditFields,
  isReasonRequired,
} from '../../services/haccpApiService';
import { supplierApiService, type Supplier } from '../../services/shoppingApiService';
import { evaluateHaccpOil, formatHaccpLimit, haccpPeriodRange, isOutOfRange } from '../../utils/haccp';
import { printHaccpReport } from '../../utils/printHaccpReport';
import { useAuth } from '../../contexts/AuthContext';
import { SkeletonHaccpSections } from '../SkeletonCards';
import { Callout, EmptyState, SegmentedControl, dsButton, dsIconButton } from '../ds';
import {
  Card, CardHeader, CloseNcDialog, HistoryDialog, NcLine, ReasonDialog, ReasonRequest, RowStamp, TFunc,
  correctableWithoutReason, field, formatLongDate, formatNumber, frequencyLabel,
  parseNumber, row, rowList, todayISO,
} from './haccpUi';
import { ReceiptsSection } from './HaccpReceipts';
import { ProcessesSection } from './HaccpProcesses';
import { CalibrationsList } from './HaccpCalibrations';

/* Il modulo del giorno. Si compila col telefono davanti alla cella: ogni
   campo salva quando lo si lascia, e il server decide se è una registrazione
   nuova, un refuso (entro 15 minuti, nessuna domanda) o una correzione da
   motivare (il dialogo del motivo). Dopo ogni salvataggio si rilegge il
   giorno intero: una lettura sola, e le non conformità aperte o chiuse dal
   server arrivano con lei. */

type SaveOutcome = Promise<boolean>;

interface HistoryTarget { entity: string; entityId: string; title: string }

export const HaccpToday: React.FC<{
  refreshKey: number;
  onOpenNonConformities: () => void;
  /** Le aperte di tutti i giorni, a ogni rilettura: il contatore sulla
   *  scheda segue così anche le chiusure fatte da qui, che il socket non
   *  rimanda a chi le ha fatte. */
  onNcCountChange?: (open: number) => void;
  onConfigure?: () => void;
}> = ({ refreshKey, onOpenNonConformities, onNcCountChange, onConfigure }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const { user, hasPermission } = useAuth();
  const canRecord = hasPermission('haccp:record');
  const [date, setDate] = useState<string>(todayISO());
  const [day, setDay] = useState<HaccpDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reasonRequest, setReasonRequest] = useState<ReasonRequest | null>(null);
  const [closingNc, setClosingNc] = useState<HaccpNonConformity | null>(null);
  const [history, setHistory] = useState<HistoryTarget | null>(null);
  const [printing, setPrinting] = useState(false);
  // L'anagrafica fornitori della Lista della spesa, per il ricevimento: si
  // legge una volta, e se non arriva il campo resta libero.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  useEffect(() => {
    supplierApiService.getAll().then(setSuppliers).catch(() => setSuppliers([]));
  }, []);

  const loadSeq = useRef(0);
  const reload = useCallback(async (dateToLoad: string, quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await haccpApiService.getDay(dateToLoad);
      if (seq !== loadSeq.current) return;
      setDay(d);
      setError(null);
      onNcCountChange?.(d.nonconformities.filter(nc => nc.status === 'OPEN').length);
    } catch (e: any) {
      if (seq !== loadSeq.current) return;
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [t, onNcCountChange]);

  useEffect(() => { reload(date); }, [date, reload]);
  // Un altro telefono ha scritto (socket): si rilegge in silenzio.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    reload(date, true);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isFuture = date > todayISO();
  const editable = canRecord && !isFuture;

  /** Prova a salvare; se il server chiede il motivo, lo chiede all'utente e
   *  riprova. Risolve false se la correzione è stata lasciata perdere: la riga
   *  torna al valore salvato. */
  const withReason = useCallback((
    attempt: (reason: string | null) => Promise<unknown>,
    dialog: { title: string; subtitle?: string },
  ): SaveOutcome => new Promise<boolean>(resolve => {
    attempt(null)
      .then(() => { reload(date, true); resolve(true); })
      .catch(e => {
        if (!isReasonRequired(e)) {
          setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
          resolve(false);
          return;
        }
        setReasonRequest({
          ...dialog,
          required: true,
          confirmLabel: t('saveCorrection', 'Salva la correzione'),
          onConfirm: async reason => {
            await attempt(reason);
            reload(date, true);
            resolve(true);
          },
          onCancel: () => resolve(false),
        });
      });
  }), [date, reload, t]);

  /** Annullare è sempre una conferma esplicita; il motivo è obbligatorio
   *  fuori tolleranza o sulla riga di un altro. */
  const confirmVoid = useCallback((
    target: HaccpAuditFields,
    subtitle: string,
    run: (reason: string | null) => Promise<unknown>,
  ) => {
    setReasonRequest({
      title: t('voidTitle', 'Annullare la registrazione?'),
      subtitle,
      required: !correctableWithoutReason(target, user?.id),
      destructive: true,
      confirmLabel: t('voidConfirm', 'Annulla registrazione'),
      onConfirm: async reason => {
        await run(reason);
        reload(date, true);
      },
    });
  }, [date, reload, t, user?.id]);

  // ---- Dati del giorno, ordinati per punto ----------------------------------
  const pointsOf = useCallback((register: HaccpPoint['register']) =>
    (day?.points ?? []).filter(p => p.register === register && p.active), [day]);

  const temperaturePoints = useMemo(() => pointsOf('TEMPERATURE'), [pointsOf]);
  const oilPoints = useMemo(() => pointsOf('OIL'), [pointsOf]);
  const cleaningPoints = useMemo(() => pointsOf('CLEANING'), [pointsOf]);
  const thermometers = useMemo(() => pointsOf('THERMOMETER'), [pointsOf]);
  const equipment = useMemo(() => pointsOf('EQUIPMENT'), [pointsOf]);
  const limits: HaccpLimits | undefined = day?.limits;

  const lastCalibration = useMemo(() => {
    const map = new Map<number, HaccpCalibration>();
    (day?.calibrations ?? []).forEach(c => map.set(c.pointId, c));
    return map;
  }, [day]);

  const readings = useMemo(() => {
    const map = new Map<string, HaccpTemperatureReading>();
    (day?.temperatures ?? []).forEach(r => map.set(`${r.pointId}:${r.slot}`, r));
    return map;
  }, [day]);

  const oilByPoint = useMemo(() => {
    const map = new Map<number, HaccpOilCheck>();
    (day?.oil ?? []).forEach(o => { if (o.pointId) map.set(o.pointId, o); });
    return map;
  }, [day]);

  /** Per ogni punto di pulizia: la registrazione che copre il periodo della
   *  sua frequenza (il giorno, la settimana, il mese, il semestre…). Il
   *  server manda l'ultima pulizia di ogni punto fino al giorno. */
  const cleaningDone = useMemo(() => {
    const map = new Map<number, HaccpCleaningCheck>();
    for (const p of cleaningPoints) {
      const range = p.frequency === 'DAILY' || p.frequency === 'ON_DEMAND'
        ? { from: date, to: date }
        : haccpPeriodRange(p.frequency, date);
      const hit = (day?.cleaning ?? []).find(c => c.pointId === p.id && c.date >= range.from && c.date <= range.to);
      if (hit) map.set(p.id, hit);
    }
    return map;
  }, [cleaningPoints, day, date]);

  const dueCalibrations = thermometers.filter(p => {
    const c = lastCalibration.get(p.id);
    const range = haccpPeriodRange(p.frequency, date);
    return !c || c.date < range.from || c.date > range.to;
  }).length;

  /** Le non conformità per registrazione d'origine (aperte e chiuse del
   *  giorno): la riga mostra il bottone dell'azione o l'azione scritta. */
  const ncBySource = useMemo(() => {
    const map = new Map<string, HaccpNonConformity>();
    (day?.nonconformities ?? []).forEach(nc => {
      if (!nc.sourceId) return;
      const prev = map.get(nc.sourceId);
      if (!prev || nc.status === 'OPEN') map.set(nc.sourceId, nc);
    });
    return map;
  }, [day]);

  const openNcCount = (day?.nonconformities ?? []).filter(nc => nc.status === 'OPEN').length;

  const expectedTemps = temperaturePoints.reduce((n, p) => n + p.checksPerDay, 0);
  const doneTemps = temperaturePoints.reduce((n, p) => {
    let k = 0;
    for (let s = 1; s <= p.checksPerDay; s++) if (readings.has(`${p.id}:${s}`)) k++;
    return n + k;
  }, 0);
  const outTemps = (day?.temperatures ?? []).filter(r => isOutOfRange(r.temperature, r.targetMin, r.targetMax)).length;
  const dueCleaning = cleaningPoints.filter(p => p.frequency !== 'ON_DEMAND');
  const doneCleaning = dueCleaning.filter(p => cleaningDone.has(p.id)).length;

  // ---- Stampa del giorno ----------------------------------------------------
  const printDay = async () => {
    setPrinting(true);
    try {
      const report = await haccpApiService.getReport(date, date);
      printHaccpReport(report);
    } catch (e: any) {
      setError(e?.message || t('err.print', 'Stampa non riuscita'));
    } finally {
      setPrinting(false);
    }
  };

  const noPoints = !loading && day && temperaturePoints.length + oilPoints.length + cleaningPoints.length + thermometers.length === 0;

  return (
    <div className="space-y-4">
      {/* Il giorno e la stampa stanno insieme a sinistra — si stampa il giorno
          che si sta guardando, sono un gesto solo — Ricarica in fondo a destra:
          non cambia niente di quello che vedi, rilegge soltanto. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-shrink-0">
          <CalendarDays
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
            aria-hidden
          />
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={e => e.target.value && setDate(e.target.value)}
            onClick={e => { try { e.currentTarget.showPicker(); } catch { /* niente picker: resta il campo nativo */ } }}
            aria-label={t('day', 'Giorno')}
            className="h-11 w-auto min-w-0 cursor-pointer rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] pl-10 pr-4 text-[15px] tabular-nums text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-left"
          />
        </div>
        <button
          type="button"
          onClick={printDay}
          disabled={loading || printing}
          title={t('printDay', 'Stampa il giorno')}
          aria-label={t('printDay', 'Stampa il giorno')}
          className={`${dsButton.primary} w-11 flex-shrink-0 px-0 sm:w-auto sm:px-5`}
        >
          <Printer className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">{t('printDay', 'Stampa il giorno')}</span>
        </button>
        <button
          type="button"
          onClick={() => reload(date)}
          className={`${dsIconButton} ml-auto`}
          title={t('reload', 'Ricarica')}
          aria-label={t('reload', 'Ricarica')}
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
              aria-label={t('closeAlert', 'Chiudi avviso')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--ds-radius-control)] opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          }
        >
          {error}
        </Callout>
      )}

      {openNcCount > 0 && (
        <Callout
          tone="critical"
          icon={ShieldAlert}
          action={
            <button type="button" onClick={onOpenNonConformities} className={`${dsButton.quiet} h-9 px-3 text-[14px]`}>
              {t('nc.see', 'Vedi')}
            </button>
          }
        >
          {t('nc.openCount', '{{count}} non conformità da chiudere con l\'azione correttiva', { count: openNcCount })}
        </Callout>
      )}

      {isFuture && (
        <Callout tone="info" icon={CalendarDays}>
          {t('futureDay', 'Un giorno che deve ancora venire non si compila.')}
        </Callout>
      )}

      {loading && !day ? (
        <SkeletonHaccpSections />
      ) : noPoints ? (
        <EmptyState
          icon={Settings2}
          action={onConfigure && (
            <button type="button" className={dsButton.primary} onClick={onConfigure}>
              {t('setup.cta', 'Configura i punti di controllo')}
            </button>
          )}
        >
          {onConfigure
            ? t('setup.empty', 'Il registro parte dai punti di controllo del tuo manuale: frigoriferi, congelatori, friggitrici e punti di pulizia.')
            : t('setup.emptyNoManage', 'Il registro non ha ancora punti di controllo: chiedi a chi gestisce l\'HACCP di configurarli.')}
        </EmptyState>
      ) : day && (
        <>
          {temperaturePoints.length > 0 && (
            <Card>
              <CardHeader
                title={t('card.temperatures', 'Temperature')}
                icon={<Thermometer className="h-4 w-4" />}
                status={t('filledCount', '{{fatti}}/{{totale}} compilati', { fatti: doneTemps, totale: expectedTemps })}
                statusTone={outTemps > 0 ? 'critical' : doneTemps === expectedTemps ? 'positive' : 'neutral'}
              />
              <div className={rowList}>
                {temperaturePoints.map(p => (
                  <TemperaturePointRow
                    key={p.id}
                    point={p}
                    readings={Array.from({ length: p.checksPerDay }, (_, i) => readings.get(`${p.id}:${i + 1}`) ?? null)}
                    ncBySource={ncBySource}
                    editable={editable}
                    onSave={(slot, temperature, note, existing) => withReason(
                      reason => haccpApiService.saveTemperature({ date, pointId: p.id, slot, temperature, note, reason }),
                      {
                        title: t('correctTitle', 'Correggere la registrazione?'),
                        subtitle: existing
                          ? t('correctTemp', '{{punto}}: da {{prima}} a {{dopo}} °C', { punto: p.label, prima: formatNumber(existing.temperature), dopo: formatNumber(temperature) })
                          : p.label,
                      },
                    )}
                    onVoid={r => confirmVoid(r, `${p.label} · ${formatNumber(r.temperature)} °C`, reason => haccpApiService.voidTemperature(r.id, reason))}
                    onCloseNc={setClosingNc}
                    onHistory={r => setHistory({ entity: 'temperature', entityId: r.id, title: p.label })}
                  />
                ))}
              </div>
            </Card>
          )}

          {oilPoints.length > 0 && (
            <Card>
              <CardHeader
                title={t('card.oil', 'Friggitrici — controllo olio')}
                icon={<Flame className="h-4 w-4" />}
                status={t('filledCount', '{{fatti}}/{{totale}} compilati', { fatti: oilPoints.filter(p => oilByPoint.has(p.id)).length, totale: oilPoints.length })}
              />
              <div className={rowList}>
                {oilPoints.map(p => (
                  <OilRow
                    key={p.id}
                    point={p}
                    check={oilByPoint.get(p.id) ?? null}
                    editable={editable}
                    limits={limits}
                    onSave={(action, note, polarCompounds, oilTemp) => withReason(
                      reason => haccpApiService.saveOilCheck({ date, pointId: p.id, action, note, polarCompounds, oilTemp, reason }),
                      { title: t('correctTitle', 'Correggere la registrazione?'), subtitle: p.label },
                    )}
                    onHistory={c => setHistory({ entity: 'oil', entityId: c.id, title: p.label })}
                    nc={ncBySource}
                    onCloseNc={setClosingNc}
                  />
                ))}
              </div>
            </Card>
          )}

          {cleaningPoints.length > 0 && (
            <Card>
              <CardHeader
                title={t('card.cleaning', 'Pulizie attrezzature e superfici')}
                icon={<Sparkles className="h-4 w-4" />}
                status={t('doneCount', '{{fatti}}/{{totale}} eseguite', { fatti: doneCleaning, totale: dueCleaning.length })}
                statusTone={dueCleaning.length > 0 && doneCleaning === dueCleaning.length ? 'positive' : 'neutral'}
              />
              <CleaningList
                points={cleaningPoints}
                done={cleaningDone}
                date={date}
                editable={editable}
                onToggle={(p, next, note, existing) => withReason(
                  reason => haccpApiService.saveCleaningCheck({ date, pointId: p.id, done: next, note, reason }),
                  { title: next ? t('correctTitle', 'Correggere la registrazione?') : t('uncheckTitle', 'Togliere la spunta?'), subtitle: p.label },
                ).then(ok => { if (!ok && existing) reload(date, true); return ok; })}
                onHistory={c => setHistory({ entity: 'cleaning', entityId: c.id, title: c.point })}
              />
            </Card>
          )}

          {thermometers.length > 0 && (
            <Card>
              <CardHeader
                title={t('card.calibrations', 'Taratura termometri')}
                icon={<Gauge className="h-4 w-4" />}
                status={dueCalibrations > 0
                  ? t('dueCount', '{{count}} da fare', { count: dueCalibrations })
                  : t('allDone', 'In regola')}
                statusTone={dueCalibrations > 0 ? 'pending' : 'positive'}
              />
              <CalibrationsList
                date={date}
                thermometers={thermometers}
                last={lastCalibration}
                limits={limits}
                editable={editable}
                onSave={async input => {
                  try {
                    await haccpApiService.createCalibration({ date, ...input });
                    reload(date, true);
                    return true;
                  } catch (e: any) {
                    setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
                    return false;
                  }
                }}
              />
            </Card>
          )}

          <Card>
            <CardHeader
              title={t('card.receipts', 'Ricevimento merci')}
              icon={<Truck className="h-4 w-4" />}
              status={t('records', '{{count}} registrazioni', { count: day.receipts.length })}
            />
            <ReceiptsSection
              date={date}
              rows={day.receipts}
              suppliers={suppliers}
              limits={limits}
              ncBySource={ncBySource}
              editable={editable}
              onAdd={async input => {
                try {
                  await haccpApiService.createReceipt({ date, ...input });
                  reload(date, true);
                  return true;
                } catch (e: any) {
                  setError(e?.message || t('err.receipt', 'Errore nel salvataggio ricevimento'));
                  return false;
                }
              }}
              onVoid={r => confirmVoid(r, r.product, reason => haccpApiService.voidReceipt(r.id, reason))}
              onCloseNc={setClosingNc}
              onHistory={r => setHistory({ entity: 'receipt', entityId: r.id, title: r.product })}
            />
          </Card>

          <Card>
            <CardHeader
              title={t('card.processes', 'Processi')}
              icon={<Timer className="h-4 w-4" />}
              status={t('records', '{{count}} registrazioni', { count: day.production.filter(r => r.date === date).length })}
            />
            <ProcessesSection
              date={date}
              rows={day.production}
              equipment={equipment}
              limits={limits}
              ncBySource={ncBySource}
              editable={editable}
              onAdd={async input => {
                try {
                  await haccpApiService.createProductionLog({ date, ...input });
                  reload(date, true);
                  return true;
                } catch (e: any) {
                  setError(e?.message || t('err.production', 'Errore nel salvataggio produzione'));
                  return false;
                }
              }}
              onCloseCycle={async (r, input) => {
                try {
                  await haccpApiService.updateProductionLog(r.id, input);
                  reload(date, true);
                  return true;
                } catch (e: any) {
                  setError(e?.message || t('err.production', 'Errore nel salvataggio produzione'));
                  return false;
                }
              }}
              onVoid={r => confirmVoid(r, r.product, reason => haccpApiService.voidProductionLog(r.id, reason))}
              onCloseNc={setClosingNc}
              onHistory={r => setHistory({ entity: 'production', entityId: r.id, title: r.product })}
            />
          </Card>
        </>
      )}

      <ReasonDialog request={reasonRequest} onDone={() => setReasonRequest(null)} />
      <CloseNcDialog
        nc={closingNc}
        userId={user?.id}
        onClose={() => setClosingNc(null)}
        onSaved={() => reload(date, true)}
      />
      <HistoryDialog target={history} onClose={() => setHistory(null)} />
    </div>
  );
};

// =============================================================================
// Temperature
// =============================================================================

const TemperaturePointRow: React.FC<{
  point: HaccpPoint;
  readings: Array<HaccpTemperatureReading | null>;
  ncBySource: Map<string, HaccpNonConformity>;
  editable: boolean;
  onSave: (slot: number, temperature: number, note: string | null, existing: HaccpTemperatureReading | null) => SaveOutcome;
  onVoid: (r: HaccpTemperatureReading) => void;
  onCloseNc: (nc: HaccpNonConformity) => void;
  onHistory: (r: HaccpTemperatureReading) => void;
}> = ({ point, readings, ncBySource, editable, onSave, onVoid, onCloseNc, onHistory }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const multi = point.checksPerDay > 1;
  return (
    <div className="grid grid-cols-12 gap-x-3 gap-y-1 py-2.5">
      <div className="col-span-12 min-w-0 sm:col-span-4 sm:pt-2.5">
        <div className="text-[15px] font-medium text-[var(--ds-text-primary)]">{point.label}</div>
        <div className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">
          {t('limitLabel', 'Limite {{limite}}', { limite: formatHaccpLimit(point.minTemp, point.maxTemp) })}
        </div>
      </div>
      <div className="col-span-12 space-y-1 sm:col-span-8">
        {readings.map((r, i) => (
          <TemperatureSlot
            key={`${point.id}-${i + 1}-${r?.id ?? 'new'}`}
            point={point}
            slot={i + 1}
            showSlot={multi}
            reading={r}
            nc={r ? ncBySource.get(r.id) : undefined}
            editable={editable}
            onSave={(temp, note) => onSave(i + 1, temp, note, r)}
            onVoid={onVoid}
            onCloseNc={onCloseNc}
            onHistory={onHistory}
          />
        ))}
      </div>
    </div>
  );
};

const TemperatureSlot: React.FC<{
  point: HaccpPoint;
  slot: number;
  showSlot: boolean;
  reading: HaccpTemperatureReading | null;
  nc: HaccpNonConformity | undefined;
  editable: boolean;
  onSave: (temperature: number, note: string | null) => SaveOutcome;
  onVoid: (r: HaccpTemperatureReading) => void;
  onCloseNc: (nc: HaccpNonConformity) => void;
  onHistory: (r: HaccpTemperatureReading) => void;
}> = ({ point, slot, showSlot, reading, nc, editable, onSave, onVoid, onCloseNc, onHistory }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  // Il campo parte dal limite, così chi controlla lo conferma o ci scrive
  // sopra. «touched» dice se l'operatore ci è entrato davvero: senza,
  // scorrere col tab su undici righe registrerebbe undici letture fantasma
  // uguali al limite.
  const suggestion = point.maxTemp ?? point.minTemp;
  const savedTemp = reading?.temperature ?? null;
  const savedNote = reading?.note ?? '';
  const [temp, setTemp] = useState(formatNumber(savedTemp ?? suggestion));
  const [note, setNote] = useState(savedNote);
  const [touched, setTouched] = useState(savedTemp !== null);
  const saving = useRef(false);

  const resetToSaved = useCallback(() => {
    setTemp(formatNumber(savedTemp ?? suggestion));
    setNote(savedNote);
    setTouched(savedTemp !== null);
  }, [savedTemp, savedNote, suggestion]);
  useEffect(() => { resetToSaved(); }, [resetToSaved]);

  const parsed = parseNumber(temp);
  const out = touched && parsed !== null && isOutOfRange(parsed, point.minTemp, point.maxTemp);
  const filled = touched && parsed !== null;

  const commit = async () => {
    if (!touched || saving.current) return;
    const next = parseNumber(temp);
    if (next === null) {
      if (savedTemp !== null) resetToSaved();
      return;
    }
    const cleanNote = note.trim() || null;
    if (next === savedTemp && (cleanNote ?? '') === savedNote) return;
    saving.current = true;
    const ok = await onSave(next, cleanNote);
    saving.current = false;
    if (!ok) resetToSaved();
  };

  // Tre stati, tre famiglie del design system: fuori limite critico, da
  // confermare pending, confermato la pillola incassata neutra. Classi per
  // esteso in ogni ramo: Tailwind non vede le stringhe composte.
  const tone = out
    ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ring-1 ring-inset ring-[var(--ds-critical-solid)]'
    : touched
      ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
      : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ring-1 ring-inset ring-[var(--ds-pending-solid)]';

  const slotLabel = t('slotN', '{{n}}ª', { n: slot });

  return (
    <div className="grid grid-cols-12 items-center gap-2">
      {/* Il numero della rilevazione sta dentro il campo, a sinistra: le
          postazioni con più rilevazioni restano incolonnate con le altre. */}
      <div className="col-span-4 sm:col-span-3">
        <div className="relative">
          {showSlot && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{slotLabel}</span>
          )}
          <input
            type="text"
            inputMode="decimal"
            value={temp}
            placeholder="—"
            disabled={!editable}
            aria-label={showSlot
              ? t('tempAriaSlot', 'Temperatura {{punto}}, rilevazione {{n}}', { punto: point.label, n: slot })
              : t('tempAria', 'Temperatura {{punto}}', { punto: point.label })}
            onChange={e => { setTemp(e.target.value); setTouched(true); }}
            onFocus={e => { setTouched(true); e.target.select(); }}
            onBlur={commit}
            className={`h-11 w-full rounded-[var(--ds-radius-control)] ${showSlot ? 'pl-9' : 'pl-3'} pr-9 text-right text-[15px] tabular-nums transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60 ${tone}`}
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">°C</span>
        </div>
      </div>
      <div className="col-span-7 sm:col-span-8">
        <input
          type="text"
          value={note}
          disabled={!editable}
          placeholder={t('notePlaceholder', 'Note (opzionale)')}
          aria-label={t('noteAria', 'Note {{punto}}', { punto: point.label })}
          onChange={e => setNote(e.target.value)}
          onBlur={() => { if (filled) commit(); }}
          className={`${field} disabled:opacity-60`}
        />
      </div>
      <div className="col-span-1 flex justify-end">
        {out ? (
          <AlertTriangle className="h-4 w-4 text-[var(--ds-critical-text)]" />
        ) : filled ? (
          <Check className="h-4 w-4 text-[var(--ds-seated-text)]" />
        ) : parsed !== null ? (
          <span
            className="inline-block h-2 w-2 rounded-full bg-[var(--ds-pending-solid)]"
            title={t('unconfirmed', 'Suggerimento — non confermato')}
          />
        ) : null}
      </div>
      {reading && (
        <RowStamp
          row={reading}
          onHistory={() => onHistory(reading)}
          onVoid={editable ? () => onVoid(reading) : undefined}
          voidLabel={t('voidNamed', 'Annulla la registrazione di {{nome}}', { nome: point.label })}
        />
      )}
      <NcLine nc={nc} onCloseNc={onCloseNc} editable={editable} />
    </div>
  );
};

// =============================================================================
// Olio
// =============================================================================

/* I valori (SOSTITUITO, FILTRATO, UTILIZZABILE) sono quelli dell'API e del
   database: si traduce l'etichetta, mai il valore. */
const OIL_ACTION_LABELS_IT: Record<HaccpOilAction, string> = {
  SOSTITUITO: 'Sostituito',
  FILTRATO: 'Filtrato',
  UTILIZZABILE: 'Utilizzabile',
};

export const oilActionLabel = (a: HaccpOilAction, t?: TFunc): string =>
  t ? t(`oil.${a}`, OIL_ACTION_LABELS_IT[a]) : OIL_ACTION_LABELS_IT[a];

const OilRow: React.FC<{
  point: HaccpPoint;
  check: HaccpOilCheck | null;
  limits: HaccpLimits | undefined;
  editable: boolean;
  onSave: (action: HaccpOilAction, note: string | null, polarCompounds: number | null, oilTemp: number | null) => SaveOutcome;
  onHistory: (c: HaccpOilCheck) => void;
  nc: Map<string, HaccpNonConformity>;
  onCloseNc: (nc: HaccpNonConformity) => void;
}> = ({ point, check, limits, editable, onSave, onHistory, nc, onCloseNc }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [action, setAction] = useState<HaccpOilAction | null>(check?.action ?? null);
  const [note, setNote] = useState(check?.note ?? '');
  const [polar, setPolar] = useState(formatNumber(check?.polarCompounds));
  const [oilTemp, setOilTemp] = useState(formatNumber(check?.oilTemp));
  useEffect(() => { setAction(check?.action ?? null); }, [check?.action]);
  useEffect(() => { setNote(check?.note ?? ''); }, [check?.note]);
  useEffect(() => { setPolar(formatNumber(check?.polarCompounds)); }, [check?.polarCompounds]);
  useEffect(() => { setOilTemp(formatNumber(check?.oilTemp)); }, [check?.oilTemp]);

  const current = () => ({
    note: note.trim() || null,
    polar: parseNumber(polar),
    temp: parseNumber(oilTemp),
  });
  const reset = () => {
    setAction(check?.action ?? null);
    setNote(check?.note ?? '');
    setPolar(formatNumber(check?.polarCompounds));
    setOilTemp(formatNumber(check?.oilTemp));
  };

  const pick = async (a: HaccpOilAction) => {
    if (a === check?.action) return;
    setAction(a);
    const c = current();
    const ok = await onSave(a, c.note, c.polar, c.temp);
    if (!ok) reset();
  };
  /** Note e misure si salvano quando si lascia il campo, a scelta fatta. */
  const commit = async () => {
    if (!action) return;
    const c = current();
    if ((c.note ?? '') === (check?.note ?? '') && c.polar === (check?.polarCompounds ?? null) && c.temp === (check?.oilTemp ?? null)) return;
    const ok = await onSave(action, c.note, c.polar, c.temp);
    if (!ok) reset();
  };

  const problems = limits && action
    ? evaluateHaccpOil({ action, polarCompounds: parseNumber(polar), oilTemp: parseNumber(oilTemp) }, limits)
    : [];
  const polarOver = !!limits && action !== 'SOSTITUITO' && (parseNumber(polar) ?? 0) > limits.oil.maxPolar;
  const tempOver = !!limits && (parseNumber(oilTemp) ?? -Infinity) > limits.oil.maxTemp;
  const measureTone = (over: boolean) => over
    ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ring-1 ring-inset ring-[var(--ds-critical-solid)]'
    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]';
  const measureClass = 'h-11 w-full rounded-[var(--ds-radius-control)] pl-3 pr-9 text-right text-[15px] tabular-nums placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50';

  return (
    <div className={row}>
      <div className="col-span-12 text-[15px] font-medium text-[var(--ds-text-primary)] sm:col-span-3">{point.label}</div>
      {/* Finché nessuna scelta è presa il valore non corrisponde a nessun
          segmento e la traccia resta vuota: «friggitrice non ancora
          controllata». */}
      <div className="col-span-12 min-w-0 sm:col-span-5">
        <SegmentedControl<HaccpOilAction>
          value={(action ?? '') as HaccpOilAction}
          onChange={a => { if (editable) pick(a); }}
          ariaLabel={t('oilAria', 'Controllo olio {{friggitrice}}', { friggitrice: point.label })}
          size="sm"
          equalWidth={false}
          options={HACCP_OIL_ACTIONS.map(a => ({ value: a, label: oilActionLabel(a, t) }))}
        />
      </div>
      {/* Le misure sono facoltative: le scrive chi ha il tester dei composti
          polari e il termometro dell'olio. */}
      <div className="col-span-6 sm:col-span-2">
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={polar}
            placeholder={t('polarShort', 'Polari')}
            aria-label={t('polarAria', 'Composti polari {{friggitrice}}', { friggitrice: point.label })}
            onChange={e => setPolar(e.target.value)}
            onBlur={commit}
            disabled={!action || !editable}
            className={`${measureClass} ${measureTone(polarOver)}`}
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">%</span>
        </div>
      </div>
      <div className="col-span-6 sm:col-span-2">
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={oilTemp}
            placeholder={t('oilTempShort', 'Olio')}
            aria-label={t('oilTempAria', 'Temperatura olio {{friggitrice}}', { friggitrice: point.label })}
            onChange={e => setOilTemp(e.target.value)}
            onBlur={commit}
            disabled={!action || !editable}
            className={`${measureClass} ${measureTone(tempOver)}`}
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">°C</span>
        </div>
      </div>
      {(action || note) && (
        <div className="col-span-12">
          <input
            type="text"
            value={note}
            placeholder={t('notePlaceholder', 'Note (opzionale)')}
            aria-label={t('noteAria', 'Note {{punto}}', { punto: point.label })}
            onChange={e => setNote(e.target.value)}
            onBlur={commit}
            disabled={!action || !editable}
            className={`${field} disabled:opacity-50`}
          />
        </div>
      )}
      {problems.length > 0 && !(check && nc.get(check.id)) && (
        <div className="col-span-12 text-[13px] text-[var(--ds-critical-text)]">{problems.join(', ')}</div>
      )}
      {check && <RowStamp row={check} onHistory={() => onHistory(check)} />}
      {check && <NcLine nc={nc.get(check.id)} onCloseNc={onCloseNc} editable={editable} />}
    </div>
  );
};

// =============================================================================
// Pulizie
// =============================================================================


const CleaningList: React.FC<{
  points: HaccpPoint[];
  done: Map<number, HaccpCleaningCheck>;
  date: string;
  editable: boolean;
  onToggle: (p: HaccpPoint, next: boolean, note: string | null, existing: HaccpCleaningCheck | null) => SaveOutcome;
  onHistory: (c: HaccpCleaningCheck) => void;
}> = ({ points, done, date, editable, onToggle, onHistory }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [showOnDemand, setShowOnDemand] = useState(false);
  const regular = points.filter(p => p.frequency !== 'ON_DEMAND');
  const onDemand = points.filter(p => p.frequency === 'ON_DEMAND');
  const onDemandDone = onDemand.filter(p => done.has(p.id)).length;

  const renderRow = (p: HaccpPoint) => (
    <CleaningRow
      key={p.id}
      point={p}
      check={done.get(p.id) ?? null}
      date={date}
      editable={editable}
      onToggle={onToggle}
      onHistory={onHistory}
    />
  );

  return (
    <div>
      <div className={rowList}>{regular.map(renderRow)}</div>
      {onDemand.length > 0 && (
        <div className="mt-2 border-t border-[var(--ds-border)] pt-2">
          <button
            type="button"
            onClick={() => setShowOnDemand(v => !v)}
            aria-expanded={showOnDemand}
            className="inline-flex h-11 items-center gap-2 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
          >
            {t('cleaning.onDemand', 'Su richiesta')}
            <span className="tabular-nums text-[var(--ds-text-muted)]">
              {t('cleaning.onDemandCount', '{{fatti}} oggi', { fatti: onDemandDone })}
            </span>
          </button>
          {(showOnDemand || onDemandDone > 0) && <div className={rowList}>{onDemand.map(renderRow)}</div>}
        </div>
      )}
    </div>
  );
};

const CleaningRow: React.FC<{
  point: HaccpPoint;
  check: HaccpCleaningCheck | null;
  date: string;
  editable: boolean;
  onToggle: (p: HaccpPoint, next: boolean, note: string | null, existing: HaccpCleaningCheck | null) => SaveOutcome;
  onHistory: (c: HaccpCleaningCheck) => void;
}> = ({ point, check, date, editable, onToggle, onHistory }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  // Fatta in un altro giorno del suo periodo (la settimanale di martedì vista
  // giovedì): spuntata e ferma, la si toglie dal giorno in cui è stata fatta.
  const elsewhere = !!check && check.date !== date;
  const isDone = !!check;
  const [note, setNote] = useState(check?.note ?? '');
  useEffect(() => { setNote(check?.note ?? ''); }, [check?.note]);

  const toggle = () => {
    if (!editable || elsewhere) return;
    onToggle(point, !isDone, note.trim() || null, check);
  };
  const commitNote = () => {
    if (!isDone || elsewhere || (note.trim() || '') === (check?.note ?? '')) return;
    onToggle(point, true, note.trim() || null, check);
  };

  return (
    <div className={row}>
      <div className="col-span-8 flex min-w-0 items-center gap-2.5 sm:col-span-5">
        {/* La casella disegnata resta 24px, ma il bottone che la contiene è
            44: sotto il dito questa è la riga che si tocca più spesso. */}
        <button
          type="button"
          onClick={toggle}
          disabled={!editable || elsewhere}
          className="-my-2 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-default"
          aria-pressed={isDone}
          aria-label={isDone ? t('markNotDone', 'Segna come non eseguito') : t('markDone', 'Segna come eseguito')}
        >
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-[var(--ds-radius-sm)] transition-colors ${
              isDone
                ? 'bg-[var(--ds-seated-solid)] text-white'
                : 'bg-[var(--ds-surface-row)] text-transparent ring-1 ring-inset ring-[var(--ds-border-strong)]'
            }`}
          >
            <Check className="h-4 w-4" />
          </span>
        </button>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{point.label}</div>
          <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
            {point.frequency !== 'DAILY' && frequencyLabel(point.frequency, t)}
            {elsewhere && ` · ${t('cleaning.doneOn', 'fatta {{giorno}}', { giorno: formatLongDate(check!.date) })}`}
            {point.instructions && (point.frequency !== 'DAILY' || elsewhere ? ' · ' : '')}
            {point.instructions}
          </div>
        </div>
      </div>
      <div className="col-span-4 sm:col-span-7">
        <input
          type="text"
          value={note}
          placeholder={t('notePlaceholder', 'Note (opzionale)')}
          aria-label={t('noteAria', 'Note {{punto}}', { punto: point.label })}
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          disabled={!isDone || elsewhere || !editable}
          className={`${field} disabled:opacity-50`}
        />
      </div>
      {check && !elsewhere && <RowStamp row={check} onHistory={() => onHistory(check)} />}
    </div>
  );
};
