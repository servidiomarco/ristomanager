import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ListChecks, Plus, Trash2 } from 'lucide-react';
import { Callout, EmptyState, SectionHeader, dsButton, dsInput, dsSelect } from './ds';
import { Loader } from './Loader';
import { platformCrmApi, type CrmTask } from '../services/platformCrmApiService';
import { addDaysIso, dueLabel, formatInstant, todayRome, type ShowToast } from './PlatformCrmShared';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, Promemoria
   ============================================
   Tutti i «richiamare giovedì» in un posto: in ritardo, oggi, la settimana,
   più avanti. Una riga si spunta dal quadrato e si modifica toccandola
   (data, priorità, testo); la data si sposta anche con «domani» e «+7 g»,
   il rinvio più comune. */

export const TaskCheck: React.FC<{ done: boolean; label: string; onToggle: () => void; disabled?: boolean }> = ({ done, label, onToggle, disabled }) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={disabled}
    aria-label={done ? `Riapri: ${label}` : `Fatto: ${label}`}
    aria-pressed={done}
    className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50"
  >
    <span className={`inline-flex h-5 w-5 items-center justify-center rounded-[var(--ds-radius-sm)] ring-1 ring-inset ${done ? 'bg-[var(--ds-seated-solid)] text-[var(--ds-seated-fg)] ring-[var(--ds-seated-solid)]' : 'ring-[var(--ds-border-strong)]'}`}>
      {done && <Check className="h-3.5 w-3.5" aria-hidden />}
    </span>
  </button>
);

/** Riga di un promemoria, aperta in modifica al tocco. Usata anche nella
 *  scheda dell'azienda (senza il nome dell'azienda). */
export const TaskRow: React.FC<{
  task: CrmTask;
  showAccount?: boolean;
  onOpenAccount?: (id: number) => void;
  onChanged: (task: CrmTask | null, removedId?: number) => void;
  showToast: ShowToast;
}> = ({ task, showAccount = true, onOpenAccount, onChanged, showToast }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: task.title, due_date: task.due_date, priority: task.priority });
  const [busy, setBusy] = useState(false);
  const [armDelete, setArmDelete] = useState(false);
  const today = todayRome();
  const late = !task.done && task.due_date < today;

  useEffect(() => {
    if (open) setDraft({ title: task.title, due_date: task.due_date, priority: task.priority });
    setArmDelete(false);
  }, [open, task]);

  const patch = async (body: Partial<Pick<CrmTask, 'title' | 'due_date' | 'priority' | 'done'>>, close = true) => {
    setBusy(true);
    try {
      onChanged(await platformCrmApi.updateTask(task.id, body));
      if (close) setOpen(false);
    } catch (err) {
      showToast((err as ApiError).message || 'Promemoria non aggiornato', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!armDelete) { setArmDelete(true); return; }
    setBusy(true);
    try {
      await platformCrmApi.deleteTask(task.id);
      onChanged(null, task.id);
    } catch (err) {
      showToast((err as ApiError).message || 'Eliminazione non riuscita', 'error');
      setBusy(false);
    }
  };

  return (
    <li className="py-0.5">
      <div className="flex items-center gap-1">
        <TaskCheck done={task.done} label={task.title} onToggle={() => patch({ done: !task.done }, false)} disabled={busy} />
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center py-1 pr-2 text-left"
        >
          <span className={`truncate text-[15px] ${task.done ? 'text-[var(--ds-text-muted)] line-through' : 'text-[var(--ds-text-primary)]'}`}>
            {task.priority === 'alta' && !task.done && <span className="mr-1 font-semibold text-[var(--ds-critical-text)]" aria-label="priorità alta">!</span>}
            {task.title}
          </span>
          <span className="truncate text-[12px] text-[var(--ds-text-muted)]">
            {task.done
              ? `fatto ${formatInstant(task.done_at)}`
              : <span className={late ? 'font-medium text-[var(--ds-critical-text)]' : ''}>{dueLabel(task.due_date)}</span>}
            {showAccount && task.account_name ? ` · ${task.account_name}` : ''}
          </span>
        </button>
        {showAccount && task.account_id && onOpenAccount && (
          <button
            type="button"
            onClick={() => onOpenAccount(task.account_id!)}
            className="hidden h-9 flex-shrink-0 items-center rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] sm:inline-flex"
          >
            Scheda
          </button>
        )}
      </div>
      {open && (
        <div className="mb-2 ml-11 space-y-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
          <input
            className={`${dsInput} bg-[var(--ds-surface)]`}
            value={draft.title}
            aria-label="Cosa fare"
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              className={`${dsInput} w-auto bg-[var(--ds-surface)]`}
              value={draft.due_date}
              aria-label="Scadenza"
              onChange={e => setDraft(d => ({ ...d, due_date: e.target.value }))}
            />
            <button type="button" className={`${dsButton.secondary} h-10 px-3 text-[13px]`} onClick={() => setDraft(d => ({ ...d, due_date: addDaysIso(today, 1) }))}>domani</button>
            <button type="button" className={`${dsButton.secondary} h-10 px-3 text-[13px]`} onClick={() => setDraft(d => ({ ...d, due_date: addDaysIso(d.due_date < today ? today : d.due_date, 7) }))}>+7 g</button>
            <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-[14px] text-[var(--ds-text-primary)]">
              <input
                type="checkbox"
                checked={draft.priority === 'alta'}
                onChange={e => setDraft(d => ({ ...d, priority: e.target.checked ? 'alta' : 'normale' }))}
                className="h-4 w-4 accent-[var(--ds-action-bg)]"
              />
              Priorità alta
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" className={armDelete ? dsButton.critical : dsButton.quiet} onClick={remove} disabled={busy} aria-label="Elimina promemoria">
              <Trash2 className="h-4 w-4" aria-hidden />{armDelete ? 'Conferma' : ''}
            </button>
            <span className="flex-1" />
            <button type="button" className={dsButton.secondary} onClick={() => setOpen(false)} disabled={busy}>Annulla</button>
            <button
              type="button"
              className={dsButton.primary}
              disabled={busy || !draft.title.trim() || !draft.due_date}
              onClick={() => patch({ title: draft.title.trim(), due_date: draft.due_date, priority: draft.priority })}
            >
              Salva
            </button>
          </div>
        </div>
      )}
    </li>
  );
};

