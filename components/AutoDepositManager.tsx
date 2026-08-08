import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import {
    getAutoDepositSettings,
    updateAutoDepositSettings,
    type AutoDepositSettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { PaymentProviderPicker } from './PaymentProviderPicker';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const centsToInput = (cents: number): string =>
    (cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');

export const AutoDepositManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<AutoDepositSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
    const [minGuestsInput, setMinGuestsInput] = useState('');
    const [perPersonInput, setPerPersonInput] = useState('10');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getAutoDepositSettings();
                if (cancelled) return;
                setSettings(data);
                setMinGuestsInput(String(data.min_guests));
                setPerPersonInput(centsToInput(data.per_person_cents ?? 1000));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    // L'operatore digita euro ("10", "7,50"); il backend vuole centesimi.
    const parsedPerPersonCents = (() => {
        const n = Number(perPersonInput.replace(',', '.'));
        return Number.isFinite(n) ? Math.round(n * 100) : NaN;
    })();
    const perPersonValid = Number.isInteger(parsedPerPersonCents)
        && parsedPerPersonCents >= 100 && parsedPerPersonCents <= 20000;
    const perPersonChanged = settings
        ? perPersonInput.trim() !== ''
            && Number.isInteger(parsedPerPersonCents)
            && parsedPerPersonCents !== (settings.per_person_cents ?? 1000)
        : false;

    const parsedMinGuests = (() => {
        const n = parseInt(minGuestsInput, 10);
        return Number.isFinite(n) ? n : NaN;
    })();
    const minGuestsValid = Number.isInteger(parsedMinGuests) && parsedMinGuests >= 1 && parsedMinGuests <= 100;
    const minGuestsChanged = settings
        ? minGuestsInput.trim() !== ''
            && Number.isInteger(parsedMinGuests)
            && parsedMinGuests !== settings.min_guests
        : false;
    const effectiveEnabled = draftEnabled ?? settings?.enabled ?? false;
    const isDirty = draftEnabled !== null || minGuestsChanged || perPersonChanged;

    const save = async () => {
        if (!canEdit || saving || !settings) return;
        if (minGuestsInput.trim() !== '' && !minGuestsValid) {
            showToast('Il numero di coperti deve essere un intero tra 1 e 100', 'error');
            return;
        }
        if (perPersonInput.trim() !== '' && !perPersonValid) {
            showToast('La caparra per persona deve essere tra € 1 e € 200', 'error');
            return;
        }
        const payload: Partial<Pick<AutoDepositSettings, 'enabled' | 'min_guests' | 'per_person_cents'>> = {};
        if (draftEnabled !== null && draftEnabled !== settings.enabled) payload.enabled = draftEnabled;
        if (minGuestsChanged) payload.min_guests = parsedMinGuests;
        if (perPersonChanged) payload.per_person_cents = parsedPerPersonCents;
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await updateAutoDepositSettings(payload);
            setSettings(updated);
            setDraftEnabled(null);
            setMinGuestsInput(String(updated.min_guests));
            setPerPersonInput(centsToInput(updated.per_person_cents ?? 1000));
            showToast('Caparra automatica aggiornata', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento caparra automatica', 'error');
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

    // The deposit link is created with whichever gateway is active, so name
    // that one instead of hardcoding Revolut. Older backends don't send the
    // label — fall back to the historical wording.
    const providerLabel = settings.active_provider_label || 'Revolut';

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">Attiva caparra automatica</p>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        Per le richieste dal modulo /prenota il sistema genera automaticamente un link di pagamento {providerLabel} inviato via SMS al cliente. Importo e soglia qui sotto valgono anche per le prenotazioni telefoniche e per le condizioni pubblicate su /prenota.
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={effectiveEnabled}
                    aria-label={effectiveEnabled ? 'Disattiva caparra automatica' : 'Attiva caparra automatica'}
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
                    Caparra per persona
                </label>
                <div className="flex items-center gap-2">
                    <span className="text-[13px] text-[var(--ds-text-muted)]">€</span>
                    <input
                        type="text"
                        inputMode="decimal"
                        value={perPersonInput}
                        onChange={(e) => setPerPersonInput(e.target.value)}
                        disabled={!canEdit || saving || !effectiveEnabled}
                        className="w-24 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                    />
                    <span className="text-[12px] text-[var(--ds-text-muted)]">a persona</span>
                </div>
                <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                    Moltiplicato per il numero di coperti. Compare nei messaggi al cliente e nella sezione "Caparra e cancellazioni" della pagina di prenotazione.
                </p>
            </div>

            <div>
                <label className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                    Richiedi caparra da (numero di coperti)
                </label>
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        inputMode="numeric"
                        value={minGuestsInput}
                        onChange={(e) => setMinGuestsInput(e.target.value)}
                        disabled={!canEdit || saving || !effectiveEnabled}
                        className="w-24 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60"
                    />
                    <span className="text-[12px] text-[var(--ds-text-muted)]">coperti o più</span>
                </div>
                <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                    Le prenotazioni con almeno questo numero di persone riceveranno il link di pagamento. Sotto la soglia il flusso è invariato.
                </p>
                {!settings.revolut_configured && effectiveEnabled && (
                    <p className="text-[11px] text-[var(--ds-pending-text)] mt-1">
                        {providerLabel} non è ancora configurato: configura le credenziali in Integrazioni → {providerLabel}, altrimenti il link non verrà generato.
                    </p>
                )}
            </div>

            {/* Provider preferito per le caparre: vale per la caparra automatica
                E per i link manuali dal modal prenotazione — stessa pipeline. */}
            <PaymentProviderPicker flow="deposit" showToast={showToast} canEdit={canEdit} />

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
