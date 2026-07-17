import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, RefreshCw, Search, X, Loader2, Calendar, Clock, MessageSquare,
  CheckCircle2, AlertCircle, Filter, ExternalLink, Play, StickyNote, CalendarPlus,
  BookUser, Send, Check, Users,
} from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
  voiceCallsApiService,
  VoiceCallSummary,
  VoiceCallDetail,
  VoiceCallsListParams,
  FollowUpStatus,
  OutboundMessage,
} from '../services/voiceCallsApiService';
import { Reservation } from '../types';

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

const messageStatusBadge = (status: string | null | undefined): { label: string; cls: string } => {
  const s = (status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return { label: 'Consegnato', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (s === 'sent' || s === 'queued' || s === 'accepted' || s === 'sending') return { label: 'Inviato', cls: 'bg-sky-50 text-sky-700 ring-sky-200' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Fallito', cls: 'bg-rose-50 text-rose-700 ring-rose-200' };
  return { label: s || 'In coda', cls: 'bg-slate-50 text-slate-700 ring-slate-200' };
};

const channelLabel = (channel: string): string => {
  if (channel === 'sms') return 'SMS';
  if (channel === 'whatsapp') return 'WhatsApp';
  return channel;
};

const reservationStatusBadge = (status: string | null | undefined): { label: string; cls: string } | null => {
  if (!status) return null;
  switch (status) {
    case 'CONFIRMED': return { label: 'Confermata', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
    case 'CANCELLED': return { label: 'Annullata', cls: 'bg-rose-50 text-rose-700 ring-rose-200' };
    case 'PENDING': return { label: 'In attesa', cls: 'bg-amber-50 text-amber-700 ring-amber-200' };
    default: return { label: status, cls: 'bg-slate-50 text-slate-700 ring-slate-200' };
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

interface DetailModalProps {
  callId: number;
  reservations: Reservation[];
  onClose: () => void;
  onFollowUpChanged?: () => void;
  onCreateReservation?: (prefill: { callId: number; customer_name: string; phone: string }) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
}

const DetailModal: React.FC<DetailModalProps> = ({ callId, reservations, onClose, onFollowUpChanged, onCreateReservation, onOpenCustomerProfile }) => {
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    voiceCallsApiService.getById(callId)
      .then(d => {
        if (cancelled) return;
        setDetail(d);
        setNotesDraft(d.notes ?? '');
        setNotesDirty(false);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callId]);

  useEffect(() => {
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
    voiceCallsApiService.listMessages(callId)
      .then(r => { if (!cancelled) setMessages(r.items); })
      .catch((err: Error) => { if (!cancelled) setMessagesError(err.message); })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [callId]);

  const markPhantomRecovered = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await voiceCallsApiService.markPhantomRecovered(callId);
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
  }, [callId, onFollowUpChanged]);

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

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-line)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Phone className="h-4 w-4 text-[var(--color-fg-muted)] shrink-0" />
            <div className="flex flex-col min-w-0">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)] truncate">
                {detail ? (detail.customer_name || formatPhone(detail.phone)) : 'Conversazione'}
              </h2>
              {detail?.customer_name && detail.phone && (
                <span className="text-[12px] text-[var(--color-fg-muted)] tabular truncate">
                  {detail.phone}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {detail?.phone && onOpenCustomerProfile && (
              <button
                type="button"
                onClick={() => onOpenCustomerProfile({ phone: detail.phone! })}
                className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors"
                aria-label="Apri anagrafica cliente"
                title="Apri anagrafica cliente"
              >
                <BookUser className="h-4 w-4" />
              </button>
            )}
            {detail?.phone && (
              <a
                href={`tel:${detail.phone.replace(/[^\d+]/g, '')}`}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 text-[12px] font-medium transition-colors"
                aria-label="Chiama"
                title="Chiama"
              >
                <Phone className="h-3.5 w-3.5" />
                Chiama
              </a>
            )}
            <button
              onClick={onClose}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]"
              aria-label="Chiudi"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <CookingPotLoader label="Carico dettaglio…" size={40} />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 text-rose-700 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {detail && !loading && (
            <>
              <div className="grid grid-cols-2 gap-3 text-[13px]">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Data</div>
                  <div className="text-[var(--color-fg)] mt-0.5">{formatDateTime(detail.created_at)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium">Durata</div>
                  <div className="text-[var(--color-fg)] mt-0.5 tabular">{formatDuration(detail.duration_seconds)}</div>
                </div>
              </div>

              {hasReservationsForPhone && (
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium flex items-center gap-1.5">
                    <Calendar className="h-3 w-3" />
                    Prenotazioni per questo numero
                    <span className="text-[var(--color-fg-muted)] font-normal">· {reservationsForPhone.length}</span>
                  </div>
                  {reservationsForPhone.map(res => {
                    const badge = reservationStatusBadge(res.reservation_status ?? null);
                    const isLinked = detail.reservation_id === res.id;
                    return (
                      <div key={res.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)] min-w-0">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                            <span className="font-medium truncate">{res.customer_name || 'Prenotazione'}</span>
                            {badge && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${badge.cls}`}>
                                {badge.label}
                              </span>
                            )}
                            {isLinked && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-indigo-50 text-indigo-700 ring-indigo-200 shrink-0">
                                Collegata
                              </span>
                            )}
                          </div>
                          <a
                            href={`/?view=RESERVATIONS&reservationId=${res.id}`}
                            className="text-[12px] text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1 shrink-0"
                          >
                            Apri <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <div className="text-[12px] text-[var(--color-fg-muted)] mt-1">
                          {formatDateTime(res.reservation_time)}
                          {res.guests != null && ` · ${res.guests} ospiti`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Fallback: call is linked to a reservation that isn't in the
                  current list (e.g. filtered out by date range or phone
                  mismatch after normalization) — still show its summary. */}
              {!hasReservationsForPhone && detail.reservation_id && (
                <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)]">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span className="font-medium">{detail.reservation_customer_name || 'Prenotazione'}</span>
                      {resBadge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset ${resBadge.cls}`}>
                          {resBadge.label}
                        </span>
                      )}
                    </div>
                    <a
                      href={`/?view=RESERVATIONS&reservationId=${detail.reservation_id}`}
                      className="text-[12px] text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1"
                    >
                      Apri <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  {detail.reservation_time && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] mt-1">
                      {formatDateTime(detail.reservation_time)}
                      {detail.reservation_guests != null && ` · ${detail.reservation_guests} ospiti`}
                    </div>
                  )}
                </div>
              )}

              {detail.summary && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-1">Riassunto</div>
                  <p className="text-[13px] text-[var(--color-fg)] leading-relaxed">{detail.summary}</p>
                </div>
              )}

              {detail.phantom_confirmation && !detail.phantom_recovered && (
                <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/40 p-3">
                  <div className="flex items-start gap-2 text-[13px] text-rose-800 dark:text-rose-200">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">Prenotazione da recuperare</div>
                      <div className="text-[12px] mt-0.5 opacity-90">
                        L'agent ha detto al cliente che la prenotazione è confermata, ma non è mai stata invocata la creazione nel CRM. Richiama il cliente per confermare o annullare, poi crea manualmente la prenotazione.
                      </div>
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={markPhantomRecovered}
                          disabled={saving}
                          className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg font-medium border border-rose-300 bg-white text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:bg-transparent dark:text-rose-100 dark:border-rose-400/60 dark:hover:bg-rose-500/20"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Segna come recuperata
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {detail.phantom_confirmation && detail.phantom_recovered && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-500/10 dark:border-emerald-500/40 p-3">
                  <div className="flex items-start gap-2 text-[13px] text-emerald-800 dark:text-emerald-200">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-semibold">Prenotazione recuperata</div>
                      <div className="text-[12px] mt-0.5 opacity-90">
                        La conferma fantasma dell'agent è stata gestita.
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {/* Large-group handoff: agent redirected the caller to a human
                  because the party was above the configurable threshold.
                  Distinct from phantom (which is an agent hallucination);
                  this one is expected behavior and just needs a callback. */}
              {detail.large_group_handoff && !detail.reservation_id && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 dark:bg-indigo-500/10 dark:border-indigo-500/40 p-3">
                  <div className="flex items-start gap-2 text-[13px] text-indigo-800 dark:text-indigo-200">
                    <Users className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                      <div className="font-semibold">Gruppo grande — richiamare</div>
                      <div className="text-[12px] mt-0.5 opacity-90">
                        Il cliente voleva prenotare per un gruppo oltre la soglia dell'agent. Sofia ha detto che avremmo richiamato: concorda con lui data, orario e mise en place.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg)]">
                    <StickyNote className="h-4 w-4 text-[var(--color-fg-muted)]" />
                    <span className="font-medium">Follow-up</span>
                    {detail.follow_up_status === 'CONTACTED' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200">
                        Ricontattato
                      </span>
                    ) : detail.reservation_id == null ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200">
                        Da ricontattare
                      </span>
                    ) : null}
                  </div>
                  {detail.reservation_id == null && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => applyFollowUpPatch({
                          status: detail.follow_up_status === 'CONTACTED' ? 'PENDING' : 'CONTACTED',
                        })}
                        disabled={saving}
                        className={`text-[12px] px-2.5 py-1 rounded-lg font-medium border transition-colors disabled:opacity-50 ${
                          detail.follow_up_status === 'CONTACTED'
                            ? 'border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        }`}
                      >
                        {detail.follow_up_status === 'CONTACTED' ? 'Segna come da ricontattare' : 'Segna come ricontattato'}
                      </button>
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
                          className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg font-medium bg-indigo-600 text-white hover:bg-indigo-700"
                        >
                          <CalendarPlus className="h-3.5 w-3.5" />
                          Crea prenotazione
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {detail.follow_up_status === 'CONTACTED' && (detail.follow_up_updated_by_name || detail.follow_up_updated_at) && (
                  <div className="text-[11px] text-[var(--color-fg-muted)]">
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
                    className="w-full px-3 py-2 text-[13px] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 resize-y"
                  />
                  {(notesDirty || saveError) && (
                    <div className="flex items-center justify-between gap-2 mt-2">
                      {saveError ? (
                        <span className="text-[11px] text-rose-600">{saveError}</span>
                      ) : <span />}
                      <div className="flex items-center gap-2">
                        {notesDirty && (
                          <button
                            onClick={() => { setNotesDraft(detail.notes ?? ''); setNotesDirty(false); setSaveError(null); }}
                            disabled={saving}
                            className="text-[12px] px-2.5 py-1 rounded-lg text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                          >
                            Annulla
                          </button>
                        )}
                        <button
                          onClick={() => applyFollowUpPatch({ notes: notesDraft })}
                          disabled={saving || !notesDirty}
                          className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                          Salva note
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-2">Audio</div>
                {audioUrl ? (
                  <audio controls src={audioUrl} className="w-full" />
                ) : audioError ? (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 text-rose-700 text-[12px]">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{audioError}</span>
                  </div>
                ) : (
                  <button
                    onClick={loadAudio}
                    disabled={audioLoading}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] text-[13px] text-[var(--color-fg)] disabled:opacity-50"
                  >
                    {audioLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {audioLoading ? 'Carico…' : 'Carica audio'}
                  </button>
                )}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-2 flex items-center gap-1.5">
                  <Send className="h-3 w-3" />
                  Messaggi inviati
                  {messages.length > 0 && (
                    <span className="text-[var(--color-fg-muted)] font-normal">· {messages.length}</span>
                  )}
                </div>
                {messagesLoading ? (
                  <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Carico messaggi…</span>
                  </div>
                ) : messagesError ? (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-[12px]">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{messagesError}</span>
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-[12px] text-[var(--color-fg-subtle)] italic">Nessun messaggio inviato a questo numero.</p>
                ) : (
                  <div className="space-y-2">
                    {messages.map(msg => {
                      const badge = messageStatusBadge(msg.status);
                      return (
                        <div key={msg.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-3">
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                              <span className="font-medium text-[var(--color-fg)]">{channelLabel(msg.channel)}</span>
                              <span>·</span>
                              <span className="tabular">{formatDateTime(msg.sent_at)}</span>
                            </div>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </div>
                          <p className="text-[13px] text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                          {msg.error_message && (
                            <div className="mt-1.5 text-[11px] text-rose-600 flex items-start gap-1">
                              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                              <span>{msg.error_code ? `${msg.error_code}: ` : ''}{msg.error_message}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-medium mb-2">Trascrizione</div>
                {turns.length === 0 ? (
                  <p className="text-[13px] text-[var(--color-fg-subtle)] italic">Trascrizione non disponibile.</p>
                ) : (
                  <div className="space-y-2">
                    {turns.map((turn, idx) => (
                      <div
                        key={idx}
                        className={`flex ${turn.who === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                            turn.who === 'user'
                              ? 'bg-indigo-600 text-white rounded-br-sm'
                              : turn.who === 'agent'
                              ? 'bg-[var(--color-bg)] text-[var(--color-fg)] border border-[var(--color-line)] rounded-bl-sm'
                              : 'bg-amber-50 text-amber-900 border border-amber-200'
                          }`}
                        >
                          {turn.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface ConversazioniPageProps {
  reservations: Reservation[];
  onFollowUpChanged?: () => void;
  onCreateReservationFromCall?: (prefill: { callId: number; customer_name: string; phone: string }) => void;
  onOpenCustomerProfile?: (args: { phone: string }) => void;
}

const ConversazioniPage: React.FC<ConversazioniPageProps> = ({ reservations, onFollowUpChanged, onCreateReservationFromCall, onOpenCustomerProfile }) => {
  const [items, setItems] = useState<VoiceCallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Single-select status filter that mirrors the badges shown on each call
  // row. "to-contact" and "contacted" imply the call has no reservation —
  // the backend translates this into linked=false + follow_up=<state>.
  const [statusFilter, setStatusFilter] = useState<'all' | 'phantom' | 'linked' | 'to-contact' | 'contacted'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
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
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [searchDebounced, statusFilter, from, to]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

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

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-[var(--color-fg)]">Conversazioni</h1>
            <p className="text-[13px] text-[var(--color-fg-muted)] mt-0.5">
              Chiamate gestite dall'agent vocale ElevenLabs
            </p>
          </div>
          <div className="flex items-center gap-2">
            {syncMessage && (
              <span className="text-[12px] text-[var(--color-fg-muted)]">{syncMessage}</span>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sincronizza
            </button>
          </div>
        </div>

        {(() => {
          const statusChips = [
            { v: 'all', l: 'Tutte', dot: null },
            { v: 'phantom', l: '⚠︎ Da recuperare', dot: 'bg-rose-500' },
            { v: 'linked', l: 'Con prenotazione', dot: 'bg-emerald-500' },
            { v: 'to-contact', l: 'Da ricontattare', dot: 'bg-amber-500' },
            { v: 'contacted', l: 'Ricontattati', dot: 'bg-emerald-500' },
          ] as const;
          const hasActiveFilters =
            statusFilter !== 'all' || !!from || !!to || !!searchDebounced.trim();
          const resetAll = () => {
            setStatusFilter('all');
            setFrom('');
            setTo('');
            setSearch('');
          };
          return (
            <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-3 md:p-4 space-y-3">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-fg-subtle)] pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cerca telefono, nome, riassunto, trascrizione…"
                  className="w-full pl-8 pr-8 py-2 text-[13px] rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-full text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                    aria-label="Svuota ricerca"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Quick filter chips — scrolls horizontally on narrow screens */}
              <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {statusChips.map(({ v, l, dot }) => {
                  const active = statusFilter === v;
                  return (
                    <button
                      key={v}
                      onClick={() => setStatusFilter(v)}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                          : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)]'
                      }`}
                    >
                      {dot && (
                        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-white/90' : dot}`} />
                      )}
                      {l}
                    </button>
                  );
                })}
              </div>

              {/* Period + count + reset */}
              <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--color-fg-muted)] pt-1 border-t border-[var(--color-line)]">
                <div className="flex items-center gap-2 flex-wrap pt-2">
                  <Filter className="h-3.5 w-3.5" />
                  <span>Periodo:</span>
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular min-w-[120px]"
                  />
                  <span>→</span>
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular min-w-[120px]"
                  />
                  {(from || to) && (
                    <button
                      onClick={() => { setFrom(''); setTo(''); }}
                      className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                      aria-label="Svuota periodo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-2 pt-2">
                  {hasActiveFilters && (
                    <button
                      onClick={resetAll}
                      className="text-indigo-600 hover:text-indigo-700 font-medium"
                    >
                      Reimposta filtri
                    </button>
                  )}
                  <span className="tabular">{displayedCount} conversazion{displayedCount === 1 ? 'e' : 'i'}</span>
                </div>
              </div>
            </div>
          );
        })()}

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 text-rose-700 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <CookingPotLoader label="Carico…" />
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-10 text-center">
            <Phone className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              {statusFilter === 'to-contact'
                ? 'Nessuna chiamata da ricontattare.'
                : statusFilter === 'contacted'
                  ? 'Nessuna chiamata ricontattata.'
                  : statusFilter === 'linked'
                    ? 'Nessuna chiamata collegata a una prenotazione.'
                    : 'Nessuna conversazione. Prova a sincronizzare se ne hai di recenti.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleItems.map(item => {
              const resBadge = reservationStatusBadge(item.reservation_status);
              const phantomOpen = item.phantom_confirmation && !item.phantom_recovered;
              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left bg-[var(--color-surface)] rounded-xl border p-3 md:p-4 hover:shadow-sm transition-all ${
                    phantomOpen
                      ? 'border-rose-300 ring-1 ring-rose-200 hover:border-rose-400'
                      : 'border-[var(--color-line)] hover:border-[var(--color-line-strong)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Phone className={`h-4 w-4 shrink-0 ${phantomOpen ? 'text-rose-600' : 'text-[var(--color-fg-muted)]'}`} />
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium text-[14px] text-[var(--color-fg)] truncate">
                          {item.customer_name || formatPhone(item.phone)}
                        </span>
                        {item.customer_name && item.phone && (
                          <span className="text-[11px] text-[var(--color-fg-muted)] tabular truncate">
                            {item.phone}
                          </span>
                        )}
                      </div>
                      {phantomOpen && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold ring-1 ring-inset shrink-0 bg-rose-50 text-rose-700 ring-rose-300"
                          title="L'agent ha detto 'confermata' senza creare davvero la prenotazione — richiamare il cliente"
                        >
                          ⚠︎ Da recuperare
                        </span>
                      )}
                      {resBadge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${resBadge.cls}`}>
                          {resBadge.label}
                        </span>
                      )}
                      {!phantomOpen && item.reservation_id == null && item.follow_up_status === 'CONTACTED' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 bg-emerald-50 text-emerald-700 ring-emerald-200">
                          Ricontattato
                        </span>
                      )}
                      {!phantomOpen && item.reservation_id == null && item.follow_up_status !== 'CONTACTED' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 bg-amber-50 text-amber-700 ring-amber-200">
                          Da ricontattare
                        </span>
                      )}
                      {/* Handoff reason badge: shown alongside the follow-up
                          status so the operator knows *why* this call needs
                          a callback (agent redirected a large group). */}
                      {!phantomOpen && item.reservation_id == null && item.large_group_handoff && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold ring-1 ring-inset shrink-0 bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30"
                          title="Il cliente voleva prenotare per un gruppo grande — l'agent ha promesso una richiamata"
                        >
                          Gruppo grande
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[12px] text-[var(--color-fg-muted)] shrink-0">
                      <span className="inline-flex items-center gap-1 tabular">
                        <Clock className="h-3 w-3" />
                        {formatDuration(item.duration_seconds)}
                      </span>
                      <span className="inline-flex items-center gap-1 tabular">
                        <Calendar className="h-3 w-3" />
                        {formatDateTime(item.created_at)}
                      </span>
                    </div>
                  </div>
                  {item.summary && (
                    <p className="text-[13px] text-[var(--color-fg-muted)] mt-2 line-clamp-2 flex items-start gap-1.5">
                      <MessageSquare className="h-3 w-3 mt-1 shrink-0" />
                      <span>{item.summary}</span>
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedId !== null && (
        <DetailModal
          callId={selectedId}
          reservations={reservations}
          onClose={() => setSelectedId(null)}
          onFollowUpChanged={() => { fetchItems(); onFollowUpChanged?.(); }}
          onCreateReservation={onCreateReservationFromCall}
          onOpenCustomerProfile={onOpenCustomerProfile}
        />
      )}
    </div>
  );
};

export default ConversazioniPage;
