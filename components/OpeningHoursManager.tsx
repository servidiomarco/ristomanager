import React, { useEffect, useMemo, useState } from 'react';
import { Clock, CalendarOff, Plus, Save, Trash2, Loader2, Sun, Moon } from 'lucide-react';
import { Shift } from '../types';
import {
    getOpeningHours,
    updateOpeningHours,
    getClosures,
    createClosure,
    deleteClosure,
    OpeningHoursRow,
    SpecialClosure,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

const WEEKDAY_LABELS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const SHORT_WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type DraftMap = Record<number, OpeningHoursRow>;

function formatItalianDate(iso: string): string {
    try {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    } catch {
        return iso;
    }
}

export const OpeningHoursManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [hours, setHours] = useState<OpeningHoursRow[]>([]);
    const [drafts, setDrafts] = useState<DraftMap>({});
    const [closures, setClosures] = useState<SpecialClosure[]>([]);
    const [loading, setLoading] = useState(true);
    const [savingWeekday, setSavingWeekday] = useState<number | null>(null);

    // New-closure form
    const [newDate, setNewDate] = useState('');
    const [newShift, setNewShift] = useState<'ALL' | Shift.LUNCH | Shift.DINNER>('ALL');
    const [newReason, setNewReason] = useState('');
    const [addingClosure, setAddingClosure] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const today = new Date().toISOString().slice(0, 10);
                const [h, c] = await Promise.all([getOpeningHours(), getClosures(today)]);
                if (cancelled) return;
                setHours(h);
                const draft: DraftMap = {};
                h.forEach(row => { draft[row.weekday] = { ...row }; });
                setDrafts(draft);
                setClosures(c);
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento orari', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        return () => { cancelled = true; };
    }, [showToast]);

    const dirtyWeekdays = useMemo(() => {
        const dirty = new Set<number>();
        hours.forEach(orig => {
            const d = drafts[orig.weekday];
            if (!d) return;
            if (
                d.lunch_open !== orig.lunch_open ||
                d.lunch_close !== orig.lunch_close ||
                d.dinner_open !== orig.dinner_open ||
                d.dinner_close !== orig.dinner_close ||
                d.slot_minutes !== orig.slot_minutes
            ) dirty.add(orig.weekday);
        });
        return dirty;
    }, [hours, drafts]);

    const handleField = (weekday: number, field: keyof OpeningHoursRow, value: string) => {
        setDrafts(prev => ({
            ...prev,
            [weekday]: {
                ...prev[weekday],
                [field]: field === 'slot_minutes' ? (parseInt(value, 10) || 0) : (value || null),
            } as OpeningHoursRow,
        }));
    };

    const handleSave = async (weekday: number) => {
        const draft = drafts[weekday];
        if (!draft) return;
        setSavingWeekday(weekday);
        try {
            const updated = await updateOpeningHours(weekday, {
                lunch_open: draft.lunch_open,
                lunch_close: draft.lunch_close,
                dinner_open: draft.dinner_open,
                dinner_close: draft.dinner_close,
                slot_minutes: draft.slot_minutes,
            });
            setHours(prev => prev.map(r => r.weekday === weekday ? updated : r));
            setDrafts(prev => ({ ...prev, [weekday]: updated }));
            showToast(`Orari di ${WEEKDAY_LABELS[weekday]} aggiornati`, 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore nel salvataggio', 'error');
        } finally {
            setSavingWeekday(null);
        }
    };

    const handleAddClosure = async () => {
        if (!newDate) {
            showToast('Seleziona una data', 'error');
            return;
        }
        setAddingClosure(true);
        try {
            const created = await createClosure({
                date: newDate,
                shift: newShift === 'ALL' ? null : newShift,
                reason: newReason.trim() || null,
            });
            setClosures(prev => {
                const filtered = prev.filter(c => !(c.date === created.date && c.shift === created.shift));
                return [...filtered, created].sort((a, b) => a.date.localeCompare(b.date));
            });
            setNewDate('');
            setNewShift('ALL');
            setNewReason('');
            showToast('Chiusura aggiunta', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiunta chiusura', 'error');
        } finally {
            setAddingClosure(false);
        }
    };

    const handleDeleteClosure = async (id: number) => {
        try {
            await deleteClosure(id);
            setClosures(prev => prev.filter(c => c.id !== id));
            showToast('Chiusura rimossa', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore rimozione', 'error');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-fg-muted)] py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Caricamento orari…
            </div>
        );
    }

    // Display weekdays starting from Monday (1..6,0) for Italian convention
    const ordered = [1, 2, 3, 4, 5, 6, 0];

    return (
        <div className="space-y-6">
            {/* Opening hours grid */}
            <div>
                <h4 className="text-[12px] font-semibold text-[var(--color-fg)] mb-2 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Orari settimanali
                </h4>
                <p className="text-[12px] text-[var(--color-fg-muted)] mb-3">
                    Imposta apertura e chiusura per ogni turno. Lascia vuoti i campi per disattivare un turno.
                    Il passo degli slot determina la durata fra un orario prenotabile e il successivo.
                </p>
                <div className="space-y-2">
                    {ordered.map(weekday => {
                        const d = drafts[weekday];
                        if (!d) return null;
                        const isDirty = dirtyWeekdays.has(weekday);
                        const saving = savingWeekday === weekday;
                        return (
                            <div
                                key={weekday}
                                className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-3"
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[13px] font-semibold text-[var(--color-fg)]">
                                        {WEEKDAY_LABELS[weekday]}
                                    </span>
                                    {canEdit && (
                                        <button
                                            type="button"
                                            disabled={!isDirty || saving}
                                            onClick={() => handleSave(weekday)}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                            Salva
                                        </button>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="border border-[var(--color-line)] rounded-md p-2 bg-amber-50/40 dark:bg-amber-500/5">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300 mb-1.5">
                                            <Sun className="h-3 w-3" /> Pranzo
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.lunch_open ?? ''}
                                                onChange={e => handleField(weekday, 'lunch_open', e.target.value)}
                                                className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px] text-[var(--color-fg)]"
                                            />
                                            <span className="text-[12px] text-[var(--color-fg-muted)]">–</span>
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.lunch_close ?? ''}
                                                onChange={e => handleField(weekday, 'lunch_close', e.target.value)}
                                                className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px] text-[var(--color-fg)]"
                                            />
                                        </div>
                                    </div>
                                    <div className="border border-[var(--color-line)] rounded-md p-2 bg-indigo-50/40 dark:bg-indigo-500/5">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 mb-1.5">
                                            <Moon className="h-3 w-3" /> Cena
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.dinner_open ?? ''}
                                                onChange={e => handleField(weekday, 'dinner_open', e.target.value)}
                                                className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px] text-[var(--color-fg)]"
                                            />
                                            <span className="text-[12px] text-[var(--color-fg-muted)]">–</span>
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.dinner_close ?? ''}
                                                onChange={e => handleField(weekday, 'dinner_close', e.target.value)}
                                                className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px] text-[var(--color-fg)]"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                    <label className="text-[12px] text-[var(--color-fg-muted)]">Passo slot (min)</label>
                                    <input
                                        type="number"
                                        min={5}
                                        max={240}
                                        step={5}
                                        disabled={!canEdit}
                                        value={d.slot_minutes}
                                        onChange={e => handleField(weekday, 'slot_minutes', e.target.value)}
                                        className="w-20 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-[13px] text-[var(--color-fg)]"
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Closures */}
            <div>
                <h4 className="text-[12px] font-semibold text-[var(--color-fg)] mb-2 flex items-center gap-1.5">
                    <CalendarOff className="h-3.5 w-3.5" />
                    Chiusure straordinarie
                </h4>
                <p className="text-[12px] text-[var(--color-fg-muted)] mb-3">
                    Date specifiche in cui il ristorante è chiuso (es. festività, ferie). Puoi chiudere l'intera giornata o solo un turno.
                </p>

                {canEdit && (
                    <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-3 mb-3">
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,2fr,auto] gap-2 items-end">
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--color-fg-muted)] mb-1">Data</label>
                                <input
                                    type="date"
                                    value={newDate}
                                    onChange={e => setNewDate(e.target.value)}
                                    className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-fg)]"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--color-fg-muted)] mb-1">Turno</label>
                                <select
                                    value={newShift}
                                    onChange={e => setNewShift(e.target.value as any)}
                                    className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-fg)]"
                                >
                                    <option value="ALL">Tutto il giorno</option>
                                    <option value={Shift.LUNCH}>Solo pranzo</option>
                                    <option value={Shift.DINNER}>Solo cena</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--color-fg-muted)] mb-1">Motivo (opzionale)</label>
                                <input
                                    type="text"
                                    value={newReason}
                                    onChange={e => setNewReason(e.target.value)}
                                    placeholder="es. Ferragosto, ferie"
                                    className="w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-fg)]"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={handleAddClosure}
                                disabled={!newDate || addingClosure}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {addingClosure ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                Aggiungi
                            </button>
                        </div>
                    </div>
                )}

                {closures.length === 0 ? (
                    <p className="text-[13px] text-[var(--color-fg-muted)] italic">Nessuna chiusura programmata.</p>
                ) : (
                    <ul className="divide-y divide-[var(--color-line)] bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)]">
                        {closures.map(c => (
                            <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] font-medium text-[var(--color-fg)]">
                                            {formatItalianDate(c.date)}
                                        </span>
                                        {c.shift === null && (
                                            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                                                Tutto il giorno
                                            </span>
                                        )}
                                        {c.shift === Shift.LUNCH && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                                                <Sun className="h-2.5 w-2.5" /> Pranzo
                                            </span>
                                        )}
                                        {c.shift === Shift.DINNER && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                                                <Moon className="h-2.5 w-2.5" /> Cena
                                            </span>
                                        )}
                                    </div>
                                    {c.reason && (
                                        <p className="text-[12px] text-[var(--color-fg-muted)] mt-0.5 truncate">{c.reason}</p>
                                    )}
                                </div>
                                {canEdit && (
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteClosure(c.id)}
                                        className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                                        title="Rimuovi"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
};
