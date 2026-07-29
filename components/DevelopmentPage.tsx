import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Kanban, Plus, X, Trash2, Loader2, GripVertical, RefreshCw } from 'lucide-react';
import {
  DevBoardCard, DevBoardColumnKey, DevBoardLabelKey,
  getDevBoardCards, createDevBoardCard, updateDevBoardCard, moveDevBoardCard, deleteDevBoardCard,
} from '../services/devBoardApiService';
import { socketClient } from '../services/socketClient';

interface ColumnMeta {
  key: DevBoardColumnKey;
  label: string;
  hint: string;
  dotClass: string;
  headerClass: string;
}

const COLUMNS: ColumnMeta[] = [
  { key: 'in_progress',  label: 'In lavorazione', hint: 'Ci stiamo lavorando ora',            dotClass: 'bg-blue-500',    headerClass: 'text-blue-700 dark:text-blue-300' },
  { key: 'review',       label: 'Da rivedere',    hint: 'Fatte, ma con revisioni da fare',    dotClass: 'bg-amber-500',   headerClass: 'text-amber-700 dark:text-amber-300' },
  { key: 'nice_to_have', label: 'Nice to have',   hint: 'Idee e migliorie non urgenti',       dotClass: 'bg-violet-500',  headerClass: 'text-violet-700 dark:text-violet-300' },
  { key: 'paused',       label: 'In pausa',       hint: 'Bloccate o rimandate',               dotClass: 'bg-slate-400',   headerClass: 'text-slate-600 dark:text-slate-300' },
  { key: 'done',         label: 'Fatte',          hint: 'Implementate e in produzione',       dotClass: 'bg-emerald-500', headerClass: 'text-emerald-700 dark:text-emerald-300' },
];

// Etichette stile Trello: palette chiusa, il colore È il significato. Il
// server sanitizza sulla stessa lista (DEV_BOARD_LABELS in server.ts).
interface LabelMeta {
  key: DevBoardLabelKey;
  name: string;
  chipClass: string;
}

