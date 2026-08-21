import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X, Trash2, Loader2, RefreshCw, Bot, Check, Undo2, Sparkles } from 'lucide-react';
import {
  RoadmapTask, RoadmapPhaseKey, RoadmapTaskStatus,
  getRoadmapTasks, createRoadmapTask, updateRoadmapTask, deleteRoadmapTask,
} from '../services/roadmapApiService';
import { socketClient } from '../services/socketClient';
import {
  ModalShell, Field, Callout, dsInput, dsTextarea, dsButton, dsIconButton,
} from './ds';

/* Una roadmap è una sequenza, non una board: le fasi stanno in colonna nell'
   ordine in cui vanno eseguite, ognuna col proprio trigger dichiarato — la
   posizione È l'informazione, come sulla one-page del dossier naming. */
interface PhaseMeta {
  key: RoadmapPhaseKey;
  label: string;
  trigger: string;
}

const PHASES: PhaseMeta[] = [
  { key: 'domini',   label: 'Domini e handle',   trigger: 'Adesso — l’unica voce non rinviabile (~€150/anno)' },
  { key: 'legale',   label: 'Parere marchi',     trigger: 'Prima di spendere in branding (€300–600)' },
  { key: 'euipo',    label: 'Deposito EUIPO',    trigger: 'Al lancio pubblico — UE è first-to-file (~€850)' },
  { key: 'branding', label: 'Branding e tecnica', trigger: 'Col prodotto — in coda alla ristrutturazione multi-tenant' },
];

/* Stessa logica famiglie-di-stato del dev board: in coda per Claude chiede
   attesa (pending), in lavorazione è imminente (arriving), fatto è chiuso
   bene (seated), da fare resta neutro. */
const STATUS_META: Record<RoadmapTaskStatus, { label: string; chipClass: string; dot: string }> = {
  todo:        { label: 'Da fare',          chipClass: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]', dot: 'bg-[var(--ds-text-muted)]' },
  queued:      { label: 'In coda per Claude', chipClass: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]', dot: 'bg-[var(--ds-pending-solid)]' },
  in_progress: { label: 'Claude ci lavora',   chipClass: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]', dot: 'bg-[var(--ds-arriving-solid)]' },
  done:        { label: 'Fatto',            chipClass: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]', dot: 'bg-[var(--ds-seated-solid)]' },
};

interface EditDraft {
  id: number | null; // null = nuovo task
  title: string;
  description: string;
  phase_key: RoadmapPhaseKey;
  claude_prompt: string;
  result_note: string;
}

