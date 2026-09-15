import React, { useCallback, useEffect, useState } from 'react';
import { Star, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { StatusPill, EmptyState, type PillTone } from './ds';
import {
    getReviewRequests, getReviewSettings,
    type ReviewRequestRow, type ReviewRequestStatus,
} from '../services/reviewsApiService';

/* ── Recensioni ───────────────────────────────────────────────────────────
   La pagina della reputazione su Google. In questa prima tappa mostra il
   registro delle richieste post-visita (chi ha ricevuto il link, su che
   canale, chi è stato saltato e perché); le recensioni vere e proprie
   arrivano qui col collegamento del profilo Google (Fase B del piano). */

const PAGE_SIZE = 50;

const STATUS_META: Record<ReviewRequestStatus, { label: string; tone: PillTone }> = {
    sent: { label: 'Inviata', tone: 'positive' },
    failed: { label: 'Non riuscita', tone: 'critical' },
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
        timeZone: 'Europe/Rome',
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
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
            <header className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-[20px] font-semibold text-[var(--ds-text-primary)]">Recensioni</h2>
                    <p className="text-[13px] text-[var(--ds-text-muted)]">
                        Le richieste inviate ai clienti dopo la visita. Le recensioni del profilo
                        Google compariranno qui col collegamento dell'account.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => { setLoading(true); load(); }}
                    aria-label="Aggiorna"
                    className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                    <RefreshCw size={16} aria-hidden />
                </button>
            </header>

            {requestsEnabled === false && (
                <p className="rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] px-3 py-2.5 text-[13px] text-[var(--ds-pending-text)]">
                    La richiesta di recensione è spenta: si accende da Impostazioni → Recensioni.
                </p>
            )}
            {requestsEnabled === true && googleReady === false && (
                <p className="rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] px-3 py-2.5 text-[13px] text-[var(--ds-pending-text)]">
                    Manca il Place ID del profilo Google: senza, il link non esiste e non parte nulla.
                    Si imposta da Impostazioni → Recensioni.
                </p>
            )}

            {error && (
                <p className="rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] px-3 py-2.5 text-[13px] text-[var(--ds-critical-text)]">{error}</p>
            )}

            {loading ? (
                <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-4 py-6 shadow-[var(--ds-shadow-card)] flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
                </div>
            ) : requests.length === 0 ? (
                <EmptyState icon={Star}>
                    Nessuna richiesta ancora: quando un tavolo chiude la visita, il cliente
                    riceve il link per recensire e la richiesta compare qui.
                </EmptyState>
            ) : (
                <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ds-border)]">
                        <h3 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">Richieste inviate</h3>
                        <span className="text-[12px] text-[var(--ds-text-muted)]">{total}</span>
                    </div>
                    <ul className="divide-y divide-[var(--ds-border)]">
                        {requests.map(r => {
                            const meta = STATUS_META[r.status] ?? { label: r.status, tone: 'neutral' as PillTone };
                            return (
                                <li key={r.id} className="px-4 py-3 flex items-center gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[14px] font-medium text-[var(--ds-text-primary)] truncate">{r.customer_name}</p>
                                        <p className="text-[12px] text-[var(--ds-text-muted)] truncate">
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
                        <div className="px-4 py-3 border-t border-[var(--ds-border)] flex justify-center">
                            <button
                                type="button"
                                disabled={loadingMore}
                                onClick={loadMore}
                                className="text-[13px] px-3 py-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] disabled:opacity-50"
                            >
                                {loadingMore ? 'Caricamento…' : 'Mostra altre'}
                            </button>
                        </div>
                    )}
                </section>
            )}

            <p className="flex items-center gap-1.5 text-[12px] text-[var(--ds-text-muted)]">
                <Settings2 size={13} aria-hidden />
                Orari, destinatari e Place ID si regolano da Impostazioni → Recensioni.
            </p>
        </div>
    );
};