const LABELS: LabelMeta[] = [
  { key: 'comande',      name: 'Comande',      chipClass: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300' },
  { key: 'prenotazioni', name: 'Prenotazioni', chipClass: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300' },
  { key: 'pagamenti',    name: 'Pagamenti',    chipClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300' },
  { key: 'stampa',       name: 'Stampa',       chipClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' },
  { key: 'bug',          name: 'Bug',          chipClass: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300' },
  { key: 'infra',        name: 'Infra',        chipClass: 'bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300' },
];

const labelMeta = (key: DevBoardLabelKey): LabelMeta | undefined => LABELS.find(l => l.key === key);

const formatCardDate = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
};

interface EditDraft {
  id: number | null; // null = new card
  title: string;
  description: string;
  column_key: DevBoardColumnKey;
  labels: DevBoardLabelKey[];
}

export const DevelopmentPage: React.FC = () => {
  const [cards, setCards] = useState<DevBoardCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Quick composer (per-column inline "add")
  const [composerColumn, setComposerColumn] = useState<DevBoardColumnKey | null>(null);
  const [composerTitle, setComposerTitle] = useState('');
  const [isComposerSaving, setIsComposerSaving] = useState(false);

  // Edit/create modal
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [isDraftSaving, setIsDraftSaving] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<DevBoardCard | null>(null);

  // Drag & drop
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ column: DevBoardColumnKey; index: number | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getDevBoardCards();
      setCards(data);
    } catch (err: any) {
      setError(err?.message || 'Errore caricamento board');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: any mutation from another device just refetches the board.
  useEffect(() => {
    const attach = () => {
      const socket = socketClient.getSocket();
      if (!socket) return () => {};
      const onChanged = () => { load(); };
      socket.on('devboard:changed', onChanged);
      return () => { socket.off('devboard:changed', onChanged); };
    };
    let detach = attach();
    const unsubscribe = socketClient.onSocketChange(() => {
      detach();
      detach = attach();
    });
    return () => { detach(); unsubscribe(); };
  }, [load]);

  const cardsByColumn = useMemo(() => {
    const map = new Map<DevBoardColumnKey, DevBoardCard[]>();
    COLUMNS.forEach(c => map.set(c.key, []));
    [...cards]
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .forEach(card => { map.get(card.column_key)?.push(card); });
    return map;
  }, [cards]);

  // --- Composer -----------------------------------------------------------

  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (composerColumn) composerInputRef.current?.focus(); }, [composerColumn]);

  const submitComposer = async () => {
    const title = composerTitle.trim();
    if (!title || !composerColumn || isComposerSaving) return;
    setIsComposerSaving(true);
    try {
      const created = await createDevBoardCard({ title, column_key: composerColumn });
      setCards(prev => [...prev, created]);
      setComposerTitle('');
      composerInputRef.current?.focus();
    } catch (err: any) {
      setError(err?.message || 'Errore salvataggio');
    } finally {
      setIsComposerSaving(false);
    }
  };

  // --- Edit modal ---------------------------------------------------------

  const submitDraft = async () => {
    if (!editDraft || isDraftSaving) return;
    const title = editDraft.title.trim();
    if (!title) return;
    setIsDraftSaving(true);
    try {
      if (editDraft.id == null) {
        const created = await createDevBoardCard({
          title,
          description: editDraft.description.trim() || null,
          column_key: editDraft.column_key,
          labels: editDraft.labels,
        });
        setCards(prev => [...prev, created]);
      } else {
        const updated = await updateDevBoardCard(editDraft.id, {
          title,
          description: editDraft.description.trim() || null,
          column_key: editDraft.column_key,
          labels: editDraft.labels,
        });
        setCards(prev => prev.map(c => c.id === updated.id ? updated : c));
      }
      setEditDraft(null);
    } catch (err: any) {
      setError(err?.message || 'Errore salvataggio');
    } finally {
      setIsDraftSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    const card = deleteCandidate;
    setDeleteCandidate(null);
    setEditDraft(null);
    setCards(prev => prev.filter(c => c.id !== card.id));
    try {
      await deleteDevBoardCard(card.id);
    } catch (err: any) {
      setError(err?.message || 'Errore eliminazione');
      load();
    }
  };

  // --- Drag & drop --------------------------------------------------------

  const handleDrop = (column: DevBoardColumnKey, index: number | null) => {
    setDropHint(null);
    const id = draggingId;
    setDraggingId(null);
    if (id == null) return;
    const card = cards.find(c => c.id === id);
    if (!card) return;

    const target = (cardsByColumn.get(column) || []).filter(c => c.id !== id);
    const insertAt = index == null ? target.length : Math.max(0, Math.min(index, target.length));
    target.splice(insertAt, 0, card);
    const orderedIds = target.map(c => c.id);

    // Optimistic: re-position the whole destination column locally.
    setCards(prev => prev.map(c => {
      const pos = orderedIds.indexOf(c.id);
      if (c.id === id) return { ...c, column_key: column, position: pos };
      if (pos >= 0 && c.column_key === column) return { ...c, position: pos };
      return c;
    }));
    moveDevBoardCard(id, column, orderedIds).catch(() => load());
  };

  /** Index where the dragged card would land when hovering a card (top half →
   *  before it, bottom half → after it). */
  const hoverIndex = (e: React.DragEvent, cardIndex: number): number => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? cardIndex : cardIndex + 1;
  };

  const totalCount = cards.length;

  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="flex items-start justify-between gap-3 px-4 lg:px-6 pt-4 lg:pt-6 pb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-[var(--color-fg)] flex items-center gap-2">
            <Kanban className="h-5 w-5 text-[var(--color-fg-muted)]" /> Development
          </h2>
          <p className="text-xs text-[var(--color-fg-muted)] mt-0.5">
            Board di progetto · {totalCount} {totalCount === 1 ? 'card' : 'cards'} · visibile solo a questo account
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setIsLoading(true); load(); }}
          title="Ricarica"
          className="p-2 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mx-4 lg:mx-6 mb-2 px-3 py-2 rounded-lg text-sm bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{error}</span>
          <button type="button" onClick={() => setError(null)} className="flex-none"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Board */}
      <div className="flex-1 min-h-0 flex gap-3 lg:gap-4 overflow-x-auto overflow-y-hidden px-4 lg:px-6 pb-4 snap-x snap-mandatory sm:snap-none">
        {COLUMNS.map(col => {
          const columnCards = cardsByColumn.get(col.key) || [];
          const isDropTarget = dropHint?.column === col.key;
          return (
            <div
              key={col.key}
              className={`w-[82vw] max-w-72 sm:w-72 lg:w-80 sm:max-w-none flex-none flex flex-col min-h-0 snap-center rounded-xl border bg-[var(--color-surface-2)] transition-colors ${
                isDropTarget ? 'border-[var(--color-fg)]/40 bg-[var(--color-surface-hover)]' : 'border-[var(--color-line)]'
              }`}
              onDragOver={(e) => { e.preventDefault(); setDropHint(prev => (prev?.column === col.key ? prev : { column: col.key, index: null })); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(col.key, dropHint?.column === col.key ? dropHint.index : null); }}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 pt-3 pb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full flex-none ${col.dotClass}`} />
                  <span className={`text-[13px] font-semibold truncate ${col.headerClass}`} title={col.hint}>{col.label}</span>
                  <span className="text-[11px] font-medium text-[var(--color-fg-subtle)] tabular-nums">{columnCards.length}</span>
                </div>
                <button
                  type="button"
                  title={`Aggiungi in ${col.label}`}
                  onClick={() => { setComposerColumn(col.key); setComposerTitle(''); }}
                  className="p-1 rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {/* Cards */}
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
                {isLoading && cards.length === 0 && (
                  <div className="flex items-center justify-center py-8 text-[var(--color-fg-subtle)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                )}
                {columnCards.map((card, i) => (
                  <React.Fragment key={card.id}>
                    {isDropTarget && dropHint?.index === i && draggingId !== card.id && (
                      <div className="h-0.5 rounded bg-[var(--color-fg)]/50 mx-1" />
                    )}
                    <div
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(card.id)); setDraggingId(card.id); }}
                      onDragEnd={() => { setDraggingId(null); setDropHint(null); }}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropHint({ column: col.key, index: hoverIndex(e, i) }); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.key, hoverIndex(e, i)); }}
                      onClick={() => setEditDraft({ id: card.id, title: card.title, description: card.description || '', column_key: card.column_key, labels: card.labels ?? [] })}
                      className={`group rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 cursor-pointer shadow-sm hover:border-[var(--color-fg)]/30 transition-colors ${
                        draggingId === card.id ? 'opacity-40' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <GripVertical className="h-3.5 w-3.5 mt-0.5 flex-none text-[var(--color-fg-subtle)] opacity-0 group-hover:opacity-100 cursor-grab" />
                        <div className="min-w-0 flex-1">
                          {(card.labels?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1">
                              {card.labels.map(key => {
                                const meta = labelMeta(key);
                                return meta ? (
                                  <span key={key} className={`px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none ${meta.chipClass}`}>
                                    {meta.name}
                                  </span>
                                ) : null;
                              })}
                            </div>
                          )}
                          <p className="text-sm font-medium text-[var(--color-fg)] leading-snug break-words">{card.title}</p>
                          {card.description && (
                            <p className="mt-1 text-xs text-[var(--color-fg-muted)] leading-snug line-clamp-3 whitespace-pre-line">{card.description}</p>
                          )}
                          <p className="mt-1.5 text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
                            {formatCardDate(card.updated_at || card.created_at)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                ))}
                {isDropTarget && dropHint?.index != null && dropHint.index >= columnCards.length && columnCards.length > 0 && (
                  <div className="h-0.5 rounded bg-[var(--color-fg)]/50 mx-1" />
                )}
                {!isLoading && columnCards.length === 0 && composerColumn !== col.key && (
                  <button
                    type="button"
                    onClick={() => { setComposerColumn(col.key); setComposerTitle(''); }}
                    className="w-full rounded-lg border border-dashed border-[var(--color-line)] px-3 py-4 text-xs text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)] hover:border-[var(--color-fg)]/30 transition-colors"
                  >
                    {col.hint} — aggiungi la prima card
                  </button>
                )}

                {/* Inline composer */}
                {composerColumn === col.key && (
                  <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2 space-y-2">
                    <textarea
                      ref={composerInputRef}
                      value={composerTitle}
                      onChange={(e) => setComposerTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer(); }
                        if (e.key === 'Escape') setComposerColumn(null);
                      }}
                      rows={2}
                      placeholder="Titolo della card…"
                      className="w-full px-2 py-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-sm text-[var(--color-fg)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={submitComposer}
                        disabled={!composerTitle.trim() || isComposerSaving}
                        className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-50"
                      >
                        {isComposerSaving && <Loader2 className="h-3 w-3 animate-spin" />} Aggiungi
                      </button>
                      <button
                        type="button"
                        onClick={() => setComposerColumn(null)}
                        className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit/create modal — portaled like every overlay that must beat the
          view container and the mobile bottom nav. */}
      {editDraft && createPortal(
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] sm:px-4" onClick={() => setEditDraft(null)}>
          <div className="bg-[var(--color-surface)] w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] overflow-hidden animate-in slide-in-from-bottom sm:slide-in-from-bottom-4 duration-200 pb-[env(safe-area-inset-bottom)] sm:pb-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
            </div>
            <div className="flex items-start justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {editDraft.id == null ? 'Nuova card' : 'Modifica card'}
              </h3>
              <button onClick={() => setEditDraft(null)}
                className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] mb-1.5 block">Titolo</label>
                <input
                  type="text"
                  value={editDraft.title}
                  onChange={(e) => setEditDraft(d => d ? { ...d, title: e.target.value } : d)}
                  autoFocus
                  className="w-full h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] mb-1.5 block">Descrizione</label>
                <textarea
                  value={editDraft.description}
                  onChange={(e) => setEditDraft(d => d ? { ...d, description: e.target.value } : d)}
                  rows={4}
                  placeholder="Dettagli, note, link…"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] text-sm text-[var(--color-fg)] leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] mb-1.5 block">Colonna</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {COLUMNS.map(col => (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => setEditDraft(d => d ? { ...d, column_key: col.key } : d)}
                      className={`flex items-center gap-2 px-2.5 h-9 rounded-lg border text-xs font-medium transition-colors ${
                        editDraft.column_key === col.key
                          ? 'border-[var(--color-fg)]/50 bg-[var(--color-surface-hover)] text-[var(--color-fg)]'
                          : 'border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full flex-none ${col.dotClass}`} />
                      <span className="truncate">{col.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--color-fg-muted)] mb-1.5 block">Etichette</label>
                <div className="flex flex-wrap gap-1.5">
                  {LABELS.map(l => {
                    const active = editDraft.labels.includes(l.key);
                    return (
                      <button
                        key={l.key}
                        type="button"
                        onClick={() => setEditDraft(d => d ? {
                          ...d,
                          labels: active ? d.labels.filter(k => k !== l.key) : [...d.labels, l.key],
                        } : d)}
                        className={`px-2.5 h-8 rounded-lg text-xs font-semibold transition-all ${l.chipClass} ${
                          active ? 'ring-2 ring-[var(--color-fg)]/40' : 'opacity-45 hover:opacity-100'
                        }`}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                {editDraft.id != null ? (
                  <button
                    type="button"
                    onClick={() => { const card = cards.find(c => c.id === editDraft.id); if (card) setDeleteCandidate(card); }}
                    className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" /> Elimina
                  </button>
                ) : <span />}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditDraft(null)}
                    className="px-3 h-9 rounded-lg text-sm font-medium border border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
                  >
                    Annulla
                  </button>
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={!editDraft.title.trim() || isDraftSaving}
                    className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg text-sm font-semibold bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-50"
                  >
                    {isDraftSaving && <Loader2 className="h-4 w-4 animate-spin" />} Salva
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirm */}
      {deleteCandidate && createPortal(
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] sm:px-4" onClick={() => setDeleteCandidate(null)}>
          <div className="bg-[var(--color-surface)] w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 space-y-3">
              <p className="text-sm text-[var(--color-fg)]">
                Eliminare la card <strong>{deleteCandidate.title}</strong>?
              </p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setDeleteCandidate(null)}
                  className="px-3 h-9 rounded-lg text-sm font-medium border border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors">
                  Annulla
                </button>
                <button type="button" onClick={confirmDelete}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 transition-colors">
                  <Trash2 className="h-4 w-4" /> Elimina
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
