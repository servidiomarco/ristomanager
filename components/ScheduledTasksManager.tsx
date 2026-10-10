import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Plus, Pencil, Trash2, Loader2, AlertCircle, Repeat, Calendar, Utensils, Clock } from 'lucide-react';
import {
  scheduledTasksApiService,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskFrequency,
  ScheduledTaskTeam,
  ScheduledTaskPriority,
  ScheduledTaskCategory,
} from '../services/scheduledTasksApiService';
import { useAuth } from '../contexts/AuthContext';
import { ModalShell, FormCard, Field, SegmentedControl, StatusPill, dsInput, dsSelect, dsTextarea, dsButton } from './ds';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { categoryLabel, priorityLabel } from './AttivitaPage';
import { TodoCategory, TodoPriority } from '../types';
import { weekdays } from './RemindersManager';
import { displayLocale } from '../utils/formatLocale';

/* Attività programmate: le attività che compaiono da sole in Attività, per
   una squadra. Erano tre righe fisse nel codice per ogni banchetto e il
   promemoria del pane; ora le crea, cambia ed elimina il ristorante. Il
   server (services/scheduledTasks.ts) le fa nascere al giorno e all'ora
   stabiliti, riempiendo i segnaposto del testo. */

type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const TEAMS: ScheduledTaskTeam[] = ['KITCHEN', 'OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'CASSA'];
const ROLE_LABELS_IT: Record<string, string> = {
  OWNER: 'Proprietario', GENERAL_MANAGER: 'General Manager', MANAGER: 'Manager',
  RECEPTION: 'Reception', WAITER: 'Cameriere', KITCHEN: 'Cucina', CASSA: 'Cassa',
};
const roleLabel = (r: string, t: TFunc): string => t(`common:role.${r}`, ROLE_LABELS_IT[r] ?? r);

const CATEGORIES: ScheduledTaskCategory[] = ['INVENTORY', 'GENERAL', 'EVENT', 'MAINTENANCE', 'STAFF', 'RESERVATION'];
const PRIORITIES: ScheduledTaskPriority[] = ['HIGH', 'MEDIUM', 'LOW'];

/* I segnaposto, nello stesso ordine in cui li spiega l'aiuto. {quantità}
   ha senso solo con una regola sui coperti, ma si scrive sempre uguale. */
const PLACEHOLDERS = ['{data}', '{coperti}', '{quantità}', '{banchetti}'] as const;
const PLACEHOLDER_RE = /(\{\s*(?:data|coperti|quantit[aà]|banchetti)\s*\})/gi;

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Stessa sostituzione del server, per l'anteprima nel modulo. */
const renderPreview = (tpl: string, vars: { data: string; coperti: number; banchetti: string; perUnit: number | null }): string =>
  tpl.replace(PLACEHOLDER_RE, m => {
    const k = m.replace(/[{}\s]/g, '').toLowerCase();
    if (k === 'data') {
      return new Date(`${vars.data}T00:00:00Z`).toLocaleDateString(displayLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    if (k === 'coperti') return String(vars.coperti);
    if (k === 'banchetti') return vars.banchetti;
    const per = vars.perUnit && vars.perUnit > 0 ? vars.perUnit : 1;
    return String(vars.coperti <= 0 ? 0 : Math.max(1, Math.ceil(vars.coperti / per)));
  });

/** Il titolo come l'ha scritto il ristorante, con i segnaposto in evidenza. */
const TemplateText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(PLACEHOLDER_RE).map((part, i) =>
      i % 2 === 1
        ? <span key={i} className="text-[var(--ds-arriving-text)]">{part}</span>
        : <React.Fragment key={i}>{part}</React.Fragment>
    )}
  </>
);

const scheduleLabel = (task: ScheduledTask, t: TFunc): string => {
  const ora = task.schedule_time;
  if (task.kind === 'BANQUET') {
    const giorni = task.days_before ?? 0;
    const base = giorni === 0
      ? t('attp.sameDayAs', 'Il giorno di ogni banchetto · {{ora}}', { ora })
      : t('attp.daysBefore', '{{count}} giorni prima di ogni banchetto · {{ora}}', { count: giorni, ora });
    return task.banquet_scope === 'CONFIRMED' ? `${base} · ${t('attp.onlyConfirmedShort', 'solo confermati')}` : base;
  }
  let base: string;
  if (task.kind === 'ONE_OFF') {
    const [y, m, d] = (task.schedule_date || '').split('-');
    base = `${d}/${m}/${y} · ${ora}`;
  } else if (task.frequency === 'WEEKLY') {
    const nomi = weekdays();
    base = `${(task.weekdays || []).map(c => nomi.find(w => w.code === c)?.short || c).join(', ')} · ${ora}`;
  } else if (task.frequency === 'MONTHLY') {
    base = t('attp.everyMonth', 'Ogni mese il {{giorno}} · {{ora}}', { giorno: task.month_day, ora });
  } else {
    base = t('attp.everyDay', 'Ogni giorno · {{ora}}', { ora });
  }
  if (task.due_in_days === 1) return `${base} · ${t('attp.dueNextDayShort', 'scade il giorno dopo')}`;
  if (task.due_in_days > 1) return `${base} · ${t('attp.dueAfterShort', 'scade dopo {{count}} giorni', { count: task.due_in_days })}`;
  return base;
};

const blankInput = (): ScheduledTaskInput => ({
  title: '',
  description: null,
  kind: 'BANQUET',
  days_before: 2,
  banquet_scope: 'ALL',
  frequency: 'DAILY',
  weekdays: ['MON'],
  month_day: 1,
  schedule_date: todayIso(),
  schedule_time: '09:00',
  due_in_days: 0,
  covers_per_unit: null,
  assigned_team: 'KITCHEN',
  priority: 'MEDIUM',
  category: 'INVENTORY',
  active: true,
});

const taskToInput = (task: ScheduledTask): ScheduledTaskInput => ({
  title: task.title,
  description: task.description,
  kind: task.kind,
  days_before: task.days_before ?? 2,
  banquet_scope: task.banquet_scope,
  frequency: task.frequency ?? 'DAILY',
  weekdays: task.weekdays?.length ? task.weekdays : ['MON'],
  month_day: task.month_day ?? 1,
  schedule_date: task.schedule_date ?? todayIso(),
  schedule_time: task.schedule_time,
  due_in_days: task.due_in_days ?? 0,
  covers_per_unit: task.covers_per_unit,
  assigned_team: task.assigned_team,
  priority: task.priority,
  category: task.category,
  active: task.active,
});

/** Il modulo tiene tutti i campi; al server vanno solo quelli del tipo scelto. */
const toPayload = (f: ScheduledTaskInput): ScheduledTaskInput => ({
  ...f,
  title: f.title.trim(),
  description: f.description?.trim() || null,
  days_before: f.kind === 'BANQUET' ? f.days_before : null,
  frequency: f.kind === 'RECURRING' ? f.frequency : null,
  weekdays: f.kind === 'RECURRING' && f.frequency === 'WEEKLY' ? f.weekdays : null,
  month_day: f.kind === 'RECURRING' && f.frequency === 'MONTHLY' ? f.month_day : null,
  schedule_date: f.kind === 'ONE_OFF' ? f.schedule_date : null,
  due_in_days: f.kind === 'BANQUET' ? 0 : f.due_in_days,
});

const Chip: React.FC<{ active: boolean; onClick: () => void; title?: string; children: React.ReactNode }> = ({ active, onClick, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={title}
    className={`inline-flex h-11 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
      active
        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
    }`}
  >
    {children}
  </button>
);

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export const ScheduledTasksManager: React.FC<Props> = ({ showToast }) => {
  const { t: tRaw, i18n } = useTranslation(['impostazioni', 'common'], { useSuspense: false });
  const { t: tA } = useTranslation('attivita', { useSuspense: false });
  const t = tRaw as unknown as TFunc;
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const giorni = useMemo(() => weekdays(), [i18n.language]);

  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ScheduledTaskInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ScheduledTask | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // Dove va il segnaposto toccato: nel campo usato per ultimo, al cursore.
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'title' | 'description'>('title');

  const load = useCallback(async () => {
    setError(null);
    try {
      const { tasks } = await scheduledTasksApiService.list();
      setItems(tasks);
    } catch (err: any) {
      setError(err?.message || t('attp.errLoad', 'Errore nel caricare le attività programmate'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setSaveError(null); setEditingId(null); setForm(blankInput()); };
  const openEdit = (task: ScheduledTask) => { setSaveError(null); setEditingId(task.id); setForm(taskToInput(task)); };
  const closeEditor = () => { if (!saving) { setForm(null); setEditingId(null); } };

  const insertPlaceholder = (token: string) => {
    if (!form) return;
    const field = lastField.current;
    const el = field === 'title' ? titleRef.current : descRef.current;
    const current = field === 'title' ? form.title : (form.description || '');
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    setForm(field === 'title' ? { ...form, title: next.slice(0, 200) } : { ...form, description: next.slice(0, 1000) });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = toPayload(form);
      if (editingId) {
        const saved = await scheduledTasksApiService.update(editingId, payload);
        setItems(prev => prev.map(x => (x.id === saved.id ? saved : x)));
        showToast(t('attp.updated', 'Attività programmata aggiornata'), 'success');
      } else {
        const created = await scheduledTasksApiService.create(payload);
        setItems(prev => [created, ...prev]);
        showToast(t('attp.created', 'Attività programmata creata'), 'success');
      }
      setForm(null);
      setEditingId(null);
    } catch (err: any) {
      setSaveError(err?.message || t('attp.errSave', 'Salvataggio non riuscito'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    setTogglingId(task.id);
    try {
      const saved = await scheduledTasksApiService.update(task.id, toPayload({ ...taskToInput(task), active: !task.active }));
      setItems(prev => prev.map(x => (x.id === saved.id ? saved : x)));
    } catch (err: any) {
      showToast(err?.message || t('attp.errSave', 'Salvataggio non riuscito'), 'error');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!toDelete) return;
    const task = toDelete;
    setToDelete(null);
    try {
      await scheduledTasksApiService.delete(task.id);
      setItems(prev => prev.filter(x => x.id !== task.id));
      showToast(t('attp.deleted', 'Attività programmata eliminata'), 'info');
    } catch (err: any) {
      showToast(err?.message || t('attp.errDelete', 'Eliminazione non riuscita'), 'error');
    }
  };

  const sorted = useMemo(() => [...items].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if ((a.kind === 'BANQUET') !== (b.kind === 'BANQUET')) return a.kind === 'BANQUET' ? -1 : 1;
    if (a.kind === 'BANQUET' && b.kind === 'BANQUET') return (b.days_before ?? 0) - (a.days_before ?? 0);
    return a.schedule_time.localeCompare(b.schedule_time);
  }), [items]);

  const canSave = !!form
    && form.title.trim().length > 0
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.schedule_time)
    && (form.kind !== 'BANQUET' || (Number.isInteger(form.days_before) && (form.days_before ?? -1) >= 0 && (form.days_before ?? 99) <= 60))
    && (form.kind !== 'ONE_OFF' || !!form.schedule_date)
    && (form.kind !== 'RECURRING' || form.frequency !== 'WEEKLY' || (form.weekdays?.length ?? 0) > 0)
    && !saving;

  // Anteprima con un esempio: il primo banchetto «tipo» o la data in cui
  // l'attività scadrebbe oggi.
  const preview = form ? (() => {
    const data = form.kind === 'BANQUET'
      ? addDays(todayIso(), form.days_before ?? 0)
      : addDays(form.kind === 'ONE_OFF' && form.schedule_date ? form.schedule_date : todayIso(), form.due_in_days);
    const vars = { data, coperti: 40, banchetti: t('attp.exampleBanquet', 'Matrimonio Rossi'), perUnit: form.covers_per_unit };
    return renderPreview(form.title || t('attp.titlePlaceholder', 'Es. Ordinare merce per i banchetti del {data}'), vars);
  })() : '';

  const kindIcon = (k: ScheduledTaskKind) => (k === 'BANQUET' ? Utensils : k === 'RECURRING' ? Repeat : Calendar);

  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--ds-border)] p-3 sm:p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]">
            <CalendarClock className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('attp.title', 'Attività programmate')}</h2>
            <p className="text-[13px] leading-snug text-[var(--ds-text-muted)]">
              {t('attp.subtitle', 'Compaiono da sole in Attività, al giorno e all\'ora stabiliti, e avvisano la squadra.')}
            </p>
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={openNew}
            className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] px-3 text-[13px] font-semibold text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Plus className="h-4 w-4" />
            {t('attp.new', 'Nuova')}
          </button>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-1.5 rounded-[var(--ds-radius-sm)] bg-[var(--ds-critical-tint)] p-3 text-[13px] text-[var(--ds-critical-text)]">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[13px] text-[var(--ds-text-muted)]">{t('attp.loading', 'Carico…')}</div>
      ) : sorted.length === 0 ? (
        <div className="p-10 text-center text-[13px] text-[var(--ds-text-muted)]">{t('attp.empty', 'Nessuna attività programmata.')}</div>
      ) : (
        <ul className="divide-y divide-[var(--ds-border)]">
          {sorted.map(task => {
            const KindIcon = kindIcon(task.kind);
            return (
              <li key={task.id} className="p-3 sm:p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className={`min-w-0 flex-1 ${task.active ? '' : 'opacity-60'}`}>
                    <p className="text-[14px] font-semibold text-[var(--ds-text-primary)] [overflow-wrap:anywhere]">
                      <TemplateText text={task.title} />
                    </p>
                    <p className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
                      <KindIcon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                      {scheduleLabel(task, t)}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusPill>{roleLabel(task.assigned_team, t)}</StatusPill>
                      {task.priority !== 'LOW' && (
                        <StatusPill tone={task.priority === 'HIGH' ? 'critical' : 'pending'}>
                          {priorityLabel(task.priority as TodoPriority, tA as any)}
                        </StatusPill>
                      )}
                      <StatusPill>{categoryLabel(task.category as TodoCategory, tA as any)}</StatusPill>
                      {!task.active && <StatusPill>{t('attp.off', 'Spenta')}</StatusPill>}
                    </div>
                    {task.last_run_at && (
                      <p className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-[var(--ds-text-subtle)]">
                        <Clock className="h-3 w-3" aria-hidden />
                        {t('attp.lastRun', 'Ultima volta: {{quando}}', {
                          quando: new Date(task.last_run_at).toLocaleString(displayLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
                        })}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {/* Interruttore: la forma è il gesto, per questo è
                          tondo (vedi le regole dei raggi in CLAUDE.md). */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={task.active}
                        aria-label={task.active ? t('attp.switchOff', 'Spegni') : t('attp.switchOn', 'Accendi')}
                        title={task.active ? t('attp.switchOff', 'Spegni') : t('attp.switchOn', 'Accendi')}
                        disabled={togglingId === task.id}
                        onClick={() => handleToggle(task)}
                        className="inline-flex h-11 w-12 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[var(--ds-radius-control)] disabled:opacity-50"
                      >
                        <span className={`relative inline-flex h-6 w-10 rounded-full transition-colors ${task.active ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-border-strong)]'}`}>
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] transition-[left] ${task.active ? 'left-[18px]' : 'left-0.5'}`} />
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(task)}
                        aria-label={t('attp.edit', 'Modifica')}
                        title={t('attp.edit', 'Modifica')}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setToDelete(task)}
                        aria-label={t('attp.delete', 'Elimina')}
                        title={t('attp.delete', 'Elimina')}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <ModalShell
          open
          onClose={closeEditor}
          title={editingId ? t('attp.editTitle', 'Modifica attività programmata') : t('attp.newTitle', 'Nuova attività programmata')}
          size="lg"
          bodyClassName="p-4 sm:p-6"
          footerNote={saveError ? (
            <span className="inline-flex items-start gap-1.5 text-[13px] text-[var(--ds-critical-text)]">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {saveError}
            </span>
          ) : undefined}
          footer={
            <>
              <button type="button" onClick={closeEditor} disabled={saving} className={dsButton.secondary}>
                {t('attp.cancel', 'Annulla')}
              </button>
              <button type="button" onClick={handleSave} disabled={!canSave} className={dsButton.primary}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingId ? t('attp.save', 'Salva') : t('attp.create', 'Crea')}
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FormCard title={t('attp.cardWhat', 'Attività')}>
              <div className="space-y-4">
                <Field label={t('attp.fieldTitle', 'Titolo')} htmlFor="attp-titolo" required>
                  <input
                    id="attp-titolo"
                    ref={titleRef}
                    type="text"
                    value={form.title}
                    onFocus={() => { lastField.current = 'title'; }}
                    onChange={e => setForm({ ...form, title: e.target.value.slice(0, 200) })}
                    placeholder={t('attp.titlePlaceholder', 'Es. Ordinare merce per i banchetti del {data}')}
                    className={dsInput}
                    autoFocus
                  />
                </Field>
                <Field label={t('attp.fieldDescription', 'Descrizione')} htmlFor="attp-descrizione" aside={t('attp.optional', 'facoltativa')}>
                  <textarea
                    id="attp-descrizione"
                    ref={descRef}
                    value={form.description || ''}
                    onFocus={() => { lastField.current = 'description'; }}
                    onChange={e => setForm({ ...form, description: e.target.value.slice(0, 1000) })}
                    rows={2}
                    className={`${dsTextarea} resize-y`}
                  />
                </Field>
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {PLACEHOLDERS.map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => insertPlaceholder(p)}
                        className="inline-flex h-9 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-tint)] px-3 text-[13px] font-medium text-[var(--ds-arriving-text)] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[13px] leading-snug text-[var(--ds-text-muted)]">
                    {form.kind === 'BANQUET'
                      ? t('attp.placeholdersHintBanquet', '{data} è il giorno del banchetto, {coperti} i suoi coperti, {banchetti} i nomi dei banchetti di quel giorno.')
                      : t('attp.placeholdersHintDay', '{data} è il giorno di scadenza, {coperti} i coperti previsti quel giorno (prenotazioni e banchetti), {banchetti} i banchetti di quel giorno.')}
                  </p>
                  {form.title.trim() && (
                    <p className="mt-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2 text-[13px] text-[var(--ds-text-secondary)] [overflow-wrap:anywhere]">
                      <span className="text-[var(--ds-text-muted)]">{t('attp.preview', 'Esempio')}: </span>{preview}
                    </p>
                  )}
                </div>
              </div>
            </FormCard>

            <FormCard title={t('attp.cardWhen', 'Quando')}>
              <div className="space-y-4">
                <SegmentedControl<ScheduledTaskKind>
                  value={form.kind}
                  onChange={kind => setForm({ ...form, kind })}
                  ariaLabel={t('attp.kind', 'Tipo')}
                  equalWidth={false}
                  options={[
                    { value: 'BANQUET', label: t('attp.kindBanquet', 'Prima dei banchetti') },
                    { value: 'RECURRING', label: t('attp.kindRecurring', 'Ricorrente') },
                    { value: 'ONE_OFF', label: t('attp.kindOneOff', 'Una volta') },
                  ]}
                />

                {form.kind === 'BANQUET' && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      label={t('attp.daysBeforeLabel', 'Giorni prima')}
                      htmlFor="attp-giorni"
                      hint={t('attp.daysBeforeHint', '0 = il giorno del banchetto')}
                    >
                      <input
                        id="attp-giorni"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={60}
                        value={form.days_before ?? ''}
                        onChange={e => {
                          const v = e.target.value === '' ? null : Math.max(0, Math.min(60, parseInt(e.target.value, 10) || 0));
                          setForm({ ...form, days_before: v });
                        }}
                        className={`${dsInput} tabular`}
                      />
                    </Field>
                    <Field label={t('attp.scope', 'Banchetti')}>
                      <SegmentedControl<'ALL' | 'CONFIRMED'>
                        value={form.banquet_scope}
                        onChange={banquet_scope => setForm({ ...form, banquet_scope })}
                        ariaLabel={t('attp.scope', 'Banchetti')}
                        options={[
                          { value: 'ALL', label: t('attp.scopeAll', 'Tutti') },
                          { value: 'CONFIRMED', label: t('attp.scopeConfirmed', 'Solo confermati') },
                        ]}
                      />
                    </Field>
                  </div>
                )}

                {form.kind === 'RECURRING' && (
                  <>
                    <SegmentedControl<ScheduledTaskFrequency>
                      value={form.frequency ?? 'DAILY'}
                      onChange={frequency => setForm({ ...form, frequency })}
                      ariaLabel={t('attp.frequency', 'Frequenza')}
                      options={[
                        { value: 'DAILY', label: t('attp.daily', 'Ogni giorno') },
                        { value: 'WEEKLY', label: t('attp.weekly', 'Settimanale') },
                        { value: 'MONTHLY', label: t('attp.monthly', 'Mensile') },
                      ]}
                    />
                    {form.frequency === 'WEEKLY' && (
                      <div className="flex flex-wrap gap-1.5">
                        {giorni.map(w => {
                          const on = (form.weekdays || []).includes(w.code);
                          return (
                            <Chip
                              key={w.code}
                              active={on}
                              title={w.long}
                              onClick={() => setForm({
                                ...form,
                                weekdays: on ? (form.weekdays || []).filter(x => x !== w.code) : [...(form.weekdays || []), w.code],
                              })}
                            >
                              {w.short}
                            </Chip>
                          );
                        })}
                      </div>
                    )}
                    {form.frequency === 'MONTHLY' && (
                      <Field label={t('attp.monthDay', 'Giorno del mese')} htmlFor="attp-giorno-mese" hint={t('attp.monthDayHint', 'Da 1 a 28, così c\'è in tutti i mesi')}>
                        <input
                          id="attp-giorno-mese"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={28}
                          value={form.month_day ?? 1}
                          onChange={e => setForm({ ...form, month_day: Math.max(1, Math.min(28, parseInt(e.target.value, 10) || 1)) })}
                          className={`${dsInput} tabular sm:max-w-[160px]`}
                        />
                      </Field>
                    )}
                  </>
                )}

                {form.kind === 'ONE_OFF' && (
                  <Field label={t('attp.date', 'Data')} htmlFor="attp-data">
                    <input
                      id="attp-data"
                      type="date"
                      value={form.schedule_date || ''}
                      onChange={e => setForm({ ...form, schedule_date: e.target.value })}
                      className={`${dsInput} tabular sm:max-w-[220px]`}
                    />
                  </Field>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field
                    label={t('attp.time', 'Ora')}
                    htmlFor="attp-ora"
                    hint={form.kind === 'BANQUET'
                      ? t('attp.timeHintBanquet', 'Quel giorno, a quest\'ora, compare in Attività e arriva la notifica')
                      : t('attp.timeHint', 'A quest\'ora compare in Attività e arriva la notifica')}
                  >
                    <input
                      id="attp-ora"
                      type="time"
                      value={form.schedule_time}
                      onChange={e => setForm({ ...form, schedule_time: e.target.value })}
                      className={`${dsInput} tabular`}
                    />
                  </Field>
                  {form.kind !== 'BANQUET' && (
                    <Field label={t('attp.due', 'Scadenza')} htmlFor="attp-scadenza">
                      <select
                        id="attp-scadenza"
                        value={form.due_in_days}
                        onChange={e => setForm({ ...form, due_in_days: parseInt(e.target.value, 10) || 0 })}
                        className={dsSelect}
                      >
                        <option value={0}>{t('attp.dueSameDay', 'Lo stesso giorno')}</option>
                        <option value={1}>{t('attp.dueNextDay', 'Il giorno dopo')}</option>
                        {[2, 3, 4, 5, 6, 7].map(n => (
                          <option key={n} value={n}>{t('attp.dueAfter', 'Dopo {{count}} giorni', { count: n })}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              </div>
            </FormCard>

            <FormCard title={t('attp.cardWho', 'Per chi')}>
              <div className="space-y-4">
                <Field label={t('attp.team', 'Squadra')}>
                  <div className="flex flex-wrap gap-1.5">
                    {TEAMS.map(team => (
                      <Chip key={team} active={form.assigned_team === team} onClick={() => setForm({ ...form, assigned_team: team })}>
                        {roleLabel(team, t)}
                      </Chip>
                    ))}
                  </div>
                </Field>
                <Field label={t('attp.priority', 'Priorità')}>
                  <SegmentedControl<ScheduledTaskPriority>
                    value={form.priority}
                    onChange={priority => setForm({ ...form, priority })}
                    ariaLabel={t('attp.priority', 'Priorità')}
                    options={PRIORITIES.map(p => ({ value: p, label: priorityLabel(p as TodoPriority, tA as any) }))}
                  />
                </Field>
                <Field label={t('attp.category', 'Categoria')}>
                  <div className="flex flex-wrap gap-1.5">
                    {CATEGORIES.map(c => (
                      <Chip key={c} active={form.category === c} onClick={() => setForm({ ...form, category: c })}>
                        {categoryLabel(c as TodoCategory, tA as any)}
                      </Chip>
                    ))}
                  </div>
                </Field>
              </div>
            </FormCard>

            <FormCard title={t('attp.cardMore', 'Altro')}>
              <div className="space-y-4">
                <Field
                  label={t('attp.coversPerUnit', 'Coperti per unità')}
                  htmlFor="attp-coperti-unita"
                  aside={t('attp.optional', 'facoltativa')}
                  hint={t('attp.coversPerUnitHint', 'Per {quantità}: con 10, una unità ogni 10 coperti arrotondando in su (il pane: 1 kg ogni 10 coperti). Vuoto: una a coperto.')}
                >
                  <input
                    id="attp-coperti-unita"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1000}
                    value={form.covers_per_unit ?? ''}
                    onChange={e => setForm({ ...form, covers_per_unit: e.target.value === '' ? null : Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1)) })}
                    className={`${dsInput} tabular sm:max-w-[160px]`}
                  />
                </Field>
                <label className="inline-flex min-h-[44px] cursor-pointer select-none items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={e => setForm({ ...form, active: e.target.checked })}
                    className="h-4 w-4 rounded-[var(--ds-radius-sm)] border-[var(--ds-border-strong)] text-[var(--ds-arriving-text)] focus:ring-[var(--ds-border-focus)]"
                  />
                  <span className="text-[14px] text-[var(--ds-text-primary)]">{t('attp.active', 'Accesa')}</span>
                </label>
              </div>
            </FormCard>
          </div>
        </ModalShell>
      )}

      <ConfirmDeleteModal
        isOpen={!!toDelete}
        title={t('attp.confirmDeleteTitle', 'Eliminare l\'attività programmata?')}
        message={t('attp.confirmDeleteHint', 'Quelle già comparse in Attività e non ancora svolte spariscono. Le svolte restano.')}
        itemName={toDelete?.title}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
};

export default ScheduledTasksManager;
