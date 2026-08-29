import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Send, Loader2, RefreshCw, CheckCircle2, Clock, AlertTriangle, ArrowRight, Check, ArrowDownLeft, ArrowUpRight, Reply, Paperclip, X as XIcon, FolderOpen, Wand2, CalendarPlus } from 'lucide-react';
import { Loader } from './Loader';
import { SkeletonInboxList, SkeletonEmailThread } from './SkeletonCards';
import {
  emailApiService,
  emailCache,
  publicMediaUrl,
  EmailThreadSummary,
  EmailMessage,
  ExtractedEmailBooking,
} from '../services/emailApiService';
import { uploadAttachment, type UploadedAttachment } from '../services/messagesApiService';
import { listMedia, attachFromLibrary, type MediaFile } from '../services/mediaApiService';
import { getFeatureFlags } from '../services/apiService';
import { socketClient } from '../services/socketClient';
import { toTitleCase } from '../utils/text';
import {
  ModalShell, FormCard, Field, SearchField, Callout, SplitPane, SectionHeader,
  Avatar, EmptyState, SwipeRow, useFirstRunHint, PanePlaceholder, PaneHeader, CountBadge,
  dsInput, dsTextarea, dsButton, dsIconButton, AttachmentRow,
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

interface EmailPageProps {
  // Apre il form di nuova prenotazione già compilato, sia con i soli
  // customer_name/email (bottone "Crea prenotazione") sia con i campi che
  // l'AI ha estratto dall'email (date/time/guests/notes).
  onCreateReservationFromEmail?: (input: {
    customer_name?: string;
    phone?: string;
    email?: string;
    date?: string;
    time?: string;
    guests?: number;
    notes?: string;
  }) => void;
}

const EmailPage: React.FC<EmailPageProps> = ({ onCreateReservationFromEmail }) => {
  // Riparte dall'ultimo stato noto (cache modulo-level, pre-riempita al
  // login): la pagina viene smontata a ogni cambio vista e senza questo ogni
  // rientro mostrava lo spinner. Il fetch parte comunque e rimpiazza in
  // silenzio (stale-while-revalidate) — stesso schema di InboxPage.
  const [threads, setThreads] = useState<EmailThreadSummary[]>(() => emailCache.threads ?? []);
  const [threadsLoading, setThreadsLoading] = useState(emailCache.threads === null);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  // Always-visible search, matching the other two Comunicazioni channels.
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);

  // Tasto AI: estrae i dettagli di una richiesta di prenotazione dall'ultima
  // email ricevuta nel thread. Vedi handleSuggestBooking più sotto.
  const [aiEnabled, setAiEnabled] = useState(false);
  const [suggestingBooking, setSuggestingBooking] = useState(false);
  const [bookingSuggestion, setBookingSuggestion] = useState<ExtractedEmailBooking | null>(null);
  const [bookingSuggestError, setBookingSuggestError] = useState<string | null>(null);

  // Composer state — both when replying to a thread and when composing a
  // brand-new email via the "Nuova" button.
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [newEmailOpen, setNewEmailOpen] = useState(false);
  const [newRecipient, setNewRecipient] = useState('');
  // Allegati: stessa via della Inbox (outbound_media + token), ma via email
  // i byte viaggiano dentro il messaggio, non su un URL per Twilio.
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [libreriaAperta, setLibreriaAperta] = useState(false);
  const [libreria, setLibreria] = useState<MediaFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  // Specchia in cache ogni cambiamento della lista (fetch, socket, letture):
  // il prossimo mount riparte da qui. Il guard evita di sovrascrivere una
  // cache pre-riempita con lo stato iniziale vuoto o con un errore.
  useEffect(() => {
    if (!threadsLoading && !threadsError) emailCache.threads = threads;
  }, [threads, threadsLoading, threadsError]);

  // Con la cache il cambio thread è istantaneo, quindi due fetch possono
  // essere in volo insieme: il ref scarta la risposta del thread che non è
  // più aperto.
  const selectedKeyRef = useRef<string | null>(null);
  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);

  const loadThread = useCallback(async (emailKey: string) => {
    // Thread già visto: si mostra subito e il fetch rinfresca in background.
    const cached = emailCache.timelines.get(emailKey);
    if (cached) setMessages(cached);
    setMsgLoading(!cached);
    setMsgError(null);
    try {
      const { messages } = await emailApiService.getThread(emailKey);
      emailCache.setTimeline(emailKey, messages);
      if (selectedKeyRef.current !== emailKey) return;
      setMessages(messages);
      emailApiService.markThreadRead(emailKey)
        .then(() => {
          setThreads(prev => prev.map(t => t.email_key === emailKey ? { ...t, unread_count: 0 } : t));
        })
        .catch(() => {});
    } catch (err: any) {
      if (selectedKeyRef.current === emailKey) {
        setMsgError(err?.message || 'Errore caricamento email');
      }
    } finally {
      if (selectedKeyRef.current === emailKey) setMsgLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedKey) { setMessages([]); return; }
    loadThread(selectedKey);
    // Il suggerimento appartiene al thread aperto: cambiando email non deve
    // restare appeso quello del cliente precedente.
    setBookingSuggestion(null);
    setBookingSuggestError(null);
  }, [selectedKey, loadThread]);

  // Il pulsante compare solo a funzione attiva, come in InboxPage.
  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setAiEnabled(f.ai_messages_enabled === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
      // Anche la cache riceve il messaggio (qualunque thread, non solo quello
      // aperto): riaprire una chat mostra subito ciò che è arrivato mentre si
      // era altrove, senza aspettare il refresh in background.
      const cachedTimeline = emailCache.timelines.get(key);
      if (cachedTimeline && !cachedTimeline.some(m => m.id === msg.id)) {
        emailCache.setTimeline(key, [...cachedTimeline, msg]);
      }
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

  // Legge l'ultima email ricevuta nel thread e propone i dati di una
  // prenotazione, se ce n'è una. Non crea nulla da sola: il risultato finisce
  // in un riquadro che lo staff conferma con "Crea prenotazione" — stesso
  // principio del suggerimento di risposta in Messaggi.
  const handleSuggestBooking = useCallback(async () => {
    if (!selected || suggestingBooking) return;
    setSuggestingBooking(true);
    setBookingSuggestion(null);
    setBookingSuggestError(null);
    try {
      const r = await emailApiService.suggestBooking(selected.email_key);
      setBookingSuggestion(r.booking);
      if (!r.booking) setBookingSuggestError(r.reason || 'Nessuna richiesta di prenotazione trovata in questa email.');
    } catch (err: any) {
      setBookingSuggestError(err?.data?.message || err?.message || 'Suggerimento non riuscito');
    } finally {
      setSuggestingBooking(false);
    }
  }, [selected, suggestingBooking]);

  const handleCreateFromSuggestion = () => {
    if (!selected || !bookingSuggestion || !onCreateReservationFromEmail) return;
    onCreateReservationFromEmail({
      customer_name: bookingSuggestion.customer_name || selected.customer_name || undefined,
      phone: bookingSuggestion.phone || undefined,
      email: selected.email,
      date: bookingSuggestion.date || undefined,
      time: bookingSuggestion.time || undefined,
      guests: bookingSuggestion.guests || undefined,
      notes: bookingSuggestion.notes || undefined,
    });
    setBookingSuggestion(null);
  };

  // Carica subito il file scelto: al momento dell'invio serve solo il token,
  // così l'attesa dell'upload non si somma a quella dell'invio.
  const handlePickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setSendError(null);
    try {
      const uploaded: UploadedAttachment[] = [];
      for (const file of Array.from(files).slice(0, 5)) {
        uploaded.push(await uploadAttachment(file));
      }
      setAttachments(prev => [...prev, ...uploaded]);
    } catch (err: any) {
      setSendError(err?.message || 'Caricamento allegato non riuscito');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleApriLibreria = useCallback(async () => {
    setLibreriaAperta(v => !v);
    if (libreria !== null) return;
    try {
      const { files } = await listMedia();
      setLibreria(files);
    } catch (err: any) {
      setSendError(err?.data?.error || 'Libreria non caricata');
      setLibreria([]);
    }
  }, [libreria]);

  const handleAllegaDallaLibreria = useCallback(async (f: MediaFile) => {
    setUploading(true);
    setSendError(null);
    try {
      const allegato = await attachFromLibrary(f.id);
      setAttachments(prev => [...prev, allegato as UploadedAttachment]);
      setLibreriaAperta(false);
    } catch (err: any) {
      setSendError(err?.data?.error || 'Allegato non preparato');
    } finally {
      setUploading(false);
    }
  }, []);

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
        attachment_tokens: attachments.map(a => a.token),
      });
      setSubject('');
      setBodyText('');
      setAttachments([]);
      setLibreriaAperta(false);
      // Timeline refresh via socket, but we also force it in case the socket
      // is disconnected — otherwise the sent email would not appear.
      loadThread(selected.email_key);
      loadThreads();
    } catch (err: any) {
      setSendError(err?.message || 'Errore invio email');
    } finally {
      setSending(false);
    }
  }, [selected, subject, bodyText, sending, messages, attachments, loadThread, loadThreads]);

  const handleSendNew = useCallback(async () => {
    if (!newRecipient.trim() || !subject.trim() || !bodyText.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const to = newRecipient.trim();
      await emailApiService.send({
        to,
        subject: subject.trim(),
        body: bodyText.trim(),
        attachment_tokens: attachments.map(a => a.token),
      });
      setNewEmailOpen(false);
      setNewRecipient('');
      setSubject('');
      setBodyText('');
      setAttachments([]);
      setLibreriaAperta(false);
      // Open the fresh thread so the operator sees the sent email.
      const key = to.toLowerCase();
      setSelectedKey(key);
      loadThreads();
    } catch (err: any) {
      setSendError(err?.message || 'Errore invio email');
    } finally {
      setSending(false);
    }
  }, [newRecipient, subject, bodyText, sending, attachments, loadThreads]);

  // Timeline grouped by day for readability. Same helper used in InboxPage.
  // Chips degli allegati pronti a partire e pannello della libreria: stessi
  // pezzi nel composer di risposta e nel modal "Nuova email", quindi vivono
  // qui una volta sola.
  /* Gli allegati stanno dentro la scheda del composer, sotto l'oggetto: sono
     parte della mail che si sta scrivendo, e sopra l'oggetto sembravano
     appartenere al thread. Nessuna anteprima — qui il file caricato ha un URL
     solo dopo l'invio (`mediaUrl` vuole un messageId), quindi la riga porta la
     targhetta del tipo. */
  const renderAttachmentRows = () => attachments.map(a => (
    <AttachmentRow
      key={a.token}
      filename={a.filename}
      contentType={a.content_type}
      sizeBytes={a.size_bytes}
      onRemove={() => setAttachments(prev => prev.filter(x => x.token !== a.token))}
    />
  ));

  const renderLibreria = () => (
    <div className="rounded-[14px] border border-[var(--ds-border)] bg-[var(--ds-surface-row)] px-3 py-2.5">
      {libreria === null ? (
        <p className="flex items-center gap-2 py-1 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carico la libreria…
        </p>
      ) : libreria.length === 0 ? (
        <p className="py-1 text-[13px] text-[var(--ds-text-muted)]">
          Nessun file in libreria. Si caricano da Impostazioni → Media.
        </p>
      ) : (
        <ul className="max-h-44 space-y-0.5 overflow-y-auto">
          {libreria.map(f => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => handleAllegaDallaLibreria(f)}
                disabled={uploading}
                className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-[var(--ds-surface)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-text-primary)]">{f.title}</span>
                <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-subtle)]">
                  {f.size_bytes >= 1024 * 1024
                    ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB`
                    : `${Math.max(1, Math.round(f.size_bytes / 1024))} KB`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

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
      {/* Un solo input file, sempre montato: lo usano sia il composer di
          risposta sia il modal "Nuova email". */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,audio/mpeg,audio/ogg,application/pdf"
        multiple
        hidden
        onChange={e => handlePickFiles(e.target.files)}
      />
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
                  <div className="flex items-center gap-2">
                    {aiEnabled && (
                      <button
                        type="button"
                        onClick={handleSuggestBooking}
                        disabled={suggestingBooking}
                        title="Cerca una richiesta di prenotazione nell'ultima email e proponi i dettagli"
                        className={dsIconButton}
                        aria-label="Suggerisci prenotazione dall'email"
                      >
                        {suggestingBooking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                      </button>
                    )}
                    <button type="button" onClick={openReply} className={dsButton.secondary}>
                      Rispondi
                    </button>
                  </div>
                }
              />

              {/* Proposta AI: legge, non scrive. Compare qui e non in chat
                  perché riguarda l'ultima email ricevuta nel thread, non la
                  risposta che si sta scrivendo. */}
              {(bookingSuggestion || bookingSuggestError) && (
                <div className="px-4 pt-3 sm:px-6 lg:px-8">
                  {bookingSuggestion ? (
                    /* Stessa cornice AI di Messaggi (.ds-ai-frame): la proposta
                       dell'agente ha un solo aspetto in tutta l'app. */
                    <div className="ds-ai-frame">
                      <div className="ds-ai-card flex items-start gap-2.5 px-3.5 py-3">
                        <Wand2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-[var(--ds-text-primary)]">
                            Richiesta di prenotazione trovata nell'email
                          </p>
                          <dl className="mt-1.5 space-y-0.5 text-[14px] text-[var(--ds-text-primary)]">
                            {bookingSuggestion.customer_name && (
                              <div><dt className="inline text-[var(--ds-text-muted)]">Cliente: </dt><dd className="inline">{bookingSuggestion.customer_name}</dd></div>
                            )}
                            {(bookingSuggestion.date || bookingSuggestion.time) && (
                              <div>
                                <dt className="inline text-[var(--ds-text-muted)]">Quando: </dt>
                                <dd className="inline">{[bookingSuggestion.date, bookingSuggestion.time].filter(Boolean).join(' · ')}</dd>
                              </div>
                            )}
                            {bookingSuggestion.guests != null && (
                              <div><dt className="inline text-[var(--ds-text-muted)]">Persone: </dt><dd className="inline">{bookingSuggestion.guests}</dd></div>
                            )}
                            {bookingSuggestion.phone && (
                              <div><dt className="inline text-[var(--ds-text-muted)]">Telefono: </dt><dd className="inline">{bookingSuggestion.phone}</dd></div>
                            )}
                            {bookingSuggestion.notes && (
                              <div><dt className="inline text-[var(--ds-text-muted)]">Note: </dt><dd className="inline">{bookingSuggestion.notes}</dd></div>
                            )}
                          </dl>
                          <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
                            Niente è ancora salvato: il form si apre già compilato, da controllare.
                          </p>
                          <div className="mt-2.5 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={handleCreateFromSuggestion}
                              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                            >
                              <CalendarPlus className="h-4 w-4" /> Crea prenotazione
                            </button>
                            <button
                              type="button"
                              onClick={() => setBookingSuggestion(null)}
                              className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
                            >
                              <XIcon className="h-4 w-4" /> Scarta
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Callout tone="info" icon={Wand2}>{bookingSuggestError}</Callout>
                  )}
                </div>
              )}

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
                              {Array.isArray(m.media) && m.media.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {m.media.map(att => (
                                    <a
                                      key={att.token}
                                      href={publicMediaUrl(att.token)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-full px-3 py-1 text-[13px] underline-offset-2 hover:underline ${
                                        isOut ? 'bg-white/15 text-white' : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
                                      }`}
                                    >
                                      <Paperclip className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                                      <span className="truncate">{att.filename || att.content_type || 'allegato'}</span>
                                    </a>
                                  ))}
                                </div>
                              )}
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
                {libreriaAperta && renderLibreria()}
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value.slice(0, 200))}
                  placeholder="Oggetto"
                  aria-label="Oggetto"
                  className="h-11 w-full rounded-full bg-[var(--ds-surface)] px-4 text-[15px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                />
                <div className="rounded-[24px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">{renderAttachmentRows()}</div>
                  )}
                  <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || sending}
                    aria-label="Allega un file"
                    title="Allega foto, PDF o audio"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleApriLibreria}
                    disabled={uploading || sending}
                    aria-label="Allega un file dalla libreria"
                    title="Allega un file già caricato (menù, piantina…)"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
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
            <Field label="Allegati">
              <div className="space-y-2">
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">{renderAttachmentRows()}</div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || sending}
                    className={dsButton.quiet}
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                    Allega file
                  </button>
                  <button
                    type="button"
                    onClick={handleApriLibreria}
                    disabled={uploading || sending}
                    className={dsButton.quiet}
                  >
                    <FolderOpen className="h-4 w-4" /> Libreria
                  </button>
                </div>
                {libreriaAperta && renderLibreria()}
              </div>
            </Field>
            {sendError && <Callout tone="critical" icon={AlertTriangle}>{sendError}</Callout>}
          </div>
        </FormCard>
      </ModalShell>
    </>
  );
};

export default EmailPage;
