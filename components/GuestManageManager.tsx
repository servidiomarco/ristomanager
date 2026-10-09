import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import {
    getGuestManageSettings,
    updateGuestManageSettings,
    type GuestManageSettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const CUTOFF_MIN = 1;
const CUTOFF_MAX = 72;

/* ── Gestione dall'ospite («La tua prenotazione») ─────────────────────────
   Il link che conferma e promemoria portano all'ospite: dalla pagina
   conferma la presenza o annulla da solo (services/guestManage.ts).
   Spento di default, come il promemoria: accenderlo cambia i messaggi che
   partono a tutti gli ospiti, quindi lo decide il ristoratore. */
export const GuestManageManager: React.FC<Props> = ({ showToast }) => {
    const { t } = useTranslation('impostazioni', { useSuspense: false });
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<GuestManageSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [cutoffInput, setCutoffInput] = useState('3');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getGuestManageSettings();
                if (cancelled) return;
                setSettings(data);
                setEnabled(data.enabled);
                setCutoffInput(String(data.cancel_cutoff_hours));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || t('card.errLoad', 'Errore nel caricamento delle impostazioni'), 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--ds-text-muted)] text-[13px] py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {t('card.loading', 'Caricamento…')}
            </div>
        );
    }
    if (!settings) return null;

    const parsedCutoff = parseInt(cutoffInput, 10);
    const cutoffValid = Number.isInteger(parsedCutoff) && parsedCutoff >= CUTOFF_MIN && parsedCutoff <= CUTOFF_MAX;
    const isDirty = enabled !== settings.enabled
        || (cutoffValid && parsedCutoff !== settings.cancel_cutoff_hours);

    const save = async () => {
        if (!canEdit || saving) return;
        if (!cutoffValid) {
            showToast(t('gestOspite.badCutoff', 'Le ore devono essere un intero tra 1 e 72'), 'error');
            return;
        }
        setSaving(true);
        try {
            const updated = await updateGuestManageSettings({ enabled, cancel_cutoff_hours: parsedCutoff });
            setSettings(updated);
            setEnabled(updated.enabled);
            setCutoffInput(String(updated.cancel_cutoff_hours));
            showToast(t('gestOspite.saved', "Gestione dall'ospite aggiornata"), 'success');
        } catch (err: any) {
            showToast(err?.data?.message || err?.message || t('gestOspite.errSave', "Errore aggiornamento della gestione dall'ospite"), 'error');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = 'px-3 py-2 rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60';

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('gestOspite.title', 'Link «Gestisci la prenotazione»')}</p>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {t('gestOspite.intro', "Conferma e promemoria portano un link: l'ospite conferma la presenza o annulla da solo, e la prenotazione si aggiorna qui.")}
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={enabled ? t('gestOspite.switchOff', "Disattiva la gestione dall'ospite") : t('gestOspite.switchOn', "Attiva la gestione dall'ospite")}
                    onClick={() => canEdit && setEnabled(!enabled)}
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
            </div>

            <div className={enabled ? '' : 'opacity-60 pointer-events-none'}>
                <label htmlFor="gest-ospite-ore" className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                    {t('gestOspite.cutoff', 'Annullo dal link fino a')}
                </label>
                <div className="flex items-center gap-2">
                    <input
                        id="gest-ospite-ore"
                        type="number"
                        min={CUTOFF_MIN}
                        max={CUTOFF_MAX}
                        step={1}
                        inputMode="numeric"
                        value={cutoffInput}
                        onChange={(e) => setCutoffInput(e.target.value)}
                        disabled={!canEdit || saving || !enabled}
                        className={`w-24 ${inputClass}`}
                    />
                    <span className="text-[12px] text-[var(--ds-text-muted)]">{t('gestOspite.cutoffUnit', "ore prima dell'arrivo")}</span>
                </div>
                <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                    {t('gestOspite.cutoffHint', 'Più vicino all\'arrivo la pagina dice di chiamare il locale.')}
                </p>
            </div>

            <p className="text-[11px] text-[var(--ds-text-subtle)]">
                {t('gestOspite.depositHint', "Se l'ospite annulla con una caparra pagata e mancano almeno 24 ore, arriva un avviso per rimborsarla; sotto le 24 ore la caparra resta al locale e la pagina lo dice prima dell'annullo.")}
            </p>

            {canEdit && (
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--ds-border)]">
                    <button
                        type="button"
                        onClick={save}
                        disabled={!isDirty || saving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {t('card.save', 'Salva modifiche')}
                    </button>
                </div>
            )}

            {!canEdit && (
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    {t('card.adminsOnly', 'Solo gli amministratori possono modificare questa impostazione.')}
                </p>
            )}
        </div>
    );
};
