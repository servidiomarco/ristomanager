import React, { useCallback, useEffect, useState } from 'react';
import { Star, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { Callout, EmptyState, StatusPill, dsButton, dsIconButton, type PillTone } from './ds';
import { SkeletonReviewList } from './SkeletonCards';
import {
    getReviewRequests, getReviewSettings,
    type ReviewRequestRow, type ReviewRequestStatus,
} from '../services/reviewsApiService';
import { sessionTimeZone } from '../utils/displayTime';

/* ── Recensioni ───────────────────────────────────────────────────────────
   La pagina della reputazione su Google. In questa prima tappa mostra il
   registro delle richieste post-visita (chi ha ricevuto il link, su che
   canale, chi è stato saltato e perché); le recensioni vere e proprie
   arrivano qui col collegamento del profilo Google (Fase B del piano). */

const PAGE_SIZE = 50;

const STATUS_META: Record<ReviewRequestStatus, { label: string; tone: PillTone }> = {
    sent: { label: 'Inviata', tone: 'positive' },
    failed: { label: 'Non riuscita', tone: 'critical' },
    sending: { label: 'Esito non confermato', tone: 'pending' },
    skipped_consent: { label: 'Saltata: senza consenso', tone: 'neutral' },
    skipped_no_contact: { label: 'Saltata: senza recapiti', tone: 'neutral' },
    skipped_recent: { label: 'Saltata: già chiesta di recente', tone: 'neutral' },
};

const CHANNEL_LABEL: Record<string, string> = {
    whatsapp: 'WhatsApp',
    sms: 'SMS',
    email: 'email',
};

const formatWhen = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('it-IT', {
        timeZone: sessionTimeZone(),
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
};

export const RecensioniPage: React.FC = () => {
    const [requests, setRequests] = useState<ReviewRequestRow[]>([]);
    const [total, setTotal] = useState(0);
    const [requestsEnabled, setRequestsEnabled] = useState<boolean | null>(null);
    const [googleReady, setGoogleReady] = useState<boolean | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const [reqs, settings] = await Promise.all([
                getReviewRequests(0, PAGE_SIZE),
                getReviewSettings().catch(() => null),
            ]);
            setRequests(reqs.requests);
            setTotal(reqs.total);
            if (settings) {
                setRequestsEnabled(settings.review_requests_enabled);
                setGoogleReady(!!settings.google_place_id);
            }
        } catch (err: any) {
            setError(err?.message || 'Errore nel caricamento');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const loadMore = async () => {
        if (loadingMore) return;
        setLoadingMore(true);
        try {
            const more = await getReviewRequests(requests.length, PAGE_SIZE);
            setRequests(prev => [...prev, ...more.requests]);
            setTotal(more.total);
        } catch (err: any) {
            setError(err?.message || 'Errore nel caricamento');
        } finally {
            setLoadingMore(false);
        }
    };

    return (
        <div className="space-y-4 p-4 sm:p-6 lg:p-8">
            <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">Recensioni</h1>
                    <p className="mt-1 text-[15px] text-[var(--ds-text-muted)]">
                        Le richieste inviate ai clienti dopo la visita. Le recensioni del profilo
                        Google compariranno qui col collegamento dell'account.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => { setLoading(true); load(); }}
                    aria-label="Aggiorna"
                    title="Aggiorna"
                    className={dsIconButton}
                >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                </button>
            </header>

            {requestsEnabled === false && (
                <Callout tone="pending" icon={Settings2}>
                    La richiesta di recensione è spenta: si accende da Impostazioni → Recensioni.
                </Callout>
            )}
            {requestsEnabled === true && googleReady === false && (
                <Callout tone="pending" icon={Settings2}>
                    Manca il Place ID del profilo Google: senza, il link non esiste e non parte nulla.
                    Si imposta da Impostazioni → Recensioni.
                </Callout>
            )}

            {/* Con l'azione, non senza: prima un caricamento fallito lasciava
                la pagina in un vicolo cieco, da cui si usciva solo ricaricando
                il browser. */}
            {error && (
                <Callout
                    tone="critical"
                    action={
                        <button type="button" className={dsButton.quiet} onClick={() => { setLoading(true); load(); }}>
                            Riprova
                        </button>
                    }
                >
                    {error}
                </Callout>
            )}

            {loading ? (
                <section className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                    <SkeletonReviewList />
                </section>
            ) : requests.length === 0 ? (
                <EmptyState icon={Star}>
                    Nessuna richiesta ancora: quando un tavolo chiude la visita, il cliente
                    riceve il link per recensire e la richiesta compare qui.
                </EmptyState>
            ) : (
                <section className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                    <div className="flex items-center justify-between border-b border-[var(--ds-border)] px-4 py-3">
                        <h2 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">Richieste inviate</h2>
                        <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{total}</span>
                    </div>
                    <ul className="divide-y divide-[var(--ds-border)]">
                        {requests.map(r => {
                            const meta = STATUS_META[r.status] ?? { label: r.status, tone: 'neutral' as PillTone };
                            return (
                                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{r.customer_name}</p>
                                        <p className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                                            {formatWhen(r.sent_at || r.reservation_time)}
                                            {r.status === 'sent' && r.channel ? ` · ${CHANNEL_LABEL[r.channel] ?? r.channel}` : ''}
                                            {r.status === 'failed' && r.error ? ` · ${r.error}` : ''}
                                        </p>
                                    </div>
                                    <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                                </li>
                            );
                        })}
                    </ul>
                    {requests.length < total && (
                        <div className="flex justify-center border-t border-[var(--ds-border)] px-4 py-3">
                            <button type="button" disabled={loadingMore} onClick={loadMore} className={dsButton.secondary}>
                                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                                {loadingMore ? 'Caricamento…' : 'Mostra altre'}
                            </button>
                        </div>
                    )}
                </section>
            )}

            <p className="flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                Orari, destinatari e Place ID si regolano da Impostazioni → Recensioni.
            </p>
        </div>
    );
};
