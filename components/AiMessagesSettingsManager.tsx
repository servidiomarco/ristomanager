import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, Plus, Trash2, ChevronDown, Pencil, Check, X } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import {
    listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
    type KnowledgeEntry,
} from '../services/aiMessagesApiService';
import { useAuth } from '../contexts/AuthContext';

/* ── Messaggi con AI ──────────────────────────────────────────────────────
   Due cose in un posto solo: l'interruttore e le regole della casa da cui il
   modello risponde. Stanno insieme perché senza regole l'interruttore non
   serve a niente — ed è la prima cosa che il gestore deve capire aprendo
   questa scheda. */

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Esempi mostrati a scheda vuota: più di una spiegazione, fanno capire in tre
// secondi che ci si aspetta una frase secca, non un regolamento.
const ESEMPI: Array<{ title: string; content: string }> = [
    { title: 'Torte da fuori', content: 'Sì, si può portare la torta da casa o dalla pasticceria, purché il cliente porti anche lo scontrino del pasticcere. Nessun costo di servizio.' },
    { title: 'Bambini', content: 'Benvenuti. Abbiamo seggioloni e un menù bambini. Meglio avvisare in anticipo quanti sono.' },
    { title: 'Parcheggio', content: 'Parcheggio gratuito davanti al ristorante, non serve prenotarlo.' },
    { title: 'Cani', content: 'I cani sono ammessi solo negli spazi esterni (tettoia e fiume), al guinzaglio.' },
];

