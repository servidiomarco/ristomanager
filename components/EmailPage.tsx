import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Send, Loader2, RefreshCw, CheckCircle2, Clock, AlertTriangle, ArrowRight, Check, ArrowDownLeft, ArrowUpRight, Reply } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import { SkeletonInboxList, SkeletonEmailThread } from './SkeletonCards';
import {
  emailApiService,
  EmailThreadSummary,
  EmailMessage,
} from '../services/emailApiService';
import { socketClient } from '../services/socketClient';
import { toTitleCase } from '../utils/text';
import {
  ModalShell, FormCard, Field, SearchField, Callout, SplitPane, SectionHeader,
  Avatar, EmptyState, SwipeRow, useFirstRunHint, PanePlaceholder, PaneHeader, CountBadge,
  dsInput, dsTextarea, dsButton, dsIconButton,
} from './ds';

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
  // On a filled bubble these ride on currentColor rather than a second colour
  // fighting the fill.
  if (s === 'delivered' || s === 'read') return <CheckCircle2 className="h-3.5 w-3.5" aria-label="Consegnato" />;
  if (s === 'failed' || s === 'undelivered') return <AlertTriangle className="h-3.5 w-3.5" aria-label="Non consegnato" />;
  return <Clock className="h-3.5 w-3.5" aria-label="In invio" />;
};

const displayName = (t: EmailThreadSummary): string =>
  (t.customer_name && t.customer_name.trim() && toTitleCase(t.customer_name)) || t.email;

