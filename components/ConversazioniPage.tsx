import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, RefreshCw, Loader2, ListFilter, ArrowRight,
  CheckCircle2, AlertCircle, ExternalLink, CalendarPlus,
  BookUser, Check, Users,
} from 'lucide-react';
import { Loader } from './Loader';
import { CallRecordingPlayer } from './CallRecordingPlayer';
import { SkeletonInboxList } from './SkeletonCards';
import {
  voiceCallsApiService,
  voiceCallsCache,
  VoiceCallSummary,
  VoiceCallDetail,
  VoiceCallsListParams,
  FollowUpStatus,
  OutboundMessage,
} from '../services/voiceCallsApiService';
import { Reservation } from '../types';
import { toTitleCase } from '../utils/text';
import {
  SplitPane, PaneHeader, PanePlaceholder, StatusPill, CountBadge, SearchField, EmptyState, SectionHeader,
  Avatar, SwipeRow, useFirstRunHint, SegmentedControl, FormCard, Callout,
  dsButton, dsTextarea, dsIconButton,
} from './ds';
import type { PillTone } from './ds';

const formatDuration = (secs: number | null | undefined): string => {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    // Explicit Europe/Rome so the timestamp reads the same for staff opening
    // the app from a different timezone (e.g. on holiday) — otherwise the
    // reservation and call times would drift by the offset.
    return new Date(iso).toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const formatPhone = (phone: string | null | undefined): string => {
  if (!phone) return 'Numero sconosciuto';
  return phone;
};

const messageStatusBadge = (status: string | null | undefined): { label: string; tone: PillTone } => {
  const s = (status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return { label: 'Consegnato', tone: 'positive' };
  if (s === 'sent' || s === 'queued' || s === 'accepted' || s === 'sending') return { label: 'Inviato', tone: 'info' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Fallito', tone: 'critical' };
  return { label: s || 'In coda', tone: 'neutral' };
};

const channelLabel = (channel: string): string => {
  if (channel === 'sms') return 'SMS';
  if (channel === 'whatsapp') return 'WhatsApp';
  return channel;
};

const reservationStatusBadge = (status: string | null | undefined): { label: string; tone: PillTone } | null => {
  if (!status) return null;
  switch (status) {
    case 'CONFIRMED': return { label: 'Confermata', tone: 'positive' };
    case 'CANCELLED': return { label: 'Annullata', tone: 'critical' };
    case 'PENDING': return { label: 'In attesa', tone: 'pending' };
    default: return { label: status, tone: 'neutral' };
  }
};

interface TranscriptTurn {
  who: 'user' | 'agent' | 'unknown';
  text: string;
}

const parseTranscript = (raw: string | null): TranscriptTurn[] => {
  if (!raw) return [];
  const lines = raw.split('\n').filter(l => l.trim());
  return lines.map(line => {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) return { who: 'unknown', text: line };
    const role = m[1].toLowerCase();
    const who: TranscriptTurn['who'] =
      role === 'user' || role === 'caller' ? 'user'
      : role === 'agent' || role === 'assistant' ? 'agent'
      : 'unknown';
    return { who, text: m[2] };
  });
};

interface CallDetailProps {
  callId: number;
  reservations: Reservation[];
  onClose: () => void;
  onFollowUpChanged?: () => void;
  onCreateReservation?: (prefill: { callId: number; customer_name: string; phone: string }) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
  // Bumped by App after an async mutation that touches voice_calls rows
  // (e.g. the quick-create reservation flow links the call in background).
  // A change refetches the detail so badges update without a page reload.
  refreshTick?: number;
  // Other still-pending calls from the same number (the list groups repeated
  // attempts into one card): "Segna ricontattato" must clear them too, or
  // they'd resurface as a new pending card after the refetch.
  siblingPendingIds?: number[];
}

const CallDetail: React.FC<CallDetailProps> = ({ callId, reservations, onClose, onFollowUpChanged, onCreateReservation, onOpenCustomerProfile, refreshTick, siblingPendingIds }) => {
  const [detail, setDetail] = useState<VoiceCallDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  const [notesDraft, setNotesDraft] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [messages, setMessages] = useState<OutboundMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  // Il draft note viaggia in un ref oltre che nello stato: il refresh in
  // background del dettaglio (cache) non deve clobberare una nota che
  // l'utente sta scrivendo, e dentro la .then la closure sarebbe stantia.
  const notesDirtyRef = useRef(false);
  useEffect(() => { notesDirtyRef.current = notesDirty; }, [notesDirty]);

  useEffect(() => {
    let cancelled = false;
    // Dettaglio già visto: si mostra subito dalla cache e il fetch rinfresca
    // in background — stesso schema stale-while-revalidate dell'inbox.
    const cached = voiceCallsCache.details.get(callId);
    if (cached) {
      setDetail(cached);
      setNotesDraft(cached.notes ?? '');
      setNotesDirty(false);
    }
    setLoading(!cached);
    setError(null);
    voiceCallsApiService.getById(callId)
      .then(d => {
        voiceCallsCache.setDetail(callId, d);
        if (cancelled) return;
        setDetail(d);
        if (!notesDirtyRef.current) {
          setNotesDraft(d.notes ?? '');
          setNotesDirty(false);
        }
      })
      .catch((err: Error) => { if (!cancelled && !cached) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callId]);

  // Silent refetch when App signals a background mutation (quick-create →
  // link). No loading flash and the notes draft is left untouched so an
  // in-progress edit can't be clobbered.
  const firstTickRef = useRef(true);
  useEffect(() => {
    if (firstTickRef.current) { firstTickRef.current = false; return; }
    let cancelled = false;
    voiceCallsApiService.getById(callId)
      .then(d => {
        voiceCallsCache.setDetail(callId, d);
        if (!cancelled) setDetail(d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const cached = voiceCallsCache.messages.get(callId);
    // Anche a cache vuota si azzera subito: mai mostrare i messaggi della
    // chiamata precedente sotto la nuova mentre il fetch è in volo.
    setMessages(cached ?? []);
    setMessagesLoading(!cached);
    setMessagesError(null);
    voiceCallsApiService.listMessages(callId)
      .then(r => {
        voiceCallsCache.setMessages(callId, r.items);
        if (!cancelled) setMessages(r.items);
      })
      .catch((err: Error) => { if (!cancelled && !cached) setMessagesError(err.message); })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [callId, refreshTick]);

  const markPhantomRecovered = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await voiceCallsApiService.markPhantomRecovered(callId);
      const cached = voiceCallsCache.details.get(callId);
      if (cached) voiceCallsCache.setDetail(callId, { ...cached, phantom_recovered: updated.phantom_recovered });
      setDetail(prev => prev ? {
        ...prev,
        phantom_recovered: updated.phantom_recovered,
      } : prev);
      onFollowUpChanged?.();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [callId, onFollowUpChanged]);

  const applyFollowUpPatch = useCallback(async (patch: { status?: FollowUpStatus; notes?: string | null }) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await voiceCallsApiService.updateFollowUp(callId, patch);
      if (patch.status === 'CONTACTED' && siblingPendingIds?.length) {
        await Promise.all(siblingPendingIds.map(id =>
          voiceCallsApiService.updateFollowUp(id, { status: 'CONTACTED' })
        ));
      }
      const cached = voiceCallsCache.details.get(callId);
      if (cached) {
        voiceCallsCache.setDetail(callId, {
          ...cached,
          follow_up_status: updated.follow_up_status,
          notes: updated.notes,
          follow_up_updated_at: updated.follow_up_updated_at,
        });
      }
      setDetail(prev => prev ? {
        ...prev,
        follow_up_status: updated.follow_up_status,
        notes: updated.notes,
        follow_up_updated_at: updated.follow_up_updated_at,
      } : prev);
      if (patch.notes !== undefined) setNotesDirty(false);
      onFollowUpChanged?.();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [callId, onFollowUpChanged, siblingPendingIds]);

  useEffect(() => {
    return () => {
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
        audioObjectUrlRef.current = null;
      }
    };
  }, []);

  const loadAudio = useCallback(async () => {
    if (audioUrl || audioLoading) return;
    setAudioLoading(true);
    setAudioError(null);
    try {
      const url = await voiceCallsApiService.getAudioBlobUrl(callId);
      audioObjectUrlRef.current = url;
      setAudioUrl(url);
    } catch (err) {
      setAudioError((err as Error).message);
    } finally {
      setAudioLoading(false);
    }
  }, [audioUrl, audioLoading, callId]);

  const turns = useMemo(() => parseTranscript(detail?.transcript ?? null), [detail]);
  const resBadge = reservationStatusBadge(detail?.reservation_status);

  // Reservations for this phone number — includes reservations that weren't
  // explicitly linked to the call but were later created for the same number
  // (e.g. reception calls back and books manually). Sorted newest first.
  const callDigits = (detail?.phone || '').replace(/\D/g, '');
  const reservationsForPhone = useMemo(() => {
    if (!callDigits || callDigits.length < 6) return [];
    return reservations
      .filter(r => (r.phone || '').replace(/\D/g, '') === callDigits)
      .filter(r => r.reservation_status !== 'CANCELLED' && r.reservation_status !== 'DECLINED')
      .sort((a, b) => {
        const ta = new Date(a.reservation_time).getTime();
        const tb = new Date(b.reservation_time).getTime();
        return tb - ta;
      });
  }, [reservations, callDigits]);
  const hasReservationsForPhone = reservationsForPhone.length > 0;

  const heading = detail ? (toTitleCase(detail.customer_name) || formatPhone(detail.phone)) : 'Conversazione';

  return (
    <>
      <PaneHeader
        onBack={onClose}
        backLabel="Torna alle chiamate"
        title={heading}
        subtitle={detail?.customer_name && detail.phone ? detail.phone : undefined}
        badge={detail && detail.reservation_id == null ? (
          <StatusPill tone={detail.follow_up_status === 'CONTACTED' ? 'positive' : 'critical'}>
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
            {detail.follow_up_status === 'CONTACTED' ? 'Ricontattato' : 'Da ricontattare'}
          </StatusPill>
        ) : undefined}
        actions={
          /* Desktop keeps the two contact actions up here; on mobile they sit
             in the bar at the bottom, within thumb reach. */
          <div className="hidden items-center gap-2 md:flex">
            {detail?.phone && onOpenCustomerProfile && (
              <button
                type="button"
                onClick={() => onOpenCustomerProfile({ phone: detail.phone! })}
                className={dsButton.secondary}
                title="Apri anagrafica cliente"
              >
                <BookUser className="h-4 w-4" />
                Anagrafica
              </button>
            )}
            {detail?.phone && (
              <a href={`tel:${detail.phone.replace(/[^\d+]/g, '')}`} className={dsButton.primary}>
                <Phone className="h-4 w-4" />
                Chiama
              </a>
            )}
          </div>
        }
      />

      {/* The scroller carries no padding of its own, so its scrollbar rides
          the pane edge. Put the padding on the scroller and the scrollbar eats
          into it, leaving these cards narrower than the pinned header above. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)]">
      <div className="space-y-4 px-4 pb-4 sm:px-6 lg:px-8">
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader label="Carico dettaglio…" size={40} />
        </div>
      )}

      {error && <Callout tone="critical" icon={AlertCircle}>{error}</Callout>}

      {detail && !loading && (
        <>
          <FormCard>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[13px] text-[var(--ds-text-muted)]">Data</div>
                <div className="mt-0.5 text-[15px] text-[var(--ds-text-primary)]">{formatDateTime(detail.created_at)}</div>
              </div>
              <div>
                <div className="text-[13px] text-[var(--ds-text-muted)]">Durata</div>
                <div className="mt-0.5 text-[15px] tabular-nums text-[var(--ds-text-primary)]">{formatDuration(detail.duration_seconds)}</div>
              </div>
            </div>
          </FormCard>

          {hasReservationsForPhone && (
            <FormCard
              title="Prenotazioni per questo numero"
              aside={<CountBadge count={reservationsForPhone.length} />}
            >
              <div className="flex flex-col gap-2">
                {reservationsForPhone.map(res => {
                  const badge = reservationStatusBadge(res.reservation_status ?? null);
                  const isLinked = detail.reservation_id === res.id;
                  return (
                    <div key={res.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2 text-[15px] text-[var(--ds-text-primary)]">
                          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[var(--ds-seated-solid)]" aria-hidden />
                          <span className="truncate font-medium">{toTitleCase(res.customer_name) || 'Prenotazione'}</span>
                          {badge && <StatusPill tone={badge.tone}>{badge.label}</StatusPill>}
                          {isLinked && <StatusPill tone="info">Collegata</StatusPill>}
                        </div>
                        <a
                          href={`/?view=RESERVATIONS&reservationId=${res.id}`}
                          className="inline-flex flex-shrink-0 items-center gap-1 text-[14px] font-medium text-[var(--ds-text-primary)] underline-offset-4 hover:underline"
                        >
                          Apri <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      </div>
                      <div className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                        {formatDateTime(res.reservation_time)}
                        {res.guests != null && ` · ${res.guests} ospiti`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </FormCard>
          )}

          {/* Fallback: call is linked to a reservation that isn't in the
              current list (e.g. filtered out by date range or phone
              mismatch after normalization) — still show its summary. */}
          {!hasReservationsForPhone && detail.reservation_id && (
            <FormCard>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-[15px] text-[var(--ds-text-primary)]">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[var(--ds-seated-solid)]" aria-hidden />
                  <span className="truncate font-medium">{toTitleCase(detail.reservation_customer_name) || 'Prenotazione'}</span>
                  {resBadge && <StatusPill tone={resBadge.tone}>{resBadge.label}</StatusPill>}
                </div>
                <a
                  href={`/?view=RESERVATIONS&reservationId=${detail.reservation_id}`}
                  className="inline-flex flex-shrink-0 items-center gap-1 text-[14px] font-medium text-[var(--ds-text-primary)] underline-offset-4 hover:underline"
                >
                  Apri <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
              {detail.reservation_time && (
                <div className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                  {formatDateTime(detail.reservation_time)}
                  {detail.reservation_guests != null && ` · ${detail.reservation_guests} ospiti`}
                </div>
              )}
            </FormCard>
          )}

          {detail.phantom_confirmation && !detail.phantom_recovered && (
            <Callout tone="critical" icon={AlertCircle} title="Prenotazione da recuperare">
              L'agent ha detto al cliente che la prenotazione è confermata, ma non è mai stata invocata la creazione nel CRM. Richiama il cliente per confermare o annullare, poi crea manualmente la prenotazione.
              <div className="mt-3">
                <button
                  type="button"
                  onClick={markPhantomRecovered}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-critical-text)] transition-colors hover:brightness-95 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Segna come recuperata
                </button>
              </div>
            </Callout>
          )}
          {detail.phantom_confirmation && detail.phantom_recovered && (
            <Callout tone="positive" icon={CheckCircle2} title="Prenotazione recuperata">
              La conferma fantasma dell'agent è stata gestita.
            </Callout>
          )}
          {/* Large-group handoff: agent redirected the caller to a human
              because the party was above the configurable threshold.
              Distinct from phantom (which is an agent hallucination);
              this one is expected behavior and just needs a callback. */}
          {detail.large_group_handoff && !detail.reservation_id && (
            <Callout tone="info" icon={Users} title="Gruppo grande — richiamare">
              Il cliente voleva prenotare per un gruppo oltre la soglia dell'agent. Sofia ha detto che avremmo richiamato: concorda con lui data, orario e mise en place.
            </Callout>
          )}

          <FormCard
            title="Follow-up"
            aside={
              detail.follow_up_status === 'CONTACTED' ? (
                <StatusPill tone="positive">Ricontattato</StatusPill>
              ) : detail.reservation_id == null ? (
                <StatusPill tone="pending">Da ricontattare</StatusPill>
              ) : null
            }
          >
            <div className="flex flex-col gap-3">
              {/* Both on one line, neither clipped. The card is ~318px wide on
                  a phone, so the pair has to come in under that: the primary
                  keeps its full label but at 14px in a shorter pill, and the
                  toggle beside it is bare text. flex-wrap stays as the escape
                  hatch — on a 320px screen it drops to a second line rather
                  than truncating anything. */}
              {detail.reservation_id == null && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  {!hasReservationsForPhone && onCreateReservation && (
                    <button
                      onClick={() => {
                        onCreateReservation({
                          callId,
                          customer_name: detail.customer_name || '',
                          phone: detail.phone || '',
                        });
                        onClose();
                      }}
                      className={`${dsButton.primary} h-10 flex-shrink-0 px-4 text-[14px]`}
                    >
                      <CalendarPlus className="h-4 w-4" aria-hidden />
                      Crea prenotazione
                    </button>
                  )}
                  {/* The toggle drops to a text action so the primary keeps its
                      full label. Two solid pills competing for one row is what
                      forced the truncation — and only one of these is the thing
                      you came here to do. No icon: it's the last ~22px needed
                      to keep the pair on one line at 375px. */}
                  <button
                    onClick={() => applyFollowUpPatch({
                      status: detail.follow_up_status === 'CONTACTED' ? 'PENDING' : 'CONTACTED',
                    })}
                    disabled={saving}
                    className="flex-shrink-0 rounded-full text-[14px] font-medium text-[var(--ds-text-primary)] underline underline-offset-4 transition-opacity hover:no-underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {detail.follow_up_status === 'CONTACTED' ? 'Da ricontattare' : 'Segna ricontattato'}
                  </button>
                </div>
              )}
              {detail.follow_up_status === 'CONTACTED' && (detail.follow_up_updated_by_name || detail.follow_up_updated_at) && (
                <div className="text-[13px] text-[var(--ds-text-muted)]">
                  {detail.follow_up_updated_by_name && `Ricontattato da ${detail.follow_up_updated_by_name}`}
                  {detail.follow_up_updated_by_name && detail.follow_up_updated_at && ' · '}
                  {detail.follow_up_updated_at && formatDateTime(detail.follow_up_updated_at)}
                </div>
              )}
              <div>
                <textarea
                  value={notesDraft}
                  onChange={(e) => { setNotesDraft(e.target.value); setNotesDirty(true); }}
                  placeholder="Note utili per la prenotazione…"
                  rows={3}
                  className={`${dsTextarea} resize-y`}
                />
                {(notesDirty || saveError) && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {saveError ? (
                      <span className="text-[13px] text-[var(--ds-critical-text)]">{saveError}</span>
                    ) : <span />}
                    <div className="flex items-center gap-2">
                      {notesDirty && (
                        <button
                          onClick={() => { setNotesDraft(detail.notes ?? ''); setNotesDirty(false); setSaveError(null); }}
                          disabled={saving}
                          className={dsButton.quiet}
                        >
                          Annulla
                        </button>
                      )}
                      <button
                        onClick={() => applyFollowUpPatch({ notes: notesDraft })}
                        disabled={saving || !notesDirty}
                        className={dsButton.primary}
                      >
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Salva note
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </FormCard>

          <FormCard title="Registrazione">
            {audioError ? (
              <Callout tone="critical" icon={AlertCircle}>{audioError}</Callout>
            ) : (
              <CallRecordingPlayer
                src={audioUrl}
                durationSeconds={detail.duration_seconds}
                loading={audioLoading}
                onLoad={loadAudio}
              />
            )}
          </FormCard>

          {/* Trascrizione sopra i messaggi e aperta di default: dopo una
              chiamata è la cosa che si guarda per prima. Entrambe collassabili
              per accorciare la colonna quando servono i messaggi. */}
          <FormCard
            title="Trascrizione"
            aside={<span className="text-[13px] text-[var(--ds-text-muted)]">Agente vocale</span>}
            collapsible
            defaultOpen
          >
            {detail.summary && (
              <div className="mb-4 rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Riassunto</div>
                <p className="text-[15px] leading-relaxed text-[var(--ds-text-primary)]">{detail.summary}</p>
              </div>
            )}
            {turns.length === 0 ? (
              <p className="text-[14px] text-[var(--ds-text-muted)]">Trascrizione non disponibile.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {turns.map((turn, idx) => (
                  <div key={idx} className={`flex ${turn.who === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-[18px] px-3.5 py-2 text-[14px] leading-relaxed ${
                        turn.who === 'user'
                          ? 'rounded-br-[6px] bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)]'
                          : turn.who === 'agent'
                          ? 'rounded-bl-[6px] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
                          : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                      }`}
                    >
                      {turn.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </FormCard>

          <FormCard
            title="Messaggi inviati"
            aside={messages.length > 0 ? <CountBadge count={messages.length} /> : undefined}
            collapsible
            defaultOpen={false}
          >
            {messagesLoading ? (
              <div className="flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Carico messaggi…</span>
              </div>
            ) : messagesError ? (
              <Callout tone="critical" icon={AlertCircle}>{messagesError}</Callout>
            ) : messages.length === 0 ? (
              <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun messaggio inviato a questo numero.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {messages.map(msg => {
                  const badge = messageStatusBadge(msg.status);
                  return (
                    <div key={msg.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                          <span className="font-medium text-[var(--ds-text-primary)]">{channelLabel(msg.channel)}</span>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">{formatDateTime(msg.sent_at)}</span>
                        </div>
                        <StatusPill tone={badge.tone}>{badge.label}</StatusPill>
                      </div>
                      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--ds-text-primary)]">{msg.body}</p>
                      {msg.error_message && (
                        <div className="mt-1.5 flex items-start gap-1 text-[13px] text-[var(--ds-critical-text)]">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                          <span>{msg.error_code ? `${msg.error_code}: ` : ''}{msg.error_message}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </FormCard>
        </>
      )}
      </div>
      </div>

      {detail?.phone && (
        <div className="flex flex-shrink-0 items-center gap-2 bg-[var(--ds-surface)] px-4 py-3 md:hidden">
          {onOpenCustomerProfile && (
            <button
              type="button"
              onClick={() => onOpenCustomerProfile({ phone: detail.phone! })}
              className={`${dsButton.secondary} flex-1`}
            >
              <BookUser className="h-4 w-4" />
              Anagrafica
            </button>
          )}
          <a href={`tel:${detail.phone.replace(/[^\d+]/g, '')}`} className={`${dsButton.primary} flex-1`}>
            <Phone className="h-4 w-4" />
            Chiama
          </a>
        </div>
      )}
    </>
  );
};

interface ConversazioniPageProps {
  reservations: Reservation[];
  onFollowUpChanged?: () => void;
  onCreateReservationFromCall?: (prefill: { callId: number; customer_name: string; phone: string }) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
  // Bumped by App when a background mutation touches voice_calls (e.g. the
  // quick-create flow links the call to the new reservation) so list and
  // open detail refetch without a manual page reload.
  refreshTick?: number;
}

const ConversazioniPage: React.FC<ConversazioniPageProps> = ({ reservations, onFollowUpChanged, onCreateReservationFromCall, onOpenCustomerProfile, refreshTick }) => {
  // Riparte dall'ultimo stato noto della vista di partenza (cache
  // modulo-level, pre-riempita al login): la pagina viene smontata a ogni
  // cambio vista e senza questo ogni rientro mostrava lo spinner. Il fetch
  // parte comunque e rimpiazza in silenzio.
  const [items, setItems] = useState<VoiceCallSummary[]>(() => voiceCallsCache.defaultList?.items ?? []);
  const [total, setTotal] = useState(() => voiceCallsCache.defaultList?.total ?? 0);
  const [loading, setLoading] = useState(voiceCallsCache.defaultList === null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Single-select status filter that mirrors the badges shown on each call
  // row. "to-contact" and "contacted" imply the call has no reservation —
  // the backend translates this into linked=false + follow_up=<state>.
  const [statusFilter, setStatusFilter] = useState<'all' | 'phantom' | 'linked' | 'to-contact' | 'contacted'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Chips and the date range fold away by default — on a phone they cost more
  // room than the first two results.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchItems = useCallback(async () => {
    // Solo la vista di partenza (nessun filtro) passa dalla cache: si mostra
    // subito e il fetch rinfresca in background. Le viste filtrate restano
    // fetch normali con spinner.
    const isDefaultView = !searchDebounced.trim() && statusFilter === 'all' && !from && !to;
    const cached = isDefaultView ? voiceCallsCache.defaultList : null;
    if (cached) {
      setItems(cached.items);
      setTotal(cached.total);
    }
    setLoading(!cached);
    setError(null);
    try {
      const params: VoiceCallsListParams = { limit: 100 };
      if (searchDebounced.trim()) params.q = searchDebounced.trim();
      if (statusFilter === 'linked') {
        params.linked = 'true';
      } else if (statusFilter === 'to-contact') {
        params.linked = 'false';
        params.follow_up = 'pending';
      } else if (statusFilter === 'contacted') {
        params.linked = 'false';
        params.follow_up = 'contacted';
      } else if (statusFilter === 'phantom') {
        params.phantom = 'true';
      }
      if (from) params.from = from;
      if (to) params.to = to;
      const result = await voiceCallsApiService.list(params);
      if (isDefaultView) voiceCallsCache.defaultList = result;
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      if (!cached) setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [searchDebounced, statusFilter, from, to]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems, refreshTick]);

  // Client-side filter as a safety net: if the backend hasn't been redeployed
  // yet (or ignores the follow_up param for any reason), we still show the
  // right rows for each chip. Idempotent when the server already filters
  // correctly. Kept in sync with the row-level badge logic.
  const visibleItems = useMemo(() => {
    if (statusFilter === 'linked') {
      return items.filter(i => i.reservation_id != null);
    }
    if (statusFilter === 'to-contact') {
      return items.filter(i => i.reservation_id == null && i.follow_up_status !== 'CONTACTED');
    }
    if (statusFilter === 'contacted') {
      return items.filter(i => i.reservation_id == null && i.follow_up_status === 'CONTACTED');
    }
    if (statusFilter === 'phantom') {
      return items.filter(i => i.phantom_confirmation === true && i.phantom_recovered !== true);
    }
    return items;
  }, [items, statusFilter]);

  // Prefer the local count when a status filter is active — the server may
  // return more rows than the chip advertises (e.g. before the follow_up
  // param is redeployed). Once the server catches up, both counts match.
  const displayedCount = statusFilter === 'all' ? total : visibleItems.length;

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await voiceCallsApiService.sync();
      setSyncMessage(`Importate ${result.imported} · numeri recuperati ${result.backfilled} · saltate ${result.skipped}${result.failed ? ` · errori ${result.failed}` : ''}`);
      await fetchItems();
    } catch (err) {
      setSyncMessage(`Errore: ${(err as Error).message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(null), 5000);
    }
  }, [fetchItems]);

  // Bulk "segna tutte come ricontattate": two-step confirm (first click arms
  // the button, second within 4s executes) so a stray tap can't flip the
  // whole queue. Result lands in the same message slot used by sync.
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllArmed, setMarkAllArmed] = useState(false);
  const markAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (markAllTimerRef.current) clearTimeout(markAllTimerRef.current); }, []);
  const handleMarkAllContacted = useCallback(async () => {
    if (!markAllArmed) {
      setMarkAllArmed(true);
      if (markAllTimerRef.current) clearTimeout(markAllTimerRef.current);
      markAllTimerRef.current = setTimeout(() => setMarkAllArmed(false), 4000);
      return;
    }
    if (markAllTimerRef.current) clearTimeout(markAllTimerRef.current);
    setMarkAllArmed(false);
    setMarkingAll(true);
    setSyncMessage(null);
    try {
      const { updated } = await voiceCallsApiService.markAllContacted();
      setSyncMessage(updated > 0
        ? `${updated} conversazion${updated === 1 ? 'e segnata' : 'i segnate'} come ricontattat${updated === 1 ? 'a' : 'e'}`
        : 'Nessuna conversazione da ricontattare');
      await fetchItems();
      onFollowUpChanged?.();
    } catch (err) {
      setSyncMessage(`Errore: ${(err as Error).message}`);
    } finally {
      setMarkingAll(false);
      setTimeout(() => setSyncMessage(null), 5000);
    }
  }, [markAllArmed, fetchItems, onFollowUpChanged]);

  // Swipe-right on a pending call. Same endpoint the detail modal's
  // "Ricontattato" button uses — the gesture is a shortcut to it,
  // not a new path. Takes the whole group: when the same number called
  // twice, marking the visible card must clear the hidden attempts too,
  // or they'd resurface as still-pending on the next fetch.
  const markContacted = useCallback(async (calls: VoiceCallSummary[]) => {
    try {
      await Promise.all(calls.map(c => voiceCallsApiService.updateFollowUp(c.id, { status: 'CONTACTED' })));
      await fetchItems();
      onFollowUpChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [fetchItems, onFollowUpChanged]);

  const statusChips = [
    { value: 'all' as const, label: 'Tutte' },
    { value: 'phantom' as const, label: 'Da recuperare', dot: 'bg-[var(--ds-critical-solid)]' },
    { value: 'linked' as const, label: 'Con prenotazione', dot: 'bg-[var(--ds-seated-solid)]' },
    { value: 'to-contact' as const, label: 'Da ricontattare', dot: 'bg-[var(--ds-pending-solid)]' },
    { value: 'contacted' as const, label: 'Ricontattati', dot: 'bg-[var(--ds-seated-solid)]' },
  ];
  const hasActiveFilters = statusFilter !== 'all' || !!from || !!to;
  const resetAll = () => {
    setStatusFilter('all');
    setFrom('');
    setTo('');
    setSearch('');
  };

  // A call is "da ricontattare" when nobody has called back and it isn't
  // already tied to a reservation. Pure derivation over rows already loaded —
  // the section pins them to the top instead of leaving them scattered by time.
  const needsCallback = (c: VoiceCallSummary) =>
    c.reservation_id == null && c.follow_up_status !== 'CONTACTED';
  const pendingCalls = visibleItems.filter(needsCallback);
  const handledCalls = visibleItems.filter(c => !needsCallback(c));
  const swipeHint = useFirstRunHint('ds-swipe-hint-chiamate');

  // Same number, several missed attempts → one card. Grouped on the last 10
  // digits (same rule as the reservation phone lookups: staff numbers without
  // +39 must match E.164 caller ids); calls without a phone stay individual.
  // The card shows the newest attempt; list order follows it.
  const pendingGroups = (() => {
    const groups: VoiceCallSummary[][] = [];
    const byPhone = new Map<string, VoiceCallSummary[]>();
    for (const c of pendingCalls) {
      const key = (c.phone || '').replace(/\D/g, '').slice(-10);
      if (!key) { groups.push([c]); continue; }
      const existing = byPhone.get(key);
      if (existing) { existing.push(c); continue; }
      const group: VoiceCallSummary[] = [c];
      byPhone.set(key, group);
      groups.push(group);
    }
    return groups;
  })();

  const renderCall = (item: VoiceCallSummary, hint: boolean, group: VoiceCallSummary[] = [item]) => {
    const resBadge = reservationStatusBadge(item.reservation_status);
    const phantomOpen = item.phantom_confirmation && !item.phantom_recovered;
    const pending = needsCallback(item);
    const tel = (item.phone || '').replace(/[^\d+]/g, '');
    return (
      <SwipeRow
        key={item.id}
        hint={hint}
        left={pending ? {
          label: 'Ricontattato',
          tone: 'confirm',
          icon: <Check className="h-4 w-4" aria-hidden />,
          onAction: () => markContacted(group),
        } : undefined}
        right={tel ? {
          label: 'Richiama',
          tone: 'primary',
          icon: <ArrowRight className="h-4 w-4" aria-hidden />,
          onAction: () => { window.location.href = `tel:${tel}`; },
        } : undefined}
      >
        <button
          type="button"
          onClick={() => setSelectedId(item.id)}
          className="flex w-full gap-3 bg-[var(--ds-surface)] p-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
        >
          <Avatar icon={Phone} tone={pending || phantomOpen ? 'critical' : 'neutral'} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                {toTitleCase(item.customer_name) || formatPhone(item.phone)}
              </span>
              <span className="flex-shrink-0 whitespace-nowrap text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                {formatDateTime(item.created_at)}
              </span>
            </div>
            {item.customer_name && item.phone && (
              <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">{item.phone}</div>
            )}
            {item.summary && (
              <p className="mt-0.5 truncate text-[14px] text-[var(--ds-text-muted)]">{item.summary}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {phantomOpen && (
                <StatusPill
                  tone="critical"
                  title="L'agent ha detto 'confermata' senza creare davvero la prenotazione — richiamare il cliente"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-critical-solid)]" aria-hidden />
                  Da recuperare
                </StatusPill>
              )}
              {resBadge && (
                <StatusPill tone={resBadge.tone}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
                  {resBadge.label}
                </StatusPill>
              )}
              {!phantomOpen && item.reservation_id == null && (
                <StatusPill tone={item.follow_up_status === 'CONTACTED' ? 'positive' : 'critical'}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
                  {item.follow_up_status === 'CONTACTED' ? 'Ricontattato' : 'Da ricontattare'}
                </StatusPill>
              )}
              {group.length > 1 && (
                <StatusPill
                  tone="pending"
                  title={`Lo stesso numero ha chiamato ${group.length} volte — "Ricontattato" le segna tutte`}
                >
                  {group.length} chiamate
                </StatusPill>
              )}
              {/* Handoff reason badge: shown alongside the follow-up status so
                  the operator knows *why* this call needs a callback (agent
                  redirected a large group). */}
              {!phantomOpen && item.reservation_id == null && item.large_group_handoff && (
                <StatusPill
                  tone="info"
                  title="Il cliente voleva prenotare per un gruppo grande — l'agent ha promesso una richiamata"
                >
                  Gruppo grande
                </StatusPill>
              )}
              <StatusPill tone="neutral" title="Durata">
                {formatDuration(item.duration_seconds)}
              </StatusPill>
            </div>
          </div>
        </button>
      </SwipeRow>
    );
  };

  return (
    <>
      {/* No visible page title: the desktop sidebar and the mobile switcher
          both already name this screen. The heading stays for screen readers. */}
      <h1 className="sr-only">Chiamate</h1>
      <SplitPane
        detailOpen={selectedId !== null}
        toolbar={
          <div className="space-y-3">
            {/* One row: search, filters, sync. Filters live behind the toggle
                because they cost more vertical space than the first two rows
                of results. */}
            <div className="flex items-center gap-2">
              <SearchField
                className="min-w-0 flex-1"
                value={search}
                onChange={setSearch}
                placeholder="Cerca telefono, nome, riassunto"
              />
              <button
                type="button"
                onClick={() => setFiltersOpen(v => !v)}
                aria-expanded={filtersOpen}
                aria-label="Filtri"
                title="Filtri"
                className={filtersOpen
                  ? 'relative inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-card)] transition-colors'
                  : `relative ${dsIconButton}`}
              >
                <ListFilter className="h-4 w-4" />
                {/* A filter you can't see is a filter you forget you set. */}
                {hasActiveFilters && !filtersOpen && (
                  <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--ds-critical-solid)] ring-2 ring-[var(--ds-surface)]" aria-hidden />
                )}
              </button>
              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                aria-label="Sincronizza"
                title="Sincronizza"
                className={dsIconButton}
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {filtersOpen && (
              <div className="space-y-3 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
                <SegmentedControl
                  value={statusFilter}
                  onChange={next => setStatusFilter(next)}
                  ariaLabel="Filtra per stato"
                  overflow="scroll"
                  size="sm"
                  options={statusChips.map(c => ({
                    value: c.value,
                    label: c.label,
                    // The dot keeps its semantic colour when selected — it
                    // names the state, so inverting it to white throws the
                    // meaning away.
                    icon: c.dot ? <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${c.dot}`} aria-hidden /> : undefined,
                  }))}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    aria-label="Da"
                    className="h-10 min-w-0 flex-1 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  />
                  <span className="flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden>→</span>
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    aria-label="A"
                    className="h-10 min-w-0 flex-1 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-[13px] text-[var(--ds-text-muted)]">
                  <span className="tabular-nums">{displayedCount} chiamat{displayedCount === 1 ? 'a' : 'e'}</span>
                  {(hasActiveFilters || search) && (
                    <button
                      onClick={resetAll}
                      className="font-medium text-[var(--ds-text-primary)] underline-offset-4 hover:underline"
                    >
                      Reimposta filtri
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        }
        list={
          <div className="space-y-3">
            {/* One slot for both outcomes of a sync or a bulk mark — the
                string already carries which one it was. */}
            {syncMessage && (
              <Callout
                tone={syncMessage.startsWith('Errore') ? 'critical' : 'info'}
                icon={syncMessage.startsWith('Errore') ? AlertCircle : CheckCircle2}
              >
                {syncMessage}
              </Callout>
            )}

            {error && <Callout tone="critical" icon={AlertCircle}>{error}</Callout>}

            {loading ? (
              <SkeletonInboxList count={6} className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)]" />
            ) : visibleItems.length === 0 ? (
              <EmptyState icon={Phone}>
                {statusFilter === 'to-contact'
                  ? 'Nessuna chiamata da ricontattare.'
                  : statusFilter === 'contacted'
                    ? 'Nessuna chiamata ricontattata.'
                    : statusFilter === 'linked'
                      ? 'Nessuna chiamata collegata a una prenotazione.'
                      : 'Nessuna conversazione. Prova a sincronizzare se ne hai di recenti.'}
              </EmptyState>
            ) : (
              <div className="space-y-1">
                {pendingCalls.length > 0 && (
                  <>
                    <SectionHeader
                      tone="attention"
                      action={
                        <button
                          onClick={handleMarkAllContacted}
                          disabled={markingAll}
                          title="Segna tutte le conversazioni in attesa come ricontattate"
                          className={`flex-shrink-0 text-[13px] font-semibold underline-offset-4 hover:underline disabled:opacity-50 ${
                            markAllArmed ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
                          }`}
                        >
                          {markingAll ? 'Attendi…' : markAllArmed ? 'Confermi?' : 'Segna tutte'}
                        </button>
                      }
                    >
                      Da ricontattare
                    </SectionHeader>
                    <div className="space-y-2 pb-2">
                      {pendingGroups.map((group, i) => renderCall(group[0], swipeHint && i === 0, group))}
                    </div>
                  </>
                )}
                {handledCalls.length > 0 && (
                  <>
                    {/* Always the same label, whether or not "Da ricontattare"
                        sits above it — Messaggi and Email name their remainder
                        section the same way at both times. */}
                    <SectionHeader>Tutte le chiamate</SectionHeader>
                    <div className="space-y-2">
                      {handledCalls.map((c, i) => renderCall(c, swipeHint && pendingCalls.length === 0 && i === 0))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        }
        detail={
          selectedId !== null ? (
            <CallDetail
              key={selectedId}
              callId={selectedId}
              reservations={reservations}
              onClose={() => setSelectedId(null)}
              onFollowUpChanged={() => { fetchItems(); onFollowUpChanged?.(); }}
              onCreateReservation={onCreateReservationFromCall}
              onOpenCustomerProfile={onOpenCustomerProfile}
              refreshTick={refreshTick}
              siblingPendingIds={(pendingGroups.find(g => g.some(c => c.id === selectedId)) ?? [])
                .filter(c => c.id !== selectedId)
                .map(c => c.id)}
            />
          ) : (
            <PanePlaceholder icon={Phone}>Seleziona una chiamata dalla lista</PanePlaceholder>
          )
        }
      />
    </>
  );
};

export default ConversazioniPage;