export const AiMessagesSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editContent, setEditContent] = useState('');

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [f, k] = await Promise.all([getFeatureFlags(), listKnowledge()]);
                if (cancelled) return;
                setFlags(f);
                setEntries(k.entries);
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const enabled = flags?.ai_messages_enabled === true;
    const activeCount = entries.filter(e => e.is_active).length;

    const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
        if (saving) return;
        setSaving(true);
        try {
            await fn();
            if (okMsg) showToast(okMsg, 'success');
        } catch (err: any) {
            showToast(err?.message || 'Operazione non riuscita', 'error');
        } finally {
            setSaving(false);
        }
    };

    const toggle = () => act(async () => {
        const updated = await updateFeatureFlags({ ai_messages_enabled: !enabled });
        setFlags(updated);
    }, `Messaggi con AI: ${!enabled ? 'attivi' : 'disattivati'}`);

    const add = (title: string, content: string) => act(async () => {
        const created = await createKnowledge({ title, content });
        setEntries(prev => [...prev, created]);
        setNewTitle(''); setNewContent('');
    }, 'Regola aggiunta');

    const saveEdit = (id: number) => act(async () => {
        const updated = await updateKnowledge(id, { title: editTitle.trim(), content: editContent.trim() });
        setEntries(prev => prev.map(e => (e.id === id ? updated : e)));
        setEditingId(null);
    }, 'Regola aggiornata');

    if (loading) {
        return (
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--color-fg-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    return (
        <details className="group bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-arriving-text)] flex-shrink-0">
                        <Sparkles className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Messaggi con AI</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                            Risposte suggerite ai clienti, basate sulle regole che scrivi tu.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                        {enabled ? 'Attivo' : 'Disattivato'}
                    </span>
                    <button
                        type="button" role="switch" aria-checked={enabled}
                        aria-label={`${enabled ? 'Disattiva' : 'Attiva'} messaggi con AI`}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); if (canEdit) toggle(); }}
                        disabled={!canEdit || saving}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                            enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                        }`}
                    >
                        <span aria-hidden="true"
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
                    </button>
                    <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </div>
            </summary>

            <div className="border-t border-[var(--color-line)] px-4 py-4 space-y-5">
                <div className="rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
                    Nella pagina Messaggi comparirà <strong className="text-[var(--color-fg)]">Suggerisci risposta</strong>:
                    l'AI legge la conversazione e la prenotazione collegata e propone una frase.
                    <strong className="text-[var(--color-fg)]"> Nessun messaggio parte da solo</strong> — leggi, correggi se serve, invii tu.
                    Su disponibilità dei tavoli e allergie non risponde mai: quelle restano a una persona.
                </div>

                <section>
                    <div className="flex items-center justify-between mb-2">
                        <h5 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">
                            Regole della casa
                        </h5>
                        <span className="text-[12px] text-[var(--color-fg-muted)]">
                            {activeCount} attiv{activeCount === 1 ? 'a' : 'e'}
                        </span>
                    </div>

                    {enabled && activeCount === 0 && (
                        <p className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-200">
                            La funzione è attiva ma non c'è nessuna regola: senza, l'AI non ha da cosa rispondere e non proporrà nulla.
                        </p>
                    )}

                    <div className="rounded-md border border-[var(--color-line)] divide-y divide-[var(--color-line)]">
                        {entries.map(e => (
                            <div key={e.id} className={`px-3 py-2.5 ${e.is_active ? '' : 'opacity-50'}`}>
                                {editingId === e.id ? (
                                    <div className="space-y-2">
                                        <input
                                            value={editTitle}
                                            onChange={ev => setEditTitle(ev.target.value)}
                                            className="w-full text-[13px] font-medium rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5"
                                        />
                                        <textarea
                                            value={editContent}
                                            onChange={ev => setEditContent(ev.target.value)}
                                            rows={3}
                                            className="w-full text-[13px] rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 resize-y"
                                        />
                                        <div className="flex items-center gap-2">
                                            <button type="button" disabled={!editTitle.trim() || !editContent.trim() || saving}
                                                onClick={() => saveEdit(e.id)}
                                                className="inline-flex items-center gap-1 text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--color-line)] disabled:opacity-50">
                                                <Check size={13} /> Salva
                                            </button>
                                            <button type="button" onClick={() => setEditingId(null)}
                                                className="inline-flex items-center gap-1 text-[13px] px-2.5 py-1.5 rounded-md text-[var(--color-fg-muted)]">
                                                <X size={13} /> Annulla
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start gap-3">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] font-medium text-[var(--color-fg)]">{e.title}</p>
                                            <p className="text-[13px] text-[var(--color-fg-muted)] whitespace-pre-wrap">{e.content}</p>
                                        </div>
                                        {canEdit && (
                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                <button type="button" aria-label={`Modifica ${e.title}`} disabled={saving}
                                                    onClick={() => { setEditingId(e.id); setEditTitle(e.title); setEditContent(e.content); }}
                                                    className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50">
                                                    <Pencil size={13} />
                                                </button>
                                                <button type="button" disabled={saving}
                                                    onClick={() => act(async () => {
                                                        const u = await updateKnowledge(e.id, { is_active: !e.is_active });
                                                        setEntries(prev => prev.map(x => (x.id === e.id ? u : x)));
                                                    })}
                                                    className="text-[12px] px-1.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50">
                                                    {e.is_active ? 'disattiva' : 'riattiva'}
                                                </button>
                                                <button type="button" aria-label={`Elimina ${e.title}`} disabled={saving}
                                                    onClick={() => act(async () => {
                                                        await deleteKnowledge(e.id);
                                                        setEntries(prev => prev.filter(x => x.id !== e.id));
                                                    }, 'Regola eliminata')}
                                                    className="p-1.5 rounded-md text-rose-600 disabled:opacity-50">
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}

                        {entries.length === 0 && (
                            <div className="px-3 py-3 space-y-2">
                                <p className="text-[13px] text-[var(--color-fg-muted)]">
                                    Nessuna regola. Parti da questi esempi, poi aggiungi le tue:
                                </p>
                                {canEdit && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {ESEMPI.map(ex => (
                                            <button key={ex.title} type="button" disabled={saving}
                                                onClick={() => add(ex.title, ex.content)}
                                                className="text-[12px] px-2 py-1 rounded-full border border-[var(--color-line)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                                                <Plus size={11} className="inline mr-0.5" />{ex.title}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {canEdit && (
                            <div className="px-3 py-2.5 space-y-2">
                                <input
                                    value={newTitle}
                                    onChange={e => setNewTitle(e.target.value)}
                                    placeholder="Argomento (es. Torte da fuori)"
                                    className="w-full text-[13px] rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5"
                                />
                                <textarea
                                    value={newContent}
                                    onChange={e => setNewContent(e.target.value)}
                                    placeholder="La regola, come la diresti a un cliente: “Sì, si può portare la torta purché porti anche lo scontrino del pasticcere.”"
                                    rows={2}
                                    className="w-full text-[13px] rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 resize-y"
                                />
                                <button type="button" disabled={!newTitle.trim() || !newContent.trim() || saving}
                                    onClick={() => add(newTitle.trim(), newContent.trim())}
                                    className="text-[13px] px-2.5 py-1.5 rounded-md border border-[var(--color-line)] flex items-center gap-1 disabled:opacity-50">
                                    <Plus size={13} /> Aggiungi regola
                                </button>
                            </div>
                        )}
                    </div>
                    <p className="text-[12px] text-[var(--color-fg-muted)] mt-1.5">
                        Scrivi frasi brevi e concrete. Quello che non è scritto qui, l'AI non lo dirà: quando non sa, non propone nulla e rispondi tu.
                    </p>
                </section>
            </div>
        </details>
    );
};
