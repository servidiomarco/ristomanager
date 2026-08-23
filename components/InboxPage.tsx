import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Send, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock, ArrowRight, Check, CalendarPlus, Paperclip, X as XIcon, Sparkles, Wand2, FolderOpen } from 'lucide-react';
import { Loader } from './Loader';
import { SkeletonInboxList } from './SkeletonCards';
import {
  messagesApiService,
  ConversationSummary,
  InboxMessage,
  MessageChannel,
  fetchMedia,
  uploadAttachment,
  type MessageMedia,
  type UploadedAttachment,
} from '../services/messagesApiService';
import { socketClient } from '../services/socketClient';
import { runAgent, confirmProposal, discardProposal, type AgentProposal } from '../services/aiMessagesApiService';
import { listMedia, attachFromLibrary, type MediaFile } from '../services/mediaApiService';
import { getFeatureFlags } from '../services/apiService';
import { toTitleCase } from '../utils/text';
import {
  SearchField, StatusPill, Callout, SegmentedControl, SplitPane, SectionHeader,
  Avatar, EmptyState, SwipeRow, useFirstRunHint, dsIconButton, PanePlaceholder, CountBadge,
  PaneHeader,
} from './ds';
import type { PillTone } from './ds';

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

// The two channels stay visually distinct, mapped onto the palette we have:
// WhatsApp keeps green, SMS takes indigo in place of the old sky blue.
const channelTone = (channel: MessageChannel): PillTone =>
  channel === 'whatsapp' ? 'positive' : 'info';

/** Un allegato in arrivo (foto, vocale, posizione). Il file sta su Twilio
 *  dietro autenticazione: si scarica dal backend e si mostra da un object URL,
 *  revocato allo smontaggio per non tenersi i blob in memoria. */
const MediaAttachment: React.FC<{ messageId: number; index: number; media: MessageMedia }> = ({ messageId, index, media }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const type = media.content_type || '';
  const isImage = type.startsWith('image/');
  const isAudio = type.startsWith('audio/');
  const isVideo = type.startsWith('video/');

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchMedia(messageId, index)
      .then(blob => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!revoked) setFailed(true); });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [messageId, index]);

  if (failed) {
    return <p className="text-[13px] italic opacity-70">Allegato non disponibile</p>;
  }
  if (!url) {
    return <div className="h-32 w-44 animate-pulse rounded-[12px] bg-[var(--ds-surface-row)]" />;
  }
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt="Allegato" className="max-h-64 w-auto rounded-[12px] object-cover" />
      </a>
    );
  }
  if (isAudio) return <audio controls src={url} className="max-w-[240px]" />;
  if (isVideo) return <video controls src={url} className="max-h-64 rounded-[12px]" />;
  return (
    <a href={url} download target="_blank" rel="noopener noreferrer" className="text-[14px] underline">
      Scarica allegato
    </a>
  );
};

