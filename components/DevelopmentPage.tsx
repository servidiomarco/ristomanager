import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, Trash2, Loader2, GripVertical, RefreshCw, Bot, RotateCcw, ExternalLink } from 'lucide-react';
import {
  DevBoardCard, DevBoardColumnKey, DevBoardLabelKey, DevBoardClaudeStatus,
  getDevBoardCards, createDevBoardCard, updateDevBoardCard, moveDevBoardCard, deleteDevBoardCard,
  approveDevBoardCardForClaude, resetDevBoardCardClaude,
} from '../services/devBoardApiService';
import { socketClient } from '../services/socketClient';
import {
  ModalShell, Field, Callout, dsInput, dsTextarea, dsButton, dsIconButton,
} from './ds';

/* Le colonne prendono le famiglie di stato del design system, non cinque tinte
   scelte a mano: in lavorazione è imminente (arriving), da rivedere chiede
   un'azione (pending), fatte è chiuso bene (seated). "Nice to have" e "in pausa"
   restano neutre — su una board la posizione è già la codifica principale, e
   inventare due colori per distinguere due colonne che stanno una accanto
   all'altra non aggiunge niente. */
type ColumnTone = 'info' | 'pending' | 'positive' | 'muted';

const COLUMN_TONE: Record<ColumnTone, { dot: string; text: string }> = {
  info: { dot: 'bg-[var(--ds-arriving-solid)]', text: 'text-[var(--ds-arriving-text)]' },
  pending: { dot: 'bg-[var(--ds-pending-solid)]', text: 'text-[var(--ds-pending-text)]' },
  positive: { dot: 'bg-[var(--ds-seated-solid)]', text: 'text-[var(--ds-seated-text)]' },
  muted: { dot: 'bg-[var(--ds-text-muted)]', text: 'text-[var(--ds-text-secondary)]' },
};

interface ColumnMeta {
  key: DevBoardColumnKey;
  label: string;
  hint: string;
  tone: ColumnTone;
}

const COLUMNS: ColumnMeta[] = [
  { key: 'in_progress',  label: 'In lavorazione', hint: 'Ci stiamo lavorando ora',         tone: 'info' },
  { key: 'review',       label: 'Da rivedere',    hint: 'Fatte, ma con revisioni da fare', tone: 'pending' },
  { key: 'nice_to_have', label: 'Nice to have',   hint: 'Idee e migliorie non urgenti',    tone: 'muted' },
  { key: 'paused',       label: 'In pausa',       hint: 'Bloccate o rimandate',            tone: 'muted' },
  { key: 'done',         label: 'Fatte',          hint: 'Implementate e in produzione',    tone: 'positive' },
];

// Etichette stile Trello: palette chiusa, il colore È il significato. Il
// server sanitizza sulla stessa lista (DEV_BOARD_LABELS in server.ts).
//
// Sono sei etichette per quattro famiglie di stato, quindi Comande e
// Prenotazioni condividono l'indaco: il nome è sempre stampato dentro il chip,
// così la collisione non rende niente ambiguo, e resta tutto dentro al sistema
// invece di pescare sky/violet/slate da fuori.
interface LabelMeta {
  key: DevBoardLabelKey;
  name: string;
  chipClass: string;
}

const LABELS: LabelMeta[] = [
  { key: 'comande',      name: 'Comande',      chipClass: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]' },
  { key: 'prenotazioni', name: 'Prenotazioni', chipClass: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]' },
  { key: 'pagamenti',    name: 'Pagamenti',    chipClass: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]' },
  { key: 'stampa',       name: 'Stampa',       chipClass: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]' },
  { key: 'bug',          name: 'Bug',          chipClass: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]' },
  { key: 'infra',        name: 'Infra',        chipClass: 'bg-[var(--ds-border)] text-[var(--ds-text-secondary)]' },
];

const labelMeta = (key: DevBoardLabelKey): LabelMeta | undefined => LABELS.find(l => l.key === key);

/* Stati del processo Claude sulla card, stesse famiglie di stato del resto
   della board: in coda chiede attesa (pending), in lavorazione è imminente
   (arriving), fatto è chiuso bene (seated), fallito chiede un'azione
   (critical). Il chip è l'action-strip della card: racconta a che punto è il
   processo senza aprire nulla. */
