import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, CreditCard, Save, Eye, EyeOff, Info } from 'lucide-react';
import { Loader } from './Loader';
import {
    getSumUpIntegration,
    updateSumUpIntegration,
    type SumUpEnvironment,
    type SumUpIntegrationStatus,
    type SumUpIntegrationUpdate,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Placeholder for a stored secret: the user types here only to overwrite it,
// an empty field means "keep current value" (the backend is partial-update
// aware). Same convention as the Revolut card.
const maskPlaceholder = (last4: string | null): string =>
    last4 ? `•••••••••••• ${last4}` : 'Non impostata';

export const SumUpIntegrationCard: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [status, setStatus] = useState<SumUpIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);

    // Draft values. `null` / '' means "unchanged" so we send partial updates.
    const [draftEnv, setDraftEnv] = useState<SumUpEnvironment | null>(null);
    const [draftActive, setDraftActive] = useState<boolean | null>(null);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [merchantCodeInput, setMerchantCodeInput] = useState('');
    const [sandboxApiKeyInput, setSandboxApiKeyInput] = useState('');
    const [sandboxMerchantCodeInput, setSandboxMerchantCodeInput] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    const [showSandboxApiKey, setShowSandboxApiKey] = useState(false);

    // Hold showToast in a ref so the fetch effect runs on mount only — App.tsx
    // re-renders on every socket event with a fresh addToast reference.
    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getSumUpIntegration();
                if (!cancelled) {
                    setStatus(data);
                    setMerchantCodeInput(data.production_merchant_code || '');
                    setSandboxMerchantCodeInput(data.sandbox_merchant_code || '');
                }
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento di SumUp', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const effectiveEnv: SumUpEnvironment = draftEnv ?? status?.environment ?? 'sandbox';
    const effectiveActive: boolean = draftActive ?? status?.is_active_provider ?? false;

    const statusPill = useMemo(() => {
        if (!status) return null;
        if (!status.configured) {
            return (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border border-[var(--ds-border)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--ds-border-strong)]"></span>
                    Non configurato
                </span>
            );
        }
        // Credentials are in place but Revolut is still taking the payments —
        // say so, otherwise "Attivo" would be a lie.
        if (!status.is_active_provider) {
            return (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border border-[var(--ds-border)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--ds-border-strong)]"></span>
                    Pronto (non attivo)
                </span>
            );
        }
        const label = status.environment === 'production' ? 'Attivo (Produzione)' : 'Attivo (Sandbox)';
        const color = status.environment === 'production'
            ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] border-[var(--ds-seated-solid)]'
            : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] border-[var(--ds-pending-solid)]';
        const dot = status.environment === 'production' ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-pending-solid)]';
        return (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${color}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
                {label}
            </span>
        );
    }, [status]);

    const hasChanges = !!status && (
        draftEnv !== null
        || (draftActive !== null && draftActive !== status.is_active_provider)
        || apiKeyInput.trim() !== ''
        || sandboxApiKeyInput.trim() !== ''
        || merchantCodeInput.trim() !== (status.production_merchant_code || '')
        || sandboxMerchantCodeInput.trim() !== (status.sandbox_merchant_code || '')
    );

    const handleSave = async () => {
        if (!canEdit || saving || !status) return;
        const payload: SumUpIntegrationUpdate = {};
        if (draftEnv !== null && draftEnv !== status.environment) payload.environment = draftEnv;
        if (apiKeyInput.trim() !== '') payload.api_key = apiKeyInput.trim();
        if (sandboxApiKeyInput.trim() !== '') payload.sandbox_api_key = sandboxApiKeyInput.trim();
        // Merchant codes aren't secret, so they're editable in place: send
        // them whenever they differ from what's stored (including a clear).
        if (merchantCodeInput.trim() !== (status.production_merchant_code || '')) {
            payload.merchant_code = merchantCodeInput.trim();
        }
        if (sandboxMerchantCodeInput.trim() !== (status.sandbox_merchant_code || '')) {
            payload.sandbox_merchant_code = sandboxMerchantCodeInput.trim();
        }
        if (draftActive !== null && draftActive !== status.is_active_provider) {
            payload.set_active = draftActive;
        }
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateSumUpIntegration(payload);
            setStatus(updated);
            setDraftEnv(null);
            setDraftActive(null);
            setApiKeyInput('');
            setSandboxApiKeyInput('');
            setMerchantCodeInput(updated.production_merchant_code || '');
            setSandboxMerchantCodeInput(updated.sandbox_merchant_code || '');
            showToast('Configurazione SumUp aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento SumUp', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!status) return null;

    const inputClass =
        'w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60';

    // The environment the user is about to save decides which credential pair
    // has to be complete before SumUp can be switched on.
    const targetEnvReady = effectiveEnv === 'production'
        ? status.production_configured
        : status.sandbox_configured;

    return (
        <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-[var(--ds-surface-row)] transition-colors"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0">
                        <CreditCard className="w-5 h-5 text-[var(--ds-text-primary)]" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">SumUp</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Hosted Checkout per caparre e conto al tavolo</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {statusPill}
                    <ChevronDown
                        className={`w-4 h-4 text-[var(--ds-text-subtle)] transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                </div>
            </button>

            {expanded && (
                <div className="border-t border-[var(--ds-border)] p-4 space-y-4">
                    {/* Environment switch */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Ambiente</p>
                            <p className="text-[12px] text-[var(--ds-text-muted)]">
                                {effectiveEnv === 'production'
                                    ? 'Pagamenti reali sul merchant SumUp.'
                                    : 'Test sul merchant sandbox. Nessun addebito reale.'}
                            </p>
                        </div>
                        <div className="inline-flex rounded-md border border-[var(--ds-border)] overflow-hidden text-[12px] font-medium">
                            <button
                                type="button"
                                onClick={() => canEdit && setDraftEnv('sandbox')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors ${
                                    effectiveEnv === 'sandbox'
                                        ? 'bg-[var(--ds-pending-solid)] text-[var(--ds-pending-fg)]'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                Sandbox
                            </button>
                            <button
                                type="button"
                                onClick={() => canEdit && setDraftEnv('production')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors border-l border-[var(--ds-border)] ${
                                    effectiveEnv === 'production'
                                        ? 'bg-[var(--ds-seated-solid)] text-white'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                Produzione
                            </button>
                        </div>
                    </div>

                    <div className="flex items-start gap-2 text-[12px] text-[var(--ds-text-subtle)] bg-[var(--ds-surface-row)] rounded-md p-2.5">
                        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <span>
                            SumUp usa lo stesso endpoint (<code className="text-[var(--ds-text-muted)]">{status.api_base}</code>) per
                            entrambi gli ambienti: a distinguerli è la chiave API. Le credenziali sandbox si creano dal
                            merchant sandbox nelle impostazioni sviluppatore SumUp. Qui restano salvate entrambe: cambiare
                            ambiente cambia solo quale coppia viene usata.
                        </span>
                    </div>

                    {/* Production credentials */}
                    <div className="space-y-3">
                        <p className="text-[12px] font-semibold text-[var(--ds-text-primary)] flex items-center gap-2">
                            Produzione
                            {status.production_configured && (
                                <span className="text-[10px] font-medium text-[var(--ds-seated-text)]">completa</span>
                            )}
                        </p>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">API Key</label>
                            <div className="relative">
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    value={apiKeyInput}
                                    onChange={(e) => setApiKeyInput(e.target.value)}
                                    placeholder={maskPlaceholder(status.production_api_key_last4)}
                                    disabled={!canEdit || saving}
                                    autoComplete="off"
                                    spellCheck={false}
                                    className={`${inputClass} pr-10`}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowApiKey((v) => !v)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ds-text-subtle)] hover:text-[var(--ds-text-primary)]"
                                    aria-label={showApiKey ? 'Nascondi' : 'Mostra'}
                                    tabIndex={-1}
                                >
                                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                                Chiave segreta dalla dashboard SumUp. Lascia vuoto per mantenere quella attuale.
                            </p>
                        </div>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Merchant Code</label>
                            <input
                                type="text"
                                value={merchantCodeInput}
                                onChange={(e) => setMerchantCodeInput(e.target.value)}
                                placeholder="MH4H92C7"
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className={inputClass}
                            />
                        </div>
                    </div>

                    {/* Sandbox credentials */}
                    <div className="space-y-3 pt-1">
                        <p className="text-[12px] font-semibold text-[var(--ds-text-primary)] flex items-center gap-2">
                            Sandbox
                            {status.sandbox_configured && (
                                <span className="text-[10px] font-medium text-[var(--ds-seated-text)]">completa</span>
                            )}
                        </p>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">API Key sandbox</label>
                            <div className="relative">
                                <input
                                    type={showSandboxApiKey ? 'text' : 'password'}
                                    value={sandboxApiKeyInput}
                                    onChange={(e) => setSandboxApiKeyInput(e.target.value)}
                                    placeholder={maskPlaceholder(status.sandbox_api_key_last4)}
                                    disabled={!canEdit || saving}
                                    autoComplete="off"
                                    spellCheck={false}
                                    className={`${inputClass} pr-10`}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowSandboxApiKey((v) => !v)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ds-text-subtle)] hover:text-[var(--ds-text-primary)]"
                                    aria-label={showSandboxApiKey ? 'Nascondi' : 'Mostra'}
                                    tabIndex={-1}
                                >
                                    {showSandboxApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Merchant Code sandbox</label>
                            <input
                                type="text"
                                value={sandboxMerchantCodeInput}
                                onChange={(e) => setSandboxMerchantCodeInput(e.target.value)}
                                placeholder="MCXXXXXX"
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className={inputClass}
                            />
                        </div>
                    </div>

                    {/* Callback URL — generated on first save, shown masked. */}
                    <div className="text-[12px] text-[var(--ds-text-subtle)]">
                        {status.callback_url ? (
                            <>Callback SumUp: <code className="text-[var(--ds-text-muted)]">{status.callback_url}</code></>
                        ) : (
                            'Il token per le notifiche di pagamento viene generato al primo salvataggio.'
                        )}
                    </div>

                    {/* Active provider */}
                    <div className="flex items-center justify-between gap-3 mt-1 pt-3 border-t border-[var(--ds-border)]">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Usa SumUp per i nuovi pagamenti</p>
                            <p className="text-[12px] text-[var(--ds-text-muted)]">
                                {effectiveActive
                                    ? 'Caparre e conto al tavolo passano da SumUp.'
                                    : 'I pagamenti continuano a passare da Revolut.'}
                                {' '}I pagamenti già aperti restano sul provider che li ha creati.
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={effectiveActive}
                            onClick={() => canEdit && setDraftActive(!effectiveActive)}
                            disabled={!canEdit || saving || (!effectiveActive && !targetEnvReady)}
                            title={!effectiveActive && !targetEnvReady ? 'Completa le credenziali di questo ambiente' : undefined}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                effectiveActive ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)]'
                            }`}
                        >
                            <span
                                className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                                    effectiveActive ? 'translate-x-[22px]' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    </div>

                    {status.updated_at && (
                        <p className="text-[11px] text-[var(--ds-text-subtle)]">
                            Ultima modifica: {new Date(status.updated_at).toLocaleString('it-IT')}
                            {status.updated_by ? ` · ${status.updated_by}` : ''}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={!canEdit || saving || !hasChanges}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Salva
                        </button>
                    </div>

                    {!canEdit && (
                        <p className="text-[12px] text-[var(--ds-text-subtle)]">
                            Solo gli amministratori possono modificare la configurazione.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
