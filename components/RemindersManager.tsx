import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Plus, Pencil, Trash2, X, Loader2, Clock, Calendar, Repeat, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  remindersApiService,
  Reminder,
  ReminderInput,
  ReminderKind,
  ReminderFrequency,
  ReminderRole,
} from '../services/remindersApiService';

const WEEKDAYS: { code: string; short: string; long: string }[] = [
  { code: 'MON', short: 'Lun', long: 'Lunedì' },
  { code: 'TUE', short: 'Mar', long: 'Martedì' },
  { code: 'WED', short: 'Mer', long: 'Mercoledì' },
  { code: 'THU', short: 'Gio', long: 'Giovedì' },
  { code: 'FRI', short: 'Ven', long: 'Venerdì' },
  { code: 'SAT', short: 'Sab', long: 'Sabato' },
  { code: 'SUN', short: 'Dom', long: 'Domenica' },
];

const ROLE_OPTIONS: { code: ReminderRole; label: string }[] = [
  { code: 'OWNER', label: 'Proprietario' },
  { code: 'GENERAL_MANAGER', label: 'Direttore' },
  { code: 'MANAGER', label: 'Responsabile' },
  { code: 'RECEPTION', label: 'Reception' },
  { code: 'WAITER', label: 'Camerieri' },
  { code: 'KITCHEN', label: 'Cucina' },
];

const formatSchedule = (r: Reminder): string => {
  if (r.kind === 'ONE_OFF') {
    if (!r.schedule_date) return r.schedule_time;
    const [y, m, d] = r.schedule_date.split('-');
    return `${d}/${m}/${y} · ${r.schedule_time}`;
  }
  if (r.frequency === 'DAILY') return `Ogni giorno · ${r.schedule_time}`;
  if (r.frequency === 'WEEKLY') {
    const days = (r.weekdays || [])
      .map(c => WEEKDAYS.find(w => w.code === c)?.short || c)
      .join(', ');
    return `${days} · ${r.schedule_time}`;
  }
  if (r.frequency === 'MONTHLY') return `Ogni mese il ${r.month_day} · ${r.schedule_time}`;
  return r.schedule_time;
};

