import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, ListChecks, Loader2, Plus, SlidersHorizontal, X,
} from 'lucide-react';
import {
  LeavePlan, LeaveProposalItem, LeaveRequest, LeaveSettings, StaffCategory, StaffMember, StaffType, TimeOffType,
} from '../types';
import { staffApiService } from '../services/staffApiService';
import { socketClient } from '../services/socketClient';
import { toTitleCase } from '../utils/text';
import { displayLocale } from '../utils/formatLocale';
import { eachIsoDay, weekdayOf } from '../utils/leavePlan';
import {
  Callout, EmptyState, Field, FormCard, ModalShell, SectionHeader, SegmentedControl, StatStrip, StatusPill,
  dsButton, dsIconButton, dsInput, dsSelect, dsTextarea,
} from './ds';
import {
  LEAVE_STATUS_TONE, formatLeaveDay, formatLeaveDays, formatLeaveRange, leaveErrorText, leaveReasonText, leaveStatusLabel,
} from './ferieShared';

// ── Piano ferie ─────────────────────────────────────────────────────────
// L'area «Ferie» di Personale. Tre cose, in ordine d'urgenza: le richieste
// in attesa (con la proposta automatica), il mese come piano a barre con la
// copertura per reparto, il monte ferie dell'anno. La logica vive sul
// server (utils/leavePlan.ts): qui si legge e si disegna.

type Choice = 'APPROVE' | 'REJECT';
type Service = 'LUNCH' | 'DINNER';

const CATEGORIES: StaffCategory[] = [StaffCategory.SALA, StaffCategory.CUCINA];
const SERVICES: Service[] = ['LUNCH', 'DINNER'];

const fullName = (s: StaffMember) => `${toTitleCase(s.name)} ${toTitleCase(s.surname)}`;

const isoOf = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const lastDayOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

