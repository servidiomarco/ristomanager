import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessagesSquare, Hash, Send, Loader2, AlertTriangle, Plus, ChevronUp, X as XIcon, Paperclip } from 'lucide-react';
import { Loader } from './Loader';
import { staffChatApiService, staffChatCache, staffMediaUrl, type StaffThreadSummary, type StaffColleague, type StaffPreset, type StaffUploadedAttachment } from '../services/staffChatApiService';
import { swrConfig } from '../services/configCache';
import {
  STAFF_MESSAGE_PRESETS, STAFF_MESSAGE_MAX_LENGTH, STAFF_MAX_MENTIONS, STAFF_MAX_ATTACHMENTS, staffMessagePreview,
  threadKeyFor, dmThreadKey, parseThreadKey, rolesForChannel,
  type StaffChannel, type StaffMessage,
} from '../services/staffChat';
import { socketClient } from '../services/socketClient';
import {
  SplitPane, PaneHeader, PanePlaceholder, SectionHeader, Avatar, EmptyState, AttachmentRow,
  Callout, CountBadge, dsIconButton,
} from './ds';

// Stesse etichette usate dalla membership in services/staffChat.ts: il canale
// si chiama come la sezione che serve.
const CHANNEL_LABELS: Record<StaffChannel, string> = {
  generale: 'Generale',
  sala: 'Sala',
  cucina: 'Cucina',
  reception: 'Reception',
};

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Titolare',
  GENERAL_MANAGER: 'Direttore',
  MANAGER: 'Manager',
  RECEPTION: 'Reception',
  WAITER: 'Sala',
  KITCHEN: 'Cucina',
  CASSA: 'Cassa',
};

const formatRelative = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
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

const PAGE_SIZE = 50;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Evidenzia le occorrenze "@Nome Cognome" dei nomi noti. Gli id menzionati
// stanno in mentioned_user_ids; il testo resta libero, quindi il match è sui
// nomi che il client conosce (colleghi + se stesso).
const renderBodyWithMentions = (body: string, names: string[], mine: boolean): React.ReactNode => {
  if (names.length === 0) return body;
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g');
  const parts = body.split(pattern);
  if (parts.length === 1) return body;
  return parts.map((part, i) => i % 2 === 1
    ? (
      <span key={i} className={`font-semibold ${mine ? 'underline underline-offset-2' : 'text-[var(--ds-arriving-text)]'}`}>
        @{part}
      </span>
    )
    : part);
};

const threadTitle = (t: StaffThreadSummary): string =>
  t.kind === 'channel'
    ? CHANNEL_LABELS[t.channel as StaffChannel] ?? t.channel ?? ''
    : t.otherUser?.fullName || 'Utente rimosso';

interface StaffChatPageProps {
  currentUserId: number;
  /** Nome di chi guarda: serve solo a evidenziare "@me" nei messaggi. */
  currentUserName?: string;
  /** Deep-link da una push (?staffchat=<threadKey>): thread da aprire subito. */
  initialThreadKey?: string | null;
  onInitialThreadConsumed?: () => void;
}

