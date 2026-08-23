import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, CalendarOff, Plus, Save, Trash2, Loader2, Sun, Moon } from 'lucide-react';
import { Loader } from './Loader';
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

// Mirror of utils/slots.ts::generateSlots. Kept as a small pure helper so the
// checkbox grid stays a client-only concern (no round-trip needed while the
// operator edits open/close/step).
function generateSlots(open: string | null, close: string | null, stepMinutes: number): string[] {
    if (!open || !close || !Number.isFinite(stepMinutes) || stepMinutes <= 0) return [];
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    const startMin = oh * 60 + om;
    const endMin = ch * 60 + cm;
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin < startMin) return [];
    const out: string[] = [];
    for (let m = startMin; m <= endMin; m += stepMinutes) {
        out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
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

    // Mount-only fetch. `showToast` from App re-renders frequently (not
    // memoized) — including it in the deps re-fired this effect on every
    // parent update, flashing the loader over the content. Route the toast
    // via ref so we always call the latest callback without re-running load.
    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });
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
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento orari', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        return () => { cancelled = true; };
    }, []);

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
                d.slot_minutes !== orig.slot_minutes ||
                !arraysEqual(d.disabled_lunch_slots ?? [], orig.disabled_lunch_slots ?? []) ||
                !arraysEqual(d.disabled_dinner_slots ?? [], orig.disabled_dinner_slots ?? [])
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

    const toggleDisabledSlot = (weekday: number, shift: Shift, slot: string) => {
        setDrafts(prev => {
            const draft = prev[weekday];
            if (!draft) return prev;
            const key = shift === Shift.LUNCH ? 'disabled_lunch_slots' : 'disabled_dinner_slots';
            const current = new Set(draft[key] ?? []);
            if (current.has(slot)) current.delete(slot);
            else current.add(slot);
            return {
                ...prev,
                [weekday]: { ...draft, [key]: Array.from(current).sort() },
            };
        });
    };

    const handleSave = async (weekday: number) => {
        const draft = drafts[weekday];
        if (!draft) return;
        setSavingWeekday(weekday);
        try {
            // Prune disabled entries that no longer belong to the generated
            // slot grid (open/close/step may have shrunk since they were
            // toggled). Keeps the persisted set tidy and defensive.
            const lunchSlots = new Set(generateSlots(draft.lunch_open, draft.lunch_close, draft.slot_minutes));
            const dinnerSlots = new Set(generateSlots(draft.dinner_open, draft.dinner_close, draft.slot_minutes));
            const disabledLunch = (draft.disabled_lunch_slots ?? []).filter(s => lunchSlots.has(s));
            const disabledDinner = (draft.disabled_dinner_slots ?? []).filter(s => dinnerSlots.has(s));

            const updated = await updateOpeningHours(weekday, {
                lunch_open: draft.lunch_open,
                lunch_close: draft.lunch_close,
                dinner_open: draft.dinner_open,
                dinner_close: draft.dinner_close,
                slot_minutes: draft.slot_minutes,
                disabled_lunch_slots: disabledLunch,
                disabled_dinner_slots: disabledDinner,
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
            <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)] py-4">
                <Loader label="Caricamento orari…" size={40} />
            </div>
        );
    }

    // Display weekdays starting from Monday (1..6,0) for Italian convention
    const ordered = [1, 2, 3, 4, 5, 6, 0];

    return (
        <div className="space-y-6">
            {/* Opening hours grid */}
            <div>
                <h4 className="text-[12px] font-semibold text-[var(--ds-text-primary)] mb-2 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Orari settimanali
                </h4>
                <p className="text-[12px] text-[var(--ds-text-muted)] mb-3">
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
                                className="bg-[var(--ds-surface)] rounded-lg border border-[var(--ds-border)] p-3"
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[13px] font-semibold text-[var(--ds-text-primary)]">
                                        {WEEKDAY_LABELS[weekday]}
                                    </span>
                                    {canEdit && (
                                        <button
                                            type="button"
                                            disabled={!isDirty || saving}
                                            onClick={() => handleSave(weekday)}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                            Salva
                                        </button>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="border border-[var(--ds-border)] rounded-md p-2 bg-[var(--ds-pending-tint)]">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ds-pending-text)] mb-1.5">
                                            <Sun className="h-3 w-3" /> Pranzo
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.lunch_open ?? ''}
                                                onChange={e => handleField(weekday, 'lunch_open', e.target.value)}
                                                className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[13px] text-[var(--ds-text-primary)]"
                                            />
                                            <span className="text-[12px] text-[var(--ds-text-muted)]">–</span>
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.lunch_close ?? ''}
                                                onChange={e => handleField(weekday, 'lunch_close', e.target.value)}
                                                className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[13px] text-[var(--ds-text-primary)]"
                                            />
                                        </div>
                                    </div>
                                    <div className="border border-[var(--ds-border)] rounded-md p-2 bg-[var(--ds-arriving-tint)]">
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ds-arriving-text)] mb-1.5">
                                            <Moon className="h-3 w-3" /> Cena
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.dinner_open ?? ''}
                                                onChange={e => handleField(weekday, 'dinner_open', e.target.value)}
                                                className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[13px] text-[var(--ds-text-primary)]"
                                            />
                                            <span className="text-[12px] text-[var(--ds-text-muted)]">–</span>
                                            <input
                                                type="time"
                                                step={60}
                                                disabled={!canEdit}
                                                value={d.dinner_close ?? ''}
                                                onChange={e => handleField(weekday, 'dinner_close', e.target.value)}
                                                className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[13px] text-[var(--ds-text-primary)]"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                    <label className="text-[12px] text-[var(--ds-text-muted)]">Passo slot (min)</label>
                                    <input
                                        type="number"
                                        min={5}
                                        max={240}
                                        step={5}
                                        disabled={!canEdit}
                                        value={d.slot_minutes}
                                        onChange={e => handleField(weekday, 'slot_minutes', e.target.value)}
                                        className="w-20 rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[13px] text-[var(--ds-text-primary)]"
                                    />
                                </div>
                                {(() => {
                                    const lunchSlots = generateSlots(d.lunch_open, d.lunch_close, d.slot_minutes);
                                    const dinnerSlots = generateSlots(d.dinner_open, d.dinner_close, d.slot_minutes);
                                    if (lunchSlots.length === 0 && dinnerSlots.length === 0) return null;
                                    const disabledLunch = new Set(d.disabled_lunch_slots ?? []);
                                    const disabledDinner = new Set(d.disabled_dinner_slots ?? []);
                                    const renderChip = (slot: string, shift: Shift, disabled: boolean) => {
                                        const enabled = !disabled;
                                        const base = 'text-[11px] font-medium rounded px-1.5 py-0.5 border transition-colors';
                                        const on = shift === Shift.LUNCH
                                            ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] border-[var(--ds-pending-solid)]'
                                            : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] border-[var(--ds-border-strong)]';
                                        const off = 'bg-transparent text-[var(--ds-text-muted)] border-[var(--ds-border)] line-through opacity-60';
                                        return (
                                            <button
                                                key={`${shift}-${slot}`}
                                                type="button"
                                                disabled={!canEdit}
                                                onClick={() => toggleDisabledSlot(weekday, shift, slot)}
                                                title={enabled ? 'Disattiva slot' : 'Riattiva slot'}
                                                className={`${base} ${enabled ? on : off} ${canEdit ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                                            >
                                                {slot}
                                            </button>
                                        );
                                    };
                                    return (
                                        <div className="mt-2 pt-2 border-t border-[var(--ds-border)]">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <span className="text-[12px] font-semibold text-[var(--ds-text-muted)] tracking-wide">
                                                    Slot prenotabili
                                                </span>
                                                <span className="text-[10px] text-[var(--ds-text-muted)]">
                                                    Clicca per attivare/disattivare
                                                </span>
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                <div>
                                                    <div className="flex items-center gap-1 text-[12px] font-semibold text-[var(--ds-pending-text)] mb-1 tracking-wide">
                                                        <Sun className="h-2.5 w-2.5" /> Pranzo
                                                    </div>
                                                    {lunchSlots.length === 0 ? (
                                                        <p className="text-[11px] text-[var(--ds-text-muted)] italic">Turno non attivo</p>
                                                    ) : (
                                                        <div className="flex flex-wrap gap-1">
                                                            {lunchSlots.map(s => renderChip(s, Shift.LUNCH, disabledLunch.has(s)))}
                                                        </div>
                                                    )}
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-1 text-[12px] font-semibold text-[var(--ds-arriving-text)] mb-1 tracking-wide">
                                                        <Moon className="h-2.5 w-2.5" /> Cena
                                                    </div>
                                                    {dinnerSlots.length === 0 ? (
                                                        <p className="text-[11px] text-[var(--ds-text-muted)] italic">Turno non attivo</p>
                                                    ) : (
                                                        <div className="flex flex-wrap gap-1">
                                                            {dinnerSlots.map(s => renderChip(s, Shift.DINNER, disabledDinner.has(s)))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Closures */}
            <div>
                <h4 className="text-[12px] font-semibold text-[var(--ds-text-primary)] mb-2 flex items-center gap-1.5">
                    <CalendarOff className="h-3.5 w-3.5" />
                    Chiusure straordinarie
                </h4>
                <p className="text-[12px] text-[var(--ds-text-muted)] mb-3">
                    Date specifiche in cui il ristorante è chiuso (es. festività, ferie). Puoi chiudere l'intera giornata o solo un turno.
                </p>

                {canEdit && (
                    <div className="bg-[var(--ds-surface)] rounded-lg border border-[var(--ds-border)] p-3 mb-3">
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,2fr,auto] gap-2 items-end">
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--ds-text-muted)] mb-1">Data</label>
                                <input
                                    type="date"
                                    value={newDate}
                                    onChange={e => setNewDate(e.target.value)}
                                    className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5 text-[13px] text-[var(--ds-text-primary)]"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--ds-text-muted)] mb-1">Turno</label>
                                <select
                                    value={newShift}
                                    onChange={e => setNewShift(e.target.value as any)}
                                    className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5 text-[13px] text-[var(--ds-text-primary)]"
                                >
                                    <option value="ALL">Tutto il giorno</option>
                                    <option value={Shift.LUNCH}>Solo pranzo</option>
                                    <option value={Shift.DINNER}>Solo cena</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[11px] font-medium text-[var(--ds-text-muted)] mb-1">Motivo (opzionale)</label>
                                <input
                                    type="text"
                                    value={newReason}
                                    onChange={e => setNewReason(e.target.value)}
                                    placeholder="es. Ferragosto, ferie"
                                    className="w-full rounded border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5 text-[13px] text-[var(--ds-text-primary)]"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={handleAddClosure}
                                disabled={!newDate || addingClosure}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {addingClosure ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                Aggiungi
                            </button>
                        </div>
                    </div>
                )}

                {closures.length === 0 ? (
                    <p className="text-[13px] text-[var(--ds-text-muted)] italic">Nessuna chiusura programmata.</p>
                ) : (
                    <ul className="divide-y divide-[var(--ds-border)] bg-[var(--ds-surface)] rounded-lg border border-[var(--ds-border)]">
                        {closures.map(c => (
                            <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] font-medium text-[var(--ds-text-primary)]">
                                            {formatItalianDate(c.date)}
                                        </span>
                                        {c.shift === null && (
                                            <span className="text-[12px] font-semibold px-1.5 py-0.5 rounded bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]">
                                                Tutto il giorno
                                            </span>
                                        )}
                                        {c.shift === Shift.LUNCH && (
                                            <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-1.5 py-0.5 rounded bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]">
                                                <Sun className="h-2.5 w-2.5" /> Pranzo
                                            </span>
                                        )}
                                        {c.shift === Shift.DINNER && (
                                            <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-1.5 py-0.5 rounded bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                                                <Moon className="h-2.5 w-2.5" /> Cena
                                            </span>
                                        )}
                                    </div>
                                    {c.reason && (
                                        <p className="text-[12px] text-[var(--ds-text-muted)] mt-0.5 truncate">{c.reason}</p>
                                    )}
                                </div>
                                {canEdit && (
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteClosure(c.id)}
                                        className="p-1.5 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] dark:hover:bg-[var(--ds-critical-tint)]"
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
