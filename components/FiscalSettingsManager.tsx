import React, { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, ChevronDown, AlertTriangle } from 'lucide-react';
import { billsApiService, type FiscalSettings } from '../services/billsApiService';
import { useAuth } from '../contexts/AuthContext';
import type { FiscalProviderSetting } from '../types';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Scontrino elettronico (documento commerciale): scelta del driver fiscale e
// P.IVA dell'esercente. Stessa forma a fisarmonica delle altre card di
// Impostazioni (vedi PayAtTableSettingsManager). Il token API del provider è
// configurazione di piattaforma (env), qui si vede solo se c'è.
const PROVIDER_LABELS: Record<FiscalProviderSetting, string> = {
    none: 'Disattivato',
    openapi: 'Openapi (cloud)',
    mock: 'Demo (senza trasmissione)',
};

export const FiscalSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<FiscalSettings | null>(null);
    const [vat, setVat] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await billsApiService.getFiscalSettings();
                if (!cancelled) { setSettings(data); setVat(data.vat_number); }
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Impostazioni fiscali non caricate', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const save = async (patch: { provider?: FiscalProviderSetting; vat_number?: string }) => {
        if (!settings || saving) return;
        setSaving(true);
        try {
            const updated = await billsApiService.updateFiscalSettings(patch);
            setSettings(updated);
            setVat(updated.vat_number);
            showToast(
                patch.provider !== undefined
                    ? `Scontrino elettronico: ${PROVIDER_LABELS[updated.provider]}`
                    : 'P.IVA aggiornata',
                'success'
            );
        } catch (err: any) {
            showToast(err?.data?.error ?? err?.message ?? 'Salvataggio non riuscito', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading || !settings) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    const active = settings.provider !== 'none';
    const vatDirty = vat !== settings.vat_number;
    const vatValid = vat === '' || /^\d{11}$/.test(vat);

    return (
        <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                        <FileText className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Scontrino elettronico</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Documento commerciale alla chiusura del conto, via provider cloud.</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[12px] font-medium ${active ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                        {active ? PROVIDER_LABELS[settings.provider] : 'Disattivato'}
                    </span>
                    <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </div>
            </summary>
            <div className="px-4 pb-4 pt-3 border-t border-[var(--ds-border)] space-y-3">
                <p className="text-[13px] text-[var(--ds-text-muted)] leading-relaxed">
                    Con un provider attivo, alla chiusura di un conto saldato per intero lo scontrino parte da solo verso l'Agenzia delle Entrate. Un documento fallito si ritenta dal conto, nella sezione Pagamenti.
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">Provider</span>
                        <select
                            value={settings.provider}
                            onChange={e => save({ provider: e.target.value as FiscalProviderSetting })}
                            disabled={!canEdit || saving}
                            className="h-10 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)] disabled:opacity-50"
                        >
                            {settings.providers.map(p => (
                                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-primary)]">P.IVA <span className="font-normal text-[var(--ds-text-muted)]">(11 cifre, senza IT)</span></span>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                inputMode="numeric"
                                value={vat}
                                onChange={e => setVat(e.target.value.trim())}
                                disabled={!canEdit || saving}
                                className="h-10 w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 text-[14px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)] disabled:opacity-50"
                            />
                            {vatDirty && (
                                <button
                                    type="button"
                                    onClick={() => save({ vat_number: vat })}
                                    disabled={!canEdit || saving || !vatValid}
                                    className="h-10 flex-shrink-0 rounded-xl bg-[var(--ds-action-bg)] px-4 text-[13px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salva'}
                                </button>
                            )}
                        </div>
                        {!vatValid && (
                            <p className="mt-1 text-[12px] text-[var(--ds-critical-text)]">Servono 11 cifre.</p>
                        )}
                    </label>
                </div>

                {settings.provider === 'openapi' && !settings.openapi_token_configured && (
                    <p className="flex items-start gap-2 rounded-md bg-[var(--ds-surface-row)] border border-[var(--ds-border)] p-3 text-[13px] text-[var(--ds-pending-text)]">
                        <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        Manca il token Openapi sul server (variabile OPENAPI_INVOICE_TOKEN): gli scontrini falliranno finché non viene configurato.
                    </p>
                )}
                {!canEdit && (
                    <p className="text-[12px] text-[var(--ds-text-subtle)] italic">
                        Solo gli amministratori possono modificare queste impostazioni.
                    </p>
                )}
            </div>
        </details>
    );
};
