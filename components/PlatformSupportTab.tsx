import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, Kanban, LifeBuoy, Loader2, LogIn, RotateCcw, UserCheck } from 'lucide-react';
import {
  SplitPane, PaneHeader, PanePlaceholder, EmptyState, Callout, SegmentedControl, FormCard,
  dsButton, dsSelect,
} from './ds';
import { Loader } from './Loader';
import {
  SupportMessages, SupportStatusPill, SupportUrgentPill, supportCategoryLabel, formatSupportDateTime,
} from './SupportThread';
import { supportApiService } from '../services/supportApiService';
import {
  SUPPORT_BODY_MAX, type SupportStatus, type SupportTicket, type SupportTicketDetail,
} from '../services/supportShared';
import { relativeTime } from '../utils/relativeTime';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — tab Supporto
   ============================================
   La coda delle richieste di tutti i ristoranti. Nessun socket: il token di
   pannello non sta in nessun tenant, e la notifica push porta già qui. La
   lista si rinfresca al rientro in primo piano e ogni minuto. */

type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;
type StatusFilter = 'aperte' | SupportStatus | 'tutte';

const REFRESH_MS = 60_000;

/* ── Contesto tecnico ────────────────────────────────────────────────────
   Il JSON raccolto all'apertura, letto da chi deve capire cosa non va: prima
   le poche righe che di solito bastano, poi tutto il resto a richiesta. Ogni
   campo è letto con difesa — il contesto è un blob, e una richiesta aperta
   da un client vecchio può non avere un pezzo. */
const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

const ContextCard: React.FC<{ context: Record<string, unknown> }> = ({ context }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [raw, setRaw] = useState(false);
  const client = asObj(context.client);
  const server = asObj(context.server);
  const node = asObj(server.sala_node);
  const jobs = asObj(server.print_jobs_24h);
  const fiscal = Array.isArray(server.fiscal_failed_24h) ? server.fiscal_failed_24h as any[] : null;
  const lastErrors = Array.isArray(jobs.last_errors) ? jobs.last_errors as any[] : [];

  const rows: Array<{ label: string; value: string; tone?: 'critical' }> = [];
  if (client.origin_view) rows.push({ label: t('platform.ctx.view', 'Schermata'), value: String(client.origin_view) });
  rows.push({
    label: t('platform.ctx.version', 'Versione'),
    value: `app ${client.app_version ?? '?'} · server ${server.server_version ?? '?'}`,
  });
  if (client.user_agent) {
    rows.push({ label: t('platform.ctx.device', 'Dispositivo'), value: `${client.viewport ?? ''}${client.standalone ? ' · app installata' : ''} · ${String(client.user_agent).slice(0, 120)}` });
  }
  if (typeof client.online === 'boolean' || typeof client.socket_connected === 'boolean') {
    const offline = client.online === false || client.socket_connected === false;
    rows.push({
      label: t('platform.ctx.connection', 'Connessione'),
      value: `${client.online === false ? 'offline' : 'online'} · socket ${client.socket_connected ? 'connesso' : 'staccato'}${typeof client.offline_queue === 'number' && client.offline_queue > 0 ? ` · ${client.offline_queue} in coda` : ''}`,
      tone: offline ? 'critical' : undefined,
    });
  }
  if (node.enabled === false) {
    rows.push({ label: t('platform.ctx.node', 'Nodo di sala'), value: t('platform.ctx.nodeOff', 'non attivo') });
  } else if (typeof node.online === 'boolean') {
    rows.push({
      label: t('platform.ctx.node', 'Nodo di sala'),
      value: node.online ? `online · visto ${node.last_seen_seconds ?? '?'} s fa` : `offline${node.last_seen_seconds != null ? ` da ${node.last_seen_seconds} s` : ''}`,
      tone: node.online ? undefined : 'critical',
    });
  }
  if (typeof jobs.pending === 'number' || typeof jobs.failed === 'number') {
    rows.push({
      label: t('platform.ctx.print', 'Stampe 24 h'),
      value: `${jobs.pending ?? 0} in attesa · ${jobs.failed ?? 0} fallite`,
      tone: (jobs.failed ?? 0) > 0 ? 'critical' : undefined,
    });
  }
  for (const e of lastErrors) {
    rows.push({ label: '', value: `${e.printer ?? ''} ${e.kind ?? ''}: ${e.error ?? ''}`.trim(), tone: 'critical' });
  }
  if (fiscal) {
    rows.push({
      label: t('platform.ctx.fiscal', 'Scontrini falliti 24 h'),
      value: fiscal.length === 0 ? '0' : fiscal.map(f => `${f.provider}: ${f.error}`).join(' · '),
      tone: fiscal.length > 0 ? 'critical' : undefined,
    });
  }

  return (
    <FormCard title={t('platform.ctx.title', 'Contesto')}>
      <dl className="space-y-1.5 text-[14px]">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-3">
            <dt className="w-32 flex-shrink-0 text-[var(--ds-text-muted)]">{r.label}</dt>
            <dd className={`min-w-0 flex-1 break-words ${r.tone === 'critical' ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        onClick={() => setRaw(r => !r)}
        aria-expanded={raw}
        className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--ds-radius-sm)] text-[13px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${raw ? 'rotate-180' : ''}`} aria-hidden />
        {t('platform.ctx.raw', 'Tutti i dati')}
      </button>
      {raw && (
        <pre className="mt-1 max-h-80 overflow-auto rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3 text-[12px] leading-relaxed text-[var(--ds-text-secondary)]">
          {JSON.stringify(context, null, 2)}
        </pre>
      )}
    </FormCard>
  );
};

