import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, CreditCard, Save, Eye, EyeOff } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
    getRevolutIntegration,
    updateRevolutIntegration,
    type RevolutEnvironment,
    type RevolutIntegrationStatus,
    type RevolutIntegrationUpdate,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Placeholder shown in the masked field when a secret is already stored.
// Users type into the input only when they want to overwrite it — leaving it
// empty means "keep current value" (the backend is partial-update aware).
const maskPlaceholder = (last4: string | null): string =>
    last4 ? `•••••••••••• ${last4}` : 'Non impostata';

export const RevolutIntegrationCard: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [status, setStatus] = useState<RevolutIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);

    // Draft form values. `null` means "unchanged" so we send partial updates.
    const [draftEnv, setDraftEnv] = useState<RevolutEnvironment | null>(null);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [webhookSecretInput, setWebhookSecretInput] = useState('');
    const [apiVersionInput, setApiVersionInput] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    const [showWebhookSecret, setShowWebhookSecret] = useState(false);
    // Auto-deposit policy drafts. `null` means "match the server value".
    const [draftAutoDepositEnabled, setDraftAutoDepositEnabled] = useState<boolean | null>(null);
    const [autoDepositMinGuestsInput, setAutoDepositMinGuestsInput] = useState('');

    // Hold showToast in a ref so the fetch effect only runs on mount, not on
    // every parent re-render (App.tsx re-renders on every socket event, and
    // its addToast is a fresh reference each time).
    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getRevolutIntegration();
                if (!cancelled) {
                    setStatus(data);
                    setApiVersionInput(data.api_version);
                    setAutoDepositMinGuestsInput(String(data.auto_deposit_min_guests));
                }
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento di Revolut', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const effectiveEnv: RevolutEnvironment = draftEnv ?? status?.environment ?? 'sandbox';
    const isConfigured = !!status?.has_api_key;

    const statusPill = useMemo(() => {
        if (!status) return null;
        if (!status.has_api_key) {
            return (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-fg-subtle)]"></span>
                    Non configurato
                </span>
            );
        }
        const label = status.environment === 'production' ? 'Attivo (Produzione)' : 'Attivo (Sandbox)';
        const color = status.environment === 'production'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
            : 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30';
        const dot = status.environment === 'production' ? 'bg-emerald-500' : 'bg-amber-500';
        return (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${color}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
                {label}
            </span>
        );
    }, [status]);

    const parsedMinGuests = (() => {
        const n = parseInt(autoDepositMinGuestsInput, 10);
        return Number.isFinite(n) ? n : NaN;
    })();
    const minGuestsChanged = status
        ? autoDepositMinGuestsInput.trim() !== ''
            && Number.isInteger(parsedMinGuests)
            && parsedMinGuests !== status.auto_deposit_min_guests
        : false;
    const minGuestsValid = Number.isInteger(parsedMinGuests) && parsedMinGuests >= 1 && parsedMinGuests <= 100;
    const effectiveAutoDepositEnabled = draftAutoDepositEnabled ?? status?.auto_deposit_enabled ?? false;

    const hasChanges = draftEnv !== null
        || apiKeyInput.trim() !== ''
        || webhookSecretInput.trim() !== ''
        || (status && apiVersionInput.trim() !== '' && apiVersionInput.trim() !== status.api_version)
        || draftAutoDepositEnabled !== null
        || minGuestsChanged;

    const handleSave = async () => {
        if (!canEdit || saving || !status) return;
        if (autoDepositMinGuestsInput.trim() !== '' && !minGuestsValid) {
            showToast('Il numero di coperti deve essere un intero tra 1 e 100', 'error');
            return;
        }
        const payload: RevolutIntegrationUpdate = {};
        if (draftEnv !== null && draftEnv !== status.environment) payload.environment = draftEnv;
        if (apiKeyInput.trim() !== '') payload.api_key = apiKeyInput.trim();
        if (webhookSecretInput.trim() !== '') payload.webhook_secret = webhookSecretInput.trim();
        if (apiVersionInput.trim() !== '' && apiVersionInput.trim() !== status.api_version) {
            payload.api_version = apiVersionInput.trim();
        }
        if (draftAutoDepositEnabled !== null && draftAutoDepositEnabled !== status.auto_deposit_enabled) {
            payload.auto_deposit_enabled = draftAutoDepositEnabled;
        }
        if (minGuestsChanged) {
            payload.auto_deposit_min_guests = parsedMinGuests;
        }
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateRevolutIntegration(payload);
            setStatus(updated);
            setDraftEnv(null);
            setApiKeyInput('');
            setWebhookSecretInput('');
            setApiVersionInput(updated.api_version);
            setDraftAutoDepositEnabled(null);
            setAutoDepositMinGuestsInput(String(updated.auto_deposit_min_guests));
            showToast('Configurazione Revolut aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento Revolut', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4 flex items-center gap-2 text-[13px] text-[var(--color-fg-muted)]">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!status) return null;

    return (
        <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-[var(--color-surface-2)] transition-colors"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center flex-shrink-0">
                        <CreditCard className="w-5 h-5 text-[var(--color-fg)]" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Revolut Merchant</h4>
                        <p className="text-[13px] text-[var(--color-fg-muted)] truncate">Link di pagamento per caparre</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {statusPill}
                    <ChevronDown
                        className={`w-4 h-4 text-[var(--color-fg-subtle)] transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                </div>
            </button>

            {expanded && (
                <div className="border-t border-[var(--color-line)] p-4 space-y-4">
                    {/* Environment switch */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--color-fg)]">Ambiente</p>
                            <p className="text-[12px] text-[var(--color-fg-muted)]">
                                {effectiveEnv === 'production'
                                    ? 'Pagamenti reali sul merchant Revolut.'
                                    : 'Test in sandbox. Nessun addebito reale.'}
                            </p>
                        </div>
                        <div className="inline-flex rounded-md border border-[var(--color-line)] overflow-hidden text-[12px] font-medium">
                            <button
                                type="button"
                                onClick={() => canEdit && setDraftEnv('sandbox')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors ${
                                    effectiveEnv === 'sandbox'
                                        ? 'bg-amber-500 text-white'
                                        : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                Sandbox
                            </button>
                            <button
                                type="button"
                                onClick={() => canEdit && setDraftEnv('production')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors border-l border-[var(--color-line)] ${
                                    effectiveEnv === 'production'
                                        ? 'bg-emerald-600 text-white'
                                        : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                Produzione
                            </button>
                        </div>
                    </div>

                    <div className="text-[12px] text-[var(--color-fg-subtle)]">
                        Base URL: <code className="text-[var(--color-fg-muted)]">{
                            effectiveEnv === 'production'
                                ? 'https://merchant.revolut.com'
                                : 'https://sandbox-merchant.revolut.com'
                        }</code>
                    </div>

                    {/* API key */}
                    <div>
                        <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1.5">
                            API Key
                        </label>
                        <div className="relative">
                            <input
                                type={showApiKey ? 'text' : 'password'}
                                value={apiKeyInput}
                                onChange={(e) => setApiKeyInput(e.target.value)}
                                placeholder={maskPlaceholder(status.api_key_last4)}
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className="w-full pr-10 px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[13px] font-mono text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60"
                            />
                            <button
                                type="button"
                                onClick={() => setShowApiKey((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                                aria-label={showApiKey ? 'Nascondi' : 'Mostra'}
                                tabIndex={-1}
                            >
                                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-[11px] text-[var(--color-fg-subtle)] mt-1">
                            Bearer token dalla console Merchant Revolut. Lascia vuoto per mantenere quella attuale.
                        </p>
                    </div>

                    {/* Webhook signing secret */}
                    <div>
                        <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1.5">
                            Webhook Signing Secret
                        </label>
                        <div className="relative">
                            <input
                                type={showWebhookSecret ? 'text' : 'password'}
                                value={webhookSecretInput}
                                onChange={(e) => setWebhookSecretInput(e.target.value)}
                                placeholder={maskPlaceholder(status.webhook_secret_last4)}
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className="w-full pr-10 px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[13px] font-mono text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60"
                            />
                            <button
                                type="button"
                                onClick={() => setShowWebhookSecret((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                                aria-label={showWebhookSecret ? 'Nascondi' : 'Mostra'}
                                tabIndex={-1}
                            >
                                {showWebhookSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-[11px] text-[var(--color-fg-subtle)] mt-1">
                            Segreto HMAC per validare i webhook. Fornito da Revolut al momento della creazione del webhook.
                        </p>
                    </div>

                    {/* API version */}
                    <div>
                        <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1.5">
                            API Version
                        </label>
                        <input
                            type="text"
                            value={apiVersionInput}
                            onChange={(e) => setApiVersionInput(e.target.value)}
                            placeholder="2024-09-01"
                            disabled={!canEdit || saving}
                            className="w-full px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[13px] font-mono text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60"
                        />
                    </div>

                    {/* Auto-deposit policy for public web bookings */}
                    <div className="pt-3 border-t border-[var(--color-line)] space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-[13px] font-medium text-[var(--color-fg)]">Caparra automatica per prenotazioni web</p>
                                <p className="text-[12px] text-[var(--color-fg-muted)]">
                                    Quando attiva, per le richieste dal modulo /prenota il sistema genera automaticamente un link Revolut (€10/persona) inviato via SMS al cliente.
                                </p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={effectiveAutoDepositEnabled}
                                aria-label={effectiveAutoDepositEnabled ? 'Disattiva caparra automatica' : 'Attiva caparra automatica'}
                                onClick={() => canEdit && setDraftAutoDepositEnabled(!effectiveAutoDepositEnabled)}
                                disabled={!canEdit || saving}
                                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] focus:ring-offset-2 focus:ring-offset-[var(--color-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                    effectiveAutoDepositEnabled ? 'bg-emerald-500' : 'bg-[var(--color-surface-3)] border border-[var(--color-line)]'
                                }`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                        effectiveAutoDepositEnabled ? 'translate-x-5' : 'translate-x-0.5'
                                    } translate-y-0.5`}
                                />
                            </button>
                        </div>

                        <div>
                            <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1.5">
                                Richiedi caparra da (numero di coperti)
                            </label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    step={1}
                                    inputMode="numeric"
                                    value={autoDepositMinGuestsInput}
                                    onChange={(e) => setAutoDepositMinGuestsInput(e.target.value)}
                                    disabled={!canEdit || saving || !effectiveAutoDepositEnabled}
                                    className="w-24 px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[13px] font-mono text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)] disabled:opacity-60"
                                />
                                <span className="text-[12px] text-[var(--color-fg-muted)]">coperti o più</span>
                            </div>
                            <p className="text-[11px] text-[var(--color-fg-subtle)] mt-1">
                                Le prenotazioni con almeno questo numero di persone riceveranno il link di pagamento. Sotto la soglia il flusso è invariato.
                            </p>
                            {!isConfigured && effectiveAutoDepositEnabled && (
                                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                                    Configura l'API key qui sopra: senza credenziali Revolut valide la caparra non verrà richiesta.
                                </p>
                            )}
                        </div>
                    </div>

                    {status.updated_at && (
                        <p className="text-[11px] text-[var(--color-fg-subtle)]">
                            Ultima modifica: {new Date(status.updated_at).toLocaleString('it-IT')}
                            {status.updated_by ? ` · ${status.updated_by}` : ''}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={!canEdit || saving || !hasChanges}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--color-fg)] text-[var(--color-bg)] text-[13px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Salva
                        </button>
                    </div>

                    {!canEdit && (
                        <p className="text-[12px] text-[var(--color-fg-subtle)]">
                            Solo gli amministratori possono modificare la configurazione.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
