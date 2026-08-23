import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Inbox, Save, Eye, EyeOff, Plug } from 'lucide-react';
import { Loader } from './Loader';
import {
    getImapIntegration,
    updateImapIntegration,
    testImapConnection,
    type ImapIntegrationStatus,
    type ImapIntegrationUpdate,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const maskPlaceholder = (last4: string | null): string =>
    last4 ? `•••••••••••• ${last4}` : 'Non impostata';

export const ImapIntegrationCard: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [status, setStatus] = useState<ImapIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);

    const [hostInput, setHostInput] = useState('');
    const [portInput, setPortInput] = useState('');
    const [secureInput, setSecureInput] = useState<boolean | null>(null);
    const [userInput, setUserInput] = useState('');
    const [passwordInput, setPasswordInput] = useState('');
    const [enabledInput, setEnabledInput] = useState<boolean | null>(null);
    const [showPassword, setShowPassword] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getImapIntegration();
                if (!cancelled) {
                    setStatus(data);
                    setHostInput(data.host || '');
                    setPortInput(data.port ? String(data.port) : '');
                    setUserInput(data.user || '');
                }
            } catch (err: any) {
                if (!cancelled) {
                    const msg = err?.message || 'Errore nel caricamento IMAP';
                    setLoadError(msg);
                    showToastRef.current(msg, 'error');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const effectiveSecure = secureInput ?? status?.secure ?? true;
    const effectiveEnabled = enabledInput ?? status?.enabled ?? false;

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
        if (!status.enabled) {
            return (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border border-[var(--ds-border)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--ds-pending-solid)]"></span>
                    Disattivo
                </span>
            );
        }
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] border-[var(--ds-seated-solid)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--ds-seated-solid)]"></span>
                Attivo
            </span>
        );
    }, [status]);

    const hasChanges = useMemo(() => {
        if (!status) return false;
        if (hostInput.trim() !== (status.host || '')) return true;
        if (portInput.trim() !== (status.port ? String(status.port) : '')) return true;
        if (secureInput !== null && secureInput !== status.secure) return true;
        if (userInput.trim() !== (status.user || '')) return true;
        if (passwordInput !== '') return true;
        if (enabledInput !== null && enabledInput !== status.enabled) return true;
        return false;
    }, [status, hostInput, portInput, secureInput, userInput, passwordInput, enabledInput]);

    const handleSave = async () => {
        if (!canEdit || saving || !status) return;
        const payload: ImapIntegrationUpdate = {};
        if (hostInput.trim() !== (status.host || '')) payload.host = hostInput.trim();
        if (portInput.trim() !== (status.port ? String(status.port) : '')) {
            const n = Number(portInput);
            if (!Number.isInteger(n) || n < 1 || n > 65535) {
                showToast('Porta non valida (1-65535)', 'error');
                return;
            }
            payload.port = n;
        }
        if (secureInput !== null && secureInput !== status.secure) payload.secure = secureInput;
        if (userInput.trim() !== (status.user || '')) payload.user = userInput.trim();
        if (passwordInput !== '') payload.password = passwordInput;
        if (enabledInput !== null && enabledInput !== status.enabled) payload.enabled = enabledInput;
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateImapIntegration(payload);
            setStatus(updated);
            setSecureInput(null);
            setEnabledInput(null);
            setPasswordInput('');
            showToast('Configurazione IMAP aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento IMAP', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!canEdit || testing) return;
        setTesting(true);
        try {
            await testImapConnection();
            showToast('Connessione IMAP OK', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Test IMAP fallito', 'error');
        } finally {
            setTesting(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!status) {
        // Endpoint mancante / errore di rete: mostriamo comunque la card così
        // l'operatore capisce perché non funziona (backend da riavviare, ecc.).
        return (
            <div className="bg-[var(--ds-surface)] rounded-lg border border-[var(--ds-border)] p-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0">
                        <Inbox className="w-5 h-5 text-[var(--ds-text-primary)]" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Ricezione Email (IMAP)</h4>
                        <p className="text-[12px] text-[var(--ds-critical-text)] truncate">
                            {loadError || 'Impossibile contattare il server. Riavvia il backend e ricarica la pagina.'}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

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
                        <Inbox className="w-5 h-5 text-[var(--ds-text-primary)]" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Ricezione Email (IMAP)</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                            Legge le risposte dei clienti dalla casella e le allega alla prenotazione
                        </p>
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
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Servizio attivo</p>
                            <p className="text-[12px] text-[var(--ds-text-muted)]">
                                Quando attivo, il server resta connesso alla casella IMAP e importa
                                automaticamente ogni risposta.
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={effectiveEnabled}
                            aria-label={effectiveEnabled ? 'Disattiva servizio IMAP' : 'Attiva servizio IMAP'}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (!canEdit || saving) return;
                                setEnabledInput(!effectiveEnabled);
                            }}
                            disabled={!canEdit || saving}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                                effectiveEnabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                            }`}
                        >
                            <span
                                aria-hidden="true"
                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                                    effectiveEnabled ? 'translate-x-5' : 'translate-x-0.5'
                                } translate-y-0.5`}
                            />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="sm:col-span-2">
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Host IMAP</label>
                            <input
                                type="text"
                                value={hostInput}
                                onChange={(e) => setHostInput(e.target.value)}
                                placeholder="imaps.aruba.it"
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                        </div>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Porta</label>
                            <input
                                type="number"
                                min={1}
                                max={65535}
                                value={portInput}
                                onChange={(e) => setPortInput(e.target.value)}
                                placeholder="993"
                                disabled={!canEdit || saving}
                                className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Connessione sicura (TLS)</p>
                            <p className="text-[12px] text-[var(--ds-text-muted)]">
                                {effectiveSecure
                                    ? 'SSL implicito (di solito porta 993).'
                                    : 'STARTTLS (di solito porta 143).'}
                            </p>
                        </div>
                        <div className="inline-flex rounded-md border border-[var(--ds-border)] overflow-hidden text-[12px] font-medium">
                            <button
                                type="button"
                                onClick={() => canEdit && setSecureInput(false)}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors ${
                                    !effectiveSecure
                                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                STARTTLS
                            </button>
                            <button
                                type="button"
                                onClick={() => canEdit && setSecureInput(true)}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors border-l border-[var(--ds-border)] ${
                                    effectiveSecure
                                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                SSL
                            </button>
                        </div>
                    </div>

                    <div>
                        <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Utente</label>
                        <input
                            type="text"
                            value={userInput}
                            onChange={(e) => setUserInput(e.target.value)}
                            placeholder="prenotazioni@ristorante.it"
                            disabled={!canEdit || saving}
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                        />
                    </div>

                    <div>
                        <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Password</label>
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={passwordInput}
                                onChange={(e) => setPasswordInput(e.target.value)}
                                placeholder={maskPlaceholder(status.password_last4)}
                                disabled={!canEdit || saving}
                                autoComplete="new-password"
                                spellCheck={false}
                                className="w-full pr-10 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ds-text-subtle)] hover:text-[var(--ds-text-primary)]"
                                aria-label={showPassword ? 'Nascondi' : 'Mostra'}
                                tabIndex={-1}
                            >
                                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                            Lascia vuoto per mantenere quella attuale.
                        </p>
                    </div>

                    {status.last_seen_uid !== null && (
                        <p className="text-[11px] text-[var(--ds-text-subtle)]">
                            Ultimo UID importato: {status.last_seen_uid}
                        </p>
                    )}

                    {status.updated_at && (
                        <p className="text-[11px] text-[var(--ds-text-subtle)]">
                            Ultima modifica: {new Date(status.updated_at).toLocaleString('it-IT')}
                            {status.updated_by ? ` · ${status.updated_by}` : ''}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={handleTest}
                            disabled={!canEdit || testing || !status.configured}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                            Test connessione
                        </button>
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

                    {!status.configured && (
                        <p className="text-[11px] text-[var(--ds-pending-text)]">
                            Salva host, utente e password per poter testare o attivare il servizio.
                        </p>
                    )}

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