/** Il campo per un promemoria nuovo: testo, data (domani di default) e,
 *  fuori dalla scheda, l'azienda. */
export const NewTaskForm: React.FC<{
  accountId?: number | null;
  accounts?: Array<{ id: number; name: string }>;
  onCreated: (task: CrmTask) => void;
  showToast: ShowToast;
}> = ({ accountId = null, accounts, onCreated, showToast }) => {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(() => addDaysIso(todayRome(), 1));
  const [account, setAccount] = useState('');
  const [high, setHigh] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !due || busy) return;
    setBusy(true);
    try {
      const task = await platformCrmApi.createTask({
        title: title.trim(),
        due_date: due,
        priority: high ? 'alta' : 'normale',
        account_id: accountId ?? (account ? Number(account) : null),
      });
      onCreated(task);
      setTitle('');
      setHigh(false);
    } catch (err) {
      showToast((err as ApiError).message || 'Promemoria non creato', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <input
          className={`${dsInput} min-w-0 flex-1`}
          value={title}
          placeholder="Nuovo promemoria…"
          aria-label="Nuovo promemoria"
          onChange={e => setTitle(e.target.value)}
        />
        <button type="submit" className={`${dsButton.primary} px-4`} disabled={!title.trim() || busy} aria-label="Aggiungi promemoria">
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {title.trim() && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className={`${dsInput} w-auto`} value={due} aria-label="Scadenza" onChange={e => setDue(e.target.value)} />
          {!accountId && accounts && (
            <select className={`${dsSelect} w-auto min-w-[180px] flex-1`} value={account} aria-label="Azienda" onChange={e => setAccount(e.target.value)}>
              <option value="">Senza azienda</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[14px] text-[var(--ds-text-primary)]">
            <input type="checkbox" checked={high} onChange={e => setHigh(e.target.checked)} className="h-4 w-4 accent-[var(--ds-action-bg)]" />
            Priorità alta
          </label>
        </div>
      )}
    </form>
  );
};

export const PlatformCrmTasks: React.FC<{
  accounts: Array<{ id: number; name: string }>;
  onOpenAccount: (id: number) => void;
  showToast: ShowToast;
}> = ({ accounts, onOpenAccount, showToast }) => {
  const [tasks, setTasks] = useState<CrmTask[] | null>(null);
  const [done, setDone] = useState<CrmTask[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTasks(await platformCrmApi.listTasks('open'));
    } catch (err) {
      setError((err as ApiError).message || 'Caricamento non riuscito');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (showDone && done === null) platformCrmApi.listTasks('done').then(setDone).catch(() => setDone([]));
  }, [showDone, done]);

  // Spuntato: esce dalle aperte e, se la lista dei fatti è aperta, ci entra.
  const changed = (task: CrmTask | null, removedId?: number) => {
    if (!task) {
      setTasks(ts => ts?.filter(t => t.id !== removedId) ?? null);
      setDone(ds => ds?.filter(t => t.id !== removedId) ?? null);
      return;
    }
    if (task.done) {
      setTasks(ts => ts?.filter(t => t.id !== task.id) ?? null);
      setDone(ds => (ds ? [task, ...ds.filter(t => t.id !== task.id)] : ds));
    } else {
      setDone(ds => ds?.filter(t => t.id !== task.id) ?? null);
      setTasks(ts => {
        const rest = (ts ?? []).filter(t => t.id !== task.id);
        return [...rest, task].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
      });
    }
  };

  const groups = useMemo(() => {
    const today = todayRome();
    const week = addDaysIso(today, 7);
    const list = tasks ?? [];
    return [
      { key: 'ritardo', label: 'In ritardo', tone: 'attention' as const, items: list.filter(t => t.due_date < today) },
      { key: 'oggi', label: 'Oggi', tone: 'pending' as const, items: list.filter(t => t.due_date === today) },
      { key: 'settimana', label: 'Prossimi 7 giorni', tone: 'info' as const, items: list.filter(t => t.due_date > today && t.due_date <= week) },
      { key: 'dopo', label: 'Più avanti', tone: 'muted' as const, items: list.filter(t => t.due_date > week) },
    ].filter(g => g.items.length > 0);
  }, [tasks]);

  return (
    <div className="space-y-4">
      <section className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
        <NewTaskForm accounts={accounts} onCreated={task => changed(task)} showToast={showToast} />
      </section>

      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
      {!tasks && !error && <div className="flex h-32 items-center justify-center"><Loader /></div>}
      {tasks && tasks.length === 0 && <EmptyState icon={ListChecks}>Nessun promemoria aperto.</EmptyState>}

      {groups.map(g => (
        <div key={g.key}>
          <SectionHeader tone={g.tone} meta={g.items.length}>{g.label}</SectionHeader>
          <ul className="divide-y divide-[var(--ds-border)] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-1 shadow-[var(--ds-shadow-card)]">
            {g.items.map(task => (
              <TaskRow key={task.id} task={task} onOpenAccount={onOpenAccount} onChanged={changed} showToast={showToast} />
            ))}
          </ul>
        </div>
      ))}

      <div>
        <SectionHeader tone="muted" onToggle={() => setShowDone(v => !v)} expanded={showDone}>Fatti di recente</SectionHeader>
        {showDone && (
          done === null ? <div className="flex h-20 items-center justify-center"><Loader /></div>
          : done.length === 0 ? <p className="px-1 text-[14px] text-[var(--ds-text-muted)]">Ancora niente.</p>
          : (
            <ul className="divide-y divide-[var(--ds-border)] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-1 shadow-[var(--ds-shadow-card)]">
              {done.map(task => (
                <TaskRow key={task.id} task={task} onOpenAccount={onOpenAccount} onChanged={changed} showToast={showToast} />
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
};

export default PlatformCrmTasks;