const StaffChatPage: React.FC<StaffChatPageProps> = ({ currentUserId, currentUserName, initialThreadKey, onInitialThreadConsumed }) => {
  // Riparte dall'ultimo stato noto (cache modulo-level, pre-riempita al
  // login): la pagina viene smontata a ogni cambio vista e senza questo ogni
  // rientro mostrava lo spinner. Il fetch parte comunque e rimpiazza in
  // silenzio (stale-while-revalidate) — stesso schema di InboxPage.
  const [threads, setThreads] = useState<StaffThreadSummary[]>(() => staffChatCache.list?.threads ?? []);
  const [colleagues, setColleagues] = useState<StaffColleague[]>(() => staffChatCache.list?.colleagues ?? []);
  const [listLoading, setListLoading] = useState(staffChatCache.list === null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<StaffMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Menzioni in bozza: id → nome inserito. All'invio si mandano solo quelle
  // il cui "@Nome" è ancora nel testo (l'utente può averlo cancellato).
  const [mentionDraft, setMentionDraft] = useState<Map<number, string>>(new Map());
  // Preset dal server (personalizzabili in Impostazioni); i default sono
  // il fallback finché la fetch non risponde o se fallisce.
  const [presets, setPresets] = useState<StaffPreset[]>(STAFF_MESSAGE_PRESETS);
  // Foto pronte per l'invio: caricate subito alla scelta (al momento
  // dell'invio serve solo il token, come nell'inbox).
  const [attachments, setAttachments] = useState<StaffUploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // selectedKey letto dai listener socket senza ri-attaccarli a ogni cambio.
  const selectedKeyRef = useRef<string | null>(null);
  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);

  const selected = useMemo(
    () => threads.find(t => t.threadKey === selectedKey) || null,
    [threads, selectedKey]
  );

  const loadThreads = useCallback(async () => {
    try {
      setListError(null);
      const { threads, colleagues } = await staffChatApiService.listThreads();
      setThreads(prev => {
        // I thread DM appena aperti dal picker esistono solo sul client
        // finché non parte il primo messaggio: non vanno persi al refresh.
        const ephemeral = prev.filter(t => t.kind === 'direct' && !t.lastMessage
          && !threads.some(s => s.threadKey === t.threadKey));
        return [...threads, ...ephemeral];
      });
      setColleagues(colleagues);
    } catch (err: any) {
      setListError(err?.message || 'Errore caricamento chat');
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // Specchia in cache ogni cambiamento di lista e colleghi (fetch, socket,
  // letture): il prossimo mount riparte da qui. Il guard evita di
  // sovrascrivere una cache pre-riempita con lo stato iniziale vuoto o con
  // un errore.
  useEffect(() => {
    if (!listLoading && !listError) staffChatCache.list = { threads, colleagues };
  }, [threads, colleagues, listLoading, listError]);

  useEffect(() => swrConfig('staffChatPresets', () => staffChatApiService.getPresets(), ({ presets }) => {
    if (presets.length > 0) setPresets(presets);
  }), []);

  // Deep-link dalla push: si apre appena la lista è pronta.
  useEffect(() => {
    if (!initialThreadKey || listLoading) return;
    if (parseThreadKey(initialThreadKey)) setSelectedKey(initialThreadKey);
    onInitialThreadConsumed?.();
  }, [initialThreadKey, listLoading, onInitialThreadConsumed]);

  const markReadLocally = useCallback((threadKey: string, lastId: number) => {
    staffChatApiService.markRead(threadKey, lastId).catch(() => {});
    setThreads(prev => prev.map(t => t.threadKey === threadKey ? { ...t, unreadCount: 0 } : t));
  }, []);

  const loadMessages = useCallback(async (threadKey: string) => {
    // Thread già visto: si mostra subito la prima pagina in cache e il fetch
    // rinfresca in background. Il guard su selectedKeyRef scarta la risposta
    // del thread che non è più aperto (coi cambi istantanei due fetch possono
    // essere in volo insieme).
    const cached = staffChatCache.timelines.get(threadKey);
    if (cached) {
      setMessages(cached);
      setHasMore(cached.length >= PAGE_SIZE);
    }
    setMsgLoading(!cached);
    setMsgError(null);
    try {
      const { messages } = await staffChatApiService.getMessages(threadKey);
      staffChatCache.setTimeline(threadKey, messages);
      if (selectedKeyRef.current !== threadKey) return;
      setMessages(messages);
      setHasMore(messages.length === PAGE_SIZE);
      const last = messages[messages.length - 1];
      if (last) markReadLocally(threadKey, last.id);
    } catch (err: any) {
      if (selectedKeyRef.current === threadKey && !cached) {
        setMsgError(err?.message || 'Errore caricamento messaggi');
      }
    } finally {
      if (selectedKeyRef.current === threadKey) setMsgLoading(false);
    }
  }, [markReadLocally]);

  useEffect(() => {
    setMentionDraft(new Map());
    setAttachments([]);
    if (!selectedKey) { setMessages([]); return; }
    loadMessages(selectedKey);
  }, [selectedKey, loadMessages]);

  useEffect(() => {
    if (!messages.length) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  const loadOlder = useCallback(async () => {
    const key = selectedKey;
    const oldest = messages[0];
    if (!key || !oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const { messages: older } = await staffChatApiService.getMessages(key, oldest.id);
      setMessages(prev => [...older, ...prev]);
      setHasMore(older.length === PAGE_SIZE);
    } catch { /* il bottone resta, si riprova */ } finally {
      setLoadingMore(false);
    }
  }, [selectedKey, messages, loadingMore]);

  // Realtime. Il messaggio arriva già completo dal server; il threadKey si
  // deriva dal punto di vista di chi guarda (per un DM è l'altro capo).
  useEffect(() => {
    const onMessage = (msg: StaffMessage) => {
      const key = threadKeyFor(msg, currentUserId);
      const open = selectedKeyRef.current === key;
      // Anche la cache riceve il messaggio (qualunque thread, non solo quello
      // aperto): riaprire una chat mostra subito ciò che è arrivato mentre si
      // era altrove, senza aspettare il refresh in background.
      const cachedTimeline = staffChatCache.timelines.get(key);
      if (cachedTimeline && !cachedTimeline.some(m => m.id === msg.id)) {
        staffChatCache.setTimeline(key, [...cachedTimeline, msg]);
      }
      setThreads(prev => {
        const existing = prev.find(t => t.threadKey === key);
        if (!existing) {
          // Thread nuovo (primo DM da un collega): la lista si ricarica.
          loadThreads();
          return prev;
        }
        const mine = msg.sender_user_id === currentUserId;
        return prev.map(t => t.threadKey === key
          ? { ...t, lastMessage: msg, unreadCount: open || mine ? t.unreadCount : t.unreadCount + 1 }
          : t);
      });
      if (open) {
        setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
        markReadLocally(key, msg.id);
      }
    };
    // Lettura da un altro device dello stesso utente: i contatori locali
    // sono stantii, si riparte dal server.
    const onRead = () => { loadThreads(); };
    // Preset cambiati da Impostazioni: le chip si aggiornano da sole.
    const onPresets = (data: { presets?: StaffPreset[] }) => {
      if (Array.isArray(data?.presets) && data.presets.length > 0) setPresets(data.presets);
    };

    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('staffchat:message', onMessage);
        attached.off('staffchat:read', onRead);
        attached.off('staffchat:presets', onPresets);
      }
      attached = s;
      if (attached) {
        attached.on('staffchat:message', onMessage);
        attached.on('staffchat:read', onRead);
        attached.on('staffchat:presets', onPresets);
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => { unsub(); attach(null); };
  }, [currentUserId, loadThreads, markReadLocally]);

  const doSend = useCallback(async (text: string, presetKey?: string | null) => {
    const key = selectedKey;
    const body = text.trim();
    if (!key || (!body && attachments.length === 0) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const mentionedIds = [...mentionDraft.entries()]
        .filter(([, name]) => body.includes(`@${name}`))
        .map(([id]) => id)
        .slice(0, STAFF_MAX_MENTIONS);
      const msg = await staffChatApiService.send(key, body, presetKey, mentionedIds, attachments.map(a => a.token));
      setComposerText('');
      setMentionDraft(new Map());
      setAttachments([]);
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      const cachedTimeline = staffChatCache.timelines.get(key);
      if (cachedTimeline && !cachedTimeline.some(m => m.id === msg.id)) {
        staffChatCache.setTimeline(key, [...cachedTimeline, msg]);
      }
      setThreads(prev => prev.map(t => t.threadKey === key ? { ...t, lastMessage: msg } : t));
      // Il proprio messaggio è per definizione letto.
      staffChatApiService.markRead(key, msg.id).catch(() => {});
      composerRef.current?.focus();
    } catch (err: any) {
      setSendError(err?.message || 'Invio non riuscito');
    } finally {
      setSending(false);
    }
  }, [selectedKey, sending, mentionDraft, attachments]);

  const handlePickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setSendError(null);
    try {
      const uploaded: StaffUploadedAttachment[] = [];
      for (const file of Array.from(files).slice(0, STAFF_MAX_ATTACHMENTS)) {
        uploaded.push(await staffChatApiService.uploadAttachment(file));
      }
      setAttachments(prev => [...prev, ...uploaded].slice(0, STAFF_MAX_ATTACHMENTS));
    } catch (err: any) {
      setSendError(err?.message || 'Caricamento foto non riuscito');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend(composerText);
    }
  };

  // Autocomplete menzioni: un "@parziale" in coda al testo apre la lista dei
  // membri del canale. Solo nei canali — nel DM l'interlocutore è già uno.
  const mentionQuery = useMemo(() => {
    if (!selected || selected.kind !== 'channel') return null;
    const m = composerText.match(/@([^\s@]{0,30})$/);
    return m ? m[1] : null;
  }, [composerText, selected]);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null || !selected || selected.kind !== 'channel') return [];
    const memberRoles = rolesForChannel(selected.channel as StaffChannel).map(String) as string[];
    const q = mentionQuery.toLowerCase();
    return colleagues
      .filter(c => memberRoles.includes(c.role))
      .filter(c => c.fullName.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, selected, colleagues]);

  const applyMention = useCallback((c: StaffColleague) => {
    setComposerText(prev => prev.replace(/@([^\s@]{0,30})$/, `@${c.fullName} `));
    setMentionDraft(prev => new Map(prev).set(c.id, c.fullName));
    composerRef.current?.focus();
  }, []);

  // Nomi noti per l'evidenziazione: i colleghi più chi guarda.
  const knownNames = useMemo(() => {
    const names = colleagues.map(c => c.fullName).filter(Boolean);
    if (currentUserName) names.push(currentUserName);
    return names;
  }, [colleagues, currentUserName]);

  // Apre (o crea lato client) il DM con un collega. Il thread nasce sul
  // server col primo messaggio.
  const openDmWith = useCallback((c: StaffColleague) => {
    const key = dmThreadKey(c.id);
    setThreads(prev => prev.some(t => t.threadKey === key) ? prev : [...prev, {
      threadKey: key,
      kind: 'direct' as const,
      otherUser: { id: c.id, fullName: c.fullName, role: c.role, isActive: true },
      lastMessage: null,
      unreadCount: 0,
    }]);
    setPickerOpen(false);
    setSelectedKey(key);
  }, []);

  // Ordine lista: ultimo messaggio più recente in testa; i thread senza
  // traffico in coda nel loro ordine naturale (canali prima dei DM appena
  // aperti). Stessa regola del server.
  const orderedThreads = useMemo(() => {
    return [...threads].sort((a, b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0));
  }, [threads]);
  const channelThreads = orderedThreads.filter(t => t.kind === 'channel');
  const dmThreads = orderedThreads.filter(t => t.kind === 'direct');

  const grouped = useMemo(() => {
    const groups: { day: string; items: StaffMessage[] }[] = [];
    for (const m of messages) {
      const day = m.created_at.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(m);
      else groups.push({ day: m.created_at, items: [m] });
    }
    return groups;
  }, [messages]);

  const renderThread = (t: StaffThreadSummary) => (
    <button
      key={t.threadKey}
      type="button"
      onClick={() => setSelectedKey(t.threadKey)}
      aria-current={selectedKey === t.threadKey ? 'true' : undefined}
      className={`flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
        selectedKey === t.threadKey ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
      }`}
    >
      {t.kind === 'channel'
        ? (
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
            <Hash className="h-4 w-4" aria-hidden />
          </span>
        )
        : <Avatar name={t.otherUser?.fullName} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-[15px] text-[var(--ds-text-primary)] ${t.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>
            {threadTitle(t)}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="whitespace-nowrap text-[13px] text-[var(--ds-text-muted)]">
              {formatRelative(t.lastMessage?.created_at ?? null)}
            </span>
            {t.unreadCount > 0 && <CountBadge tone="alert" count={t.unreadCount} />}
          </span>
        </div>
        <p className={`mt-0.5 truncate text-[14px] ${t.unreadCount > 0 ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'}`}>
          {t.lastMessage
            ? (t.kind === 'channel' && t.lastMessage.sender_user_id !== currentUserId
              ? `${t.lastMessage.sender_name}: ${staffMessagePreview(t.lastMessage)}`
              : staffMessagePreview(t.lastMessage))
            : 'Nessun messaggio'}
        </p>
      </div>
    </button>
  );

  return (
    <SplitPane
      detailOpen={!!selectedKey}
      toolbar={
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Chat staff</h2>
          <button
            type="button"
            onClick={() => setPickerOpen(o => !o)}
            aria-expanded={pickerOpen}
            className={dsIconButton}
            title="Nuovo messaggio diretto"
            aria-label="Nuovo messaggio diretto"
          >
            {pickerOpen ? <XIcon className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      }
      list={
        listLoading ? (
          <div className="flex h-32 items-center justify-center"><Loader /></div>
        ) : listError ? (
          <Callout tone="critical" icon={AlertTriangle}>{listError}</Callout>
        ) : (
          <div className="space-y-1">
            {pickerOpen && (
              <div className="mb-2 rounded-[16px] bg-[var(--ds-surface)] p-1.5">
                <SectionHeader>Scrivi a</SectionHeader>
                {colleagues.length === 0 ? (
                  <p className="px-3 py-2 text-[14px] text-[var(--ds-text-muted)]">Nessun altro utente attivo.</p>
                ) : colleagues.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openDmWith(c)}
                    className="flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <Avatar name={c.fullName} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-text-primary)]">{c.fullName}</span>
                    <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">{ROLE_LABELS[c.role] ?? c.role}</span>
                  </button>
                ))}
              </div>
            )}
            <SectionHeader>Canali</SectionHeader>
            <div className="space-y-1 pb-2">
              {channelThreads.map(renderThread)}
            </div>
            {dmThreads.length > 0 && (
              <>
                <SectionHeader>Messaggi diretti</SectionHeader>
                <div className="space-y-1">
                  {dmThreads.map(renderThread)}
                </div>
              </>
            )}
          </div>
        )
      }
      detail={
        !selected ? (
          <PanePlaceholder icon={MessagesSquare}>Seleziona un canale o un collega</PanePlaceholder>
        ) : (
          <>
            <PaneHeader
              onBack={() => setSelectedKey(null)}
              backLabel="Torna alle chat"
              title={threadTitle(selected)}
              subtitle={selected.kind === 'direct'
                ? (ROLE_LABELS[selected.otherUser?.role ?? ''] ?? undefined)
                : undefined}
            />

            <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)]">
              <div className="px-4 pb-4 sm:px-6 lg:px-8">
                {msgLoading ? (
                  <div className="flex h-32 items-center justify-center"><Loader /></div>
                ) : msgError ? (
                  <Callout tone="critical" icon={AlertTriangle}>{msgError}</Callout>
                ) : messages.length === 0 ? (
                  <p className="mt-8 text-center text-[14px] text-[var(--ds-text-muted)]">
                    Nessun messaggio ancora.
                  </p>
                ) : (
                  <div className="mx-auto max-w-3xl space-y-4">
                    {hasMore && (
                      <div className="flex justify-center pt-2">
                        <button
                          type="button"
                          onClick={loadOlder}
                          disabled={loadingMore}
                          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                        >
                          {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronUp className="h-4 w-4" />}
                          Messaggi precedenti
                        </button>
                      </div>
                    )}
                    {grouped.map(g => (
                      <div key={g.day} className="space-y-2">
                        <div className="flex justify-center">
                          <span className="rounded-full bg-[var(--ds-surface)] px-2.5 py-1 text-[12px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)]">
                            {formatDayHeader(g.day)}
                          </span>
                        </div>
                        {g.items.map(m => {
                          const mine = m.sender_user_id === currentUserId;
                          const mentionsMe = !mine && (m.mentioned_user_ids ?? []).includes(currentUserId);
                          return (
                            // Il proprio messaggio prende `action`, non una
                            // famiglia di stato: "mio" contro "suo" non e' uno
                            // stato del servizio, e `seated` — che vuol dire
                            // seduto/in servizio — qui non diceva niente (§3.5).
                            // `action` e' lo stesso nero del tasto Invia due
                            // righe sotto, quindi la bolla appartiene a chi
                            // scrive. Le categorie `--ds-cat-*` sono escluse:
                            // non vanno mai dietro testo piccolo.
                            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                              <div
                                className={`max-w-[80%] rounded-[18px] px-3.5 py-2 ${
                                  mine
                                    ? 'rounded-br-[6px] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                    : 'rounded-bl-[6px] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                                } ${mentionsMe ? 'ring-1 ring-[var(--ds-arriving-solid)]' : ''}`}
                              >
                                {!mine && selected.kind === 'channel' && (
                                  <p className="text-[12px] font-semibold text-[var(--ds-text-secondary)]">{m.sender_name}</p>
                                )}
                                {(m.media ?? []).length > 0 && (
                                  <div className="mb-1.5 space-y-1.5">
                                    {(m.media ?? []).map(att => (
                                      <a key={att.token} href={staffMediaUrl(att.token)} target="_blank" rel="noopener noreferrer">
                                        <img src={staffMediaUrl(att.token)} alt={att.filename || 'Foto'} className="max-h-64 w-auto rounded-[12px] object-cover" loading="lazy" />
                                      </a>
                                    ))}
                                  </div>
                                )}
                                {m.body && (
                                  <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">
                                    {(m.mentioned_user_ids ?? []).length > 0
                                      ? renderBodyWithMentions(m.body, knownNames, mine)
                                      : m.body}
                                  </p>
                                )}
                                <div className={`mt-1 flex justify-end text-[12px] ${mine ? 'text-[var(--ds-action-fg)] opacity-75' : 'text-[var(--ds-text-muted)]'}`}>
                                  <span className="tabular-nums">{formatTime(m.created_at)}</span>
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
            </div>

            <div className="flex-shrink-0 px-4 pb-4 pt-3 sm:px-6 lg:px-8">
              <div className="mx-auto max-w-3xl space-y-2">
                {sendError && <Callout tone="critical" icon={AlertTriangle}>{sendError}</Callout>}

                {/* Messaggi rapidi: un tap e parte — è il gesto pensato per il
                    servizio, quando scrivere è un lusso. */}
                <div className="flex flex-wrap gap-1.5">
                  {presets.map(p => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => doSend(p.label, p.key)}
                      disabled={sending}
                      className="inline-flex h-9 items-center rounded-full bg-[var(--ds-surface)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {/* Autocomplete menzioni: compare quando il testo finisce con
                    "@parziale", elenca i membri del canale. */}
                {mentionCandidates.length > 0 && (
                  <div className="rounded-[14px] bg-[var(--ds-surface)] p-1.5 shadow-[var(--ds-shadow-card)]">
                    {mentionCandidates.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => applyMention(c)}
                        className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        <Avatar name={c.fullName} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-text-primary)]">{c.fullName}</span>
                        <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">{ROLE_LABELS[c.role] ?? c.role}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="rounded-[24px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                  {/* Gli allegati stanno dentro la scheda del composer, sopra
                      la riga di scrittura: appartengono al messaggio che si sta
                      componendo, non alla pagina. Qui la chat ha l'anteprima
                      vera — `staffMediaUrl` da' un URL al file gia' caricato. */}
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {attachments.map(a => (
                        <AttachmentRow
                          key={a.token}
                          filename={a.filename}
                          contentType={a.content_type}
                          sizeBytes={a.size_bytes}
                          previewUrl={staffMediaUrl(a.token)}
                          onRemove={() => setAttachments(prev => prev.filter(x => x.token !== a.token))}
                        />
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    hidden
                    onChange={e => handlePickFiles(e.target.files)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || sending || attachments.length >= STAFF_MAX_ATTACHMENTS}
                    aria-label="Allega una foto"
                    title="Allega una foto"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                  </button>
                  <textarea
                    ref={composerRef}
                    value={composerText}
                    onChange={e => setComposerText(e.target.value.slice(0, STAFF_MESSAGE_MAX_LENGTH))}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Scrivi un messaggio…"
                    rows={1}
                    className="max-h-40 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-snug text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none"
                  />
                  <button
                    onClick={() => doSend(composerText)}
                    disabled={(!composerText.trim() && attachments.length === 0) || sending || uploading}
                    aria-label="Invia messaggio"
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-all hover:bg-[var(--ds-action-bg-hover)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed disabled:bg-[var(--ds-surface-row)] disabled:text-[var(--ds-text-subtle)]"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )
      }
    />
  );
};

export default StaffChatPage;
