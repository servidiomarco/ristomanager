import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Send, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock, ArrowLeft } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
  messagesApiService,
  ConversationSummary,
  InboxMessage,
  MessageChannel,
} from '../services/messagesApiService';
import { socketClient } from '../services/socketClient';

const formatRelative = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'ora';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h fa`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} g fa`;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
};

const formatTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
};

const formatDayHeader = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isSame = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (isSame(d, today)) return 'Oggi';
  if (isSame(d, yesterday)) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'short' });
};

// Countdown to the 24h WhatsApp window closure. Returns null when closed or
// when there was never an inbound. UI shows the remaining hours so operators
// know they need to send a template if they wait too long.
const windowRemainingLabel = (lastInboundAt: string | null | undefined): string | null => {
  if (!lastInboundAt) return null;
  const elapsed = Date.now() - new Date(lastInboundAt).getTime();
  const remaining = 24 * 3600 * 1000 - elapsed;
  if (remaining <= 0) return null;
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  if (h < 1) return `${m}m`;
  return `${h}h ${m}m`;
};

const channelBadgeCls = (channel: MessageChannel): string =>
  channel === 'whatsapp'
    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
    : 'bg-sky-50 text-sky-700 ring-1 ring-sky-200';

const statusIcon = (m: InboxMessage) => {
  if (m.direction !== 'outbound') return null;
  const s = (m.status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
  if (s === 'failed' || s === 'undelivered') return <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />;
  return <Clock className="w-3.5 h-3.5 text-slate-400" />;
};

const displayName = (c: ConversationSummary): string =>
  (c.customer_name && c.customer_name.trim()) || c.phone || `+${c.phone_digits}`;

const InboxPage: React.FC = () => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);

  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [preferredChannel, setPreferredChannel] = useState<MessageChannel>('whatsapp');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const selected = useMemo(
    () => conversations.find(c => c.phone_digits === selectedKey) || null,
    [conversations, selectedKey]
  );

  // When a conversation is picked, default the composer channel to whatever
  // the last inbound used (or WA when there's no inbound at all, since WA is
  // still the primary outbound path when the window is open).
  useEffect(() => {
    if (!selected) return;
    setPreferredChannel(selected.last_channel === 'sms' ? 'sms' : 'whatsapp');
  }, [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadConversations = useCallback(async () => {
    try {
      setConvError(null);
      const { conversations } = await messagesApiService.listConversations();
      setConversations(conversations);
    } catch (err: any) {
      setConvError(err?.message || 'Errore caricamento conversazioni');
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const loadTimeline = useCallback(async (phoneDigits: string) => {
    setMsgLoading(true);
    setMsgError(null);
    try {
      const { messages } = await messagesApiService.getTimeline(phoneDigits);
      setMessages(messages);
      // Mark inbound messages as read once the timeline is on screen. Errors
      // are silent — worst case, the badge is stale until the next refresh.
      messagesApiService.markRead(phoneDigits)
        .then(() => {
          setConversations(prev => prev.map(c =>
            c.phone_digits === phoneDigits ? { ...c, unread_count: 0 } : c
          ));
        })
        .catch(() => {});
    } catch (err: any) {
      setMsgError(err?.message || 'Errore caricamento conversazione');
    } finally {
      setMsgLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedKey) { setMessages([]); return; }
    loadTimeline(selectedKey);
  }, [selectedKey, loadTimeline]);

  // Auto-scroll to the bottom on new messages so operators land on the most
  // recent reply. `behavior: 'auto'` avoids the jarring smooth-scroll every
  // time the socket delivers a new event.
  useEffect(() => {
    if (!messages.length) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length]);

  // Real-time updates: append inbound/outbound messages to the open thread
  // when they match, and refresh the conversation list preview counts.
  useEffect(() => {
    const digitsMatch = (msg: InboxMessage): string | null => {
      const raw = msg.direction === 'inbound' ? msg.from_phone_digits : msg.to_phone_digits;
      if (!raw) return null;
      return String(raw).slice(-10);
    };

    const onInbound = (msg: InboxMessage) => {
      const key = digitsMatch(msg);
      if (!key) return;
      // Optimistically bump the conversation to the top, or add it if new.
      setConversations(prev => {
        const existing = prev.find(c => c.phone_digits === key);
        const isOpen = selectedKey === key;
        if (existing) {
          const updated: ConversationSummary = {
            ...existing,
            last_channel: msg.channel,
            last_direction: 'inbound',
            last_body: msg.body,
            last_sent_at: msg.sent_at,
            last_inbound_at: msg.sent_at,
            unread_count: isOpen ? 0 : existing.unread_count + 1,
          };
          return [updated, ...prev.filter(c => c.phone_digits !== key)];
        }
        // First-time contact: minimal record; a full refresh backfills customer_name.
        const created: ConversationSummary = {
          phone_digits: key,
          phone: msg.from_phone,
          last_channel: msg.channel,
          last_direction: 'inbound',
          last_body: msg.body,
          last_sent_at: msg.sent_at,
          last_reservation_id: msg.reservation_id,
          unread_count: isOpen ? 0 : 1,
          last_inbound_at: msg.sent_at,
          customer_name: null,
        };
        // Trigger a background refresh for the customer_name lookup.
        loadConversations();
        return [created, ...prev];
      });
      if (selectedKey === key) {
        setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
        messagesApiService.markRead(key).catch(() => {});
      }
    };

    const onOutbound = (msg: InboxMessage) => {
      const key = digitsMatch(msg);
      if (!key) return;
      setConversations(prev => {
        const existing = prev.find(c => c.phone_digits === key);
        if (existing) {
          const updated: ConversationSummary = {
            ...existing,
            last_channel: msg.channel,
            last_direction: 'outbound',
            last_body: msg.body,
            last_sent_at: msg.sent_at,
          };
          return [updated, ...prev.filter(c => c.phone_digits !== key)];
        }
        return prev;
      });
      if (selectedKey === key) {
        setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      }
    };

    // Re-attach on reconnect: if the socket isn't ready when this effect runs
    // (or drops mid-session), listeners registered directly on it are lost.
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('message:inbound', onInbound);
        attached.off('message:outbound', onOutbound);
      }
      attached = s;
      if (attached) {
        attached.on('message:inbound', onInbound);
        attached.on('message:outbound', onOutbound);
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => {
      unsub();
      attach(null);
    };
  }, [selectedKey, loadConversations]);

  const windowRemaining = useMemo(
    () => (selected ? windowRemainingLabel(selected.last_inbound_at) : null),
    [selected]
  );
  const waWindowOpen = !!windowRemaining;

  const handleSend = useCallback(async () => {
    if (!selected || !composerText.trim() || sending) return;
    const phone = selected.phone || `+${selected.phone_digits}`;
    setSending(true);
    setSendError(null);
    try {
      await messagesApiService.send({
        phone,
        text: composerText.trim(),
        channel: preferredChannel,
      });
      setComposerText('');
      composerRef.current?.focus();
    } catch (err: any) {
      const data = (err as any)?.data;
      if (data?.error === 'window_closed' && preferredChannel === 'whatsapp') {
        setSendError('Finestra 24h WhatsApp chiusa. Passa a SMS o attendi che il cliente scriva.');
      } else {
        setSendError(err?.message || 'Invio fallito');
      }
    } finally {
      setSending(false);
    }
  }, [selected, composerText, sending, preferredChannel]);

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Group messages by day for the day-separator chips inside the timeline.
  const grouped = useMemo(() => {
    const groups: { day: string; items: InboxMessage[] }[] = [];
    for (const m of messages) {
      const day = new Date(m.sent_at).toDateString();
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(m);
      else groups.push({ day, items: [m] });
    }
    return groups;
  }, [messages]);

  const totalUnread = conversations.reduce((s, c) => s + Number(c.unread_count || 0), 0);

  return (
    <div className="flex h-[calc(100vh-64px)] bg-[var(--color-bg)]">
      {/* Sidebar: conversations */}
      <aside
        className={`${selectedKey ? 'hidden md:flex' : 'flex'} w-full md:w-80 lg:w-96 flex-shrink-0 border-r border-[var(--color-line)] flex-col bg-[var(--color-surface)]`}
      >
        <div className="p-4 border-b border-[var(--color-line)] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle className="w-5 h-5 text-[var(--color-fg-muted)]" />
            <h2 className="font-semibold text-[15px] text-[var(--color-fg)]">Messaggi</h2>
            {totalUnread > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[11px] font-semibold rounded-full bg-rose-500 text-white">
                {totalUnread}
              </span>
            )}
          </div>
          <button
            onClick={() => { setConvLoading(true); loadConversations(); }}
            className="p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]"
            title="Aggiorna"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {convLoading ? (
            <div className="flex items-center justify-center h-32"><CookingPotLoader /></div>
          ) : convError ? (
            <div className="p-4 text-[13px] text-rose-600">{convError}</div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-[var(--color-fg-muted)]">
              Nessuna conversazione.<br />
              I messaggi in arrivo appariranno qui.
            </div>
          ) : (
            <ul>
              {conversations.map(c => {
                const active = c.phone_digits === selectedKey;
                const unread = c.unread_count || 0;
                return (
                  <li key={c.phone_digits}>
                    <button
                      onClick={() => setSelectedKey(c.phone_digits)}
                      className={`w-full text-left px-4 py-3 border-b border-[var(--color-line)] transition-colors ${active ? 'bg-[var(--color-surface-2)]' : 'hover:bg-[var(--color-surface-2)]'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`truncate text-[14px] ${unread > 0 ? 'font-semibold text-[var(--color-fg)]' : 'font-medium text-[var(--color-fg)]'}`}>
                              {displayName(c)}
                            </span>
                            <span className={`px-1.5 py-0.5 text-[10px] rounded ${channelBadgeCls(c.last_channel)}`}>
                              {c.last_channel === 'whatsapp' ? 'WA' : 'SMS'}
                            </span>
                          </div>
                          <p className={`text-[13px] truncate mt-0.5 ${unread > 0 ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}`}>
                            {c.last_direction === 'outbound' ? '↗ ' : ''}{c.last_body}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          <span className="text-[11px] text-[var(--color-fg-subtle)]">{formatRelative(c.last_sent_at)}</span>
                          {unread > 0 && (
                            <span className="min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-rose-500 text-white flex items-center justify-center">
                              {unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main pane: timeline + composer */}
      <main className={`${selectedKey ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-center px-6">
            <div className="max-w-md">
              <MessageCircle className="w-12 h-12 mx-auto text-[var(--color-fg-subtle)] mb-3" />
              <h3 className="text-[15px] font-semibold text-[var(--color-fg)] mb-1">Nessuna conversazione selezionata</h3>
              <p className="text-[13px] text-[var(--color-fg-muted)]">
                Seleziona una conversazione dalla lista per vedere lo storico dei messaggi.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center justify-between bg-[var(--color-surface)]">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelectedKey(null)}
                  className="md:hidden p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]"
                  title="Torna alle conversazioni"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="font-semibold text-[15px] text-[var(--color-fg)] truncate">{displayName(selected)}</h3>
                    <span className={`px-1.5 py-0.5 text-[10px] rounded ${channelBadgeCls(selected.last_channel)}`}>
                      {selected.last_channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                    </span>
                  </div>
                  {selected.phone && (
                    <p className="text-[12px] text-[var(--color-fg-muted)] truncate">{selected.phone}</p>
                  )}
                </div>
              </div>
              {waWindowOpen && preferredChannel === 'whatsapp' && (
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                  <Clock className="w-3 h-3" /> Finestra WA: {windowRemaining}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 bg-[var(--color-bg)]">
              {msgLoading ? (
                <div className="flex items-center justify-center h-32"><CookingPotLoader /></div>
              ) : msgError ? (
                <div className="p-4 text-[13px] text-rose-600">{msgError}</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-[13px] text-[var(--color-fg-muted)] mt-8">
                  Nessun messaggio ancora.
                </div>
              ) : (
                <div className="space-y-4 max-w-3xl mx-auto">
                  {grouped.map(g => (
                    <div key={g.day} className="space-y-2">
                      <div className="flex justify-center">
                        <span className="px-2 py-0.5 text-[11px] rounded-full bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]">
                          {formatDayHeader(g.day)}
                        </span>
                      </div>
                      {g.items.map(m => {
                        const outbound = m.direction === 'outbound';
                        const bubbleCls = outbound
                          ? 'bg-emerald-500 text-white'
                          : 'bg-[var(--color-surface)] text-[var(--color-fg)] ring-1 ring-[var(--color-line)]';
                        return (
                          <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[80%] rounded-2xl px-3 py-2 ${bubbleCls}`}>
                              <p className="text-[14px] whitespace-pre-wrap break-words">{m.body}</p>
                              <div className={`flex items-center gap-1 justify-end mt-1 text-[11px] ${outbound ? 'text-emerald-100' : 'text-[var(--color-fg-subtle)]'}`}>
                                <span>{formatTime(m.sent_at)}</span>
                                {statusIcon(m)}
                                <span className={`ml-1 px-1 rounded text-[10px] ${outbound ? 'bg-emerald-600/40' : 'bg-[var(--color-surface-2)]'}`}>
                                  {m.channel === 'whatsapp' ? 'WA' : 'SMS'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            <div className="border-t border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
              <div className="max-w-3xl mx-auto space-y-2">
                {!waWindowOpen && preferredChannel === 'whatsapp' && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-800 ring-1 ring-amber-200 text-[12.5px]">
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      Finestra 24h WhatsApp chiusa: il cliente deve scrivere per primo.
                    </span>
                    <button
                      onClick={() => setPreferredChannel('sms')}
                      className="font-semibold underline hover:no-underline whitespace-nowrap"
                    >
                      Passa a SMS
                    </button>
                  </div>
                )}
                {sendError && (
                  <div className="px-3 py-2 rounded-lg bg-rose-50 text-rose-700 ring-1 ring-rose-200 text-[12.5px]">
                    {sendError}
                  </div>
                )}

                {/* Segmented channel toggle above the composer, iOS-style. */}
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-full bg-[var(--color-surface-2)] p-0.5 text-[11px] font-semibold">
                    <button
                      onClick={() => setPreferredChannel('whatsapp')}
                      className={`px-3 py-1 rounded-full transition-colors ${preferredChannel === 'whatsapp' ? 'bg-emerald-500 text-white shadow-sm' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                    >
                      WhatsApp
                    </button>
                    <button
                      onClick={() => setPreferredChannel('sms')}
                      className={`px-3 py-1 rounded-full transition-colors ${preferredChannel === 'sms' ? 'bg-sky-500 text-white shadow-sm' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                    >
                      SMS
                    </button>
                  </div>
                  {preferredChannel === 'whatsapp' && waWindowOpen && (
                    <span className="text-[11px] text-[var(--color-fg-subtle)] flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {windowRemaining} rimanenti
                    </span>
                  )}
                </div>

                {/* Composer: pill-shaped textarea with a floating send button. */}
                <div className="flex items-end gap-2">
                  <div className="flex-1 flex items-end rounded-2xl bg-[var(--color-surface-2)] ring-1 ring-[var(--color-line)] focus-within:ring-2 focus-within:ring-emerald-500 transition-shadow px-4 py-2.5">
                    <textarea
                      ref={composerRef}
                      value={composerText}
                      onChange={e => setComposerText(e.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      placeholder={preferredChannel === 'whatsapp' && !waWindowOpen
                        ? 'Finestra chiusa — passa a SMS'
                        : 'Scrivi un messaggio…'}
                      rows={1}
                      disabled={preferredChannel === 'whatsapp' && !waWindowOpen}
                      className="flex-1 resize-none max-h-40 bg-transparent border-0 text-[14px] leading-snug text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none disabled:opacity-60"
                    />
                  </div>
                  <button
                    onClick={handleSend}
                    disabled={!composerText.trim() || sending || (preferredChannel === 'whatsapp' && !waWindowOpen)}
                    aria-label="Invia messaggio"
                    className={`flex-shrink-0 h-11 w-11 rounded-full flex items-center justify-center text-white transition-all shadow-sm disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-fg-subtle)] disabled:cursor-not-allowed disabled:shadow-none ${
                      preferredChannel === 'whatsapp'
                        ? 'bg-emerald-500 hover:bg-emerald-600 active:scale-95'
                        : 'bg-sky-500 hover:bg-sky-600 active:scale-95'
                    }`}
                  >
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-[var(--color-fg-subtle)] px-1">
                  Invio con <kbd className="px-1 py-0.5 rounded bg-[var(--color-surface-2)] ring-1 ring-[var(--color-line)] font-mono text-[10px]">Enter</kbd>, a capo con <kbd className="px-1 py-0.5 rounded bg-[var(--color-surface-2)] ring-1 ring-[var(--color-line)] font-mono text-[10px]">Shift+Enter</kbd>
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default InboxPage;
