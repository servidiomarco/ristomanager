import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, Save, GripVertical } from 'lucide-react';
import { Loader } from './Loader';
import {
    getReservationAllergenPresets,
    updateReservationAllergenPresets,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type Draft = { key: string; label: string; existingId?: number };

const MAX_LABELS = 30;
const MAX_LABEL_LENGTH = 80;

let draftCounter = 0;
const makeKey = () => `allergen-draft-${++draftCounter}`;

export const ReservationAllergensManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [initial, setInitial] = useState<Draft[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const dragIndexRef = useRef<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getReservationAllergenPresets();
                if (cancelled) return;
                const rows = data.map(d => ({ key: makeKey(), label: d.label, existingId: d.id }));
                setDrafts(rows);
                setInitial(rows.map(r => ({ ...r, key: r.key })));
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento delle intolleranze', 'error');
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
        }
        return false;
    })();

    const addLabel = () => {
        const trimmed = newLabel.trim();
        if (!trimmed) return;
        if (trimmed.length > MAX_LABEL_LENGTH) {
            showToast(`L'intolleranza non può superare ${MAX_LABEL_LENGTH} caratteri`, 'error');
            return;
        }
        if (drafts.length >= MAX_LABELS) {
            showToast(`Massimo ${MAX_LABELS} intolleranze`, 'error');
            return;
        }
        const dup = drafts.some(d => d.label.trim().toLowerCase() === trimmed.toLowerCase());
        if (dup) {
            showToast('Intolleranza già presente', 'error');
            return;
        }
        setDrafts(prev => [...prev, { key: makeKey(), label: trimmed }]);
        setNewLabel('');
    };

    const removeAt = (idx: number) => {
        setDrafts(prev => prev.filter((_, i) => i !== idx));
    };

    const updateLabelAt = (idx: number, value: string) => {
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
            const labels = drafts
                .map(d => d.label.trim())
                .filter(l => l.length > 0);
            const updated = await updateReservationAllergenPresets(labels);
            const rows = updated.map(d => ({ key: makeKey(), label: d.label, existingId: d.id }));
            setDrafts(rows);
            setInitial(rows.map(r => ({ ...r, key: r.key })));
            showToast('Intolleranze aggiornate', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Errore aggiornamento intolleranze', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-[var(--ds-text-muted)] text-[13px] py-2">
                <Loader label="Caricamento…" size={40} />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {drafts.length === 0 ? (
                <p className="text-[13px] text-[var(--ds-text-subtle)] italic px-1">Nessuna intolleranza configurata.</p>
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
                            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 bg-[var(--ds-surface)] transition-colors ${
                                dragOverIndex === i ? 'border-[var(--ds-arriving-solid)] bg-[var(--ds-arriving-tint)]' : 'border-[var(--ds-border)]'
                            }`}
                        >
                            <GripVertical className={`w-4 h-4 flex-shrink-0 ${canEdit ? 'text-[var(--ds-text-muted)] cursor-grab active:cursor-grabbing' : 'text-[var(--ds-text-subtle)]'}`} />
                            <input
                                type="text"
                                value={d.label}
                                disabled={!canEdit}
                                maxLength={MAX_LABEL_LENGTH}
                                onChange={(e) => updateLabelAt(i, e.target.value)}
                                className="flex-1 bg-transparent text-[14px] text-[var(--ds-text-primary)] focus:outline-none disabled:opacity-70"
                            />
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={() => removeAt(i)}
                                    className="p-1.5 rounded-md text-[var(--ds-critical-solid)] hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
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
                        placeholder="Aggiungi intolleranza (es. Fragole)"
                        maxLength={MAX_LABEL_LENGTH}
                        onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
                        className="flex-1 rounded-md border border-[var(--ds-border)] px-3 py-1.5 text-[14px] bg-[var(--ds-surface)] focus:outline-none focus:border-[var(--ds-action-bg)]"
                    />
                    <button
                        type="button"
                        onClick={addLabel}
                        disabled={!newLabel.trim() || drafts.length >= MAX_LABELS}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-4 h-4" /> Aggiungi
                    </button>
                </div>
            )}

            {canEdit && (
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--ds-border)]">
                    <span className="text-[12px] text-[var(--ds-text-subtle)]">
                        {drafts.length}/{MAX_LABELS} intolleranze
                    </span>
                    <button
                        type="button"
                        onClick={save}
                        disabled={!isDirty || saving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Salva modifiche
                    </button>
                </div>
            )}

            {!canEdit && (
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    Solo gli amministratori possono modificare la lista.
                </p>
            )}
        </div>
    );
};
