import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, LifeBuoy, Loader2, Paperclip, Plus, Send } from 'lucide-react';
import {
  SplitPane, PaneHeader, PanePlaceholder, EmptyState, Callout, AttachmentRow, ModalShell, FormCard, Field,
  dsButton, dsIconButton, dsInput, dsTextarea,
} from './ds';
import { Loader } from './Loader';
import {
  SupportMessages, SupportStatusPill, SupportUrgentPill, supportCategoryLabel,
} from './SupportThread';
import { supportApiService, type SupportClientContext, type SupportUploadedAttachment } from '../services/supportApiService';
import {
  SUPPORT_ATTACHMENTS_MAX, SUPPORT_BODY_MAX, SUPPORT_CATEGORIES, SUPPORT_SUBJECT_MAX,
  type SupportCategory, type SupportTicket, type SupportTicketDetail,
} from '../services/supportShared';
import { socketClient } from '../services/socketClient';
import { offlineQueue } from '../services/offlineQueue';
import { isHybridActive, isNodeInUse } from '../services/apiRouting';
import { relativeTime } from '../utils/relativeTime';
import type { ApiError } from '../services/apiError';

/* ============================================
   AIUTO — richieste di supporto al team Sympotia
   ============================================
   Lista delle richieste a sinistra, conversazione a destra (sheet a tutto
   schermo sul telefono, come i canali di Comunicazioni). Una richiesta nuova
   porta con sé la fotografia tecnica del momento: qui la parte che vede solo
   il browser, il resto lo aggiunge il server (vedi POST /support/tickets). */

type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;

/** Quello che solo il browser sa. Ogni pezzo è best-effort: un dato che non
 *  si legge non deve impedire di chiedere aiuto. */