const dayIndex = (from: string, date: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/* Una cella del piano. Le barre sono celle contigue senza spazio fra le
   colonne: gli angoli si arrotondano solo in testa e in coda alla serie,
   così dieci giorni di ferie si leggono come un'unica barra. Classi scritte
   per intero, Tailwind le estrae staticamente. */
const BAR_TONE = {
  approved: 'bg-[var(--ds-seated-tint)]',
  // Il bordo solo sopra e sotto: un anello per cella spezzerebbe la barra
  // in tanti quadretti. I lati si chiudono in testa e in coda (vedi sotto).
  pending: 'bg-[var(--ds-pending-tint)] border-y border-[var(--ds-pending-solid)]',
  other: 'bg-[var(--ds-surface-row)]',
} as const;
const LEGEND_TONE: Record<keyof typeof BAR_TONE, string> = {
  approved: 'bg-[var(--ds-seated-tint)]',
  pending: 'bg-[var(--ds-pending-tint)] border border-[var(--ds-pending-solid)]',
  other: 'bg-[var(--ds-surface-row)]',
};
type BarKind = keyof typeof BAR_TONE;

interface PianoFerieProps {
  staffMembers: StaffMember[];
  canManage: boolean;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** Il padre rilegge assenze e contatori dopo una decisione. */
  onChanged: () => void;
}

export const PianoFerie: React.FC<PianoFerieProps> = ({ staffMembers, canManage, showToast, onChanged }) => {
  const { t, i18n } = useTranslation('ferie', { useSuspense: false });

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [plan, setPlan] = useState<LeavePlan | null>(null);
  const [loading, setLoading] = useState(true);

  const [proposal, setProposal] = useState<Map<string, LeaveProposalItem> | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [revoking, setRevoking] = useState<LeaveRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [showDecided, setShowDecided] = useState(false);

  // Sul mese corrente la griglia si apre già su oggi: su un telefono si
  // vedono otto giorni, e i primi del mese sono quasi sempre passati.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = gridScrollRef.current;
    if (!box) return;
    const today = box.querySelector<HTMLElement>('[data-today]');
    if (!today) { box.scrollLeft = 0; return; }
    const x = today.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    box.scrollLeft = Math.max(0, x - box.clientWidth / 2);
  }, [year, month, plan]);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const yearRef = useRef(year);
  useEffect(() => { yearRef.current = year; }, [year]);

  const load = useCallback(async (y: number, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await staffApiService.getLeavePlan(y);
      // Un anno cambiato mentre la richiesta viaggiava: la risposta è vecchia.
      if (yearRef.current !== y) return;
      setPlan(data);
      // Una proposta sopravvive al ricaricamento solo per ciò che è ancora
      // in attesa: una richiesta decisa altrove esce dalla proposta.
      setProposal(prev => {
        if (!prev) return prev;
        const stillPending = new Set(data.requests.filter(r => r.status === 'PENDING').map(r => r.id));
        const next = new Map([...prev].filter(([id]) => stillPending.has(id)));
        return next.size > 0 ? next : null;
      });
    } catch (err) {
      console.error('getLeavePlan failed', err);
      showToastRef.current(t('loadError'), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(year); }, [year, load]);

  // Richieste nuove, decisioni prese da un altro dispositivo, assenze
  // toccate dal calendario turni: si rilegge in silenzio.
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => load(yearRef.current, true), 300);
    };
    const events = ['leave:changed', 'timeoff:created', 'timeoff:updated', 'timeoff:deleted'];
    const attach = (socket: ReturnType<typeof socketClient.getSocket>) => {
      if (!socket) return () => {};
      events.forEach(e => socket.on(e, refresh));
      return () => events.forEach(e => socket.off(e, refresh));
    };
    let detach = attach(socketClient.getSocket());
    const unsubscribe = socketClient.onSocketChange(s => { detach(); detach = attach(s); });
    return () => { window.clearTimeout(timer); detach(); unsubscribe(); };
  }, [load]);

  const afterChange = useCallback(async () => {
    await load(yearRef.current, true);
    onChangedRef.current();
  }, [load]);

  // ── Derivati ──────────────────────────────────────────────────────────

  const staffById = useMemo(() => new Map(staffMembers.map(s => [s.id, s])), [staffMembers]);
  const balanceById = useMemo(
    () => new Map((plan?.balances ?? []).map(b => [b.staffId, b])),
    [plan]
  );

  const pending = useMemo(
    () => (plan?.requests ?? [])
      .filter(r => r.status === 'PENDING')
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.createdAt.localeCompare(b.createdAt)),
    [plan]
  );
  const decided = useMemo(
    () => (plan?.requests ?? [])
      .filter(r => r.status !== 'PENDING')
      .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [plan]
  );

  const minimums = plan?.settings.minimums;
  const hasMinimums = !!minimums && CATEGORIES.some(c => SERVICES.some(s => minimums[c][s] > 0));

  // Giorni dell'anno sotto la copertura minima, con le ferie già decise
  // (critico) e se si approvasse tutto ciò che è in attesa (da guardare).
  const shortDays = useMemo(() => {
    if (!plan || !hasMinimums) return { now: 0, ifPending: 0 };
    const cov = plan.coverage;
    const n = cov.onDuty.SALA.LUNCH.length;
    let nowShort = 0;
    let pendingShort = 0;
    for (let i = 0; i < n; i++) {
      let a = false;
      let b = false;
      for (const c of CATEGORIES) {
        for (const s of SERVICES) {
          const min = plan.settings.minimums[c][s];
          const on = cov.onDuty[c][s][i];
          if (min <= 0 || on < 0) continue;
          if (on < min) a = true;
          else if (on - cov.pendingLoss[c][s][i] < min) b = true;
        }
      }
      if (a) nowShort++;
      else if (b) pendingShort++;
    }
    return { now: nowShort, ifPending: pendingShort };
  }, [plan, hasMinimums]);

  // ── Azioni ───────────────────────────────────────────────────────────

  const decide = async (decisions: Array<{ id: string; decision: 'APPROVE' | 'REJECT' | 'REVOKE'; note?: string }>) => {
    const results = await staffApiService.decideLeaveRequests(decisions);
    const failed = results.filter(r => !r.ok).length;
    if (failed > 0) showToast(t('someFailed', { count: failed }), 'error');
    return results;
  };

  const approveOne = async (r: LeaveRequest) => {
    setBusyId(r.id);
    try {
      const [res] = await decide([{ id: r.id, decision: 'APPROVE' }]);
      if (res?.ok) showToast(t('approvedToast'), 'success');
      await afterChange();
    } catch (err) {
      showToast(leaveErrorText(err, t), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    const r = rejecting;
    setBusyId(r.id);
    try {
      const [res] = await decide([{ id: r.id, decision: 'REJECT', note: rejectNote.trim() || undefined }]);
      if (res?.ok) showToast(t('rejectedToast'), 'success');
      setRejecting(null);
      await afterChange();
    } catch (err) {
      showToast(leaveErrorText(err, t), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    const r = revoking;
    setBusyId(r.id);
    try {
      const [res] = await decide([{ id: r.id, decision: 'REVOKE' }]);
      if (res?.ok) showToast(t('revokedToast'), 'success');
      setRevoking(null);
      await afterChange();
    } catch (err) {
      showToast(leaveErrorText(err, t), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const generate = async () => {
    setProposing(true);
    try {
      const items = await staffApiService.proposeLeavePlan();
      const map = new Map(items.map(i => [i.requestId, i]));
      setProposal(map);
      setChoices(Object.fromEntries(items.map(i => [i.requestId, i.verdict])));
    } catch (err) {
      console.error('proposeLeavePlan failed', err);
      showToast(t('proposalError'), 'error');
    } finally {
      setProposing(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal) return;
    setApplying(true);
    try {
      // Il rifiuto porta con sé il motivo della proposta: è quello che il
      // dipendente legge nella notifica e nel suo profilo.
      const decisions = pending
        .filter(r => choices[r.id])
        .map(r => {
          const choice = choices[r.id];
          const item = proposal.get(r.id);
          const note = choice === 'REJECT' && item?.verdict === 'REJECT' && item.reasons[0]
            ? leaveReasonText(item.reasons[0], t)
            : undefined;
          return { id: r.id, decision: choice, note };
        });
      if (decisions.length === 0) return;
      const results = await decide(decisions);
      const ok = results.filter(r => r.ok).length;
      if (ok > 0) showToast(t('proposalApplied', { count: ok }), 'success');
      setProposal(null);
      setChoices({});
      await afterChange();
    } catch (err) {
      showToast(leaveErrorText(err, t), 'error');
    } finally {
      setApplying(false);
    }
  };

  const goMonth = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m);
    if (y !== year) setYear(y);
  };

  // ── Render ───────────────────────────────────────────────────────────

  if (loading && !plan) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-text-muted)]" aria-hidden />
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <EmptyState icon={CalendarDays}>{t('loadError')}</EmptyState>
      </div>
    );
  }

  const approveCount = proposal ? pending.filter(r => choices[r.id] === 'APPROVE').length : 0;
  const rejectCount = proposal ? pending.filter(r => choices[r.id] === 'REJECT').length : 0;

  /* ── Una richiesta in attesa ───────────────────────────────────────── */
  const pendingRow = (r: LeaveRequest) => {
    const s = staffById.get(r.staffId);
    const bal = balanceById.get(r.staffId);
    // Il residuo è dell'anno del piano: una richiesta a cavallo d'anno pesa
    // su due monti, e il conto «restano» sarebbe sbagliato.
    const sameYear = Number(r.startDate.slice(0, 4)) === plan.year && Number(r.endDate.slice(0, 4)) === plan.year;
    const after = bal && bal.entitled !== null && sameYear ? (bal.remaining ?? 0) - r.days : null;
    const item = proposal?.get(r.id);
    const choice = choices[r.id];
    const busy = busyId === r.id;
    return (
      <div key={r.id} className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] sm:p-4">
        {/* Il testo non scende sotto i 14rem: su un telefono i bottoni vanno a
            capo su una riga loro invece di schiacciare nome e date. */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[min(100%,14rem)] flex-1 space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                {s ? fullName(s) : t('unknownStaff')}
              </span>
              {s && <span className="text-[13px] text-[var(--ds-text-muted)]">{t(`category.${s.category}`)}</span>}
            </div>
            <div className="text-[14px] tabular-nums text-[var(--ds-text-secondary)]">
              {formatLeaveRange(r.startDate, r.endDate, plan.year)} · {formatLeaveDays(r.days, t)}
              {after !== null && (
                <span className={after < 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}>
                  {' · '}{t('remainingAfter', { days: formatLeaveDays(after, t) })}
                </span>
              )}
            </div>
            {(r.note || !r.requestedByStaff) && (
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                {!r.requestedByStaff && t('enteredByManager')}
                {!r.requestedByStaff && r.note && ' · '}
                {r.note && <span className="italic">«{r.note}»</span>}
              </div>
            )}
            {item && item.reasons.length > 0 && (
              <div className="text-[13px] text-[var(--ds-critical-text)]">
                {leaveReasonText(item.reasons[0], t)}
                {item.reasons.length > 1 && ` ${t('moreReasons', { count: item.reasons.length - 1 })}`}
              </div>
            )}
          </div>

          {canManage && (proposal && item ? (
            <SegmentedControl<Choice>
              value={choice ?? item.verdict}
              onChange={next => setChoices(prev => ({ ...prev, [r.id]: next }))}
              ariaLabel={t('decisionFor', { name: s ? fullName(s) : '' })}
              equalWidth={false}
              size="sm"
              options={[
                { value: 'APPROVE', label: t('approve') },
                { value: 'REJECT', label: t('reject') },
              ]}
            />
          ) : (
            <div className="flex items-center gap-2 max-sm:w-full">
              <button
                type="button"
                onClick={() => { setRejectNote(''); setRejecting(r); }}
                disabled={busy}
                className={`${dsButton.quiet} max-sm:flex-1`}
              >
                <X className="h-4 w-4" aria-hidden />
                {t('reject')}
              </button>
              <button type="button" onClick={() => approveOne(r)} disabled={busy} className={`${dsButton.primary} max-sm:flex-1`}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                {t('approve')}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /* ── Il mese come piano a barre ────────────────────────────────────── */
  const monthDays = year === plan.year ? eachIsoDay(isoOf(year, month, 1), isoOf(year, month, lastDayOf(year, month))) : [];
  const cov = plan.coverage;
  const covAt = (c: StaffCategory, s: Service, date: string) => {
    const i = dayIndex(cov.from, date);
    return {
      on: cov.onDuty[c]?.[s]?.[i] ?? 0,
      loss: cov.pendingLoss[c]?.[s]?.[i] ?? 0,
    };
  };
  const closedDay = (date: string) => SERVICES.every(s => covAt(StaffCategory.SALA, s, date).on < 0);

  const barKind = (staffId: string, date: string): BarKind | null => {
    let kind: BarKind | null = null;
    for (const a of plan.absences) {
      if (a.staffId !== staffId || a.startDate > date || a.endDate < date) continue;
      if (a.type === TimeOffType.VACANZA) return 'approved';
      kind = 'other';
    }
    for (const r of pending) {
      if (r.staffId === staffId && r.startDate <= date && r.endDate >= date) return 'pending';
    }
    return kind;
  };

  const weekdayFmt = new Intl.DateTimeFormat(displayLocale(i18n.language), { weekday: 'narrow', timeZone: 'UTC' });
  const monthLabel = new Date(year, month, 1).toLocaleDateString(displayLocale(i18n.language), { month: 'long', year: 'numeric' });
  // 31 colonne da 22px più i nomi stanno nella larghezza della pagina: sotto,
  // la griglia scorre in orizzontale dentro la sua card. La colonna dei nomi
  // viene da una variabile CSS perché su un telefono deve stringersi.
  const gridStyle = { gridTemplateColumns: `var(--ferie-name-col) repeat(${monthDays.length}, minmax(22px, 1fr))` };

  const coverageCell = (c: StaffCategory, date: string) => {
    const parts = SERVICES.map(s => ({ s, ...covAt(c, s, date), min: plan.settings.minimums[c][s] }));
    const open = parts.filter(p => p.on >= 0);
    if (open.length === 0) {
      return <span className="text-[11px] text-[var(--ds-text-subtle)]">–</span>;
    }
    const short = open.some(p => p.min > 0 && p.on < p.min);
    const risky = !short && open.some(p => p.min > 0 && p.on - p.loss < p.min);
    const value = Math.min(...open.map(p => p.on));
    const title = open
      .map(p => `${t(`service.${p.s}`)} ${p.on}${p.min > 0 ? ` / ${p.min}` : ''}${p.loss > 0 ? ` (−${p.loss})` : ''}`)
      .join(' · ');
    return (
      <span
        title={title}
        className={`flex h-6 w-full items-center justify-center rounded-[var(--ds-radius-sm)] text-[11px] font-semibold tabular-nums ${
          short
            ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
            : risky
              ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
              : 'text-[var(--ds-text-muted)]'
        }`}
      >
        {value}
      </span>
    );
  };

  const staffRow = (s: StaffMember) => {
    const bal = balanceById.get(s.id);
    const kinds = monthDays.map(d => barKind(s.id, d));
    return (
      <React.Fragment key={s.id}>
        <div
          className="sticky left-0 z-10 shadow-[-12px_0_0_0_var(--ds-surface)] flex min-w-0 flex-col justify-center border-t border-[var(--ds-border)] bg-[var(--ds-surface)] py-1.5 pr-2"
          title={bal && bal.entitled !== null
            ? t('balanceTitle', { entitled: bal.entitled, approved: bal.approved, pending: bal.pending })
            : undefined}
        >
          <span className="truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{fullName(s)}</span>
          {bal && bal.remaining !== null && (
            <span className={`text-[12px] tabular-nums ${bal.remaining < 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>
              {t('remainingShort', { days: formatLeaveDays(bal.remaining, t) })}
            </span>
          )}
        </div>
        {monthDays.map((d, i) => {
          const k = kinds[i];
          const closed = closedDay(d);
          const rest = s.weeklyRestDay != null && weekdayOf(d) === s.weeklyRestDay;
          const startRun = k && kinds[i - 1] !== k;
          const endRun = k && kinds[i + 1] !== k;
          return (
            <div
              key={d}
              className={`flex items-center border-t border-[var(--ds-border)] ${closed ? 'bg-[var(--ds-canvas)]' : ''}`}
            >
              {k ? (
                <span
                  className={`h-6 w-full ${BAR_TONE[k]} ${startRun ? `ml-0.5 rounded-l-[var(--ds-radius-sm)] ${k === 'pending' ? 'border-l' : ''}` : ''} ${endRun ? `mr-0.5 rounded-r-[var(--ds-radius-sm)] ${k === 'pending' ? 'border-r' : ''}` : ''}`}
                  title={`${formatLeaveDay(d)} · ${t(`bar.${k}`)}`}
                />
              ) : rest ? (
                <span className="mx-auto h-1 w-1 rounded-full bg-[var(--ds-text-subtle)]" title={t('restDay')} aria-hidden />
              ) : null}
            </div>
          );
        })}
      </React.Fragment>
    );
  };

  const groups = CATEGORIES.map(c => ({
    category: c,
    // Gli EXTRA a chiamata non hanno ferie da pianificare: entrano nel piano
    // solo se hanno un'assenza o una richiesta nell'anno.
    people: staffMembers
      .filter(s => s.category === c)
      .filter(s => {
        const involved = plan.absences.some(a => a.staffId === s.id) || plan.requests.some(r => r.staffId === s.id);
        return s.isActive ? (s.staffType !== StaffType.EXTRA || involved) : involved;
      })
      .sort((a, b) => a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name)),
  })).filter(g => g.people.length > 0);

  const todayIso = plan.today;

  const balanceRows = staffMembers
    .filter(s => s.isActive && (s.staffType !== StaffType.EXTRA || (balanceById.get(s.id)?.approved ?? 0) > 0))
    .sort((a, b) => a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
      {/* ── Anno e comandi ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setYear(y => y - 1)} aria-label={t('prevYear')} className={dsIconButton}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[72px] text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{year}</span>
          <button type="button" onClick={() => setYear(y => y + 1)} aria-label={t('nextYear')} className={dsIconButton}>
            <ChevronRight className="h-4 w-4" />
          </button>
          {loading && <Loader2 className="ml-2 h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSettingsOpen(true)} className={dsButton.quiet}>
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              {t('rules')}
            </button>
            <button type="button" onClick={() => setRequestOpen(true)} className={dsButton.secondary}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('newRequest')}
            </button>
          </div>
        )}
      </div>

      <StatStrip
        layout="stacked"
        stats={[
          { value: pending.length, label: t('stat.pending'), tone: pending.length > 0 ? 'pending' : 'neutral', tint: pending.length > 0 },
          { value: plan.balances.reduce((n, b) => n + b.approved, 0), label: t('stat.approvedDays') },
          ...(hasMinimums
            ? [{ value: shortDays.now, label: t('stat.shortDays'), tone: shortDays.now > 0 ? 'critical' as const : 'neutral' as const }]
            : []),
        ]}
      />

      {/* ── In attesa ── */}
      <section className="space-y-2">
        <SectionHeader
          tone={pending.length > 0 ? 'pending' : 'muted'}
          meta={pending.length > 0 ? pending.length : undefined}
          action={canManage && pending.length > 0 && !proposal ? (
            <button
              type="button"
              onClick={generate}
              disabled={proposing}
              className="inline-flex h-11 items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text-primary)] hover:opacity-80 disabled:opacity-40"
            >
              {proposing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ListChecks className="h-4 w-4" aria-hidden />}
              {t('generate')}
            </button>
          ) : undefined}
        >
          {t('pendingTitle')}
        </SectionHeader>

        {canManage && pending.length > 0 && !hasMinimums && !proposal && (
          <Callout
            tone="info"
            action={
              <button type="button" onClick={() => setSettingsOpen(true)} className="text-[14px] font-semibold underline-offset-2 hover:underline">
                {t('rules')}
              </button>
            }
          >
            {t('noMinimumsHint')}
          </Callout>
        )}

        {proposal && (
          <Callout
            tone="info"
            icon={ListChecks}
            title={t('proposalTitle')}
            action={
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setProposal(null); setChoices({}); }} disabled={applying} className={dsButton.quiet}>
                  {t('cancel')}
                </button>
                <button type="button" onClick={applyProposal} disabled={applying} className={dsButton.primary}>
                  {applying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {t('apply')}
                </button>
              </div>
            }
          >
            {t('proposalSummary', { approve: approveCount, reject: rejectCount })}
          </Callout>
        )}

        {pending.length === 0 ? (
          <p className="px-1 text-[14px] text-[var(--ds-text-muted)]">{t('noPending')}</p>
        ) : (
          <div className="space-y-2">{pending.map(pendingRow)}</div>
        )}
      </section>

      {/* ── Il mese ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => goMonth(-1)} aria-label={t('prevMonth')} className={dsIconButton}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[150px] text-center text-[16px] font-semibold capitalize text-[var(--ds-text-primary)]">{monthLabel}</span>
            <button type="button" onClick={() => goMonth(1)} aria-label={t('nextMonth')} className={dsIconButton}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {groups.length === 0 ? (
          <EmptyState icon={CalendarDays}>{t('noStaff')}</EmptyState>
        ) : (
          <div className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {/* La colonna dei nomi è sticky dentro un contenitore con 12px di
                padding: senza l'ombra piena color superficie, i giorni scorsi
                sotto spunterebbero in quella striscia a sinistra. */}
            <div ref={gridScrollRef} className="overflow-x-auto overscroll-x-contain px-3 pb-3">
              <div
                className="grid min-w-max [--ferie-name-col:104px] sm:[--ferie-name-col:minmax(112px,160px)]"
                style={gridStyle}
                role="table"
                aria-label={t('planAria', { month: monthLabel })}
              >
                {/* Intestazione: giorno della settimana e numero. */}
                <div className="sticky left-0 z-10 shadow-[-12px_0_0_0_var(--ds-surface)] bg-[var(--ds-surface)]" />
                {monthDays.map(d => {
                  const closed = closedDay(d);
                  const today = d === todayIso;
                  return (
                    <div
                      key={d}
                      data-today={today || undefined}
                      className={`flex flex-col items-center py-2 text-[11px] leading-tight ${closed ? 'bg-[var(--ds-canvas)] text-[var(--ds-text-subtle)]' : 'text-[var(--ds-text-muted)]'}`}
                      title={closed ? t('closedDay') : undefined}
                    >
                      <span>{weekdayFmt.format(new Date(`${d}T00:00:00Z`))}</span>
                      <span className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${
                        today ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'text-[var(--ds-text-secondary)]'
                      }`}>
                        {Number(d.slice(8, 10))}
                      </span>
                    </div>
                  );
                })}

                {groups.map(g => (
                  <React.Fragment key={g.category}>
                    <div className="sticky left-0 z-10 shadow-[-12px_0_0_0_var(--ds-surface)] bg-[var(--ds-surface)] pb-1 pt-3 text-[13px] font-semibold text-[var(--ds-text-muted)]">
                      {t(`category.${g.category}`)}
                    </div>
                    <div className="pb-1 pt-3" style={{ gridColumn: `span ${monthDays.length}` }} />
                    {g.people.map(staffRow)}
                    <div className="sticky left-0 z-10 shadow-[-12px_0_0_0_var(--ds-surface)] flex items-center border-t border-[var(--ds-border-strong)] bg-[var(--ds-surface)] py-1.5 pr-2 text-[13px] text-[var(--ds-text-muted)]">
                      {t('coverageRow')}
                    </div>
                    {monthDays.map(d => (
                      <div key={d} className={`flex items-center border-t border-[var(--ds-border-strong)] px-px py-1.5 ${closedDay(d) ? 'bg-[var(--ds-canvas)]' : ''}`}>
                        {coverageCell(g.category, d)}
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Legenda: solo quello che il piano può mostrare. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-[13px] text-[var(--ds-text-muted)]">
          {(['approved', 'pending', 'other'] as BarKind[]).map(k => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={`h-3 w-5 rounded-[var(--ds-radius-sm)] ${LEGEND_TONE[k]}`} aria-hidden />
              {t(`bar.${k}`)}
            </span>
          ))}
          {hasMinimums && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-5 rounded-[var(--ds-radius-sm)] bg-[var(--ds-critical-tint)]" aria-hidden />
                {t('legend.short')}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-5 rounded-[var(--ds-radius-sm)] bg-[var(--ds-pending-tint)]" aria-hidden />
                {t('legend.risky')}
              </span>
            </>
          )}
        </div>
      </section>

      {/* ── Monte ferie ── */}
      <section className="space-y-2">
        <SectionHeader meta={plan.settings.defaultAnnualDays !== null ? t('defaultDaysMeta', { days: formatLeaveDays(plan.settings.defaultAnnualDays, t) }) : undefined}>
          {t('balanceTitleSection', { year: plan.year })}
        </SectionHeader>
        {balanceRows.length === 0 ? (
          <p className="px-1 text-[14px] text-[var(--ds-text-muted)]">{t('noStaff')}</p>
        ) : (
          <div className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {/* Su un telefono «Spettanti» esce: il residuo è il numero che conta,
                e cinque colonne lasciavano al nome una manciata di pixel. */}
            <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(48px,auto))] items-center gap-x-3 px-4 py-2 text-[12px] text-[var(--ds-text-muted)] sm:grid-cols-[minmax(0,1fr)_repeat(4,minmax(56px,auto))] sm:gap-x-6">
              <span />
              <span className="text-right max-sm:hidden">{t('col.entitled')}</span>
              <span className="text-right">{t('col.approved')}</span>
              <span className="text-right">{t('col.pending')}</span>
              <span className="text-right">{t('col.remaining')}</span>
            </div>
            {balanceRows.map(s => {
              const b = balanceById.get(s.id);
              const num = (n: number | null | undefined) =>
                n === null || n === undefined ? '—' : new Intl.NumberFormat(displayLocale(), { maximumFractionDigits: 1 }).format(n);
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(48px,auto))] items-center gap-x-3 border-t border-[var(--ds-border)] px-4 py-2.5 text-[14px] tabular-nums sm:grid-cols-[minmax(0,1fr)_repeat(4,minmax(56px,auto))] sm:gap-x-6"
                >
                  <span className="truncate font-medium text-[var(--ds-text-primary)]">{fullName(s)}</span>
                  <span className="text-right text-[var(--ds-text-secondary)] max-sm:hidden">{num(b?.entitled)}</span>
                  <span className="text-right text-[var(--ds-text-secondary)]">{num(b?.approved ?? 0)}</span>
                  <span className={`text-right ${(b?.pending ?? 0) > 0 ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-secondary)]'}`}>{num(b?.pending ?? 0)}</span>
                  <span className={`text-right font-semibold ${b?.remaining != null && b.remaining < 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}>{num(b?.remaining)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Decise ── */}
      {decided.length > 0 && (
        <section className="space-y-2">
          <SectionHeader meta={decided.length} onToggle={() => setShowDecided(v => !v)} expanded={showDecided}>
            {t('decidedTitle')}
          </SectionHeader>
          {showDecided && (
            <div className="space-y-2">
              {decided.map(r => {
                const s = staffById.get(r.staffId);
                const canRevoke = canManage && r.status === 'APPROVED' && r.endDate >= todayIso;
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
                    <StatusPill tone={LEAVE_STATUS_TONE[r.status]}>{leaveStatusLabel(r.status, t)}</StatusPill>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] text-[var(--ds-text-primary)]">
                        <span className="font-medium">{s ? fullName(s) : t('unknownStaff')}</span>
                        <span className="text-[var(--ds-text-muted)]"> · {formatLeaveRange(r.startDate, r.endDate, plan.year)} · {formatLeaveDays(r.days, t)}</span>
                      </div>
                      {(r.decisionNote || r.decidedByName) && (
                        <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                          {r.decidedByName}{r.decidedByName && r.decisionNote ? ' · ' : ''}{r.decisionNote}
                        </div>
                      )}
                    </div>
                    {canRevoke && (
                      <button type="button" onClick={() => setRevoking(r)} className={dsButton.quiet}>
                        {t('revoke')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── Rifiuto con motivo ── */}
      <ModalShell
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title={t('rejectTitle')}
        subtitle={rejecting ? `${staffById.get(rejecting.staffId) ? fullName(staffById.get(rejecting.staffId)!) : ''} · ${formatLeaveRange(rejecting.startDate, rejecting.endDate, plan.year)}` : undefined}
        size="sm"
        closeOnEscape
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setRejecting(null)} className={dsButton.secondary}>{t('cancel')}</button>
            <button type="button" onClick={confirmReject} disabled={busyId === rejecting?.id} className={dsButton.critical}>
              {busyId === rejecting?.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('reject')}
            </button>
          </>
        }
      >
        <FormCard>
          <Field label={t('rejectNote')} htmlFor="ferie-reject-note" hint={t('rejectNoteHint')}>
            <textarea
              id="ferie-reject-note"
              value={rejectNote}
              onChange={e => setRejectNote(e.target.value)}
              rows={3}
              maxLength={500}
              className={dsTextarea}
            />
          </Field>
        </FormCard>
      </ModalShell>

      {/* ── Revoca di ferie approvate ── */}
      <ModalShell
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={t('revokeTitle')}
        subtitle={revoking ? `${staffById.get(revoking.staffId) ? fullName(staffById.get(revoking.staffId)!) : ''} · ${formatLeaveRange(revoking.startDate, revoking.endDate, plan.year)}` : undefined}
        size="sm"
        closeOnEscape
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setRevoking(null)} className={dsButton.secondary}>{t('cancel')}</button>
            <button type="button" onClick={confirmRevoke} disabled={busyId === revoking?.id} className={dsButton.critical}>
              {busyId === revoking?.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('revoke')}
            </button>
          </>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-secondary)]">{t('revokeBody')}</p>
      </ModalShell>

      <LeaveRulesModal
        open={settingsOpen}
        settings={plan.settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={async () => {
          setSettingsOpen(false);
          setProposal(null);
          await afterChange();
        }}
        showToast={showToast}
      />

      <LeaveRequestModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        staffMembers={staffMembers}
        onCreated={async () => {
          setRequestOpen(false);
          await afterChange();
        }}
        showToast={showToast}
      />
    </div>
  );
};

// ── Regole ──────────────────────────────────────────────────────────────

const LeaveRulesModal: React.FC<{
  open: boolean;
  settings: LeaveSettings;
  onClose: () => void;
  onSaved: () => void;
  showToast: PianoFerieProps['showToast'];
}> = ({ open, settings, onClose, onSaved, showToast }) => {
  const { t } = useTranslation('ferie', { useSuspense: false });
  const [days, setDays] = useState('');
  const [mins, setMins] = useState(settings.minimums);
  const [priority, setPriority] = useState(settings.priority);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDays(settings.defaultAnnualDays === null ? '' : String(settings.defaultAnnualDays));
    setMins(settings.minimums);
    setPriority(settings.priority);
  }, [open, settings]);

  const setMin = (c: StaffCategory, s: Service, v: string) => {
    const n = Math.max(0, Math.min(50, Math.floor(Number(v) || 0)));
    setMins(prev => ({ ...prev, [c]: { ...prev[c], [s]: n } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const parsed = days.trim() === '' ? null : Number(days.replace(',', '.'));
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 365)) {
        showToast(t('invalidDays'), 'error');
        return;
      }
      await staffApiService.updateLeaveSettings({ defaultAnnualDays: parsed, minimums: mins, priority });
      showToast(t('rulesSaved'), 'success');
      onSaved();
    } catch (err) {
      console.error('updateLeaveSettings failed', err);
      showToast(t('error.generic'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('rulesTitle')}
      size="md"
      closeOnEscape
      bodyClassName="space-y-4 p-4 sm:p-5"
      footer={
        <>
          <button type="button" onClick={onClose} className={dsButton.secondary}>{t('cancel')}</button>
          <button type="button" onClick={save} disabled={saving} className={dsButton.primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('save')}
          </button>
        </>
      }
    >
      <FormCard title={t('minimumsTitle')} aside={<span className="text-[13px] text-[var(--ds-text-muted)]">{t('minimumsAside')}</span>}>
        <div className="grid grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-x-3 gap-y-3">
          <span />
          <span className="text-center text-[13px] text-[var(--ds-text-muted)]">{t('service.LUNCH')}</span>
          <span className="text-center text-[13px] text-[var(--ds-text-muted)]">{t('service.DINNER')}</span>
          {CATEGORIES.map(c => (
            <React.Fragment key={c}>
              <span className="text-[15px] font-medium text-[var(--ds-text-primary)]">{t(`category.${c}`)}</span>
              {SERVICES.map(s => (
                <input
                  key={s}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={50}
                  value={mins[c][s]}
                  onChange={e => setMin(c, s, e.target.value)}
                  aria-label={`${t(`category.${c}`)} · ${t(`service.${s}`)}`}
                  className={`${dsInput} text-center tabular-nums`}
                />
              ))}
            </React.Fragment>
          ))}
        </div>
      </FormCard>

      <FormCard title={t('defaultDaysTitle')}>
        <Field htmlFor="ferie-default-days" hint={t('defaultDaysHint')}>
          <input
            id="ferie-default-days"
            type="number"
            inputMode="decimal"
            min={0}
            max={365}
            step={0.5}
            value={days}
            onChange={e => setDays(e.target.value)}
            placeholder={t('notTracked')}
            className={dsInput}
          />
        </Field>
      </FormCard>

      <FormCard title={t('priorityTitle')}>
        <Field hint={priority === 'FIRST_COME' ? t('priorityHint.FIRST_COME') : t('priorityHint.FEWEST_DAYS')}>
          <SegmentedControl<LeaveSettings['priority']>
            value={priority}
            onChange={setPriority}
            ariaLabel={t('priorityTitle')}
            options={[
              { value: 'FIRST_COME', label: t('priority.FIRST_COME') },
              { value: 'FEWEST_DAYS', label: t('priority.FEWEST_DAYS') },
            ]}
          />
        </Field>
      </FormCard>
    </ModalShell>
  );
};

// ── Richiesta per conto di un dipendente ────────────────────────────────
// Esportato: la stessa finestra si apre dal piano e dalla scheda del
// dipendente, già puntata su di lui.

export const LeaveRequestModal: React.FC<{
  open: boolean;
  onClose: () => void;
  staffMembers: StaffMember[];
  initialStaffId?: string;
  onCreated: (r: LeaveRequest) => void;
  showToast: PianoFerieProps['showToast'];
}> = ({ open, onClose, staffMembers, initialStaffId, onCreated, showToast }) => {
  const { t } = useTranslation('ferie', { useSuspense: false });
  const [staffId, setStaffId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStaffId(initialStaffId ?? '');
    setStartDate('');
    setEndDate('');
    setNote('');
    setError(null);
  }, [open, initialStaffId]);

  const active = staffMembers
    .filter(s => s.isActive)
    .sort((a, b) => a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name));
  const fixed = !!initialStaffId;
  const person = staffMembers.find(s => s.id === staffId);

  const submit = async () => {
    if (!staffId || !startDate || !endDate) {
      setError(t('error.invalid_dates'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await staffApiService.createLeaveRequestFor({ staffId, startDate, endDate, note: note.trim() || undefined });
      showToast(t('requestCreated', { days: formatLeaveDays(created.days, t) }), 'success');
      onCreated(created);
    } catch (err) {
      setError(leaveErrorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('newRequestTitle')}
      subtitle={fixed && person ? fullName(person) : undefined}
      size="sm"
      closeOnEscape
      bodyClassName="px-5 pb-5 pt-1 sm:px-6"
      footer={
        <>
          <button type="button" onClick={onClose} className={dsButton.secondary}>{t('cancel')}</button>
          <button type="button" onClick={submit} disabled={saving} className={dsButton.primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('createRequest')}
          </button>
        </>
      }
    >
      <FormCard className="space-y-4">
        {!fixed && (
          <Field label={t('staffMember')} htmlFor="ferie-req-staff" required>
            <select id="ferie-req-staff" value={staffId} onChange={e => setStaffId(e.target.value)} className={dsSelect}>
              <option value="">{t('pickStaff')}</option>
              {CATEGORIES.map(c => (
                <optgroup key={c} label={t(`category.${c}`)}>
                  {active.filter(s => s.category === c).map(s => (
                    <option key={s.id} value={s.id}>{fullName(s)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('from')} htmlFor="ferie-req-from" required>
            <input
              id="ferie-req-from"
              type="date"
              value={startDate}
              onChange={e => {
                setStartDate(e.target.value);
                if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
              }}
              className={dsInput}
            />
          </Field>
          <Field label={t('to')} htmlFor="ferie-req-to" required>
            <input
              id="ferie-req-to"
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={e => setEndDate(e.target.value)}
              className={dsInput}
            />
          </Field>
        </div>
        <Field label={t('note')} htmlFor="ferie-req-note">
          <input id="ferie-req-note" type="text" value={note} maxLength={500} onChange={e => setNote(e.target.value)} className={dsInput} />
        </Field>
        {error && <p role="alert" className="text-[13px] text-[var(--ds-critical-text)]">{error}</p>}
      </FormCard>
    </ModalShell>
  );
};
