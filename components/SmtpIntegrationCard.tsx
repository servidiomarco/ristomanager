import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Mail, Save, Eye, EyeOff, Send } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
    getSmtpIntegration,
    updateSmtpIntegration,
    sendSmtpTestEmail,
    type SmtpIntegrationStatus,
    type SmtpIntegrationUpdate,
    type EmailProvider,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const maskPlaceholder = (last4: string | null): string =>
    last4 ? `•••••••••••• ${last4}` : 'Non impostata';

export const SmtpIntegrationCard: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [status, setStatus] = useState<SmtpIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);

    const [providerInput, setProviderInput] = useState<EmailProvider | null>(null);
    const [hostInput, setHostInput] = useState('');
    const [portInput, setPortInput] = useState('');
    const [secureInput, setSecureInput] = useState<boolean | null>(null);
    const [userInput, setUserInput] = useState('');
    const [passwordInput, setPasswordInput] = useState('');
    const [resendKeyInput, setResendKeyInput] = useState('');
    const [fromEmailInput, setFromEmailInput] = useState('');
    const [fromNameInput, setFromNameInput] = useState('');
    const [replyToInput, setReplyToInput] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showResendKey, setShowResendKey] = useState(false);
    const [testRecipient, setTestRecipient] = useState('');

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getSmtpIntegration();
                if (!cancelled) {
                    setStatus(data);
                    setHostInput(data.host || '');
                    setPortInput(data.port ? String(data.port) : '');
                    setUserInput(data.user || '');
                    setFromEmailInput(data.from_email || '');
                    setFromNameInput(data.from_name || '');
                    setReplyToInput(data.reply_to || '');
                    setTestRecipient(data.from_email || '');
                }
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento email', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const effectiveProvider: EmailProvider = providerInput ?? status?.provider ?? 'smtp';
    const effectiveSecure = secureInput ?? status?.secure ?? false;

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
        const label = status.provider === 'resend' ? 'Attivo (Resend)' : 'Attivo (SMTP)';
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] border-[var(--ds-seated-solid)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--ds-seated-solid)]"></span>
                {label}
            </span>
        );
    }, [status]);

    const hasChanges = useMemo(() => {
        if (!status) return false;
        if (providerInput !== null && providerInput !== status.provider) return true;
        if (fromEmailInput.trim() !== (status.from_email || '')) return true;
        if (fromNameInput.trim() !== (status.from_name || '')) return true;
        if (replyToInput.trim() !== (status.reply_to || '')) return true;
        if (effectiveProvider === 'smtp') {
            if (hostInput.trim() !== (status.host || '')) return true;
            if (portInput.trim() !== (status.port ? String(status.port) : '')) return true;
            if (secureInput !== null && secureInput !== status.secure) return true;
            if (userInput.trim() !== (status.user || '')) return true;
            if (passwordInput !== '') return true;
        } else {
            if (resendKeyInput.trim() !== '') return true;
        }
        return false;
    }, [status, providerInput, effectiveProvider, hostInput, portInput, secureInput, userInput, passwordInput, resendKeyInput, fromEmailInput, fromNameInput, replyToInput]);

    const handleSave = async () => {
        if (!canEdit || saving || !status) return;
        const payload: SmtpIntegrationUpdate = {};
        if (providerInput !== null && providerInput !== status.provider) payload.provider = providerInput;
        if (fromEmailInput.trim() !== (status.from_email || '')) payload.from_email = fromEmailInput.trim();
        if (fromNameInput.trim() !== (status.from_name || '')) payload.from_name = fromNameInput.trim();
        if (replyToInput.trim() !== (status.reply_to || '')) payload.reply_to = replyToInput.trim();
        if (effectiveProvider === 'smtp') {
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
        } else {
            if (resendKeyInput.trim() !== '') payload.resend_api_key = resendKeyInput.trim();
        }
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateSmtpIntegration(payload);
            setStatus(updated);
            setProviderInput(null);
            setSecureInput(null);
            setPasswordInput('');
            setResendKeyInput('');
            showToast('Configurazione email aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento email', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!canEdit || testing) return;
        const to = testRecipient.trim();
        if (!to || !to.includes('@')) {
            showToast('Inserisci un indirizzo email di destinazione', 'error');
            return;
        }
        setTesting(true);
        try {
            await sendSmtpTestEmail(to);
            showToast(`Email di test inviata a ${to}`, 'success');
        } catch (err: any) {
            showToast(err?.message || 'Invio email di test fallito', 'error');
        } finally {
            setTesting(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }
    if (!status) return null;

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
                        <Mail className="w-5 h-5 text-[var(--ds-text-primary)]" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Server Email</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">Invio conferme email ai clienti</p>
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
                    {/* Provider switch */}
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Provider</p>
                            <p className="text-[12px] text-[var(--ds-text-muted)]">
                                {effectiveProvider === 'resend'
                                    ? 'Invio via API HTTPS Resend. Consigliato in cloud.'
                                    : 'Invio SMTP diretto (Aruba, Gmail, server on-prem…).'}
                            </p>
                        </div>
                        <div className="inline-flex rounded-md border border-[var(--ds-border)] overflow-hidden text-[12px] font-medium">
                            <button
                                type="button"
                                onClick={() => canEdit && setProviderInput('smtp')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors ${
                                    effectiveProvider === 'smtp'
                                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                SMTP
                            </button>
                            <button
                                type="button"
                                onClick={() => canEdit && setProviderInput('resend')}
                                disabled={!canEdit}
                                className={`px-3 py-1.5 transition-colors border-l border-[var(--ds-border)] ${
                                    effectiveProvider === 'resend'
                                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                                } disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                                Resend
                            </button>
                        </div>
                    </div>

                    {effectiveProvider === 'smtp' && (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="sm:col-span-2">
                                    <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Host SMTP</label>
                                    <input
                                        type="text"
                                        value={hostInput}
                                        onChange={(e) => setHostInput(e.target.value)}
                                        placeholder="smtps.aruba.it"
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
                                        placeholder="465"
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
                                            ? 'SSL implicito (di solito porta 465).'
                                            : 'STARTTLS o non cifrato (di solito porta 587).'}
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
                                    placeholder="noreply@vecchiofrantoio.it"
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
                        </>
                    )}

                    {effectiveProvider === 'resend' && (
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">API Key Resend</label>
                            <div className="relative">
                                <input
                                    type={showResendKey ? 'text' : 'password'}
                                    value={resendKeyInput}
                                    onChange={(e) => setResendKeyInput(e.target.value)}
                                    placeholder={maskPlaceholder(status.resend_api_key_last4)}
                                    disabled={!canEdit || saving}
                                    autoComplete="off"
                                    spellCheck={false}
                                    className="w-full pr-10 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowResendKey((v) => !v)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ds-text-subtle)] hover:text-[var(--ds-text-primary)]"
                                    aria-label={showResendKey ? 'Nascondi' : 'Mostra'}
                                    tabIndex={-1}
                                >
                                    {showResendKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                            <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                                Ottieni la chiave da resend.com → API Keys. Il dominio del mittente deve essere verificato lì (SPF+DKIM).
                            </p>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Email mittente</label>
                            <input
                                type="email"
                                value={fromEmailInput}
                                onChange={(e) => setFromEmailInput(e.target.value)}
                                placeholder="prenotazioni@vecchiofrantoio.it"
                                disabled={!canEdit || saving}
                                autoComplete="off"
                                spellCheck={false}
                                className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                        </div>
                        <div>
                            <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Nome mittente</label>
                            <input
                                type="text"
                                value={fromNameInput}
                                onChange={(e) => setFromNameInput(e.target.value)}
                                placeholder="Vecchio Frantoio"
                                disabled={!canEdit || saving}
                                className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Reply-To (dove ricevi le risposte)</label>
                        <input
                            type="email"
                            value={replyToInput}
                            onChange={(e) => setReplyToInput(e.target.value)}
                            placeholder="prenotazioni@vecchiofrantoio.com"
                            disabled={!canEdit || saving}
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                        />
                        <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                            Quando il cliente clicca “Rispondi”, la mail va a questo indirizzo. Deve essere la casella pollata via IMAP.
                        </p>
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

                    <div className="border-t border-[var(--ds-border)] pt-4">
                        <p className="text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">Invia email di test</p>
                        <p className="text-[11px] text-[var(--ds-text-subtle)] mb-2">
                            Usa la configurazione attualmente salvata (le modifiche non ancora salvate non contano).
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input
                                type="email"
                                value={testRecipient}
                                onChange={(e) => setTestRecipient(e.target.value)}
                                placeholder="destinatario@esempio.it"
                                disabled={!canEdit || testing || !status.configured}
                                className="flex-1 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                            />
                            <button
                                type="button"
                                onClick={handleTest}
                                disabled={!canEdit || testing || !status.configured || !testRecipient.trim()}
                                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                Invia test
                            </button>
                        </div>
                        {!status.configured && (
                            <p className="text-[11px] text-[var(--ds-pending-text)] mt-2">
                                Salva prima una configurazione completa per poter inviare un test.
                            </p>
                        )}
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
