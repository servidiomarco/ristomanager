import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, Save, GripVertical, StickyNote } from 'lucide-react';
import {
    getReservationNotePresets,
    updateReservationNotePresets,
    ReservationNotePreset,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type Draft = { key: string; label: string; existingId?: number };

const MAX_LABELS = 30;
const MAX_LABEL_LENGTH = 80;

let draftCounter = 0;
const makeKey = () => `draft-${++draftCounter}`;

export const ReservationNotesManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [initial, setInitial] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const dragIndexRef = useRef<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getReservationNotePresets();
                if (cancelled) return;
                setDrafts(data.map(d => ({ key: makeKey(), label: d.label, existingId: d.id })));
                setInitial(data.map(d => d.label));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle note', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const currentLabels = drafts.map(d => d.label.trim()).filter(Boolean);
    const isDirty = currentLabels.length !== initial.length
        || currentLabels.some((l, i) => l !== initial[i]);

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
        setDrafts(prev => [...prev, { key: makeKey(), label: trimmed }]);
        setNewLabel('');
    };

    const removeAt = (idx: number) => {
        setDrafts(prev => prev.filter((_, i) => i !== idx));
    };

    const updateAt = (idx: number, value: string) => {
        setDrafts(prev => prev.map((d, i) => i === idx ? { ...d, label: value } : d));
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
            const labels = drafts.map(d => d.label.trim()).filter(Boolean);
            const updated = await updateReservationNotePresets(labels);
            setDrafts(updated.map(d => ({ key: makeKey(), label: d.label, existingId: d.id })));
            setInitial(updated.map(d => d.label));
            showToast('Note aggiornate', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento note', 'error');
        } finally {
            setSaving(false);
        }
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
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                    <StickyNote className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Note rapide prenotazione</h4>
                    <p className="text-[13px] text-[var(--color-fg-muted)]">
                        Chip suggeriti nel modal di prenotazione (es. Seggiolone, Compleanno). Trascina per riordinare.
                    </p>
                </div>
            </div>

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
                            <input
                                type="text"
                                value={d.label}
                                disabled={!canEdit}
                                maxLength={MAX_LABEL_LENGTH}
                                onChange={(e) => updateAt(i, e.target.value)}
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