export const RoadmapPage: React.FC = () => {
  const [tasks, setTasks] = useState<RoadmapTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);

  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [isDraftSaving, setIsDraftSaving] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<RoadmapTask | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getRoadmapTasks();
      setTasks(data);
    } catch (err: any) {
      setError(err?.message || 'Errore caricamento roadmap');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: quando Claude (via scripts/roadmap.mjs) o un altro device muove
  // un task, la pagina si riallinea da sola.
  useEffect(() => {
    const attach = () => {
      const socket = socketClient.getSocket();
      if (!socket) return () => {};
      const onChanged = () => { load(); };
      socket.on('roadmap:changed', onChanged);
      return () => { socket.off('roadmap:changed', onChanged); };
    };
    let detach = attach();
    const unsubscribe = socketClient.onSocketChange(() => {
      detach();
      detach = attach();
    });
    return () => { detach(); unsubscribe(); };
  }, [load]);

  const tasksByPhase = useMemo(() => {
    const map = new Map<RoadmapPhaseKey, RoadmapTask[]>();
    PHASES.forEach(p => map.set(p.key, []));
    [...tasks]
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .forEach(t => { map.get(t.phase_key)?.push(t); });
    return map;
  }, [tasks]);

  const doneCount = tasks.filter(t => t.status === 'done').length;
  const queuedCount = tasks.filter(t => t.status === 'queued' || t.status === 'in_progress').length;

  const setStatus = async (task: RoadmapTask, status: RoadmapTaskStatus) => {
    if (busyTaskId != null) return;
    setBusyTaskId(task.id);
    // Ottimista: la transizione è visibile subito, il server conferma.
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
    try {
      const updated = await updateRoadmapTask(task.id, { status });
      setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
    } catch (err: any) {
      setError(err?.message || 'Errore aggiornamento');
      load();
    } finally {
      setBusyTaskId(null);
    }
  };

  const submitDraft = async () => {
    if (!editDraft || isDraftSaving) return;
    const title = editDraft.title.trim();
    if (!title) return;
    setIsDraftSaving(true);
    try {
      if (editDraft.id == null) {
        const created = await createRoadmapTask({
          title,
          description: editDraft.description.trim() || null,
          phase_key: editDraft.phase_key,
          claude_prompt: editDraft.claude_prompt.trim() || null,
        });
        setTasks(prev => [...prev, created]);
      } else {
        const updated = await updateRoadmapTask(editDraft.id, {
          title,
          description: editDraft.description.trim() || null,
          phase_key: editDraft.phase_key,
          claude_prompt: editDraft.claude_prompt.trim() || null,
          result_note: editDraft.result_note.trim() || null,
        });
        setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
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
    const task = deleteCandidate;
    setDeleteCandidate(null);
    setEditDraft(null);
    setTasks(prev => prev.filter(t => t.id !== task.id));
    try {
      await deleteRoadmapTask(task.id);
    } catch (err: any) {
      setError(err?.message || 'Errore eliminazione');
      load();
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--ds-canvas)]">
      {/* Header pagina */}
      <div className="flex flex-shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-4 lg:px-6 lg:pt-6">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            Roadmap
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
            Lancio Sympotia · {doneCount}/{tasks.length} fatti
            {queuedCount > 0 && <> · {queuedCount} in mano a Claude</>}
            {' '}· visibile solo a questo account
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setIsLoading(true); load(); }}
          aria-label="Ricarica la roadmap"
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

      {/* Fasi in sequenza */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-6 lg:px-6">
        {isLoading && tasks.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[var(--ds-text-subtle)]">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {PHASES.map((phase, phaseIndex) => {
          const phaseTasks = tasksByPhase.get(phase.key) || [];
          const phaseDone = phaseTasks.filter(t => t.status === 'done').length;
          const complete = phaseTasks.length > 0 && phaseDone === phaseTasks.length;
          return (
            <section
              key={phase.key}
              className="mx-auto w-full max-w-3xl rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]"
            >
              {/* Header fase: il numero d'ordine è informazione vera (le fasi
                  vanno in sequenza), non decorazione. */}
              <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4 sm:px-5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[12px] font-bold ${
                      complete
                        ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
                    }`}
                    aria-hidden
                  >
                    {complete ? <Check className="h-3.5 w-3.5" /> : phaseIndex + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                      {phase.label}
                    </h3>
                    <p className="truncate text-[12px] text-[var(--ds-text-muted)]">{phase.trigger}</p>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  <span className="text-[13px] font-medium tabular-nums text-[var(--ds-text-muted)]">
                    {phaseDone}/{phaseTasks.length}
                  </span>
                  <button
                    type="button"
                    title={`Aggiungi task in ${phase.label}`}
                    aria-label={`Aggiungi task in ${phase.label}`}
                    onClick={() => setEditDraft({ id: null, title: '', description: '', phase_key: phase.key, claude_prompt: '', result_note: '' })}
                    className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Task */}
              <div className="space-y-1.5 px-3 pb-3 pt-1 sm:px-4">
                {phaseTasks.map(task => {
                  const meta = STATUS_META[task.status];
                  const isClaudeTask = !!task.claude_prompt;
                  const isBusy = busyTaskId === task.id;
                  return (
                    <div
                      key={task.id}
                      className="group rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5 transition-colors hover:bg-[var(--ds-border)]"
                    >
                      <div className="flex items-start gap-2.5">
                        {/* Toggle fatto: per i task manuali è l'azione primaria;
                            per i task Claude serve da chiusura/riapertura a mano. */}
                        <button
                          type="button"
                          disabled={isBusy}
                          aria-label={task.status === 'done' ? 'Riapri il task' : 'Segna come fatto'}
                          title={task.status === 'done' ? 'Riapri' : 'Segna fatto'}
                          onClick={() => setStatus(task, task.status === 'done' ? 'todo' : 'done')}
                          className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border transition-colors ${
                            task.status === 'done'
                              ? 'border-transparent bg-[var(--ds-seated-solid)] text-white'
                              : 'border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-transparent hover:border-[var(--ds-text-muted)]'
                          }`}
                        >
                          <Check className="h-3 w-3" />
                        </button>

                        <div
                          className="min-w-0 flex-1 cursor-pointer"
                          onClick={() => setEditDraft({
                            id: task.id,
                            title: task.title,
                            description: task.description || '',
                            phase_key: task.phase_key,
                            claude_prompt: task.claude_prompt || '',
                            result_note: task.result_note || '',
                          })}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <p className={`break-words text-[14px] font-medium leading-snug ${
                              task.status === 'done' ? 'text-[var(--ds-text-muted)] line-through' : 'text-[var(--ds-text-primary)]'
                            }`}>
                              {task.title}
                            </p>
                            {isClaudeTask && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-border)] px-2 py-0.5 text-[11px] font-semibold leading-none text-[var(--ds-text-secondary)]">
                                <Bot className="h-3 w-3" aria-hidden /> Claude
                              </span>
                            )}
                            {task.status !== 'todo' && task.status !== 'done' && (
                              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none ${meta.chipClass}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${task.status === 'in_progress' ? 'animate-pulse' : ''}`} aria-hidden />
                                {meta.label}
                              </span>
                            )}
                          </div>
                          {task.description && task.status !== 'done' && (
                            <p className="mt-1 line-clamp-2 whitespace-pre-line text-[13px] leading-snug text-[var(--ds-text-muted)]">
                              {task.description}
                            </p>
                          )}
                          {task.result_note && (
                            <p className="mt-1 line-clamp-2 whitespace-pre-line text-[13px] leading-snug text-[var(--ds-seated-text)]">
                              <Sparkles className="mr-1 inline h-3 w-3" aria-hidden />
                              {task.result_note}
                            </p>
                          )}
                        </div>

                        {/* Azione Claude: approva/ritira dalla coda */}
                        {isClaudeTask && task.status === 'todo' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setStatus(task, 'queued')}
                            className="inline-flex h-9 flex-none items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
                          >
                            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" aria-hidden />}
                            Approva per Claude
                          </button>
                        )}
                        {isClaudeTask && task.status === 'queued' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            title="Ritira dalla coda"
                            onClick={() => setStatus(task, 'todo')}
                            className="inline-flex h-9 flex-none items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface)] disabled:opacity-40"
                          >
                            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Ritira
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!isLoading && phaseTasks.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setEditDraft({ id: null, title: '', description: '', phase_key: phase.key, claude_prompt: '', result_note: '' })}
                    className="w-full rounded-[14px] border border-dashed border-[var(--ds-border-strong)] px-3 py-4 text-[13px] text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]"
                  >
                    Nessun task — aggiungi il primo
                  </button>
                )}
              </div>
            </section>
          );
        })}

        {/* Come funziona la coda Claude */}
        <div className="mx-auto w-full max-w-3xl px-1 pb-2">
          <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
            I task con etichetta <strong className="font-semibold">Claude</strong> hanno un prompt pronto: «Approva per
            Claude» li mette in coda; in una sessione Claude Code basta chiedere di eseguire la roadmap
            (<code className="rounded bg-[var(--ds-surface-row)] px-1">node scripts/roadmap.mjs list</code>) e Claude li
            prende in carico, li lavora e chiude qui con l'esito.
          </p>
        </div>
      </div>

      <ModalShell
        open={!!editDraft}
        onClose={() => setEditDraft(null)}
        title={editDraft?.id == null ? 'Nuovo task' : 'Modifica task'}
        size="sm"
        closeOnEscape
        bodyClassName="space-y-4 p-5 sm:p-6"
        footerStart={
          editDraft?.id != null ? (
            <button
              type="button"
              onClick={() => { const task = tasks.find(t => t.id === editDraft.id); if (task) setDeleteCandidate(task); }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-[15px] font-medium text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Elimina
            </button>
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
            <Field label="Titolo" htmlFor="roadmap-title" required>
              <input
                id="roadmap-title"
                type="text"
                value={editDraft.title}
                onChange={(e) => setEditDraft(d => d ? { ...d, title: e.target.value } : d)}
                autoFocus
                className={dsInput}
              />
            </Field>
            <Field label="Descrizione" htmlFor="roadmap-description" aside="opzionale">
              <textarea
                id="roadmap-description"
                value={editDraft.description}
                onChange={(e) => setEditDraft(d => d ? { ...d, description: e.target.value } : d)}
                rows={3}
                placeholder="Dettagli, costi, note…"
                className={`${dsTextarea} resize-y leading-relaxed`}
              />
            </Field>
            <Field label="Fase">
              <div className="grid grid-cols-2 gap-2">
                {PHASES.map(p => {
                  const active = editDraft.phase_key === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setEditDraft(d => d ? { ...d, phase_key: p.key } : d)}
                      aria-pressed={active}
                      className={`flex h-11 items-center justify-center rounded-full px-3 text-[14px] font-medium transition-colors ${
                        active
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                      }`}
                    >
                      <span className="truncate">{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field
              label="Prompt per Claude"
              htmlFor="roadmap-prompt"
              aside="vuoto = task manuale"
            >
              <textarea
                id="roadmap-prompt"
                value={editDraft.claude_prompt}
                onChange={(e) => setEditDraft(d => d ? { ...d, claude_prompt: e.target.value } : d)}
                rows={3}
                placeholder="Cosa deve fare Claude quando prende in carico questo task…"
                className={`${dsTextarea} resize-y leading-relaxed`}
              />
            </Field>
            {editDraft.id != null && editDraft.result_note && (
              <Field label="Esito" htmlFor="roadmap-note">
                <textarea
                  id="roadmap-note"
                  value={editDraft.result_note}
                  onChange={(e) => setEditDraft(d => d ? { ...d, result_note: e.target.value } : d)}
                  rows={2}
                  className={`${dsTextarea} resize-y leading-relaxed`}
                />
              </Field>
            )}
          </>
        )}
      </ModalShell>

      <ModalShell
        open={!!deleteCandidate}
        onClose={() => setDeleteCandidate(null)}
        title="Elimina task"
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
          Eliminare il task <strong className="font-semibold">{deleteCandidate?.title}</strong>?
        </p>
      </ModalShell>
    </div>
  );
};
