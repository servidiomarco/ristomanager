import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import {
    getBookingReminderSettings,
    updateBookingReminderSettings,
    type BookingReminderSettings,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { SegmentedControl } from './ds';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const DAY_BEFORE_MIN = '09:00';
const DAY_BEFORE_MAX = '20:00';
const HOURS_MIN = 2;
const HOURS_MAX = 48;

/* ── Promemoria automatico all'ospite ─────────────────────────────────────
   Il promemoria che prima partiva solo dal bottone del modal, mandato da
   solo prima di ogni prenotazione confermata (services/bookingReminders.ts).
   Spento di default: accenderlo manda messaggi veri a tutte le prenotazioni
   di domani, quindi lo decide il ristoratore. */
export const BookingReminderManager: React.FC<Props> = ({ showToast }) => {
    const { t } = useTranslation('impostazioni', { useSuspense: false });
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [settings, setSettings] = useState<BookingReminderSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [draft, setDraft] = useState<BookingReminderSettings | null>(null);
    const [hoursInput, setHoursInput] = useState('24');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getBookingReminderSettings();
                if (cancelled) return;
                setSettings(data);
                setDraft(data);
                setHoursInput(String(data.hours_before));
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
    if (!settings || !draft) return null;

    const parsedHours = parseInt(hoursInput, 10);
    const hoursValid = Number.isInteger(parsedHours) && parsedHours >= HOURS_MIN && parsedHours <= HOURS_MAX;
    // Confronto fra stringhe HH:MM: l'input type=time le dà sempre a due cifre.
    const timeValid = /^\d{2}:\d{2}$/.test(draft.day_before_time)
        && draft.day_before_time >= DAY_BEFORE_MIN && draft.day_before_time <= DAY_BEFORE_MAX;
    // Un campo non valido della modalità NON scelta non deve far rifiutare
    // il salvataggio: resta il valore salvato.
    const next: BookingReminderSettings = {
        ...draft,
        hours_before: hoursValid ? parsedHours : settings.hours_before,
        day_before_time: timeValid ? draft.day_before_time : settings.day_before_time,
    };
    const isDirty = next.enabled !== settings.enabled
        || next.timing !== settings.timing
        || next.day_before_time !== settings.day_before_time
        || next.hours_before !== settings.hours_before;

    const save = async () => {
        if (!canEdit || saving) return;
        if (draft.timing === 'hours_before' && !hoursValid) {
            showToast(t('promOspite.badHours', 'Le ore devono essere un intero tra 2 e 48'), 'error');
            return;
        }
        if (draft.timing === 'day_before' && !timeValid) {
            showToast(t('promOspite.badTime', "L'orario deve stare tra le 9:00 e le 20:00"), 'error');
            return;
        }
        setSaving(true);
        try {
            const updated = await updateBookingReminderSettings(next);
            setSettings(updated);
            setDraft(updated);
            setHoursInput(String(updated.hours_before));
            showToast(t('promOspite.saved', "Promemoria all'ospite aggiornato"), 'success');
        } catch (err: any) {
            showToast(err?.data?.message || err?.message || t('promOspite.errSave', 'Errore aggiornamento del promemoria'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const disabled = !canEdit || saving || !draft.enabled;
    const inputClass = 'px-3 py-2 rounded-[var(--ds-radius)] border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[13px] font-mono text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-60';

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--ds-text-primary)]">{t('promOspite.title', 'Promemoria automatico')}</p>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {t('promOspite.intro', 'Parte da solo prima di ogni prenotazione confermata. Salta chi ha prenotato da meno di 12 ore e chi ha già avuto il promemoria a mano.')}
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={draft.enabled}
                    aria-label={draft.enabled ? t('promOspite.switchOff', 'Disattiva il promemoria automatico') : t('promOspite.switchOn', 'Attiva il promemoria automatico')}
                    onClick={() => canEdit && setDraft({ ...draft, enabled: !draft.enabled })}
                    disabled={!canEdit || saving}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                        draft.enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                            draft.enabled ? 'translate-x-5' : 'translate-x-0.5'
                        } translate-y-0.5`}
                    />
                </button>
            </div>

            <div className={draft.enabled ? '' : 'opacity-60 pointer-events-none'}>
                <p className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                    {t('promOspite.when', 'Quando')}
                </p>
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('promOspite.when', 'Quando')}
                    value={draft.timing}
                    onChange={(timing) => canEdit && setDraft({ ...draft, timing })}
                    options={[
                        { value: 'day_before', label: t('promOspite.dayBefore', 'Il giorno prima') },
                        { value: 'hours_before', label: t('promOspite.hoursBefore', 'Ore prima') },
                    ]}
                />
            </div>

            {draft.timing === 'day_before' ? (
                <div>
                    <label htmlFor="prom-ospite-ora" className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                        {t('promOspite.at', 'Alle')}
                    </label>
                    <input
                        id="prom-ospite-ora"
                        type="time"
                        min={DAY_BEFORE_MIN}
                        max={DAY_BEFORE_MAX}
                        step={900}
                        value={draft.day_before_time}
                        onChange={(e) => setDraft({ ...draft, day_before_time: e.target.value })}
                        disabled={disabled}
                        className={`w-28 ${inputClass}`}
                    />
                    <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                        {t('promOspite.atHint', "Tra le 9:00 e le 20:00, sull'ora del ristorante.")}
                    </p>
                </div>
            ) : (
                <div>
                    <label htmlFor="prom-ospite-ore" className="block text-[12px] font-medium text-[var(--ds-text-primary)] mb-1.5">
                        {t('promOspite.howMany', 'Quante ore prima')}
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            id="prom-ospite-ore"
                            type="number"
                            min={HOURS_MIN}
                            max={HOURS_MAX}
                            step={1}
                            inputMode="numeric"
                            value={hoursInput}
                            onChange={(e) => setHoursInput(e.target.value)}
                            disabled={disabled}
                            className={`w-24 ${inputClass}`}
                        />
                        <span className="text-[12px] text-[var(--ds-text-muted)]">{t('promOspite.hoursUnit', "ore prima dell'arrivo")}</span>
                    </div>
                    <p className="text-[11px] text-[var(--ds-text-subtle)] mt-1">
                        {t('promOspite.hoursHint', 'Da 2 a 48. Fra le 21 e le 9 non parte niente: il messaggio aspetta la mattina.')}
                    </p>
                </div>
            )}

            <p className="text-[11px] text-[var(--ds-text-subtle)]">
                {t('promOspite.channelHint', 'Parte sul canale previsto dai Canali di risposta della fonte (WhatsApp con ripiego SMS, email). Se un invio non riesce arriva un avviso a chi gestisce le prenotazioni.')}
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
