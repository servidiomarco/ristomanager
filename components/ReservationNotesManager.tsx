import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, Save, GripVertical, Smile, X, ChevronDown, ChevronRight } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
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

type VariantDraft = { key: string; label: string };
type Draft = {
    key: string;
    label: string;
    icon: string | null;
    has_quantity: boolean;
    variants: VariantDraft[];
    existingId?: number;
};

const MAX_LABELS = 30;
const MAX_LABEL_LENGTH = 80;
const MAX_VARIANTS = 20;

let draftCounter = 0;
const makeKey = () => `draft-${++draftCounter}`;

const toDraft = (d: ReservationNotePreset): Draft => ({
    key: makeKey(),
    label: d.label,
    icon: d.icon || null,
    has_quantity: !!d.has_quantity,
    variants: (d.variants || []).map(v => ({ key: makeKey(), label: v.label })),
    existingId: d.id,
});

const draftEquals = (a: Draft, b: Draft): boolean => {
    if (a.label.trim() !== b.label.trim()) return false;
    if ((a.icon || null) !== (b.icon || null)) return false;
    if (!!a.has_quantity !== !!b.has_quantity) return false;
    if (a.variants.length !== b.variants.length) return false;
    for (let i = 0; i < a.variants.length; i++) {
        if (a.variants[i].label.trim() !== b.variants[i].label.trim()) return false;
    }
    return true;
};

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
    // Only presets with variants (or a "quantity" toggle) show a nested
    // section. We keep the disclosure state client-side keyed on draft.key,
    // so a fresh row starts collapsed but stays open once the user opens it.
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
    const dragIndexRef = useRef<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getReservationNotePresets();
                if (cancelled) return;
                const rows = data.map(toDraft);
                setDrafts(rows);
                // Deep-clone `initial` so future mutations to `drafts` don't
                // creep into the baseline used to compute `isDirty`.
                setInitial(rows.map(r => ({
                    ...r,
                    variants: r.variants.map(v => ({ ...v })),
                })));
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
            if (!draftEquals(drafts[i], initial[i])) return true;
        }
        return false;
    })();

    const toggleExpanded = (key: string) => {
        setExpandedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

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
        setDrafts(prev => [
            ...prev,
            { key: makeKey(), label: trimmed, icon: newIcon, has_quantity: false, variants: [] },
        ]);
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

    const toggleQuantityAt = (idx: number) => {
        setDrafts(prev => prev.map((d, i) => {
            if (i !== idx) return d;
            const next: Draft = { ...d, has_quantity: !d.has_quantity };
            return next;
        }));
        // If we're just enabling quantity/variants, auto-expand so the
        // operator sees the new section instead of guessing where it went.
        const target = drafts[idx];
        if (target && !target.has_quantity && target.variants.length === 0) {
            setExpandedKeys(prev => {
                const next = new Set(prev);
                next.add(target.key);
                return next;
            });
        }
    };

    const addVariantAt = (idx: number, rawLabel: string) => {
        const label = rawLabel.trim();
        if (!label) return;
        if (label.length > MAX_LABEL_LENGTH) {
            showToast(`Variante troppo lunga (max ${MAX_LABEL_LENGTH} caratteri)`, 'error');
            return;
        }
        const target = drafts[idx];
        if (target && target.variants.length >= MAX_VARIANTS) {
            showToast(`Massimo ${MAX_VARIANTS} varianti per nota`, 'error');
            return;
        }
        const dup = target?.variants.some(v => v.label.trim().toLowerCase() === label.toLowerCase());
        if (dup) {
            showToast('Variante già presente', 'error');
            return;
        }
        setDrafts(prev => prev.map((d, i) => i === idx
            ? { ...d, variants: [...d.variants, { key: makeKey(), label }] }
            : d
        ));
    };

    const updateVariantLabelAt = (idx: number, vIdx: number, value: string) => {
        setDrafts(prev => prev.map((d, i) => i === idx
            ? { ...d, variants: d.variants.map((v, j) => j === vIdx ? { ...v, label: value } : v) }
            : d
        ));
    };

    const removeVariantAt = (idx: number, vIdx: number) => {
        setDrafts(prev => prev.map((d, i) => i === idx
            ? { ...d, variants: d.variants.filter((_, j) => j !== vIdx) }
            : d
        ));
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
                .map(d => {
                    const label = d.label.trim();
                    if (!label) return null;
                    const variants = d.variants
                        .map(v => ({ label: v.label.trim() }))
                        .filter(v => v.label.length > 0);
                    return {
                        label,
                        icon: d.icon || null,
                        // Se ci sono varianti forziamo has_quantity=true: una
                        // variante senza quantità non ha senso operativo.
                        has_quantity: d.has_quantity || variants.length > 0,
                        variants,
                    };
                })
                .filter((d): d is NonNullable<typeof d> => d !== null);
            const updated = await updateReservationNotePresets(items);
            const rows = updated.map(toDraft);
            setDrafts(rows);
            setInitial(rows.map(r => ({
                ...r,
                variants: r.variants.map(v => ({ ...v })),
            })));
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
                <CookingPotLoader label="Caricamento…" size={40} />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {drafts.length === 0 ? (
                <p className="text-[13px] text-[var(--color-fg-subtle)] italic px-1">Nessuna nota configurata.</p>
            ) : (
                <ul className="space-y-1.5">
                    {drafts.map((d, i) => {
                        const hasStructure = d.has_quantity || d.variants.length > 0;
                        const isExpanded = expandedKeys.has(d.key);
                        return (
                            <li
                                key={d.key}
                                className={`rounded-md border bg-[var(--color-surface)] transition-colors ${
                                    dragOverIndex === i ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10' : 'border-[var(--color-line)]'
                                }`}
                            >
                                <div
                                    draggable={canEdit}
                                    onDragStart={() => handleDragStart(i)}
                                    onDragOver={(e) => handleDragOver(e, i)}
                                    onDrop={() => handleDrop(i)}
                                    onDragEnd={handleDragEnd}
                                    className="flex items-center gap-2 px-2 py-1.5"
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
                                    {/* Toggle "Quantità": una nota può chiedere un numero al click.
                                        Se ci sono varianti, il toggle resta on: la variante senza
                                        quantità non ha senso operativo (si taglierebbe l'aggregazione). */}
                                    <label className={`inline-flex items-center gap-1.5 text-[12px] select-none ${canEdit ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                                        <input
                                            type="checkbox"
                                            className="w-3.5 h-3.5 rounded border-[var(--color-line)] accent-indigo-600"
                                            checked={d.has_quantity || d.variants.length > 0}
                                            disabled={!canEdit || d.variants.length > 0}
                                            onChange={() => toggleQuantityAt(i)}
                                        />
                                        <span className="text-[var(--color-fg-muted)]">Quantità</span>
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => toggleExpanded(d.key)}
                                        className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                        title={isExpanded ? 'Nascondi varianti' : 'Mostra varianti'}
                                        aria-label={isExpanded ? 'Nascondi varianti' : 'Mostra varianti'}
                                        aria-expanded={isExpanded}
                                    >
                                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                        {d.variants.length > 0 && (
                                            <span className="ml-1 text-[11px] tabular-nums">{d.variants.length}</span>
                                        )}
                                    </button>
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
                                </div>

                                {isExpanded && (
                                    <VariantEditor
                                        variants={d.variants}
                                        canEdit={canEdit}
                                        hint={hasStructure
                                            ? 'Es. "Maiale", "Vitello". Se la nota non ha varianti, viene chiesta solo la quantità.'
                                            : 'Attiva "Quantità" per contare gli ordini di questa nota. Aggiungi varianti se ci sono più tipologie.'}
                                        onAdd={(label) => addVariantAt(i, label)}
                                        onUpdate={(vIdx, value) => updateVariantLabelAt(i, vIdx, value)}
                                        onRemove={(vIdx) => removeVariantAt(i, vIdx)}
                                    />
                                )}
                            </li>
                        );
                    })}
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

interface VariantEditorProps {
    variants: VariantDraft[];
    canEdit: boolean;
    hint: string;
    onAdd: (label: string) => void;
    onUpdate: (idx: number, value: string) => void;
    onRemove: (idx: number) => void;
}

const VariantEditor: React.FC<VariantEditorProps> = ({ variants, canEdit, hint, onAdd, onUpdate, onRemove }) => {
    const [pending, setPending] = useState('');
    const commit = () => {
        const v = pending.trim();
        if (!v) return;
        onAdd(v);
        setPending('');
    };
    return (
        <div className="border-t border-[var(--color-line)] px-3 py-2 space-y-2 bg-[var(--color-surface-alt,transparent)]">
            <p className="text-[11px] text-[var(--color-fg-subtle)]">{hint}</p>
            {variants.length > 0 && (
                <ul className="space-y-1">
                    {variants.map((v, i) => (
                        <li key={v.key} className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-fg-muted)] flex-shrink-0" />
                            <input
                                type="text"
                                value={v.label}
                                disabled={!canEdit}
                                maxLength={MAX_LABEL_LENGTH}
                                onChange={(e) => onUpdate(i, e.target.value)}
                                className="flex-1 bg-transparent text-[13px] text-[var(--color-fg)] focus:outline-none disabled:opacity-70"
                            />
                            {canEdit && (
                                <button
                                    type="button"
                                    onClick={() => onRemove(i)}
                                    className="p-1 rounded-md text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/50 transition-colors"
                                    title="Rimuovi variante"
                                    aria-label={`Rimuovi variante ${v.label}`}
                                >
                                    <X className="w-3.5 h-3.5" />
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
                        value={pending}
                        placeholder="Aggiungi variante (es. Maiale)"
                        maxLength={MAX_LABEL_LENGTH}
                        onChange={(e) => setPending(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
                        className="flex-1 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[13px] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-fg)]"
                    />
                    <button
                        type="button"
                        onClick={commit}
                        disabled={!pending.trim() || variants.length >= MAX_VARIANTS}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[12px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-3.5 h-3.5" /> Aggiungi
                    </button>
                </div>
            )}
        </div>
    );
};