const CLAUDE_STATUS_META: Record<Exclude<DevBoardClaudeStatus, null>, { label: string; chipClass: string; dot: string; pulse?: boolean }> = {
  queued:  { label: 'In coda',          chipClass: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]', dot: 'bg-[var(--ds-pending-solid)]' },
  running: { label: 'Claude ci lavora', chipClass: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]', dot: 'bg-[var(--ds-arriving-solid)]', pulse: true },
  done:    { label: 'Fatto da Claude',  chipClass: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]', dot: 'bg-[var(--ds-seated-solid)]' },
  failed:  { label: 'Errore',           chipClass: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]', dot: 'bg-[var(--ds-critical-solid)]' },
};

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

  // --- Claude -------------------------------------------------------------

  const [busyClaudeId, setBusyClaudeId] = useState<number | null>(null);

  /** Approva per Claude: il processo parte subito (dispatch del workflow);
   *  gli stati successivi arrivano dal callback via socket. */
  const approveForClaude = async (card: DevBoardCard) => {
    if (busyClaudeId != null) return;
    setBusyClaudeId(card.id);
    try {
      const updated = await approveDevBoardCardForClaude(card.id);
      setCards(prev => prev.map(c => c.id === updated.id ? updated : c));
    } catch (err: any) {
      setError(err?.message || 'Errore avvio Claude');
    } finally {
      setBusyClaudeId(null);
    }
  };

  const resetClaude = async (card: DevBoardCard) => {
    if (busyClaudeId != null) return;
    setBusyClaudeId(card.id);
    try {
      const updated = await resetDevBoardCardClaude(card.id);
      setCards(prev => prev.map(c => c.id === updated.id ? updated : c));
    } catch (err: any) {
      setError(err?.message || 'Errore reset');
    } finally {
      setBusyClaudeId(null);
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
    <div className="flex h-full flex-col bg-[var(--ds-canvas)]">
      {/* Page header */}
      <div className="flex flex-shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-4 lg:px-6 lg:pt-6">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            Development
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
            Board di progetto · {totalCount} {totalCount === 1 ? 'card' : 'cards'} · visibile solo a questo account
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setIsLoading(true); load(); }}
          aria-label="Ricarica la board"
          title="Ricarica"
          className={dsIconButton}
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mx-4 mb-2 flex-shrink-0 lg:mx-6">
          <Callout
            tone="critical"
            action={
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Chiudi l'errore"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-[filter] hover:brightness-90"
              >
                <X className="h-4 w-4" />
              </button>
            }
          >
            {error}
          </Callout>
        </div>
      )}

      {/* Board */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-4 pb-4 sm:snap-none lg:gap-4 lg:px-6">
        {COLUMNS.map(col => {
          const columnCards = cardsByColumn.get(col.key) || [];
          const isDropTarget = dropHint?.column === col.key;
          const tone = COLUMN_TONE[col.tone];
          return (
            // La corsia è la superficie bianca e le card sono tessere sopra:
            // una corsia in grigio di secondo livello sulla tela misura circa
            // 1.03:1 e sparirebbe, lasciando cinque liste senza contorno.
            <div
              key={col.key}
              className={`flex min-h-0 w-[82vw] max-w-72 flex-none snap-center flex-col rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] transition-shadow sm:w-72 sm:max-w-none lg:w-80 ${
                isDropTarget ? 'ring-2 ring-[var(--ds-border-focus)]' : ''
              }`}
              onDragOver={(e) => { e.preventDefault(); setDropHint(prev => (prev?.column === col.key ? prev : { column: col.key, index: null })); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(col.key, dropHint?.column === col.key ? dropHint.index : null); }}
            >
              {/* Column header */}
              <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 flex-none rounded-full ${tone.dot}`} aria-hidden />
                  <span className={`truncate text-[14px] font-semibold ${tone.text}`} title={col.hint}>
                    {col.label}
                  </span>
                  <span className="text-[13px] font-medium tabular-nums text-[var(--ds-text-muted)]">
                    {columnCards.length}
                  </span>
                </div>
                <button
                  type="button"
                  title={`Aggiungi in ${col.label}`}
                  aria-label={`Aggiungi in ${col.label}`}
                  onClick={() => { setComposerColumn(col.key); setComposerTitle(''); }}
                  className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {/* Cards */}
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {isLoading && cards.length === 0 && (
                  <div className="flex items-center justify-center py-8 text-[var(--ds-text-subtle)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                )}
                {columnCards.map((card, i) => (
                  <React.Fragment key={card.id}>
                    {isDropTarget && dropHint?.index === i && draggingId !== card.id && (
                      <div className="mx-1 h-0.5 rounded bg-[var(--ds-border-focus)]" />
                    )}
                    <div
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(card.id)); setDraggingId(card.id); }}
                      onDragEnd={() => { setDraggingId(null); setDropHint(null); }}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropHint({ column: col.key, index: hoverIndex(e, i) }); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.key, hoverIndex(e, i)); }}
                      onClick={() => setEditDraft({ id: card.id, title: card.title, description: card.description || '', column_key: card.column_key, labels: card.labels ?? [] })}
                      className={`group cursor-pointer rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5 transition-colors hover:bg-[var(--ds-border)] ${
                        draggingId === card.id ? 'opacity-40' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <GripVertical className="mt-0.5 h-3.5 w-3.5 flex-none cursor-grab text-[var(--ds-text-subtle)] opacity-0 group-hover:opacity-100" aria-hidden />
                        <div className="min-w-0 flex-1">
                          {(card.labels?.length ?? 0) > 0 && (
                            <div className="mb-1.5 flex flex-wrap gap-1">
                              {card.labels.map(key => {
                                const meta = labelMeta(key);
                                return meta ? (
                                  <span key={key} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${meta.chipClass}`}>
                                    {meta.name}
                                  </span>
                                ) : null;
                              })}
                            </div>
                          )}
                          <p className="break-words text-[14px] font-medium leading-snug text-[var(--ds-text-primary)]">
                            {card.title}
                          </p>
                          {card.description && (
                            <p className="mt-1 line-clamp-3 whitespace-pre-line text-[13px] leading-snug text-[var(--ds-text-muted)]">
                              {card.description}
                            </p>
                          )}
                          {/* Non in maiuscolo: "05 ago" a 10px in capitali
                              perde la forma della parola e non guadagna nulla. */}
                          <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                            {formatCardDate(card.updated_at || card.created_at)}
                          </p>

                          {/* Action strip Claude: stato del processo + azioni.
                              stopPropagation ovunque — i click qui non devono
                              aprire il modal della card. */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {card.claude_status == null ? (
                              <button
                                type="button"
                                disabled={busyClaudeId === card.id}
                                onClick={(e) => { e.stopPropagation(); approveForClaude(card); }}
                                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3 text-[12px] font-semibold text-[var(--ds-action-fg)] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                              >
                                {busyClaudeId === card.id
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Bot className="h-3.5 w-3.5" aria-hidden />}
                                Approva per Claude
                              </button>
                            ) : (
                              <>
                                {(() => {
                                  const meta = CLAUDE_STATUS_META[card.claude_status];
                                  return (
                                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold leading-none ${meta.chipClass}`}>
                                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${meta.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                                      <Bot className="h-3 w-3" aria-hidden />
                                      {meta.label}
                                    </span>
                                  );
                                })()}
                                {card.claude_run_url && (card.claude_status === 'queued' || card.claude_status === 'running') && (
                                  <a
                                    href={card.claude_run_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface)]"
                                  >
                                    <ExternalLink className="h-3 w-3" aria-hidden /> Log
                                  </a>
                                )}
                                {card.claude_status === 'done' && card.claude_note?.includes('http') && (
                                  <a
                                    href={card.claude_note.slice(card.claude_note.indexOf('http')).split(/\s/)[0]}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[12px] font-semibold text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-seated-tint)]"
                                  >
                                    <ExternalLink className="h-3 w-3" aria-hidden /> Vedi PR
                                  </a>
                                )}
                                {(card.claude_status === 'failed' || card.claude_status === 'done') && (
                                  <button
                                    type="button"
                                    disabled={busyClaudeId === card.id}
                                    title={card.claude_status === 'failed' ? 'Riprova' : 'Rilancia'}
                                    onClick={(e) => { e.stopPropagation(); approveForClaude(card); }}
                                    className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface)] disabled:opacity-40"
                                  >
                                    {busyClaudeId === card.id
                                      ? <Loader2 className="h-3 w-3 animate-spin" />
                                      : <RotateCcw className="h-3 w-3" aria-hidden />}
                                    {card.claude_status === 'failed' ? 'Riprova' : 'Rilancia'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                          {card.claude_status === 'failed' && card.claude_note && (
                            <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--ds-critical-text)]">
                              {card.claude_note}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                ))}
                {isDropTarget && dropHint?.index != null && dropHint.index >= columnCards.length && columnCards.length > 0 && (
                  <div className="mx-1 h-0.5 rounded bg-[var(--ds-border-focus)]" />
                )}
                {!isLoading && columnCards.length === 0 && composerColumn !== col.key && (
                  <button
                    type="button"
                    onClick={() => { setComposerColumn(col.key); setComposerTitle(''); }}
                    className="w-full rounded-[14px] border border-dashed border-[var(--ds-border-strong)] px-3 py-4 text-[13px] text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]"
                  >
                    {col.hint} — aggiungi la prima card
                  </button>
                )}

                {/* Inline composer */}
                {composerColumn === col.key && (
                  <div className="space-y-2 rounded-[14px] bg-[var(--ds-surface-row)] p-2">
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
                      className="w-full resize-none rounded-[12px] bg-[var(--ds-surface)] px-3 py-2 text-[14px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={submitComposer}
                        disabled={!composerTitle.trim() || isComposerSaving}
                        className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-4 text-[14px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                      >
                        {isComposerSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Aggiungi
                      </button>
                      <button
                        type="button"
                        onClick={() => setComposerColumn(null)}
                        aria-label="Chiudi il compositore"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]"
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

      <ModalShell
        open={!!editDraft}
        onClose={() => setEditDraft(null)}
        title={editDraft?.id == null ? 'Nuova card' : 'Modifica card'}
        size="sm"
        closeOnEscape
        bodyClassName="space-y-4 p-5 sm:p-6"
        footerStart={
          editDraft?.id != null ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { const card = cards.find(c => c.id === editDraft.id); if (card) setDeleteCandidate(card); }}
                className="inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-[15px] font-medium text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Elimina
              </button>
              {(() => {
                // Sblocco per stati rimasti appesi (run cancellata a mano su
                // GitHub, callback perso): azzera il tracking, non il workflow.
                const card = cards.find(c => c.id === editDraft.id);
                return card?.claude_status ? (
                  <button
                    type="button"
                    onClick={() => { resetClaude(card); setEditDraft(null); }}
                    className="inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-[15px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden /> Azzera Claude
                  </button>
                ) : null;
              })()}
            </div>
          ) : undefined
        }
        footer={
          <button
            type="button"
            onClick={submitDraft}
            disabled={!editDraft?.title.trim() || isDraftSaving}
            className={dsButton.primary}
          >
            {isDraftSaving && <Loader2 className="h-4 w-4 animate-spin" />} Salva
          </button>
        }
      >
        {editDraft && (
          <>
            <Field label="Titolo" htmlFor="devcard-title" required>
              <input
                id="devcard-title"
                type="text"
                value={editDraft.title}
                onChange={(e) => setEditDraft(d => d ? { ...d, title: e.target.value } : d)}
                autoFocus
                className={dsInput}
              />
            </Field>
            <Field label="Descrizione" htmlFor="devcard-description" aside="opzionale">
              <textarea
                id="devcard-description"
                value={editDraft.description}
                onChange={(e) => setEditDraft(d => d ? { ...d, description: e.target.value } : d)}
                rows={4}
                placeholder="Dettagli, note, link…"
                className={`${dsTextarea} resize-y leading-relaxed`}
              />
            </Field>
            <Field label="Colonna">
              <div className="grid grid-cols-2 gap-2">
                {COLUMNS.map(col => {
                  const active = editDraft.column_key === col.key;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => setEditDraft(d => d ? { ...d, column_key: col.key } : d)}
                      aria-pressed={active}
                      className={`flex h-11 items-center gap-2 rounded-full px-3 text-[14px] font-medium transition-colors ${
                        active
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                      }`}
                    >
                      <span className={`h-2 w-2 flex-none rounded-full ${COLUMN_TONE[col.tone].dot}`} aria-hidden />
                      <span className="truncate">{col.label}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Etichette">
              <div className="flex flex-wrap gap-2">
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
                      aria-pressed={active}
                      // Selezionata = anello. Prima le non selezionate stavano
                      // al 45% di opacità, che portava il testo del chip sotto
                      // il minimo di contrasto per leggere quello che offre.
                      className={`inline-flex h-11 items-center rounded-full px-4 text-[14px] font-semibold transition-shadow ${l.chipClass} ${
                        active ? 'ring-2 ring-[var(--ds-text-primary)]' : ''
                      }`}
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
        )}
      </ModalShell>

      <ModalShell
        open={!!deleteCandidate}
        onClose={() => setDeleteCandidate(null)}
        title="Elimina card"
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
        footer={
          <button
            type="button"
            onClick={confirmDelete}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--ds-critical-solid)] px-5 text-[15px] font-semibold text-[var(--ds-critical-fg)] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Trash2 className="h-4 w-4" aria-hidden /> Elimina
          </button>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-primary)]">
          Eliminare la card <strong className="font-semibold">{deleteCandidate?.title}</strong>?
        </p>
      </ModalShell>
    </div>
  );
};