/* ── Tab ─────────────────────────────────────────────────────────────── */

export const PlatformSupportTab: React.FC<{
  tenants: Array<{ id: number; name: string }>;
  initialTicketId: number | null;
  onInitialTicketConsumed: () => void;
  onUnreadChange: (n: number) => void;
  /** «Entra» e impersonation arrivano dal pannello, che ne possiede la
   *  sessione salvata: ricaricano la pagina, ritornano solo se falliscono. */
  onEnter: (tenantId: number) => Promise<void>;
  onImpersonate: (tenantId: number) => Promise<void>;
  showToast: ShowToast;
}> = ({ tenants, initialTicketId, onInitialTicketConsumed, onUnreadChange, onEnter, onImpersonate, showToast }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('aperte');
  const [tenantFilter, setTenantFilter] = useState<number | 0>(0);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [counts, setCounts] = useState<Record<SupportStatus, number> | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await supportApiService.adminList({
        status: statusFilter,
        tenantId: tenantFilter || undefined,
      });
      setTickets(res.tickets);
      setCounts(res.counts);
      onUnreadChange(typeof res.unread === 'number' ? res.unread : 0);
      setListError(null);
    } catch (err) {
      const apiErr = err as ApiError;
      // Backend più vecchio del frontend: la rotta non c'è ancora.
      if (apiErr.status === 404) setTickets([]);
      else setListError(apiErr.message || t('errLoad', 'Richieste non caricate'));
    } finally {
      setListLoading(false);
    }
  }, [statusFilter, tenantFilter, onUnreadChange, t]);

  // loadDetail non dipende dai filtri: legge la lista più recente da qui.
  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;

  const loadDetail = useCallback(async (id: number) => {
    try {
      const d = await supportApiService.adminGet(id);
      setDetail(d);
      setDetailError(null);
      setTickets(prev => prev.map(x => (x.id === id ? { ...x, platform_unread: false } : x)));
      // Aperta = letta anche per il numero sul segmento «Supporto».
      loadListRef.current();
    } catch (err) {
      setDetailError((err as ApiError).message || t('errLoadOne', 'Richiesta non caricata'));
    }
  }, [t]);

  useEffect(() => { setListLoading(true); loadList(); }, [loadList]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') loadList(); };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [loadList]);

  useEffect(() => {
    if (initialTicketId) {
      setSelectedId(initialTicketId);
      onInitialTicketConsumed();
    }
  }, [initialTicketId, onInitialTicketConsumed]);

  useEffect(() => {
    setReply('');
    if (selectedId == null) { setDetail(null); return; }
    setDetail(null);
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length]);

  const applyDetail = (d: SupportTicketDetail) => {
    setDetail(d);
    setTickets(prev => prev.map(x => (x.id === d.id ? { ...x, ...d } : x)));
  };

  const send = async (status: SupportStatus) => {
    if (!detail || !reply.trim()) return;
    setBusy(`reply-${status}`);
    try {
      applyDetail(await supportApiService.adminReply(detail.id, reply.trim(), status));
      setReply('');
      loadList();
    } catch (err) {
      showToast((err as ApiError).message || t('errSend', 'Messaggio non inviato'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: SupportStatus) => {
    if (!detail) return;
    setBusy(`status-${status}`);
    try {
      applyDetail(await supportApiService.adminUpdate(detail.id, { status }));
      loadList();
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Modifica non salvata'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const createCard = async () => {
    if (!detail) return;
    setBusy('card');
    try {
      const res = await supportApiService.adminCreateDevCard(detail.id);
      setDetail(prev => (prev ? { ...prev, dev_card_id: res.dev_card_id } : prev));
      showToast(t('platform.cardCreated', 'Card creata nel dev board'), 'success');
    } catch (err) {
      showToast((err as ApiError).message || t('platform.errCard', 'Card non creata'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const goInto = async (mode: 'enter' | 'impersonate') => {
    if (!detail) return;
    setBusy(mode);
    try {
      if (mode === 'enter') await onEnter(detail.tenant_id);
      else await onImpersonate(detail.tenant_id);
    } catch (err) {
      setBusy(null);
      showToast((err as ApiError).message || t('platform.errEnter', 'Ingresso non riuscito'), 'error');
    }
  };

  const filterOptions = useMemo(() => {
    const openCount = counts ? counts.nuovo + counts.in_corso + counts.attesa_cliente : undefined;
    return [
      { value: 'aperte' as StatusFilter, label: t('platform.filter.open', 'Aperte'), badge: openCount },
      { value: 'nuovo' as StatusFilter, label: t('platform.filter.new', 'Nuove'), badge: counts?.nuovo, badgeTone: 'alert' as const },
      { value: 'attesa_cliente' as StatusFilter, label: t('platform.filter.waiting', 'Attesa cliente') },
      { value: 'risolto' as StatusFilter, label: t('platform.filter.resolved', 'Risolte') },
    ];
  }, [counts, t]);

  const renderRow = (x: SupportTicket) => (
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
        {x.platform_unread && <span className="h-2 w-2 flex-shrink-0 self-center rounded-full bg-[var(--ds-critical-solid)]" aria-label={t('platform.unread', 'Da leggere')} />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ds-text-secondary)]">{x.tenant_name}</span>
        <span className="flex-shrink-0 whitespace-nowrap text-[13px] text-[var(--ds-text-muted)]">{relativeTime(x.last_message_at, t)}</span>
      </div>
      <span className={`truncate text-[15px] text-[var(--ds-text-primary)] ${x.platform_unread ? 'font-semibold' : 'font-medium'}`}>{x.subject}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <SupportStatusPill status={x.status} perspective="platform" />
        {x.priority === 'urgente' && x.status !== 'risolto' && <SupportUrgentPill />}
        <span className="truncate text-[13px] text-[var(--ds-text-muted)]">{supportCategoryLabel(x.category, t)}</span>
      </div>
    </button>
  );

  return (
    <SplitPane
      detailOpen={selectedId != null}
      toolbar={
        <div className="space-y-2">
          <SegmentedControl
            value={statusFilter}
            onChange={next => setStatusFilter(next as StatusFilter)}
            options={filterOptions}
            ariaLabel={t('platform.filter.aria', 'Filtra per stato')}
            equalWidth={false}
            overflow="scroll"
            size="sm"
          />
          {tenants.length > 1 && (
            <select
              className={dsSelect}
              value={tenantFilter}
              onChange={e => setTenantFilter(Number(e.target.value))}
              aria-label={t('platform.filter.tenant', 'Ristorante')}
            >
              <option value={0}>{t('platform.filter.allTenants', 'Tutti i ristoranti')}</option>
              {tenants.map(tn => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
            </select>
          )}
        </div>
      }
      list={
        listLoading ? (
          <div className="flex h-32 items-center justify-center"><Loader /></div>
        ) : listError ? (
          <Callout tone="critical" icon={AlertTriangle}>{listError}</Callout>
        ) : tickets.length === 0 ? (
          <EmptyState icon={LifeBuoy}>{t('platform.empty', 'Nessuna richiesta.')}</EmptyState>
        ) : (
          <div className="space-y-1.5">{tickets.map(renderRow)}</div>
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
              subtitle={detail
                ? `${detail.tenant_name ?? ''} · #${detail.id} · ${supportCategoryLabel(detail.category, t)}${detail.created_by_name ? ` · ${detail.created_by_name}` : ''} · ${formatSupportDateTime(detail.created_at)}`
                : undefined}
              badge={detail ? <SupportStatusPill status={detail.status} perspective="platform" /> : undefined}
            />
            <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)]">
              <div className="px-4 pb-4 sm:px-6 lg:px-8">
                {!detail && !detailError ? (
                  <div className="flex h-32 items-center justify-center"><Loader /></div>
                ) : detailError ? (
                  <Callout tone="critical" icon={AlertTriangle}>{detailError}</Callout>
                ) : detail ? (
                  <div className="mx-auto max-w-3xl space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {detail.priority === 'urgente' && detail.status !== 'risolto' && <SupportUrgentPill />}
                      <button type="button" className={dsButton.secondary} onClick={() => goInto('enter')} disabled={busy !== null}>
                        {busy === 'enter' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
                        {t('platform.enter', 'Entra')}
                      </button>
                      <button type="button" className={dsButton.secondary} onClick={() => goInto('impersonate')} disabled={busy !== null}>
                        {busy === 'impersonate' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserCheck className="h-4 w-4" aria-hidden />}
                        {t('platform.impersonate', 'Vedi come il titolare')}
                      </button>
                      <button
                        type="button"
                        className={dsButton.secondary}
                        onClick={createCard}
                        disabled={busy !== null || detail.dev_card_id != null}
                      >
                        {busy === 'card' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Kanban className="h-4 w-4" aria-hidden />}
                        {detail.dev_card_id != null
                          ? t('platform.cardExists', 'Card #{{id}}', { id: detail.dev_card_id })
                          : t('platform.createCard', 'Crea card dev')}
                      </button>
                      {detail.status === 'risolto' ? (
                        <button type="button" className={dsButton.secondary} onClick={() => setStatus('in_corso')} disabled={busy !== null}>
                          <RotateCcw className="h-4 w-4" aria-hidden />
                          {t('platform.reopen', 'Riapri')}
                        </button>
                      ) : (
                        <button type="button" className={dsButton.secondary} onClick={() => setStatus('risolto')} disabled={busy !== null}>
                          <Check className="h-4 w-4" aria-hidden />
                          {t('markResolved', 'Segna risolta')}
                        </button>
                      )}
                    </div>
                    <ContextCard context={detail.context ?? {}} />
                    <SupportMessages messages={detail.messages} perspective="platform" />
                    <div ref={endRef} />
                  </div>
                ) : null}
              </div>
            </div>

            {detail && (
              <div className="flex-shrink-0 px-4 pb-4 pt-3 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-3xl space-y-2">
                  <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ds-border-focus)]">
                    <textarea
                      value={reply}
                      onChange={e => setReply(e.target.value.slice(0, SUPPORT_BODY_MAX))}
                      placeholder={t('platform.replyPlaceholder', 'Rispondi al ristorante…')}
                      rows={3}
                      className="w-full resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-snug text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none"
                    />
                  </div>
                  {/* Due esiti, due tasti: la risposta dice anche di chi è la
                      prossima mossa. «Rispondi» passa la palla al ristorante. */}
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className={dsButton.secondary} onClick={() => send('risolto')} disabled={!reply.trim() || busy !== null}>
                      {busy === 'reply-risolto' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                      {t('platform.replyResolve', 'Rispondi e chiudi')}
                    </button>
                    <button type="button" className={dsButton.primary} onClick={() => send('attesa_cliente')} disabled={!reply.trim() || busy !== null}>
                      {busy === 'reply-attesa_cliente' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                      {t('platform.reply', 'Rispondi')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )
      }
    />
  );
};

export default PlatformSupportTab;
