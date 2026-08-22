import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
    getPaymentLinkExpirySettings,
    updatePaymentLinkExpirySettings,
    type PaymentLinkExpirySettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/* ── Scadenza dei link di pagamento (card dev board #28) ──────────────────
   Un link di caparra non pagato resta payabile per sempre e la prenotazione
   resta in attesa a tempo indeterminato. Qui si decide dopo quante ore il
   link viene annullato da solo e se il cliente riceve il messaggio delle
   prenotazioni non confermate. Spenta di default: la si accende consapevoli
   che da quel momento i link pendenti oltre la soglia scadono davvero. */
export const PaymentLinkExpiryManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<PaymentLinkExpirySettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
    const [hoursInput, setHoursInput] = useState('24');
    const [draftMessage, setDraftMessage] = useState<'declined' | 'none' | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getPaymentLinkExpirySettings();
                if (cancelled) return;
                setSettings(data);
                setHoursInput(String(data.hours));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const parsedHours = (() => {
        const n = parseInt(hoursInput, 10);
        return Number.isFinite(n) ? n : NaN;
    })();
    const hoursValid = Number.isInteger(parsedHours) && parsedHours >= 1 && parsedHours <= 168;
    const hoursChanged = settings
        ? hoursInput.trim() !== '' && Number.isInteger(parsedHours) && parsedHours !== settings.hours
        : false;
    const effectiveEnabled = draftEnabled ?? settings?.enabled ?? false;
    const effectiveMessage = draftMessage ?? settings?.message ?? 'declined';
    const isDirty = draftEnabled !== null || hoursChanged || (settings ? effectiveMessage !== settings.message : false);

    const save = async () => {
        if (!canEdit || saving || !settings) return;
        if (hoursInput.trim() !== '' && !hoursValid) {
            showToast('Le ore devono essere un intero tra 1 e 168', 'error');
            return;
        }
        const payload: Partial<PaymentLinkExpirySettings> = {};
        if (draftEnabled !== null && draftEnabled !== settings.enabled) payload.enabled = draftEnabled;
        if (hoursChanged) payload.hours = parsedHours;
        if (effectiveMessage !== settings.message) payload.message = effectiveMessage;
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updatePaymentLinkExpirySettings(payload);
            setSettings(updated);
            setDraftEnabled(null);
            setDraftMessage(null);
            setHoursInput(String(updated.hours));
            showToast('Scadenza link di pagamento aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento scadenza link', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--ds-text-muted)] text-[13px] py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
            </div>
        );
    }
    if (!settings) return null;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Scadenza automatica dei link</p>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        Dopo la soglia il link non è più pagabile e la prenotazione in attesa di caparra viene declinata. Vale per i link degli ultimi 7 giorni; le quote del conto al tavolo sono escluse.
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={effectiveEnabled}
                    aria-label={effectiveEnabled ? 'Disattiva scadenza automatica' : 'Attiva scadenza automatica'}
                    onClick={() => canEdit && setDraftEnabled(!effectiveEnabled)}
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

            <div>
                <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                    Il link scade dopo
                </label>
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        min={1}
                        max={168}
                        step={1}
                        inputMode="numeric"
                        value={hoursInput}
                        onChange={(e) => setHoursInput(e.target.value)}
                        disabled={!canEdit || saving || !effectiveEnabled}
                        className="w-24 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                    />
                    <span className="text-[12px] text-[var(--ds-text-muted)]">ore dall'invio</span>
                </div>
            </div>

            <div>
                <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                    Messaggio al cliente
                </label>
                <select
                    value={effectiveMessage}
                    onChange={(e) => setDraftMessage(e.target.value as 'declined' | 'none')}
                    disabled={!canEdit || saving || !effectiveEnabled}
                    className="w-full max-w-xs px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                >
                    <option value="declined">Prenotazione non confermata (stessi testi del rifiuto manuale)</option>
                    <option value="none">Nessun messaggio</option>
                </select>
                <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                    Parte sul canale previsto dai Canali di risposta della fonte (WhatsApp con ripiego SMS, email).
                </p>
            </div>

            {canEdit && (
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--ds-border)]">
                    <button
                        type="button"
                        onClick={save}
                        disabled={!isDirty || saving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Salva modifiche
                    </button>
                </div>
            )}

            {!canEdit && (
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    Solo gli amministratori possono modificare questa impostazione.
                </p>
            )}
        </div>
    );
};