// Delivery state on an outbound bubble. The bubble is already filled, so these
// ride on currentColor rather than a second colour fighting the fill.
const statusIcon = (m: InboxMessage) => {
  if (m.direction !== 'outbound') return null;
  const s = (m.status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return <CheckCircle2 className="h-3.5 w-3.5" aria-label="Consegnato" />;
  if (s === 'failed' || s === 'undelivered') return <AlertTriangle className="h-3.5 w-3.5" aria-label="Non consegnato" />;
  return <Clock className="h-3.5 w-3.5" aria-label="In invio" />;
};

const displayName = (c: ConversationSummary): string =>
  (c.customer_name && c.customer_name.trim() && toTitleCase(c.customer_name)) || c.phone || `+${c.phone_digits}`;

interface InboxPageProps {
  /** Apre il modulo nuova prenotazione col contatto già compilato. */
  onCreateReservationFromContact?: (contact: { customer_name?: string; phone?: string }) => void;
}

const InboxPage: React.FC<InboxPageProps> = ({ onCreateReservationFromContact }) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);
  // Search over the conversation list. Always visible rather than behind a
  // toggle: on a list you filter before you scroll. Matches name, phone (raw +
  // digits) or the last message body — case-insensitive, no debounce (the list
  // is filtered client-side already).
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);

  const [composerText, setComposerText] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  // Libreria: si carica solo quando la apri, non a ogni conversazione.
  const [libreriaAperta, setLibreriaAperta] = useState(false);
  const [libreria, setLibreria] = useState<MediaFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

    // Esito di consegna dal callback Twilio: arriva dopo l'invio, quindi
    // senza questo la bolla resta con l'orologio anche quando il messaggio e'
    // fallito e chi l'ha mandato crede sia partito.
    const onStatus = (msg: InboxMessage) => {
      if (!msg?.id) return;
      setMessages(prev => prev.map(m => (m.id === msg.id ? { ...m, ...msg } : m)));
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
        attached.off('message:status', onStatus);
      }
      attached = s;
      if (attached) {
        attached.on('message:inbound', onInbound);
        attached.on('message:outbound', onOutbound);
        attached.on('message:status', onStatus);
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

  // Carica subito il file scelto: al momento dell'invio serve solo il token,
  // cosi' l'attesa dell'upload non si somma a quella dell'invio.
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
      // WhatsApp e' l'unico canale con gli allegati: evita che il primo
      // invio fallisca solo perche' il canale era su SMS.
      setPreferredChannel('whatsapp');
    } catch (err: any) {
      setSendError(err?.message || 'Caricamento allegato non riuscito');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  // Il pulsante compare solo a funzione attiva: senza, sarebbe un bottone che
  // risponde sempre "disattivato".
  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setAiEnabled(f.ai_messages_enabled === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Il suggerimento finisce NEL CAMPO DI SCRITTURA, non in chat: da lì si
  // legge, si corregge e si invia — o si cancella. Non parte niente da solo.
  // L'agente legge la conversazione, verifica la disponibilità se serve e
  // propone. Il testo finisce nel campo di scrittura, l'eventuale azione in un
  // riquadro sopra: nulla parte e nulla viene scritto senza un tocco.
  const handleSuggest = useCallback(async () => {
    if (!selected || suggesting) return;
    setSuggesting(true);
    setSendError(null);
    try {
      const r = await runAgent(selected.phone_digits);
      setProposal(r.proposal);
      if (r.reply) {
        setComposerText(r.reply);
        composerRef.current?.focus();
      } else if (!r.proposal) {
        setSendError(r.reason || 'Nessun suggerimento: rispondi tu.');
      }
    } catch (err: any) {
      setSendError(err?.data?.message || err?.message || 'Suggerimento non riuscito');
    } finally {
      setSuggesting(false);
    }
  }, [selected, suggesting]);

  // Cambiando conversazione la proposta non deve seguirti addosso.
  useEffect(() => { setProposal(null); }, [selectedKey]);

  const handleConfirmProposal = useCallback(async () => {
    if (!proposal || proposalBusy) return;
    setProposalBusy(true);
    setSendError(null);
    try {
      const r = await confirmProposal(proposal.id);
      if (r.ok) {
        setProposal(null);
        loadConversations();
      } else {
        setSendError(r.result?.message || 'Il gestionale ha rifiutato la modifica');
      }
    } catch (err: any) {
      setSendError(err?.data?.message || err?.message || 'Esecuzione non riuscita');
    } finally {
      setProposalBusy(false);
    }
  }, [proposal, proposalBusy, loadConversations]);

  // Allegare dalla libreria non ricarica niente dal telefono: il backend
  // duplica il file già a bordo e restituisce un token come per un caricamento
  // normale, quindi da qui in poi la via dell'invio è la stessa.
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
      setAttachments(prev => [...prev, allegato as any]);
      setPreferredChannel('whatsapp');
      setLibreriaAperta(false);
    } catch (err: any) {
      setSendError(err?.data?.error || 'Allegato non preparato');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDiscardProposal = useCallback(async () => {
    if (!proposal) return;
    try { await discardProposal(proposal.id); } catch { /* resta comunque scartata a schermo */ }
    setProposal(null);
  }, [proposal]);

  const handleSend = useCallback(async () => {
    if (!selected || sending) return;
    const hasText = composerText.trim().length > 0;
    if (!hasText && attachments.length === 0) return;
    const phone = selected.phone || `+${selected.phone_digits}`;
    setSending(true);
    setSendError(null);
    try {
      await messagesApiService.send({
        phone,
        text: composerText.trim(),
        channel: preferredChannel,
        attachment_tokens: attachments.map(a => a.token),
      });
      setComposerText('');
      setAttachments([]);
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
  }, [selected, composerText, sending, preferredChannel, attachments]);

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

  // Filter the sidebar list by search query. Empty query returns everything.
  // Matches on customer name, phone (raw + digits), or last message body.
  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    const qDigits = q.replace(/\D/g, '');
    return conversations.filter(c => {
      const name = (c.customer_name || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      const body = (c.last_body || '').toLowerCase();
      if (name.includes(q) || phone.includes(q) || body.includes(q)) return true;
      if (qDigits.length >= 3 && c.phone_digits.includes(qDigits)) return true;
      return false;
    });
  }, [conversations, searchQuery]);

  // A thread is "da rispondere" when the customer wrote last and nobody has
  // read it. Derived from rows already loaded; the section just pins them up
  // top instead of leaving them scattered through the timeline.
  const needsReply = (c: ConversationSummary) =>
    (c.unread_count || 0) > 0 && c.last_direction !== 'outbound';
  const replyQueue = filteredConversations.filter(needsReply);
  const restOfInbox = filteredConversations.filter(c => !needsReply(c));
  const swipeHint = useFirstRunHint('ds-swipe-hint-messaggi');

  const markConversationRead = useCallback(async (phoneDigits: string) => {
    try {
      await messagesApiService.markRead(phoneDigits);
      setConversations(prev => prev.map(c =>
        c.phone_digits === phoneDigits ? { ...c, unread_count: 0 } : c
      ));
    } catch { /* badge stays stale until the next refresh */ }
  }, []);

  const renderConversation = (c: ConversationSummary, hint: boolean) => {
    const active = c.phone_digits === selectedKey;
    const unread = c.unread_count || 0;
    const whatsapp = c.last_channel === 'whatsapp';
    return (
      <SwipeRow
        key={c.phone_digits}
        hint={hint}
        left={unread > 0 ? {
          label: 'Letto',
          tone: 'confirm',
          icon: <Check className="h-4 w-4" aria-hidden />,
          onAction: () => markConversationRead(c.phone_digits),
        } : undefined}
        right={{
          label: 'Rispondi',
          tone: 'primary',
          icon: <ArrowRight className="h-4 w-4" aria-hidden />,
          onAction: () => setSelectedKey(c.phone_digits),
        }}
      >
        <button
          onClick={() => setSelectedKey(c.phone_digits)}
          className={`flex w-full gap-3 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
            active ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
          }`}
        >
          <Avatar
            name={c.customer_name || undefined}
            badge={
              <span className={`inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-semibold leading-none ring-2 ring-[var(--ds-surface)] ${
                whatsapp
                  ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                  : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
              }`}>
                {whatsapp ? 'WA' : 'SMS'}
              </span>
            }
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`truncate text-[15px] text-[var(--ds-text-primary)] ${unread > 0 ? 'font-semibold' : 'font-medium'}`}>
                {displayName(c)}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="whitespace-nowrap text-[13px] text-[var(--ds-text-muted)]">{formatRelative(c.last_sent_at)}</span>
                {unread > 0 && (
                  <CountBadge tone="alert" count={unread} />
                )}
              </span>
            </div>
            <p className={`mt-0.5 flex items-center gap-1 truncate text-[14px] ${unread > 0 ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'}`}>
              <span aria-hidden>{c.last_direction === 'outbound' ? '↗' : '↙'}</span>
              <span className="truncate">{c.last_body}</span>
            </p>
          </div>
        </button>
      </SwipeRow>
    );
  };

  return (
    <SplitPane
      detailOpen={!!selectedKey}
      toolbar={
        <div className="space-y-3">
          {/* No visible page title: the sidebar and the mobile switcher both
              name this screen, and both already carry the unread count. */}
          <h2 className="sr-only">Messaggi{totalUnread > 0 ? `, ${totalUnread} non letti` : ''}</h2>
          <div className="flex items-center gap-2">
            <SearchField
              className="min-w-0 flex-1"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Cerca nome o numero…"
            />
            <button
              onClick={() => { setConvLoading(true); loadConversations(); }}
              className={dsIconButton}
              title="Aggiorna"
              aria-label="Aggiorna"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      }
      list={
        convLoading ? (
          <SkeletonInboxList count={7} className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)]" />
        ) : convError ? (
          <Callout tone="critical" icon={AlertTriangle}>{convError}</Callout>
        ) : conversations.length === 0 ? (
          <EmptyState icon={MessageCircle}>
            Nessuna conversazione. I messaggi in arrivo appariranno qui.
          </EmptyState>
        ) : filteredConversations.length === 0 ? (
          <EmptyState icon={MessageCircle}>
            Nessun risultato per "{searchQuery.trim()}".
          </EmptyState>
        ) : (
          <div className="space-y-1">
            {replyQueue.length > 0 && (
              <>
                <SectionHeader tone="positive">Da rispondere</SectionHeader>
                <div className="space-y-2 pb-2">
                  {replyQueue.map((c, i) => renderConversation(c, swipeHint && i === 0))}
                </div>
              </>
            )}
            {restOfInbox.length > 0 && (
              <>
                <SectionHeader>Tutti i messaggi</SectionHeader>
                <div className="space-y-2">
                  {restOfInbox.map((c, i) => renderConversation(c, swipeHint && replyQueue.length === 0 && i === 0))}
                </div>
              </>
            )}
          </div>
        )
      }
      detail={
        !selected ? (
          <PanePlaceholder icon={MessageCircle}>Seleziona una conversazione dalla lista</PanePlaceholder>
        ) : (
          <>
            <PaneHeader
              onBack={() => setSelectedKey(null)}
              backLabel="Torna alle conversazioni"
              title={displayName(selected)}
              subtitle={selected.phone || undefined}
              badge={
                <StatusPill tone={channelTone(selected.last_channel)}>
                  {selected.last_channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                </StatusPill>
              }
              actions={
                <div className="flex items-center gap-2">
                  {waWindowOpen && preferredChannel === 'whatsapp' && (
                    <StatusPill tone="positive" className="hidden sm:inline-flex">
                      <Clock className="h-3 w-3" aria-hidden /> Finestra WA: {windowRemaining}
                    </StatusPill>
                  )}
                  {/* Chi scrive senza avere una prenotazione e' un cliente da
                      acquisire: il numero e' gia' qui, ricopiarlo a mano e'
                      l'unico attrito fra il messaggio e il tavolo prenotato. */}
                  {onCreateReservationFromContact && !selected.last_reservation_id && (
                    <button
                      type="button"
                      onClick={() => onCreateReservationFromContact({
                        customer_name: selected.customer_name || undefined,
                        phone: selected.phone || selected.phone_digits,
                      })}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <CalendarPlus className="h-4 w-4" aria-hidden />
                      <span className="hidden sm:inline">Crea prenotazione</span>
                    </button>
                  )}
                </div>
              }
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
                  {grouped.map(g => (
                    <div key={g.day} className="space-y-2">
                      <div className="flex justify-center">
                        <span className="rounded-full bg-[var(--ds-surface)] px-2.5 py-1 text-[12px] text-[var(--ds-text-muted)]">
                          {formatDayHeader(g.day)}
                        </span>
                      </div>
                      {g.items.map(m => {
                        const outbound = m.direction === 'outbound';
                        return (
                          <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                            {/* Ours is the filled bubble, theirs is plain
                                surface — the same side assignment the page
                                already used, now on tokens. */}
                            <div
                              className={`max-w-[80%] rounded-[18px] px-3.5 py-2 ${
                                outbound
                                  ? 'rounded-br-[6px] bg-[var(--ds-seated-solid)] text-white'
                                  : 'rounded-bl-[6px] bg-[var(--ds-surface)] text-[var(--ds-text-primary)]'
                              }`}
                            >
                              {Array.isArray(m.media) && m.media.length > 0 && (
                                <div className="mb-1.5 space-y-1.5">
                                  {m.media.map((att, i) => (
                                    <MediaAttachment key={i} messageId={m.id} index={i} media={att} />
                                  ))}
                                </div>
                              )}
                              {m.body && (
                                <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{m.body}</p>
                              )}
                              <div className={`mt-1 flex items-center justify-end gap-1.5 text-[12px] ${outbound ? 'text-white/75' : 'text-[var(--ds-text-muted)]'}`}>
                                <span className="tabular-nums">{formatTime(m.sent_at)}</span>
                                {statusIcon(m)}
                                <span className={`rounded-full px-1.5 text-[11px] ${outbound ? 'bg-white/20' : 'bg-[var(--ds-surface-row)]'}`}>
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
            </div>

            <div className="flex-shrink-0 px-4 pb-4 pt-3 sm:px-6 lg:px-8">
              <div className="mx-auto max-w-3xl space-y-2">
                {!waWindowOpen && preferredChannel === 'whatsapp' && (
                  <Callout
                    tone="pending"
                    icon={AlertTriangle}
                    action={
                      <button
                        onClick={() => setPreferredChannel('sms')}
                        className="whitespace-nowrap font-semibold underline underline-offset-4 hover:no-underline"
                      >
                        Passa a SMS
                      </button>
                    }
                  >
                    Finestra 24h WhatsApp chiusa: il cliente deve scrivere per primo.
                  </Callout>
                )}
                {sendError && <Callout tone="critical" icon={AlertTriangle}>{sendError}</Callout>}

                {/* La libreria: l'elenco dei file già caricati in Impostazioni.
                    Sta qui e non in un dialogo perché allegare il menù è un
                    gesto da due secondi in mezzo a una conversazione. */}
                {libreriaAperta && (
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
                )}

                {/* La proposta dell'agente. Sta sopra il campo di scrittura e
                    non parte da sola: l'agente ha capito cosa fare, la
                    decisione resta di chi legge. */}
                {proposal && (
                  <div className="rounded-[14px] border border-violet-300 bg-violet-50 px-3.5 py-3 dark:border-violet-800 dark:bg-violet-950/40">
                    <div className="flex items-start gap-2.5">
                      <Wand2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-violet-900 dark:text-violet-200">
                          L'agente propone un'azione sulla prenotazione
                        </p>
                        <p className="mt-0.5 text-[14px] text-[var(--ds-text-primary)]">{proposal.summary}</p>
                        <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
                          Niente è ancora cambiato: controlla e conferma tu.
                        </p>
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={handleConfirmProposal}
                            disabled={proposalBusy}
                            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-violet-600 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                          >
                            {proposalBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Conferma ed esegui
                          </button>
                          <button
                            type="button"
                            onClick={handleDiscardProposal}
                            disabled={proposalBusy}
                            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                          >
                            <XIcon className="h-4 w-4" /> Scarta
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Allegati pronti: si vedono prima di premere invia, e si
                    tolgono uno per uno se si sbaglia file. */}
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {attachments.map(a => (
                      <span
                        key={a.token}
                        className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] py-1 pl-3 pr-1.5 text-[13px] text-[var(--ds-text-primary)]"
                      >
                        <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                        <span className="truncate">{a.filename || a.content_type}</span>
                        <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">
                          {Math.max(1, Math.round(a.size_bytes / 1024))} KB
                        </span>
                        <button
                          type="button"
                          onClick={() => setAttachments(prev => prev.filter(x => x.token !== a.token))}
                          aria-label={`Togli ${a.filename || 'allegato'}`}
                          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Channel toggle. The raised-pill treatment is the app's
                    segmented control; the coloured dot keeps the channel
                    legible without repainting the whole pill. */}
                <div className="flex items-center gap-2">
                  <SegmentedControl
                    value={preferredChannel}
                    onChange={next => setPreferredChannel(next)}
                    ariaLabel="Canale di invio"
                    equalWidth={false}
                    size="sm"
                    options={[
                      { value: 'whatsapp' as MessageChannel, label: 'WhatsApp', icon: <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-seated-solid)]" aria-hidden /> },
                      { value: 'sms' as MessageChannel, label: 'SMS', icon: <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-arriving-solid)]" aria-hidden /> },
                    ]}
                  />
                  {preferredChannel === 'whatsapp' && waWindowOpen && (
                    <span className="flex items-center gap-1 text-[13px] text-[var(--ds-text-muted)]">
                      <Clock className="h-3.5 w-3.5" aria-hidden /> {windowRemaining} rimanenti
                    </span>
                  )}
                </div>

                {/* Composer: one card, send button inside the field. */}
                <div className="flex items-end gap-2 rounded-[24px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,audio/mpeg,audio/ogg,application/pdf"
                    multiple
                    hidden
                    onChange={e => handlePickFiles(e.target.files)}
                  />
                  {aiEnabled && (
                    <button
                      type="button"
                      onClick={handleSuggest}
                      disabled={suggesting || sending}
                      aria-label="Suggerisci una risposta"
                      title="Proponi una risposta in base alla conversazione e alle regole della casa"
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-violet-600 transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] dark:text-violet-400"
                    >
                      {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || sending}
                    aria-label="Allega un file"
                    title="Allega foto, PDF o audio (solo WhatsApp)"
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
                    value={composerText}
                    onChange={e => setComposerText(e.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={preferredChannel === 'whatsapp' && !waWindowOpen
                      ? 'Finestra chiusa — passa a SMS'
                      : 'Scrivi un messaggio…'}
                    rows={1}
                    disabled={preferredChannel === 'whatsapp' && !waWindowOpen}
                    className="max-h-40 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-snug text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none disabled:opacity-60"
                  />
                  <button
                    onClick={handleSend}
                    disabled={(!composerText.trim() && attachments.length === 0) || sending || uploading || (preferredChannel === 'whatsapp' && !waWindowOpen)}
                    aria-label="Invia messaggio"
                    className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed disabled:bg-[var(--ds-surface-row)] disabled:text-[var(--ds-text-subtle)] ${
                      preferredChannel === 'whatsapp'
                        ? 'bg-[var(--ds-seated-solid)] hover:brightness-95 active:scale-95'
                        : 'bg-[var(--ds-arriving-solid)] hover:brightness-95 active:scale-95'
                    }`}
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
                <p className="px-1 text-[12px] text-[var(--ds-text-muted)]">
                  Invio con <kbd className="rounded bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px]">Enter</kbd>, a capo con <kbd className="rounded bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px]">Shift+Enter</kbd>
                </p>
              </div>
            </div>
          </>
        )
      }
    />
  );
};

export default InboxPage;