const buildClientContext = (originView: string | null): SupportClientContext => {
  const ctx: SupportClientContext = {};
  try { ctx.origin_view = originView ?? undefined; } catch { /* niente */ }
  try { ctx.app_version = __APP_VERSION__; } catch { /* niente */ }
  try {
    ctx.user_agent = navigator.userAgent;
    ctx.language = navigator.language;
    ctx.online = navigator.onLine;
  } catch { /* niente */ }
  try {
    ctx.viewport = `${window.innerWidth}x${window.innerHeight}`;
    ctx.dpr = window.devicePixelRatio;
    ctx.standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch { /* niente */ }
  try { ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* niente */ }
  try { ctx.socket_connected = socketClient.isConnected(); } catch { /* niente */ }
  try { ctx.offline_queue = offlineQueue.size(); } catch { /* niente */ }
  try {
    ctx.node_hybrid = isHybridActive();
    ctx.node_in_use = isNodeInUse();
  } catch { /* niente */ }
  return ctx;
};

/* ── Nuova richiesta ─────────────────────────────────────────────────── */

interface PendingPhoto extends SupportUploadedAttachment {
  previewUrl: string;
}

const NewRequestModal: React.FC<{
  open: boolean;
  originView: string | null;
  onClose: () => void;
  onCreated: (ticket: SupportTicketDetail) => void;
  showToast: ShowToast;
}> = ({ open, originView, onClose, onCreated, showToast }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [category, setCategory] = useState<SupportCategory | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    photos.forEach(p => URL.revokeObjectURL(p.previewUrl));
    setCategory(null); setUrgent(false); setSubject(''); setBody('');
    setPhotos([]); setError(null); setShowContext(false);
  };

  const close = () => { reset(); onClose(); };

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, SUPPORT_ATTACHMENTS_MAX - photos.length)) {
        const uploaded = await supportApiService.uploadAttachment(file);
        setPhotos(prev => [...prev, { ...uploaded, previewUrl: URL.createObjectURL(file) }]);
      }
    } catch (err) {
      showToast((err as ApiError).message || t('errUpload', 'Foto non caricata'), 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const valid = !!category && subject.trim().length > 0 && body.trim().length > 0;

  const submit = async () => {
    if (!valid || !category) return;
    setSubmitting(true);
    setError(null);
    try {
      const ticket = await supportApiService.create({
        category,
        urgent,
        subject: subject.trim(),
        body: body.trim(),
        attachments: photos.map(p => p.token),
        context: buildClientContext(originView),
      });
      reset();
      onCreated(ticket);
    } catch (err) {
      setError((err as ApiError).message || t('errCreate', 'Richiesta non inviata'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <ModalShell
      open
      onClose={close}
      title={t('newRequest', 'Nuova richiesta')}
      size="md"
      bodyClassName="p-5 sm:p-6"
      footer={
        <>
          <button type="button" className={dsButton.secondary} onClick={close}>
            {t('cancel', 'Annulla')}
          </button>
          <button type="button" className={dsButton.primary} onClick={submit} disabled={!valid || submitting || uploading}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            {t('send', 'Invia')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

        <FormCard title={t('whatAbout', 'Di cosa si tratta')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('whatAbout', 'Di cosa si tratta')}>
            {SUPPORT_CATEGORIES.map(c => {
              const on = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setCategory(c)}
                  className={`inline-flex h-11 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    on
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                  }`}
                >
                  {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {supportCategoryLabel(c, t)}
                </button>
              );
            })}
          </div>
        </FormCard>

        <FormCard>
          {/* L'interruttore alza la priorità e avvisa subito: nessuna
              promessa di tempi, solo che il team lo sa adesso. */}
          <button
            type="button"
            role="switch"
            aria-checked={urgent}
            onClick={() => setUrgent(u => !u)}
            className="flex min-h-[44px] w-full items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[var(--ds-radius-sm)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-[var(--ds-text-primary)]">{t('blocksService', 'Blocca il servizio')}</span>
              <span className="block text-[13px] text-[var(--ds-text-muted)]">
                {urgent ? t('urgentHint', 'Avvisiamo subito il team Sympotia.') : t('normalHint', 'Il problema impedisce di lavorare adesso.')}
              </span>
            </span>
            <span
              aria-hidden
              className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-colors ${urgent ? 'bg-[var(--ds-critical-solid)]' : 'bg-[var(--ds-border-strong)]'}`}
            >
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] transition-transform ${urgent ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
            </span>
          </button>
        </FormCard>

        <FormCard>
          <div className="space-y-4">
            <Field label={t('subject', 'Oggetto')} htmlFor="sup-subject" required>
              <input
                id="sup-subject"
                type="text"
                className={dsInput}
                value={subject}
                maxLength={SUPPORT_SUBJECT_MAX}
                onChange={e => setSubject(e.target.value)}
                placeholder={t('subjectPlaceholder', 'Es. la comanda non esce in cucina')}
              />
            </Field>
            <Field label={t('description', 'Cosa succede')} htmlFor="sup-body" required>
              <textarea
                id="sup-body"
                rows={5}
                className={dsTextarea}
                value={body}
                maxLength={SUPPORT_BODY_MAX}
                onChange={e => setBody(e.target.value)}
                placeholder={t('descriptionPlaceholder', 'Cosa stavi facendo, cosa ti aspettavi, cosa è successo.')}
              />
            </Field>
            <div className="space-y-2">
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {photos.map(p => (
                    <AttachmentRow
                      key={p.token}
                      filename={p.filename}
                      contentType={p.content_type}
                      sizeBytes={p.size_bytes}
                      previewUrl={p.previewUrl}
                      onRemove={() => {
                        URL.revokeObjectURL(p.previewUrl);
                        setPhotos(prev => prev.filter(x => x.token !== p.token));
                      }}
                    />
                  ))}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                hidden
                onChange={e => pickFiles(e.target.files)}
              />
              <button
                type="button"
                className={dsButton.quiet}
                onClick={() => fileRef.current?.click()}
                disabled={uploading || photos.length >= SUPPORT_ATTACHMENTS_MAX}
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Paperclip className="h-4 w-4" aria-hidden />}
                {t('addPhoto', 'Aggiungi una foto')}
              </button>
            </div>
          </div>
        </FormCard>

        {/* Trasparenza su cosa parte da solo: niente dati dei clienti, solo
            lo stato tecnico del locale e del dispositivo. */}
        <div>
          <button
            type="button"
            onClick={() => setShowContext(s => !s)}
            aria-expanded={showContext}
            className="inline-flex min-h-[44px] items-center gap-1.5 text-[14px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[var(--ds-radius-sm)]"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${showContext ? 'rotate-180' : ''}`} aria-hidden />
            {t('autoData', 'Dati inviati automaticamente')}
          </button>
          {showContext && (
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              {t('autoDataBody', "Versione dell'app, schermata da cui scrivi, dispositivo e connessione, stato del nodo di sala e delle stampe delle ultime 24 ore. Nessun dato dei tuoi clienti.")}
            </p>
          )}
        </div>
      </div>
    </ModalShell>
  );
};

/* ── Pagina ──────────────────────────────────────────────────────────── */

export const SupportPanel: React.FC<{
  currentUserId: number;
  /** La vista da cui si è arrivati all'Aiuto: finisce nel contesto. */
  originView: string | null;
  /** Deep link da notifica (?ticket=): apre quella richiesta. */
  initialTicketId: number | null;
  onInitialTicketConsumed: () => void;
  showToast: ShowToast;
}> = ({ currentUserId, originView, initialTicketId, onInitialTicketConsumed, showToast }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [seesAll, setSeesAll] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  // Un backend più vecchio del frontend (la finestra fra i due deploy) non
  // ha la rotta: 404 si legge come lista vuota, non come errore.
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [replyPhotos, setReplyPhotos] = useState<PendingPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<'resolve' | 'escalate' | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await supportApiService.list();
      setTickets(res.tickets);
      setSeesAll(res.sees_all === true);
      setListError(null);
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 404) setTickets([]);
      else setListError(apiErr.message || t('errLoad', 'Richieste non caricate'));
    } finally {
      setListLoading(false);
    }
  }, [t]);

  const loadDetail = useCallback(async (id: number, quiet = false) => {
    if (!quiet) setDetailLoading(true);
    try {
      const d = await supportApiService.get(id);
      setDetail(d);
      setDetailError(null);
      // Aperta = letta: la lista spegne il pallino senza rifare la chiamata.
      setTickets(prev => prev.map(x => (x.id === id ? { ...x, tenant_unread: d.tenant_unread } : x)));
    } catch (err) {
      setDetailError((err as ApiError).message || t('errLoadOne', 'Richiesta non caricata'));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    if (initialTicketId) {
      setSelectedId(initialTicketId);
      onInitialTicketConsumed();
    }
  }, [initialTicketId, onInitialTicketConsumed]);

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    setReply('');
    setReplyPhotos([]);
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // La risposta della piattaforma arriva via socket: lista e conversazione
  // aperta si rinfrescano senza ricaricare la pagina.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  useEffect(() => {
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const onUpdated = (payload: { id?: number }) => {
      loadList();
      if (payload?.id && payload.id === selectedRef.current) loadDetail(payload.id, true);
    };
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      attached?.off('support:updated', onUpdated);
      attached = s;
      attached?.on('support:updated', onUpdated);
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange(s => attach(s));
    return () => { unsub(); attach(null); };
  }, [loadList, loadDetail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length]);

  const applyDetail = (d: SupportTicketDetail) => {
    setDetail(d);
    setTickets(prev => {
      const rest = prev.filter(x => x.id !== d.id);
      return [d, ...rest];
    });
  };

  const pickReplyFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, SUPPORT_ATTACHMENTS_MAX - replyPhotos.length)) {
        const uploaded = await supportApiService.uploadAttachment(file);
        setReplyPhotos(prev => [...prev, { ...uploaded, previewUrl: URL.createObjectURL(file) }]);
      }
    } catch (err) {
      showToast((err as ApiError).message || t('errUpload', 'Foto non caricata'), 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const sendReply = async () => {
    if (!detail || !reply.trim()) return;
    setSending(true);
    try {
      const d = await supportApiService.reply(detail.id, reply.trim(), replyPhotos.map(p => p.token));
      replyPhotos.forEach(p => URL.revokeObjectURL(p.previewUrl));
      setReply('');
      setReplyPhotos([]);
      applyDetail(d);
    } catch (err) {
      showToast((err as ApiError).message || t('errSend', 'Messaggio non inviato'), 'error');
    } finally {
      setSending(false);
    }
  };

  const resolve = async () => {
    if (!detail) return;
    setBusy('resolve');
    try {
      applyDetail(await supportApiService.resolve(detail.id));
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Modifica non salvata'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const escalate = async () => {
    if (!detail) return;
    setBusy('escalate');
    try {
      applyDetail(await supportApiService.escalate(detail.id));
      showToast(t('escalated', 'Segnalata come urgente'), 'success');
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Modifica non salvata'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const open = useMemo(() => tickets.filter(x => x.status !== 'risolto'), [tickets]);
  const closed = useMemo(() => tickets.filter(x => x.status === 'risolto'), [tickets]);

  // Il pallino è di chi ha aperto la richiesta: lo spegne solo lui leggendo.
  const isUnread = (x: SupportTicket) => x.tenant_unread && x.created_by_user_id === currentUserId;

  const renderRow = (x: SupportTicket) => {
    const unread = isUnread(x);
    return (
      <button
        key={x.id}
        type="button"
        onClick={() => setSelectedId(x.id)}
        aria-current={selectedId === x.id ? 'true' : undefined}
        className={`flex w-full flex-col gap-1 rounded-[var(--ds-radius)] px-3.5 py-3 text-left shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
          selectedId === x.id ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
        }`}
      >
        <div className="flex items-baseline gap-2">
          {unread && <span className="h-2 w-2 flex-shrink-0 self-center rounded-full bg-[var(--ds-critical-solid)]" aria-label={t('unread', 'Risposta da leggere')} />}
          <span className={`min-w-0 flex-1 truncate text-[15px] text-[var(--ds-text-primary)] ${unread ? 'font-semibold' : 'font-medium'}`}>
            {x.subject}
          </span>
          <span className="flex-shrink-0 whitespace-nowrap text-[13px] text-[var(--ds-text-muted)]">
            {relativeTime(x.last_message_at, t)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SupportStatusPill status={x.status} perspective="tenant" />
          {x.priority === 'urgente' && x.status !== 'risolto' && <SupportUrgentPill />}
          <span className="truncate text-[13px] text-[var(--ds-text-muted)]">
            {supportCategoryLabel(x.category, t)}
            {seesAll && x.created_by_name ? ` · ${x.created_by_name}` : ''}
          </span>
        </div>
      </button>
    );
  };

  const canAct = detail ? detail.created_by_user_id === currentUserId || seesAll : false;

  return (
    <>
      <SplitPane
        detailOpen={selectedId != null}
        toolbar={
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">{t('title', 'Aiuto')}</h2>
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className={dsIconButton}
              title={t('newRequest', 'Nuova richiesta')}
              aria-label={t('newRequest', 'Nuova richiesta')}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
        }
        list={
          listLoading ? (
            <div className="flex h-32 items-center justify-center"><Loader /></div>
          ) : listError ? (
            <Callout tone="critical" icon={AlertTriangle}>{listError}</Callout>
          ) : tickets.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              action={
                <button type="button" className={dsButton.primary} onClick={() => setNewOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('newRequest', 'Nuova richiesta')}
                </button>
              }
            >
              {t('empty', 'Qualcosa non va? Scrivi al team Sympotia.')}
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {open.length > 0 && <div className="space-y-1.5">{open.map(renderRow)}</div>}
              {closed.length > 0 && (
                <div className="space-y-1.5">
                  <p className="px-1 text-[13px] font-medium text-[var(--ds-text-muted)]">{t('resolvedSection', 'Risolte')}</p>
                  {closed.map(renderRow)}
                </div>
              )}
            </div>
          )
        }
        detail={
          selectedId == null ? (
            <PanePlaceholder icon={LifeBuoy}>{t('pickOne', 'Seleziona una richiesta')}</PanePlaceholder>
          ) : (
            <>
              <PaneHeader
                onBack={() => setSelectedId(null)}
                backLabel={t('backToList', 'Torna alle richieste')}
                title={detail?.subject ?? ''}
                subtitle={detail ? `#${detail.id} · ${supportCategoryLabel(detail.category, t)}${seesAll && detail.created_by_name ? ` · ${detail.created_by_name}` : ''}` : undefined}
                badge={detail ? <SupportStatusPill status={detail.status} perspective="tenant" /> : undefined}
              />
              <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)]">
                <div className="px-4 pb-4 sm:px-6 lg:px-8">
                  {detailLoading && !detail ? (
                    <div className="flex h-32 items-center justify-center"><Loader /></div>
                  ) : detailError ? (
                    <Callout tone="critical" icon={AlertTriangle}>{detailError}</Callout>
                  ) : detail ? (
                    <div className="mx-auto max-w-3xl space-y-3">
                      {canAct && detail.status !== 'risolto' && (
                        <div className="flex flex-wrap gap-2">
                          {detail.priority === 'urgente' ? (
                            <SupportUrgentPill />
                          ) : (
                            <button type="button" className={dsButton.secondary} onClick={escalate} disabled={busy !== null}>
                              {busy === 'escalate' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
                              {t('markUrgent', 'Blocca il servizio')}
                            </button>
                          )}
                          <button type="button" className={dsButton.secondary} onClick={resolve} disabled={busy !== null}>
                            {busy === 'resolve' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                            {t('markResolved', 'Segna risolta')}
                          </button>
                        </div>
                      )}
                      <SupportMessages messages={detail.messages} perspective="tenant" />
                      <div ref={endRef} />
                    </div>
                  ) : null}
                </div>
              </div>

              {detail && canAct && (
                <div className="flex-shrink-0 px-4 pb-4 pt-3 sm:px-6 lg:px-8">
                  <div className="mx-auto max-w-3xl rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                    {replyPhotos.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {replyPhotos.map(p => (
                          <AttachmentRow
                            key={p.token}
                            filename={p.filename}
                            contentType={p.content_type}
                            sizeBytes={p.size_bytes}
                            previewUrl={p.previewUrl}
                            onRemove={() => {
                              URL.revokeObjectURL(p.previewUrl);
                              setReplyPhotos(prev => prev.filter(x => x.token !== p.token));
                            }}
                          />
                        ))}
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        hidden
                        onChange={e => pickReplyFiles(e.target.files)}
                      />
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading || sending || replyPhotos.length >= SUPPORT_ATTACHMENTS_MAX}
                        aria-label={t('addPhoto', 'Aggiungi una foto')}
                        title={t('addPhoto', 'Aggiungi una foto')}
                        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                      </button>
                      <textarea
                        value={reply}
                        onChange={e => setReply(e.target.value.slice(0, SUPPORT_BODY_MAX))}
                        placeholder={detail.status === 'risolto'
                          ? t('replyReopen', 'Scrivi per riaprire…')
                          : t('replyPlaceholder', 'Scrivi una risposta…')}
                        rows={1}
                        className="max-h-40 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] leading-snug text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={sendReply}
                        disabled={!reply.trim() || sending || uploading}
                        aria-label={t('send', 'Invia')}
                        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-all hover:bg-[var(--ds-action-bg-hover)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:cursor-not-allowed disabled:bg-[var(--ds-surface-row)] disabled:text-[var(--ds-text-subtle)]"
                      >
                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )
        }
      />

      <NewRequestModal
        open={newOpen}
        originView={originView}
        onClose={() => setNewOpen(false)}
        onCreated={ticket => {
          setNewOpen(false);
          setTickets(prev => [ticket, ...prev]);
          setSelectedId(ticket.id);
          setDetail(ticket);
          showToast(t('sent', 'Richiesta inviata'), 'success');
        }}
        showToast={showToast}
      />
    </>
  );
};

export default SupportPanel;