const EmailPage: React.FC = () => {
  const [threads, setThreads] = useState<EmailThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  // Always-visible search, matching the other two Comunicazioni channels.
  const [searchQuery, setSearchQuery] = useState('');

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

  // A thread wants attention when the customer replied and nobody has opened
  // it. Derived from threads already loaded — the section only reorders.
  const needsAttention = (t: EmailThreadSummary) =>
    t.unread_count > 0 && t.last_direction !== 'outbound';
  const customerReplies = visibleThreads.filter(needsAttention);
  const restOfThreads = visibleThreads.filter(t => !needsAttention(t));
  const swipeHint = useFirstRunHint('ds-swipe-hint-email');

  const markThreadRead = useCallback(async (emailKey: string) => {
    try {
      await emailApiService.markThreadRead(emailKey);
      setThreads(prev => prev.map(t =>
        t.email_key === emailKey ? { ...t, unread_count: 0 } : t
      ));
    } catch { /* badge stays stale until the next refresh */ }
  }, []);

  const renderThread = (t: EmailThreadSummary, hint: boolean) => {
    const active = selectedKey === t.email_key;
    const outbound = t.last_direction === 'outbound';
    return (
      <SwipeRow
        key={t.email_key}
        hint={hint}
        left={t.unread_count > 0 ? {
          label: 'Letto',
          tone: 'confirm',
          icon: <Check className="h-4 w-4" aria-hidden />,
          onAction: () => markThreadRead(t.email_key),
        } : undefined}
        right={{
          label: 'Rispondi',
          tone: 'primary',
          icon: <ArrowRight className="h-4 w-4" aria-hidden />,
          onAction: () => { setSelectedKey(t.email_key); },
        }}
      >
        <button
          type="button"
          onClick={() => setSelectedKey(t.email_key)}
          className={`flex w-full gap-3 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
            active ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
          }`}
        >
          <Avatar name={t.customer_name || t.email} icon={t.customer_name ? undefined : Mail} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{displayName(t)}</span>
              <span className="flex items-center gap-1.5">
                <span className="whitespace-nowrap text-[13px] text-[var(--ds-text-muted)]">{formatRelative(t.last_sent_at)}</span>
                {t.unread_count > 0 && (
                  <CountBadge tone="alert" count={t.unread_count} />
                )}
              </span>
            </div>
            {t.customer_name && (
              <div className="truncate text-[13px] text-[var(--ds-text-muted)]">{t.email}</div>
            )}
            {t.last_subject && (
              <div className="truncate text-[14px] font-semibold text-[var(--ds-text-primary)]">{t.last_subject}</div>
            )}
            <p className="mt-0.5 flex items-center gap-1 truncate text-[14px] text-[var(--ds-text-muted)]">
              <span aria-hidden>{outbound ? '↗' : '↙'}</span>
              <span className="truncate">{outbound ? `Tu: ${t.last_body}` : t.last_body}</span>
            </p>
          </div>
        </button>
      </SwipeRow>
    );
  };

  return (
    <>
      <SplitPane
        detailOpen={!!selectedKey}
        toolbar={
          <div className="space-y-3">
            {/* No visible page title: the sidebar and the mobile switcher
                both already name this screen. */}
            <h1 className="sr-only">Email</h1>
            <div className="flex items-center gap-2">
              <SearchField
                className="min-w-0 flex-1"
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Cerca mittente, oggetto…"
              />
              <button
                type="button"
                onClick={loadThreads}
                className={dsIconButton}
                title="Aggiorna"
                aria-label="Aggiorna"
              >
                <RefreshCw className={`h-4 w-4 ${threadsLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => { setNewEmailOpen(true); setSubject(''); setBodyText(''); setNewRecipient(''); }}
                className={`${dsButton.primary} flex-shrink-0 max-lg:w-11 max-lg:px-0`}
                aria-label="Nuova email"
                title="Nuova email"
              >
                <Mail className="h-4 w-4" />
                <span className="max-lg:hidden">Nuova</span>
              </button>
            </div>
          </div>
        }
        list={
          threadsLoading ? (
            <SkeletonInboxList count={7} className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)]" />
          ) : threadsError ? (
            <Callout tone="critical" icon={AlertTriangle}>{threadsError}</Callout>
          ) : visibleThreads.length === 0 ? (
            <EmptyState icon={Mail}>
              {searchQuery ? 'Nessun risultato' : 'Nessuna email al momento.'}
            </EmptyState>
          ) : (
            <div className="space-y-1">
              {customerReplies.length > 0 && (
                <>
                  <SectionHeader tone="positive">Risposte dei clienti</SectionHeader>
                  <div className="space-y-2 pb-2">
                    {customerReplies.map((t, i) => renderThread(t, swipeHint && i === 0))}
                  </div>
                </>
              )}
              {restOfThreads.length > 0 && (
                <>
                  <SectionHeader>Tutte le email</SectionHeader>
                  <div className="space-y-2">
                    {restOfThreads.map((t, i) => renderThread(t, swipeHint && customerReplies.length === 0 && i === 0))}
                  </div>
                </>
              )}
            </div>
          )
        }
        detail={
          selected ? (
            <>
              <PaneHeader
                onBack={() => setSelectedKey(null)}
                backLabel="Torna alle email"
                title={displayName(selected)}
                subtitle={selected.email}
                actions={
                  <button type="button" onClick={openReply} className={dsButton.secondary}>
                    Rispondi
                  </button>
                }
              />

              <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-4 px-4 pb-4 sm:px-6 lg:px-8">
                {msgLoading ? (
                  <SkeletonEmailThread count={4} />
                ) : msgError ? (
                  <Callout tone="critical" icon={AlertTriangle}>{msgError}</Callout>
                ) : (
                  grouped.map(group => (
                    <div key={group.day} className="space-y-2">
                      <div className="flex justify-center">
                        <span className="rounded-full bg-[var(--ds-surface)] px-2.5 py-1 text-[12px] text-[var(--ds-text-muted)]">{group.day}</span>
                      </div>
                      {group.items.map(m => {
                        const isOut = m.direction === 'outbound';
                        const isReply = !isOut && !!m.in_reply_to;
                        const DirIcon = isOut ? ArrowUpRight : isReply ? Reply : ArrowDownLeft;
                        const dirLabel = isOut ? 'Uscita' : isReply ? 'Risposta' : 'Entrata';
                        return (
                          <div key={m.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                            <div
                              className={`max-w-[85%] rounded-[18px] px-4 py-3 md:max-w-[70%] ${
                                isOut
                                  ? 'rounded-br-[6px] bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)]'
                                  : 'rounded-bl-[6px] bg-[var(--ds-surface)] text-[var(--ds-text-primary)]'
                              }`}
                            >
                              <div className={`mb-1 flex items-center gap-1 text-[12px] font-medium ${isOut ? 'text-white/75' : 'text-[var(--ds-text-muted)]'}`}>
                                <DirIcon className="h-3.5 w-3.5" aria-hidden />
                                <span>{dirLabel}</span>
                              </div>
                              {m.subject && (
                                <div className="mb-1.5 text-[15px] font-semibold">{m.subject}</div>
                              )}
                              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.body}</p>
                              <div className={`mt-1.5 flex items-center gap-1.5 text-[12px] ${isOut ? 'text-white/75' : 'text-[var(--ds-text-muted)]'}`}>
                                <span className="tabular-nums">{formatTime(m.sent_at)}</span>
                                {statusIcon(m)}
                                {m.error_message && <span>· {m.error_message}</span>}
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
              </div>

              {/* Reply composer: subject and body as cards, send inside the body. */}
              <div className="flex-shrink-0 space-y-2 px-4 pb-4 pt-3 sm:px-6 lg:px-8">
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value.slice(0, 200))}
                  placeholder="Oggetto"
                  aria-label="Oggetto"
                  className="h-11 w-full rounded-full bg-[var(--ds-surface)] px-4 text-[15px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                />
                <div className="flex items-end gap-2 rounded-[24px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                  <textarea
                    ref={composerRef}
                    value={bodyText}
                    onChange={e => setBodyText(e.target.value.slice(0, 5000))}
                    rows={2}
                    placeholder="Scrivi la risposta…"
                    aria-label="Risposta"
                    className="max-h-48 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-snug text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSendReply}
                    disabled={!subject.trim() || !bodyText.trim() || sending}
                    aria-label="Invia risposta"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)] transition-all hover:brightness-95 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed disabled:bg-[var(--ds-surface-row)] disabled:text-[var(--ds-text-subtle)]"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
                {sendError && (
                  <p className="px-1 text-[13px] text-[var(--ds-critical-text)]">{sendError}</p>
                )}
              </div>
            </>
          ) : (
            <PanePlaceholder icon={Mail}>Seleziona una conversazione dalla lista</PanePlaceholder>
          )
        }
      />

      {/* New email modal */}
      <ModalShell
        open={newEmailOpen}
        onClose={() => { if (!sending) setNewEmailOpen(false); }}
        title="Nuova email"
        bodyClassName="p-4 sm:p-5"
        footer={
          <>
            <button type="button" onClick={() => setNewEmailOpen(false)} disabled={sending} className={dsButton.quiet}>
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSendNew}
              disabled={!newRecipient.trim() || !subject.trim() || !bodyText.trim() || sending}
              className={dsButton.primary}
            >
              {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> Invio…</> : <><Send className="h-4 w-4" /> Invia</>}
            </button>
          </>
        }
      >
        <FormCard>
          <div className="flex flex-col gap-4">
            <Field label="Destinatario" htmlFor="new-email-to">
              <input
                id="new-email-to"
                type="email"
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                placeholder="cliente@esempio.com"
                className={dsInput}
                autoFocus
              />
            </Field>
            <Field label="Oggetto" htmlFor="new-email-subject">
              <input
                id="new-email-subject"
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value.slice(0, 200))}
                placeholder="Es. Promemoria prenotazione"
                className={dsInput}
              />
            </Field>
            <Field label="Messaggio" htmlFor="new-email-body">
              <textarea
                id="new-email-body"
                value={bodyText}
                onChange={e => setBodyText(e.target.value.slice(0, 5000))}
                rows={8}
                placeholder="Ciao, ci scriviamo per…"
                className={`${dsTextarea} resize-y`}
              />
            </Field>
            {sendError && <Callout tone="critical" icon={AlertTriangle}>{sendError}</Callout>}
          </div>
        </FormCard>
      </ModalShell>
    </>
  );
};

export default EmailPage;