const kindBadge = (r: Reminder): { label: string; cls: string } => {
  if (r.system_key) return { label: 'Sistema', cls: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30' };
  if (r.kind === 'ONE_OFF') return { label: 'Temporaneo', cls: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30' };
  return { label: 'Ricorrente', cls: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30' };
};

interface EditorState {
  id?: number;
  title: string;
  description: string;
  kind: ReminderKind;
  frequency: ReminderFrequency;
  schedule_time: string;
  schedule_date: string;
  weekdays: string[];
  month_day: number;
  target_roles: ReminderRole[];
  active: boolean;
}

const blankEditor = (): EditorState => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    title: '',
    description: '',
    kind: 'RECURRING',
    frequency: 'DAILY',
    schedule_time: '09:00',
    schedule_date: iso,
    weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    month_day: 1,
    target_roles: ['OWNER'],
    active: true,
  };
};

const reminderToEditor = (r: Reminder): EditorState => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    kind: r.kind,
    frequency: (r.frequency || 'DAILY') as ReminderFrequency,
    schedule_time: r.schedule_time,
    schedule_date: r.schedule_date || iso,
    weekdays: r.weekdays || ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    month_day: r.month_day || 1,
    target_roles: r.target_roles as ReminderRole[],
    active: r.active,
  };
};

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export const RemindersManager: React.FC<Props> = ({ showToast }) => {
  const [items, setItems] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { reminders } = await remindersApiService.list();
      setItems(reminders);
    } catch (err: any) {
      setError(err?.message || 'Errore caricamento promemoria');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setSaveError(null); setEditor(blankEditor()); };
  const openEdit = (r: Reminder) => { setSaveError(null); setEditor(reminderToEditor(r)); };
  const closeEditor = () => { if (!saving) setEditor(null); };

  const toBackendInput = (e: EditorState): ReminderInput => ({
    title: e.title.trim(),
    description: e.description.trim() || null,
    kind: e.kind,
    frequency: e.kind === 'RECURRING' ? e.frequency : null,
    schedule_time: e.schedule_time,
    schedule_date: e.kind === 'ONE_OFF' ? e.schedule_date : null,
    weekdays: e.kind === 'RECURRING' && e.frequency === 'WEEKLY' ? e.weekdays : null,
    month_day: e.kind === 'RECURRING' && e.frequency === 'MONTHLY' ? e.month_day : null,
    target_roles: e.target_roles,
    active: e.active,
  });

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = toBackendInput(editor);
      if (editor.id) {
        const saved = await remindersApiService.update(editor.id, input);
        setItems(prev => prev.map(x => x.id === saved.id ? saved : x));
        showToast('Promemoria aggiornato', 'success');
      } else {
        const created = await remindersApiService.create(input);
        setItems(prev => [created, ...prev]);
        showToast('Promemoria creato', 'success');
      }
      setEditor(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Errore salvataggio');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (r: Reminder) => {
    try {
      const saved = await remindersApiService.update(r.id, {
        title: r.title,
        description: r.description,
        kind: r.kind,
        frequency: r.frequency,
        schedule_time: r.schedule_time,
        schedule_date: r.schedule_date,
        weekdays: r.weekdays,
        month_day: r.month_day,
        target_roles: r.target_roles,
        active: !r.active,
      });
      setItems(prev => prev.map(x => x.id === saved.id ? saved : x));
    } catch (err: any) {
      showToast(err?.message || 'Errore aggiornamento', 'error');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await remindersApiService.delete(id);
      setItems(prev => prev.filter(x => x.id !== id));
      setConfirmDeleteId(null);
      showToast('Promemoria eliminato', 'info');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione', 'error');
    }
  };

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      // Active first, then most recently updated
      if (a.active !== b.active) return a.active ? -1 : 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [items]);

  const canSave = editor
    ? editor.title.trim().length > 0
      && /^([01]\d|2[0-3]):([0-5]\d)$/.test(editor.schedule_time)
      && editor.target_roles.length > 0
      && (editor.kind === 'ONE_OFF' ? !!editor.schedule_date : true)
      && (editor.kind === 'RECURRING' && editor.frequency === 'WEEKLY' ? editor.weekdays.length > 0 : true)
      && !saving
    : false;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-sm">
      <div className="flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-[var(--color-line)]">
        <div className="flex items-start gap-2">
          <Bell className="h-5 w-5 text-indigo-600 mt-0.5" />
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Promemoria</h2>
            <p className="text-[12px] text-[var(--color-fg-muted)] mt-0.5">
              Notifiche automatiche programmate — una volta o ricorrenti (giornaliere, settimanali, mensili).
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-indigo-600 text-white text-[12px] font-semibold hover:bg-indigo-700 shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Nuovo
        </button>
      </div>

      {error && (
        <div className="p-3 mx-4 mt-3 rounded-lg bg-rose-50 text-rose-700 text-[12px] flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[13px] text-[var(--color-fg-muted)]">Carico…</div>
      ) : sorted.length === 0 ? (
        <div className="p-10 text-center text-[13px] text-[var(--color-fg-muted)]">
          Nessun promemoria configurato.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {sorted.map(r => {
            const badge = kindBadge(r);
            const roles = r.target_roles.map(rc => ROLE_OPTIONS.find(o => o.code === rc)?.label || rc).join(', ');
            return (
              <li key={r.id} className={`p-3 sm:p-4 ${r.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-[var(--color-fg)] truncate">{r.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${badge.cls}`}>
                        {badge.label}
                      </span>
                      {!r.active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-slate-100 text-slate-700 ring-slate-200 shrink-0">
                          Disattivato
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[12px] text-[var(--color-fg-muted)] flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        {r.kind === 'RECURRING' ? <Repeat className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                        {formatSchedule(r)}
                      </span>
                      <span className="inline-flex items-center gap-1">→ {roles}</span>
                    </div>
                    {r.description && (
                      <p className="mt-1 text-[12px] text-[var(--color-fg-muted)] line-clamp-2">
                        {r.description}
                      </p>
                    )}
                    {r.last_run_at && (
                      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)] inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Ultima esecuzione: {new Date(r.last_run_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(r)}
                      className={`h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors ${
                        r.active
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                      title={r.active ? 'Disattiva' : 'Attiva'}
                    >
                      {r.active ? 'Attivo' : 'Off'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(r)}
                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:text-indigo-600 hover:bg-indigo-50"
                      title="Modifica"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(r.id)}
                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-rose-50"
                      title="Elimina"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Editor modal */}
      {editor && createPortal(
        <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4" onClick={closeEditor}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-xl)] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
            <div className="p-4 sm:p-5 border-b border-[var(--color-line)] flex items-center justify-between gap-2">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {editor.id ? 'Modifica promemoria' : 'Nuovo promemoria'}
              </h3>
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
              {/* Title */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1">Titolo *</label>
                <input
                  type="text"
                  value={editor.title}
                  onChange={e => setEditor({ ...editor, title: e.target.value.slice(0, 200) })}
                  placeholder="Es. Ordinare il pane per domani"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[14px] text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  autoFocus
                />
              </div>
              {/* Description */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1">Descrizione (opzionale)</label>
                <textarea
                  value={editor.description}
                  onChange={e => setEditor({ ...editor, description: e.target.value.slice(0, 500) })}
                  rows={2}
                  placeholder="Contenuto del messaggio inviato"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[14px] text-[var(--color-fg)] resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              {/* Kind */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1.5">Tipo</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['RECURRING', 'ONE_OFF'] as const).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEditor({ ...editor, kind: k })}
                      className={`h-10 px-3 rounded-lg text-[13px] font-medium border transition-colors ${
                        editor.kind === k
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      {k === 'RECURRING' ? 'Ricorrente' : 'Temporaneo'}
                    </button>
                  ))}
                </div>
              </div>
              {/* Frequency (RECURRING) */}
              {editor.kind === 'RECURRING' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1.5">Frequenza</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setEditor({ ...editor, frequency: f })}
                        className={`h-9 px-2 rounded-lg text-[12px] font-medium border transition-colors ${
                          editor.frequency === f
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {f === 'DAILY' ? 'Giornaliero' : f === 'WEEKLY' ? 'Settimanale' : 'Mensile'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Weekdays (WEEKLY) */}
              {editor.kind === 'RECURRING' && editor.frequency === 'WEEKLY' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1.5">Giorni</label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map(w => {
                      const on = editor.weekdays.includes(w.code);
                      return (
                        <button
                          key={w.code}
                          type="button"
                          onClick={() => setEditor({
                            ...editor,
                            weekdays: on
                              ? editor.weekdays.filter(x => x !== w.code)
                              : [...editor.weekdays, w.code],
                          })}
                          className={`h-8 px-3 rounded-full text-[12px] font-medium border transition-colors ${
                            on
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                          }`}
                          title={w.long}
                        >
                          {w.short}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Month day (MONTHLY) */}
              {editor.kind === 'RECURRING' && editor.frequency === 'MONTHLY' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1">Giorno del mese (1-28)</label>
                  <input
                    type="number"
                    min={1} max={28}
                    value={editor.month_day}
                    onChange={e => setEditor({ ...editor, month_day: Math.max(1, Math.min(28, parseInt(e.target.value, 10) || 1)) })}
                    className="w-28 h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[14px] tabular text-[var(--color-fg)]"
                  />
                  <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
                    Limitato a 28 per garantire l'esecuzione in tutti i mesi (incluso febbraio).
                  </p>
                </div>
              )}
              {/* Date (ONE_OFF) */}
              {editor.kind === 'ONE_OFF' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1">Data</label>
                  <input
                    type="date"
                    value={editor.schedule_date}
                    onChange={e => setEditor({ ...editor, schedule_date: e.target.value })}
                    className="h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[14px] tabular text-[var(--color-fg)]"
                  />
                </div>
              )}
              {/* Time */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1">Orario (HH:MM)</label>
                <input
                  type="time"
                  value={editor.schedule_time}
                  onChange={e => setEditor({ ...editor, schedule_time: e.target.value })}
                  className="h-10 px-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] text-[14px] tabular text-[var(--color-fg)]"
                />
              </div>
              {/* Roles */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-fg-muted)] mb-1.5">Destinatari</label>
                <div className="flex flex-wrap gap-1.5">
                  {ROLE_OPTIONS.map(o => {
                    const on = editor.target_roles.includes(o.code);
                    return (
                      <button
                        key={o.code}
                        type="button"
                        onClick={() => setEditor({
                          ...editor,
                          target_roles: on
                            ? editor.target_roles.filter(x => x !== o.code)
                            : [...editor.target_roles, o.code],
                        })}
                        className={`h-8 px-3 rounded-full text-[12px] font-medium border transition-colors ${
                          on
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Active toggle */}
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={editor.active}
                  onChange={e => setEditor({ ...editor, active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-[13px] text-[var(--color-fg)]">Attivo</span>
              </label>
              {saveError && (
                <div className="p-2 rounded-lg bg-rose-50 text-rose-700 text-[12px] flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
                  <span>{saveError}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]">
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="px-4 py-2 rounded-full text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {editor.id ? 'Salva' : 'Crea'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirmation */}
      {confirmDeleteId !== null && createPortal(
        <div className="fixed inset-0 z-[85] bg-black/50 flex items-center justify-center p-4" onClick={() => setConfirmDeleteId(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-xl)] w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare il promemoria?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              L'azione non è reversibile. Il promemoria non verrà più eseguito.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 rounded-full text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => handleDelete(confirmDeleteId)}
                className="px-4 py-2 rounded-full bg-rose-600 text-white text-[13px] font-medium hover:bg-rose-700"
              >
                Elimina
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default RemindersManager;
