import React, { useEffect, useRef, useState } from 'react';
import { Receipt, Loader2, Clock, ShieldCheck, ChevronDown } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { PaymentProviderPicker } from './PaymentProviderPicker';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export const PayAtTableSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getFeatureFlags();
                if (!cancelled) setFlags(data);
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const toggle = async () => {
        if (!flags || !canEdit || saving) return;
        const nextValue = !flags.pay_at_table_enabled;
        const previous = flags;
        setFlags({ ...flags, pay_at_table_enabled: nextValue });
        setSaving(true);
        try {
            const updated = await updateFeatureFlags({ pay_at_table_enabled: nextValue });
            setFlags(updated);
            showToast(`Conto al tavolo: ${nextValue ? 'attivo' : 'disattivato'}`, 'success');
        } catch (err: any) {
            setFlags(previous);
            showToast(err?.message || 'Errore aggiornamento impostazione', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading || !flags) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    const enabled = flags.pay_at_table_enabled;

    return (
        <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                        <Receipt className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Conto al tavolo</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Pay-at-table + split bill via Revolut hosted checkout.</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                        {enabled ? 'Attivo' : 'Disattivato'}
                    </span>
                    {/* stopPropagation so clicking the switch doesn't toggle the accordion */}
                    <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? 'Disattiva' : 'Attiva'} conto al tavolo`}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
                        disabled={!canEdit || saving}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                            enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                        }`}
                    >
                        <span
                            aria-hidden="true"
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                enabled ? 'translate-x-5' : 'translate-x-0.5'
                            } translate-y-0.5`}
                        />
                    </button>
                    <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </div>
            </summary>
            <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                <p className="text-[13px] text-[var(--ds-text-muted)] leading-relaxed">
                    Il cameriere apre un conto per la prenotazione e genera un QR effimero. Gli ospiti lo scansionano e pagano la propria quota via hosted checkout del provider scelto — split equo o importo libero. Quando la somma raggiunge il totale, il conto diventa <em>SETTLED</em>; se il cameriere chiude con un delta viene stampato un <em>SETTLED_PARTIAL</em> con l'ammanco per audit.
                </p>

                {/* Provider preferito per i conti al tavolo — indipendente da
                    quello delle caparre. */}
                <PaymentProviderPicker flow="bill" showToast={showToast} canEdit={canEdit} />

                {/* Parametri tecnici — read-only. Sono costanti nel backend; qui
                    mostrati per trasparenza operativa (il gestore sa quando un
                    claim scade, e perché un guest colpisce il rate limit). */}
                <div className="rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3">
                    <h5 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-3">
                        Parametri tecnici (sola lettura)
                    </h5>
                    <ul className="space-y-2.5 text-[13px]">
                        <li className="flex items-start gap-2.5">
                            <Clock className="h-4 w-4 mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[var(--ds-text-primary)]">TTL prenotazione quota: <strong>5 minuti</strong></div>
                                <div className="text-[12px] text-[var(--ds-text-muted)]">Un claim non pagato viene rilasciato automaticamente dal reconcile job (ogni 60s) così la capacità torna disponibile per altri ospiti.</div>
                            </div>
                        </li>
                        <li className="flex items-start gap-2.5">
                            <ShieldCheck className="h-4 w-4 mt-0.5 text-[var(--ds-text-muted)] flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[var(--ds-text-primary)]">Rate limit endpoint pubblico: <strong>60 richieste/min per IP</strong> · <strong>10 claim/min per conto</strong></div>
                                <div className="text-[12px] text-[var(--ds-text-muted)]">Limita spam e prevenzione lock-out del residuo: la protezione per token blocca chi cerca di monopolizzare le quote conoscendo un singolo QR.</div>
                            </div>
                        </li>
                    </ul>
                    {!canEdit && (
                        <p className="text-[12px] text-[var(--ds-text-subtle)] mt-3 italic">
                            Solo gli amministratori possono modificare queste impostazioni.
                        </p>
                    )}
                </div>
            </div>
        </details>
    );
};
