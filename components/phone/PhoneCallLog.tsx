import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, ArrowRight, BookUser, CalendarDays, CalendarPlus, ExternalLink, Loader2,
  NotebookPen, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Wand2,
} from 'lucide-react';
import {
  SplitPane, PaneHeader, PanePlaceholder, StatusPill, SearchField, EmptyState, SectionHeader,
  Avatar, SwipeRow, SegmentedControl, FormCard, Callout, dsButton, dsTextarea,
} from '../ds';
import type { PillTone } from '../ds';
import { SkeletonInboxList } from '../SkeletonCards';
import { socketClient } from '../../services/socketClient';
import { callFromCrm } from '../../services/softphone';
import { voiceCallsApiService, type PhoneCallRow, type PhoneCallsFilter } from '../../services/voiceCallsApiService';
import { toTitleCase } from '../../utils/text';
import { getRomeDatePart } from '../../utils/reservationTime';

/* Registro delle chiamate (docs/telefono-piano.md, Fase 3): ogni chiamata
   al numero di Sofia — presa dal locale, da Sofia o persa — e i «Richiama»
   dal CRM, con chi ha risposto, la nota e la prenotazione nata dalla
   chiamata. Le conversazioni di Sofia hanno la loro vista: da qui si aprono. */

const formatDuration = (secs: number | null): string => {
  if (secs == null || secs < 0) return '';
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};

// Come nella card «chi chiama»: i cellulari a gruppi, senza +39.
const displayPhone = (e164: string | null): string => {
  if (!e164) return '';
  if (!e164.startsWith('+39')) return e164;
  const national = e164.slice(3);
  return /^3\d{9}$/.test(national) ? `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}` : national;
};

type Kind = 'missed' | 'staff' | 'sofia' | 'outbound' | 'ringing';
const kindOf = (c: PhoneCallRow): Kind =>
  c.direction === 'outbound' ? 'outbound'
    : c.status === 'missed' ? 'missed'
    : c.status === 'answered' ? 'staff'
    : c.status === 'sofia' ? 'sofia'
    : 'ringing';

const KIND_ICON: Record<Kind, React.ComponentType<{ className?: string }>> = {
  missed: PhoneMissed, staff: PhoneCall, sofia: Wand2, outbound: PhoneOutgoing, ringing: PhoneIncoming,
};
const KIND_TONE: Record<Kind, PillTone> = {
  missed: 'critical', staff: 'positive', sofia: 'info', outbound: 'neutral', ringing: 'pending',
};
// L'avatar in rosso solo per le perse: sono quelle da richiamare.
const AVATAR_TONE: Record<Kind, 'neutral' | 'critical' | 'info'> = {
  missed: 'critical', staff: 'neutral', sofia: 'info', outbound: 'neutral', ringing: 'neutral',
};

interface Props {
  /** Il selettore Sofia / Registro, in testa alla barra. */
  switcher: React.ReactNode;
  onOpenSofiaCall: (voiceCallId: number) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
  onCreateReservation?: (prefill: { phone_call_ref: string; customer_name?: string; phone?: string }) => void;
}

