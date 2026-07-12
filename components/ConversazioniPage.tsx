import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, RefreshCw, Search, X, Loader2, Calendar, Clock, MessageSquare,
  CheckCircle2, AlertCircle, Filter, ExternalLink, Play,
} from 'lucide-react';
import {
  voiceCallsApiService,
  VoiceCallSummary,
  VoiceCallDetail,
  VoiceCallsListParams,
} from '../services/voiceCallsApiService';

const formatDuration = (secs: number | null | undefined): string => {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
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
  onClose: () => void;
}

const DetailModal: React.FC<DetailModalProps> = ({ callId, onClose }) => {
  const [detail, setDetail] = useState<VoiceCallDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    voiceCallsApiService.getById(callId)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callId]);

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[80] p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--color-line)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-[var(--color-fg-muted)]" />
            <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">
              {detail ? formatPhone(detail.phone) : 'Conversazione'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-[var(--color-fg-muted)]">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">Carico dettaglio…</span>
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

              {detail.reservation_id && (
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
                      href={`/?view=RESERVATIONS`}
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

const ConversazioniPage: React.FC = () => {
  const [items, setItems] = useState<VoiceCallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [linkedFilter, setLinkedFilter] = useState<'all' | 'true' | 'false'>('all');
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
      if (linkedFilter !== 'all') params.linked = linkedFilter;
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
  }, [searchDebounced, linkedFilter, from, to]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

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
    <div className="min-h-screen bg-[var(--color-bg)] pb-20 md:pb-8">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 md:py-6 space-y-4">
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

        <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-3 md:p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-fg-subtle)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca telefono, riassunto, trascrizione…"
                className="w-full pl-8 pr-3 py-1.5 text-[13px] rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-[var(--color-line)] p-0.5 bg-[var(--color-bg)]">
              {([
                { v: 'all', l: 'Tutte' },
                { v: 'true', l: 'Con prenotazione' },
                { v: 'false', l: 'Senza' },
              ] as const).map(({ v, l }) => (
                <button
                  key={v}
                  onClick={() => setLinkedFilter(v)}
                  className={`px-2.5 py-1 text-[12px] rounded-md ${
                    linkedFilter === v
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--color-fg-muted)]">
            <Filter className="h-3.5 w-3.5" />
            <span>Periodo:</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular"
            />
            <span>→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg)] text-[12px] tabular"
            />
            {(from || to) && (
              <button
                onClick={() => { setFrom(''); setTo(''); }}
                className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="ml-auto tabular">{total} conversazion{total === 1 ? 'e' : 'i'}</span>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 text-rose-700 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-[var(--color-fg-muted)]">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Carico…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-10 text-center">
            <Phone className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Nessuna conversazione. Prova a sincronizzare se ne hai di recenti.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map(item => {
              const resBadge = reservationStatusBadge(item.reservation_status);
              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className="w-full text-left bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-3 md:p-4 hover:border-[var(--color-line-strong)] hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Phone className="h-4 w-4 text-[var(--color-fg-muted)] shrink-0" />
                      <span className="font-medium text-[14px] text-[var(--color-fg)] truncate">
                        {formatPhone(item.phone)}
                      </span>
                      {resBadge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${resBadge.cls}`}>
                          {resBadge.label}
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
        <DetailModal callId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
};

export default ConversazioniPage;
