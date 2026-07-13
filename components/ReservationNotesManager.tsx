import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, Save, GripVertical, Smile, X } from 'lucide-react';
import {
    getReservationNotePresets,
    updateReservationNotePresets,
    ReservationNotePreset,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import {
    RESERVATION_NOTE_ICONS,
    RESERVATION_NOTE_ICON_KEYS,
    RESERVATION_NOTE_ICON_LABELS,
    getReservationNoteIcon,
} from './reservationNoteIcons';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type Draft = { key: string; label: string; icon: string | null; existingId?: number };

const MAX_LABELS = 30;
const MAX_LABEL_LENGTH = 80;

let draftCounter = 0;
const makeKey = () => `draft-${++draftCounter}`;

export const ReservationNotesManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [initial, setInitial] = useState<Draft[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [newIcon, setNewIcon] = useState<string | null>(null);
    const [iconPickerFor, setIconPickerFor] = useState<string | 'new' | null>(null);
    const dragIndexRef = useRef<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getReservationNotePresets();
                if (cancelled) return;
                const rows = data.map(d => ({ key: makeKey(), label: d.label, icon: d.icon || null, existingId: d.id }));
                setDrafts(rows);
                setInitial(rows.map(r => ({ ...r, key: r.key })));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle note', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const isDirty = (() => {
        if (drafts.length !== initial.length) return true;
        for (let i = 0; i < drafts.length; i++) {
            if (drafts[i].label.trim() !== initial[i].label.trim()) return true;
            if ((drafts[i].icon || null) !== (initial[i].icon || null)) return true;
        }
        return false;
    })();

    const addLabel = () => {
        const trimmed = newLabel.trim();
        if (!trimmed) return;
        if (trimmed.length > MAX_LABEL_LENGTH) {
            showToast(`La nota non può superare ${MAX_LABEL_LENGTH} caratteri`, 'error');
            return;
        }
        if (drafts.length >= MAX_LABELS) {
            showToast(`Massimo ${MAX_LABELS} note`, 'error');
            return;
        }
        const dup = drafts.some(d => d.label.trim().toLowerCase() === trimmed.toLowerCase());
        if (dup) {
            showToast('Nota già presente', 'error');
            return;
        }
        setDrafts(prev => [...prev, { key: makeKey(), label: trimmed, icon: newIcon }]);
        setNewLabel('');
        setNewIcon(null);
    };

    const removeAt = (idx: number) => {
        setDrafts(prev => prev.filter((_, i) => i !== idx));
    };

    const updateLabelAt = (idx: number, value: string) => {
        setDrafts(prev => prev.map((d, i) => i === idx ? { ...d, label: value } : d));
    };

    const updateIconAt = (idx: number, icon: string | null) => {
        setDrafts(prev => prev.map((d, i) => i === idx ? { ...d, icon } : d));
    };

    const handleDragStart = (idx: number) => {
        dragIndexRef.current = idx;
    };

    const handleDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (dragIndexRef.current !== null && dragIndexRef.current !== idx) {
            setDragOverIndex(idx);
        }
    };

    const handleDrop = (idx: number) => {
        const from = dragIndexRef.current;
        dragIndexRef.current = null;
        setDragOverIndex(null);
        if (from == null || from === idx) return;
        setDrafts(prev => {
            const next = prev.slice();
            const [moved] = next.splice(from, 1);
            next.splice(idx, 0, moved);
            return next;
        });
    };

    const handleDragEnd = () => {
        dragIndexRef.current = null;
        setDragOverIndex(null);
    };

    const save = async () => {
        if (!canEdit || saving) return;
        setSaving(true);
        try {
            const items = drafts
                .map(d => ({ label: d.label.trim(), icon: d.icon || null }))
                .filter(d => d.label.length > 0);
            const updated = await updateReservationNotePresets(items);
            const rows = updated.map(d => ({ key: makeKey(), label: d.label, icon: d.icon || null, existingId: d.id }));
            setDrafts(rows);
            setInitial(rows.map(r => ({ ...r, key: r.key })));
            showToast('Note aggiornate', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento note', 'error');
        } finally {
            setSaving(false);
        }
    };

    const renderIconButton = (
        currentIcon: string | null,
        pickerKey: string,
        onPick: (icon: string | null) => void,
        disabled: boolean,
    ) => {
        const Icon = getReservationNoteIcon(currentIcon);
        const isOpen = iconPickerFor === pickerKey;
        return (
            <div className="relative flex-shrink-0">
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setIconPickerFor(isOpen ? null : pickerKey)}
                    className={`w-9 h-9 rounded-md border flex items-center justify-center transition-colors ${
                        currentIcon
                            ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/40'
                            : 'border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title={currentIcon ? RESERVATION_NOTE_ICON_LABELS[currentIcon] || currentIcon : 'Scegli icona'}
                    aria-label="Scegli icona"
                >
                    {Icon ? <Icon className="w-4 h-4" /> : <Smile className="w-4 h-4" />}
                </button>
                {isOpen && (
                    <>
                        <div className="fixed inset-0 z-[70]" onClick={() => setIconPickerFor(null)} />
                        <div className="absolute right-0 top-full mt-1 z-[71] w-64 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg shadow-[var(--shadow-overlay)] p-2">
                            <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b border-[var(--color-line)]">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">Icona</span>
                                <button
                                    type="button"
                                    onClick={() => { onPick(null); setIconPickerFor(null); }}
                                    className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-500 hover:text-rose-600"
                                >
                                    <X className="w-3 h-3" /> Nessuna
                                </button>
                            </div>
                            <div className="grid grid-cols-6 gap-1 max-h-56 overflow-y-auto">
                                {RESERVATION_NOTE_ICON_KEYS.map(key => {
                                    const Ic = RESERVATION_NOTE_ICONS[key];
                                    const selected = currentIcon === key;
                                    return (
                                        <button
                                            key={key}
                                            type="button"
                                            onClick={() => { onPick(key); setIconPickerFor(null); }}
                                            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
                                                selected
                                                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/25 dark:text-indigo-200'
                                                    : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                                            }`}
                                            title={RESERVATION_NOTE_ICON_LABELS[key] || key}
                                        >
                                            <Ic className="w-4 h-4" />
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </div>
        );
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--color-fg-muted)] text-[13px] py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {drafts.length === 0 ? (
                <p className="text-[13px] text-[var(--color-fg-subtle)] italic px-1">Nessuna nota configurata.</p>
            ) : (
                <ul className="space-y-1.5">
                    {drafts.map((d, i) => (
                        <li
                            key={d.key}
                            draggable={canEdit}
                            onDragStart={() => handleDragStart(i)}
                            onDragOver={(e) => handleDragOver(e, i)}
                            onDrop={() => handleDrop(i)}
                            onDragEnd={handleDragEnd}
                            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 bg-[var(--color-surface)] transition-colors ${
                                dragOverIndex === i ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10' : 'border-[var(--color-line)]'
                            }`}
                        >
                            <GripVertical className={`w-4 h-4 flex-shrink-0 ${canEdit ? 'text-[var(--color-fg-muted)] cursor-grab active:cursor-grabbing' : 'text-[var(--color-fg-subtle)]'}`} />
                            {renderIconButton(d.icon, d.key, (icon) => updateIconAt(i, icon), !canEdit)}
                            <input
                                type="text"
                                value={d.label}
                                disabled={!canEdit}
                                maxLength={MAX_LABEL_LENGTH}
                                onChange={(e) => updateLabelAt(i, e.target.value)}
                                className="flex-1 bg-transparent text-[14px] text-[var(--color-fg)] focus:outline-none disabled:opacity-70"
                            />
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={() => removeAt(i)}
                                    className="p-1.5 rounded-md text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/50 transition-colors"
                                    title="Rimuovi"
                                    aria-label={`Rimuovi ${d.label}`}
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {canEdit && (
                <div className="flex items-center gap-2">
                    {renderIconButton(newIcon, 'new', setNewIcon, false)}
                    <input
                        type="text"
                        value={newLabel}
                        placeholder="Aggiungi nota (es. Tavolo esterno)"
                        maxLength={MAX_LABEL_LENGTH}
                        onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
                        className="flex-1 rounded-md border border-[var(--color-line)] px-3 py-1.5 text-[14px] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-fg)]"
                    />
                    <button
                        type="button"
                        onClick={addLabel}
                        disabled={!newLabel.trim() || drafts.length >= MAX_LABELS}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-4 h-4" /> Aggiungi
                    </button>
                </div>
            )}

            {canEdit && (
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--color-line)]">
                    <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {drafts.length}/{MAX_LABELS} note
                    </span>
                    <button
                        type="button"
                        onClick={save}
                        disabled={!isDirty || saving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Salva modifiche
                    </button>
                </div>
            )}

            {!canEdit && (
                <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Solo gli amministratori possono modificare la lista.
                </p>
            )}
        </div>
    );
};