export const PhoneCallLog: React.FC<Props> = ({ switcher, onOpenSofiaCall, onOpenCustomerProfile, onCreateReservation }) => {
  const { t, i18n } = useTranslation('chiamate', { useSuspense: false });
  const [filter, setFilter] = useState<PhoneCallsFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [calls, setCalls] = useState<PhoneCallRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const paramsRef = useRef({ filter, query });
  paramsRef.current = { filter, query };

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await voiceCallsApiService.phoneCalls({ filter: paramsRef.current.filter, q: paramsRef.current.query });
      setCalls(res.calls);
      setNextBefore(res.next_before);
      setError(null);
    } catch (err: any) {
      setError(err?.message || t('log.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [filter, query, load]);

  // Una chiamata che inizia o finisce cambia il registro: si rilegge in
  // silenzio, con un attimo di respiro per gli eventi a raffica.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(true); }, 1200);
    };
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) { attached.off('phoneCall:started', bump); attached.off('phoneCall:ended', bump); attached.off('phoneCall:updated', bump); }
      attached = s;
      if (attached) { attached.on('phoneCall:started', bump); attached.on('phoneCall:ended', bump); attached.on('phoneCall:updated', bump); }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange(s => attach(s));
    return () => { if (timer) clearTimeout(timer); unsub(); attach(null); };
  }, [load]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await voiceCallsApiService.phoneCalls({ filter, q: query, before: nextBefore });
      setCalls(prev => [...prev, ...res.calls.filter(c => !prev.some(p => p.id === c.id))]);
      setNextBefore(res.next_before);
    } catch (err: any) {
      setError(err?.message || t('log.loadError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const time = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const shortDate = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  const today = getRomeDatePart(new Date());
  const yesterday = getRomeDatePart(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dayHeading = (iso: string) => {
    const d = getRomeDatePart(iso);
    return d === today ? t('log.today') : d === yesterday ? t('log.yesterday') : shortDate(iso);
  };

  const outcome = (c: PhoneCallRow): string => {
    const k = kindOf(c);
    if (k === 'outbound') {
      if (c.answered_by?.kind === 'user' && c.answered_by.name) return t('log.outboundBy', { name: c.answered_by.name });
      if (c.answered_by?.kind === 'cordless') return c.answered_by.name ? t('log.outboundCordlessName', { name: c.answered_by.name }) : t('log.outboundCordless');
      return t('log.outbound');
    }
    if (k === 'staff') {
      if (c.answered_by?.kind === 'user') return c.answered_by.name ? t('log.answeredBy', { name: c.answered_by.name }) : t('log.answeredCrm');
      if (c.answered_by?.kind === 'mobile') return t('log.answeredMobile', { number: displayPhone(c.answered_by.number) });
      if (c.answered_by?.kind === 'cordless') return c.answered_by.name ? t('log.answeredCordlessName', { name: c.answered_by.name }) : t('log.answeredCordless');
      return t('log.answered');
    }
    if (k === 'sofia') return t('log.sofia');
    if (k === 'missed') return t(`log.missed.${c.missed_reason || 'other'}`, { defaultValue: t('log.missed.other') });
    return t('log.ringing');
  };

  const title = (c: PhoneCallRow) => toTitleCase(c.customer?.name || '') || displayPhone(c.phone) || t('log.hidden');

  const selected = calls.find(c => c.id === selectedId) ?? null;

  const filters: { value: PhoneCallsFilter; label: string }[] = [
    { value: 'all', label: t('log.filter.all') },
    { value: 'missed', label: t('log.filter.missed') },
    { value: 'staff', label: t('log.filter.staff') },
    { value: 'sofia', label: t('log.filter.sofia') },
    { value: 'outbound', label: t('log.filter.outbound') },
  ];

  // Raggruppate per giorno, nell'ordine in cui arrivano (più recenti prima).
  const days: { key: string; label: string; items: PhoneCallRow[] }[] = [];
  for (const c of calls) {
    const key = getRomeDatePart(c.started_at);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(c);
    else days.push({ key, label: dayHeading(c.started_at), items: [c] });
  }

  const renderRow = (c: PhoneCallRow) => {
    const k = kindOf(c);
    const Icon = KIND_ICON[k];
    const tel = (c.phone || '').replace(/[^\d+]/g, '');
    const active = c.id === selectedId;
    return (
      <SwipeRow
        key={c.id}
        right={tel ? {
          label: t('callBack'),
          tone: 'primary',
          icon: <ArrowRight className="h-4 w-4" aria-hidden />,
          onAction: () => { if (!callFromCrm(tel)) window.location.href = `tel:${tel}`; },
        } : undefined}
      >
        <button
          type="button"
          onClick={() => setSelectedId(c.id)}
          aria-current={active ? 'true' : undefined}
          className={`flex w-full gap-3 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
            active ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
          }`}
        >
          <Avatar icon={Icon} tone={AVATAR_TONE[k]} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{title(c)}</span>
              <span className="flex-shrink-0 whitespace-nowrap text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                {time(c.started_at)}
                {c.duration_seconds ? ` · ${formatDuration(c.duration_seconds)}` : ''}
              </span>
            </div>
            <p className={`truncate text-[14px] ${k === 'missed' ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>{outcome(c)}</p>
            {c.note && (
              <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[var(--ds-text-secondary)]">
                <NotebookPen className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                <span className="truncate">{c.note}</span>
              </p>
            )}
            {c.reservation && (
              <div className="mt-1.5">
                <StatusPill tone="positive">
                  <CalendarDays className="h-3 w-3" aria-hidden />
                  {t('log.booked', { date: shortDate(c.reservation.reservation_time), time: time(c.reservation.reservation_time), n: c.reservation.guests })}
                </StatusPill>
              </div>
            )}
          </div>
        </button>
      </SwipeRow>
    );
  };

  return (
    <SplitPane
      detailOpen={selected !== null}
      toolbar={
        <div className="space-y-3">
          {switcher}
          <SearchField className="w-full" value={search} onChange={setSearch} placeholder={t('log.searchPh')} />
          <SegmentedControl
            value={filter}
            onChange={next => setFilter(next as PhoneCallsFilter)}
            ariaLabel={t('filterByStatus')}
            overflow="scroll"
            size="sm"
            options={filters}
          />
        </div>
      }
      list={
        <div className="space-y-3">
          {error && <Callout tone="critical" icon={AlertCircle}>{error}</Callout>}
          {loading ? (
            <SkeletonInboxList count={6} className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)]" />
          ) : calls.length === 0 ? (
            <EmptyState icon={Phone}>{t('log.empty')}</EmptyState>
          ) : (
            <div className="space-y-1">
              {days.map(d => (
                <React.Fragment key={d.key}>
                  <SectionHeader>{d.label}</SectionHeader>
                  <div className="space-y-2 pb-2">{d.items.map(renderRow)}</div>
                </React.Fragment>
              ))}
              {nextBefore && (
                <div className="flex justify-center pt-2">
                  <button type="button" onClick={loadMore} disabled={loadingMore} className={dsButton.secondary}>
                    {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {t('log.more')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      }
      detail={selected ? (
        <PhoneCallDetail
          key={selected.id}
          call={selected}
          title={title(selected)}
          outcome={outcome(selected)}
          when={`${dayHeading(selected.started_at)} · ${time(selected.started_at)}`}
          bookedLabel={selected.reservation ? t('log.booked', { date: shortDate(selected.reservation.reservation_time), time: time(selected.reservation.reservation_time), n: selected.reservation.guests }) : ''}
          onClose={() => setSelectedId(null)}
          onSaved={(note) => setCalls(prev => prev.map(c => (c.id === selected.id ? { ...c, note } : c)))}
          onOpenSofiaCall={onOpenSofiaCall}
          onOpenCustomerProfile={onOpenCustomerProfile}
          onCreateReservation={onCreateReservation}
        />
      ) : (
        <PanePlaceholder icon={Phone}>{t('pickCall')}</PanePlaceholder>
      )}
    />
  );
};

const PhoneCallDetail: React.FC<{
  call: PhoneCallRow;
  title: string;
  outcome: string;
  when: string;
  bookedLabel: string;
  onClose: () => void;
  onSaved: (note: string | null) => void;
  onOpenSofiaCall: (voiceCallId: number) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
  onCreateReservation?: Props['onCreateReservation'];
}> = ({ call, title, outcome, when, bookedLabel, onClose, onSaved, onOpenSofiaCall, onOpenCustomerProfile, onCreateReservation }) => {
  const { t } = useTranslation('chiamate', { useSuspense: false });
  const [draft, setDraft] = useState(call.note ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const dirty = draft.trim() !== (call.note ?? '');
  const tel = (call.phone || '').replace(/[^\d+]/g, '');
  const profilePhone = call.customer?.phone || call.phone;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      const res = await voiceCallsApiService.setPhoneCallNote(call.id, draft.trim());
      onSaved(res.note);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const k = kindOf(call);
  return (
    <>
      <PaneHeader
        onBack={onClose}
        backLabel={t('backToCalls')}
        title={title}
        subtitle={call.customer && call.phone ? displayPhone(call.phone) : undefined}
        badge={<StatusPill tone={KIND_TONE[k]}>{t(`log.kind.${k}`)}</StatusPill>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)]">
        <div className="space-y-4 px-4 pb-4 sm:px-6 lg:px-8">
          <FormCard>
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--ds-text-muted)]">{t('log.when')}</dt>
                <dd className="text-right tabular-nums text-[var(--ds-text-primary)]">{when}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--ds-text-muted)]">{t('log.outcome')}</dt>
                <dd className="text-right text-[var(--ds-text-primary)]">{outcome}</dd>
              </div>
              {call.duration_seconds != null && call.duration_seconds > 0 && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--ds-text-muted)]">{t('duration')}</dt>
                  <dd className="tabular-nums text-[var(--ds-text-primary)]">{formatDuration(call.duration_seconds)}</dd>
                </div>
              )}
            </dl>
            {call.reservation && (
              <a
                href={`/?view=RESERVATIONS&reservationId=${call.reservation.id}`}
                className="mt-3 flex items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2 text-[14px] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
              >
                <CalendarDays className="h-4 w-4 flex-shrink-0 text-[var(--ds-seated-solid)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{bookedLabel}</span>
                <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
              </a>
            )}
            {call.voice_call_id != null && (
              <button type="button" onClick={() => onOpenSofiaCall(call.voice_call_id!)} className={`${dsButton.secondary} mt-3 w-full`}>
                <Wand2 className="h-4 w-4" aria-hidden /> {t(k === 'missed' ? 'log.openFollowUp' : 'log.openSofia')}
              </button>
            )}
          </FormCard>

          <FormCard title={t('log.note')}>
            <textarea
              rows={3}
              maxLength={1000}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={t('log.notePh')}
              className={dsTextarea}
            />
            {saveError && <p className="mt-2 text-[13px] text-[var(--ds-critical-text)]">{t('log.noteError')}</p>}
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={save} disabled={!dirty || saving} className={dsButton.primary}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t('saveNotes')}
              </button>
            </div>
          </FormCard>
        </div>
      </div>

      {(tel || profilePhone) && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 bg-[var(--ds-surface)] px-4 py-3">
          {profilePhone && onOpenCustomerProfile && (
            <button type="button" onClick={() => onOpenCustomerProfile({ phone: profilePhone })} className={`${dsButton.secondary} flex-1`}>
              <BookUser className="h-4 w-4" aria-hidden /> {t('customerRecord')}
            </button>
          )}
          {!call.reservation && onCreateReservation && (
            <button
              type="button"
              onClick={() => onCreateReservation({ phone_call_ref: String(call.id), customer_name: call.customer?.name || undefined, phone: profilePhone || undefined })}
              className={`${dsButton.secondary} flex-1`}
            >
              <CalendarPlus className="h-4 w-4" aria-hidden /> {t('createReservation')}
            </button>
          )}
          {tel && (
            <a href={`tel:${tel}`} onClick={e => { if (callFromCrm(tel)) e.preventDefault(); }} className={`${dsButton.primary} flex-1`}>
              <Phone className="h-4 w-4" aria-hidden /> {t('call')}
            </a>
          )}
        </div>
      )}
    </>
  );
};
