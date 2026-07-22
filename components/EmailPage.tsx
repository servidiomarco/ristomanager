import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Send, Loader2, RefreshCw, CheckCircle2, Clock, AlertTriangle, ArrowLeft, Search, X, ArrowDownLeft, ArrowUpRight, Reply } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
  emailApiService,
  EmailThreadSummary,
  EmailMessage,
} from '../services/emailApiService';
import { socketClient } from '../services/socketClient';
import { toTitleCase } from '../utils/text';

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
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Oggi';
  if (same(d, yesterday)) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'short' });
};

const statusIcon = (m: EmailMessage) => {
  if (m.direction !== 'outbound') return null;
  const s = (m.status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
  if (s === 'failed' || s === 'undelivered') return <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />;
  return <Clock className="w-3.5 h-3.5 text-slate-400" />;
};

const displayName = (t: EmailThreadSummary): string =>
  (t.customer_name && t.customer_name.trim() && toTitleCase(t.customer_name)) || t.email;

const EmailPage: React.FC = () => {
  const [threads, setThreads] = useState<EmailThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);

  // Composer state — both when replying to a thread and when composing a
  // brand-new email via the "Nuova" button.
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [newEmailOpen, setNewEmailOpen] = useState(false);
  const [newRecipient, setNewRecipient] = useState('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const selected = useMemo(
    () => threads.find(t => t.email_key === selectedKey) || null,
    [threads, selectedKey]
  );

  const loadThreads = useCallback(async () => {
    try {
      setThreadsError(null);
      const { threads } = await emailApiService.listThreads();
      setThreads(threads);
    } catch (err: any) {
      setThreadsError(err?.message || 'Errore caricamento thread');
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const loadThread = useCallback(async (emailKey: string) => {
    setMsgLoading(true);
    setMsgError(null);
    try {
      const { messages } = await emailApiService.getThread(emailKey);
      setMessages(messages);
      emailApiService.markThreadRead(emailKey)
        .then(() => {
          setThreads(prev => prev.map(t => t.email_key === emailKey ? { ...t, unread_count: 0 } : t));
        })
        .catch(() => {});
    } catch (err: any) {
      setMsgError(err?.message || 'Errore caricamento email');
    } finally {
      setMsgLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedKey) { setMessages([]); return; }
    loadThread(selectedKey);
  }, [selectedKey, loadThread]);

  useEffect(() => {
    if (!messages.length) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length]);

  // Real-time updates via socket. Mirrors messagesApiService: same detach-on-
  // reconnect dance.
  useEffect(() => {
    const keyOf = (msg: EmailMessage): string | null => {
      const addr = msg.direction === 'inbound' ? msg.from_email : msg.to_email;
      return addr ? addr.trim().toLowerCase() : null;
    };
    const upsertThread = (msg: EmailMessage) => {
      const key = keyOf(msg);
      if (!key) return;
      const isOpen = selectedKey === key;
      setThreads(prev => {
        const existing = prev.find(t => t.email_key === key);
        if (existing) {
          const updated: EmailThreadSummary = {
            ...existing,
            last_direction: msg.direction,
            last_subject: msg.subject,
            last_body: msg.body,
            last_sent_at: msg.sent_at,
            last_inbound_at: msg.direction === 'inbound' ? msg.sent_at : existing.last_inbound_at,
            unread_count: msg.direction === 'inbound' && !isOpen ? existing.unread_count + 1 : (isOpen ? 0 : existing.unread_count),
          };
          return [updated, ...prev.filter(t => t.email_key !== key)];
        }
        // First-time thread: minimal record; the background refresh backfills customer_name.
        const created: EmailThreadSummary = {
          email_key: key,
          email: (msg.direction === 'inbound' ? msg.from_email : msg.to_email) || key,
          last_direction: msg.direction,
          last_subject: msg.subject,
          last_body: msg.body,
          last_sent_at: msg.sent_at,
          last_reservation_id: msg.reservation_id,
          unread_count: msg.direction === 'inbound' && !isOpen ? 1 : 0,
          last_inbound_at: msg.direction === 'inbound' ? msg.sent_at : null,
          customer_name: null,
        };
        loadThreads();
        return [created, ...prev];
      });
      if (isOpen) {
        setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
        if (msg.direction === 'inbound') emailApiService.markThreadRead(key).catch(() => {});
      }
    };

    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('email:inbound', upsertThread);
        attached.off('email:new', (payload: any) => payload?.message && upsertThread(payload.message));
      }
      attached = s;
      if (attached) {
        attached.on('email:inbound', upsertThread);
        attached.on('email:new', (payload: any) => payload?.message && upsertThread(payload.message));
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => { unsub(); attach(null); };
  }, [selectedKey, loadThreads]);

  // Filter conversations by the search bar. Case-insensitive on name, email,
  // last body, and last subject.
  const visibleThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(t => {
      const name = (t.customer_name || '').toLowerCase();
      const email = (t.email || '').toLowerCase();
      const body = (t.last_body || '').toLowerCase();
      const subj = (t.last_subject || '').toLowerCase();
      return name.includes(q) || email.includes(q) || body.includes(q) || subj.includes(q);
    });
  }, [threads, searchQuery]);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  const openReply = () => {
    if (!selected) return;
    const last = messages[messages.length - 1];
    const lastSubj = (last?.subject || selected.last_subject || '').replace(/^re:\s*/i, '');
    setSubject(lastSubj ? `Re: ${lastSubj}` : '');
    setBodyText('');
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleSendReply = useCallback(async () => {
    if (!selected || !subject.trim() || !bodyText.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const lastMsgId = [...messages].reverse().find(m => m.message_id)?.message_id ?? null;
      await emailApiService.send({
        to: selected.email,
        subject: subject.trim(),
        body: bodyText.trim(),
        reservation_id: selected.last_reservation_id,
        in_reply_to: lastMsgId,
      });
      setSubject('');
      setBodyText('');
      // Timeline refresh via socket, but we also force it in case the socket
      // is disconnected — otherwise the sent email would not appear.
      loadThread(selected.email_key);
      loadThreads();
    } catch (err: any) {
      setSendError(err?.message || 'Errore invio email');
    } finally {
      setSending(false);
    }
  }, [selected, subject, bodyText, sending, messages, loadThread, loadThreads]);

  const handleSendNew = useCallback(async () => {
    if (!newRecipient.trim() || !subject.trim() || !bodyText.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const to = newRecipient.trim();
      await emailApiService.send({ to, subject: subject.trim(), body: bodyText.trim() });
      setNewEmailOpen(false);
      setNewRecipient('');
      setSubject('');
      setBodyText('');
      // Open the fresh thread so the operator sees the sent email.
      const key = to.toLowerCase();
      setSelectedKey(key);
      loadThreads();
    } catch (err: any) {
      setSendError(err?.message || 'Errore invio email');
    } finally {
      setSending(false);
    }
  }, [newRecipient, subject, bodyText, sending, loadThreads]);

  // Timeline grouped by day for readability. Same helper used in InboxPage.
  const grouped = useMemo(() => {
    const out: { day: string; items: EmailMessage[] }[] = [];
    for (const m of messages) {
      const day = formatDayHeader(m.sent_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [messages]);

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-56px)] md:h-[calc(100vh-72px)] bg-[var(--color-bg)]">
      {/* Sidebar list */}
      <aside className={`${selectedKey ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 lg:w-96 border-r border-[var(--color-line)] bg-[var(--color-surface)]`}>
        <header className="flex items-center gap-2 h-14 px-4 border-b border-[var(--color-line)]">
          {searchOpen ? (
            <>
              <Search className="w-4 h-4 text-[var(--color-fg-muted)] shrink-0" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Cerca nome, email, oggetto…"
                className="flex-1 bg-transparent outline-none text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); }}}
              />
              <button type="button" onClick={() => { setSearchOpen(false); setSearchQuery(''); }} className="p-1 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <h1 className="text-base font-semibold text-[var(--color-fg)] flex-1">Email</h1>
              <button type="button" onClick={() => setSearchOpen(true)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]" title="Cerca">
                <Search className="w-4 h-4" />
              </button>
              <button type="button" onClick={loadThreads} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]" title="Aggiorna">
                <RefreshCw className={`w-4 h-4 ${threadsLoading ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={() => { setNewEmailOpen(true); setSubject(''); setBodyText(''); setNewRecipient(''); }} className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700">
                <Mail className="w-3.5 h-3.5" /> Nuova
              </button>
            </>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          {threadsLoading ? (
            <div className="flex items-center justify-center h-64">
              <CookingPotLoader label="Carico…" size={40} />
            </div>
          ) : threadsError ? (
            <div className="p-4 text-sm text-rose-600">{threadsError}</div>
          ) : visibleThreads.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--color-fg-muted)]">
              {searchQuery ? 'Nessun risultato' : 'Nessuna email al momento.'}
            </div>
          ) : (
            <ul>
              {visibleThreads.map(t => {
                const active = selectedKey === t.email_key;
                return (
                  <li key={t.email_key}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(t.email_key)}
                      className={`w-full text-left px-4 py-3 border-b border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] transition ${active ? 'bg-indigo-50 dark:bg-indigo-500/10' : ''}`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`inline-flex w-2 h-2 rounded-full ${t.unread_count > 0 ? 'bg-indigo-500' : 'bg-transparent'}`} />
                        <span className="font-semibold text-[13px] text-[var(--color-fg)] truncate flex-1">{displayName(t)}</span>
                        <span className="text-[11px] text-[var(--color-fg-subtle)] tabular whitespace-nowrap">{formatRelative(t.last_sent_at)}</span>
                      </div>
                      {t.customer_name && (
                        <div className="text-[11px] text-[var(--color-fg-muted)] truncate mb-0.5">{t.email}</div>
                      )}
                      {t.last_subject && (
                        <div className="text-[12px] font-medium text-[var(--color-fg)] truncate">{t.last_subject}</div>
                      )}
                      <div className="text-[12px] text-[var(--color-fg-muted)] line-clamp-1 flex items-center gap-1">
                        {t.last_direction === 'outbound' ? (
                          <ArrowUpRight className="w-3 h-3 text-[var(--color-fg-subtle)] shrink-0" />
                        ) : (
                          <ArrowDownLeft className="w-3 h-3 text-indigo-500 shrink-0" />
                        )}
                        <span className="truncate">
                          {t.last_direction === 'outbound' && <span className="text-[var(--color-fg-subtle)]">Tu: </span>}
                          {t.last_body}
                        </span>
                      </div>
                      {t.unread_count > 0 && (
                        <span className="inline-flex items-center h-4 px-1.5 mt-1 rounded-full bg-indigo-600 text-white text-[10px] font-semibold">
                          {t.unread_count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className={`${selectedKey ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 bg-[var(--color-bg)]`}>
        {selected ? (
          <>
            <header className="flex items-center gap-2 h-14 px-4 border-b border-[var(--color-line)] bg-[var(--color-surface)]">
              <button type="button" onClick={() => setSelectedKey(null)} className="md:hidden p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--color-fg)] truncate">{displayName(selected)}</div>
                <div className="text-[11px] text-[var(--color-fg-muted)] truncate">{selected.email}</div>
              </div>
              <button type="button" onClick={openReply} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-xs font-medium hover:bg-[var(--color-surface-hover)]">
                Rispondi
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {msgLoading ? (
                <div className="flex items-center justify-center h-64">
                  <CookingPotLoader label="Carico…" size={40} />
                </div>
              ) : msgError ? (
                <div className="text-sm text-rose-600">{msgError}</div>
              ) : (
                grouped.map(group => (
                  <div key={group.day} className="space-y-2">
                    <div className="text-center">
                      <span className="text-[10px] tracking-wider uppercase font-semibold text-[var(--color-fg-subtle)]">{group.day}</span>
                    </div>
                    {group.items.map(m => {
                      const isOut = m.direction === 'outbound';
                      const isReply = !isOut && !!m.in_reply_to;
                      const DirIcon = isOut ? ArrowUpRight : isReply ? Reply : ArrowDownLeft;
                      const dirLabel = isOut ? 'Uscita' : isReply ? 'Risposta' : 'Entrata';
                      return (
                        <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 shadow-sm ${isOut ? 'bg-indigo-600 text-white' : 'bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-fg)]'}`}>
                            <div className={`flex items-center gap-1 mb-1 text-[10px] font-semibold uppercase tracking-wider ${isOut ? 'text-indigo-100' : 'text-[var(--color-fg-muted)]'}`}>
                              <DirIcon className="w-3 h-3" />
                              <span>{dirLabel}</span>
                            </div>
                            {m.subject && (
                              <div className={`text-[13px] font-semibold mb-1.5 ${isOut ? 'text-white' : 'text-[var(--color-fg)]'}`}>
                                {m.subject}
                              </div>
                            )}
                            <p className="text-[14px] whitespace-pre-wrap leading-relaxed">{m.body}</p>
                            <div className={`flex items-center gap-1 mt-1.5 text-[11px] ${isOut ? 'text-indigo-100' : 'text-[var(--color-fg-muted)]'}`}>
                              <span className="tabular">{formatTime(m.sent_at)}</span>
                              {statusIcon(m)}
                              {m.error_message && (
                                <span className="text-rose-200">· {m.error_message}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply composer */}
            <div className="border-t border-[var(--color-line)] p-3 bg-[var(--color-surface)]">
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value.slice(0, 200))}
                placeholder="Oggetto"
                className="w-full mb-2 px-3 py-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <div className="flex items-end gap-2">
                <textarea
                  ref={composerRef}
                  value={bodyText}
                  onChange={e => setBodyText(e.target.value.slice(0, 5000))}
                  rows={3}
                  placeholder="Scrivi la risposta…"
                  className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-sm text-[var(--color-fg)] resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
                <button
                  type="button"
                  onClick={handleSendReply}
                  disabled={!subject.trim() || !bodyText.trim() || sending}
                  className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Invia
                </button>
              </div>
              {sendError && (
                <p className="mt-1.5 text-[12px] text-rose-600">{sendError}</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-[var(--color-fg-muted)] text-sm">
            <Mail className="w-8 h-8 mb-2 text-[var(--color-fg-subtle)]" />
            Seleziona una conversazione dalla lista.
          </div>
        )}
      </section>

      {/* New email modal */}
      {newEmailOpen && (
        <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4" onClick={() => !sending && setNewEmailOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-xl)] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-[var(--color-line)] flex items-center gap-2">
              <Mail className="h-4 w-4 text-indigo-600" />
              <h3 className="text-lg font-semibold text-[var(--color-fg)]">Nuova email</h3>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] block mb-1.5">Destinatario</label>
                <input
                  type="email"
                  value={newRecipient}
                  onChange={e => setNewRecipient(e.target.value)}
                  placeholder="cliente@esempio.com"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] block mb-1.5">Oggetto</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value.slice(0, 200))}
                  placeholder="Es. Promemoria prenotazione"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] block mb-1.5">Messaggio</label>
                <textarea
                  value={bodyText}
                  onChange={e => setBodyText(e.target.value.slice(0, 5000))}
                  rows={8}
                  placeholder="Ciao, ci scriviamo per…"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-sm text-[var(--color-fg)] resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              {sendError && <p className="text-[12px] text-rose-600">{sendError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]">
              <button type="button" onClick={() => setNewEmailOpen(false)} disabled={sending} className="px-4 py-2 rounded-full text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
                Annulla
              </button>
              <button
                type="button"
                onClick={handleSendNew}
                disabled={!newRecipient.trim() || !subject.trim() || !bodyText.trim() || sending}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? <><Loader2 className="w-4 h-4 animate-spin" /> Invio…</> : <><Send className="w-4 h-4" /> Invia</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailPage;
