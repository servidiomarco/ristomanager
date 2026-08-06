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
  if (r.system_key) return { label: 'Sistema', cls: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] ring-[var(--ds-arriving-solid)]' };
  if (r.kind === 'ONE_OFF') return { label: 'Temporaneo', cls: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ring-[var(--ds-pending-solid)]' };
  return { label: 'Ricorrente', cls: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] ring-[var(--ds-arriving-solid)]' };
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
    <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)]">
      <div className="flex items-start justify-between gap-3 p-3 sm:p-4 border-b border-[var(--ds-border)]">
        {/* Stessa piastrella da 40px delle altre righe di Impostazioni: la
            campanella era l'unica icona nuda della pagina, e in indaco quando
            tutte le altre sono neutre. */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]">
            <Bell className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">Promemoria</h2>
            <p className="text-[13px] leading-snug text-[var(--ds-text-muted)]">
              Notifiche automatiche programmate — una volta o ricorrenti (giornaliere, settimanali, mensili).
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[12px] font-semibold hover:bg-[var(--ds-action-bg-hover)] shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Nuovo
        </button>
      </div>

      {error && (
        <div className="p-3 mx-4 mt-3 rounded-lg bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] text-[12px] flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[13px] text-[var(--ds-text-muted)]">Carico…</div>
      ) : sorted.length === 0 ? (
        <div className="p-10 text-center text-[13px] text-[var(--ds-text-muted)]">
          Nessun promemoria configurato.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--ds-border)]">
          {sorted.map(r => {
            const badge = kindBadge(r);
            const roles = r.target_roles.map(rc => ROLE_OPTIONS.find(o => o.code === rc)?.label || rc).join(', ');
            return (
              <li key={r.id} className={`p-3 sm:p-4 ${r.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-[var(--ds-text-primary)] truncate">{r.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset shrink-0 ${badge.cls}`}>
                        {badge.label}
                      </span>
                      {!r.active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ring-1 ring-inset bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] ring-[var(--ds-border)] shrink-0">
                          Disattivato
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[12px] text-[var(--ds-text-muted)] flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        {r.kind === 'RECURRING' ? <Repeat className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                        {formatSchedule(r)}
                      </span>
                      <span className="inline-flex items-center gap-1">→ {roles}</span>
                    </div>
                    {r.description && (
                      <p className="mt-1 text-[12px] text-[var(--ds-text-muted)] line-clamp-2">
                        {r.description}
                      </p>
                    )}
                    {r.last_run_at && (
                      <p className="mt-1 text-[11px] text-[var(--ds-text-subtle)] inline-flex items-center gap-1">
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
                          ? 'border-[var(--ds-seated-solid)] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:bg-[var(--ds-seated-tint)]'
                          : 'border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                      }`}
                      title={r.active ? 'Disattiva' : 'Attiva'}
                    >
                      {r.active ? 'Attivo' : 'Off'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(r)}
                      className="p-1.5 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-arriving-text)] hover:bg-[var(--ds-arriving-tint)]"
                      title="Modifica"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(r.id)}
                      className="p-1.5 rounded-md text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)]"
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
        <div className="fixed inset-0 z-[80] bg-[var(--ds-backdrop)] flex items-center justify-center p-4" onClick={closeEditor}>
          <div className="bg-[var(--ds-surface)] rounded-2xl shadow-[var(--ds-shadow-raised)] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
            <div className="p-4 sm:p-5 border-b border-[var(--ds-border)] flex items-center justify-between gap-2">
              <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">
                {editor.id ? 'Modifica promemoria' : 'Nuovo promemoria'}
              </h3>
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="p-1.5 rounded-lg text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
              {/* Title */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1">Titolo *</label>
                <input
                  type="text"
                  value={editor.title}
                  onChange={e => setEditor({ ...editor, title: e.target.value.slice(0, 200) })}
                  placeholder="Es. Ordinare il pane per domani"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]"
                  autoFocus
                />
              </div>
              {/* Description */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1">Descrizione (opzionale)</label>
                <textarea
                  value={editor.description}
                  onChange={e => setEditor({ ...editor, description: e.target.value.slice(0, 500) })}
                  rows={2}
                  placeholder="Contenuto del messaggio inviato"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[14px] text-[var(--ds-text-primary)] resize-y focus:outline-none focus:ring-2 focus:ring-[var(--ds-border-focus)]"
                />
              </div>
              {/* Kind */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1.5">Tipo</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['RECURRING', 'ONE_OFF'] as const).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEditor({ ...editor, kind: k })}
                      className={`h-10 px-3 rounded-lg text-[13px] font-medium border transition-colors ${
                        editor.kind === k
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:text-[var(--ds-text-primary)]'
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
                  <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1.5">Frequenza</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setEditor({ ...editor, frequency: f })}
                        className={`h-9 px-2 rounded-lg text-[12px] font-medium border transition-colors ${
                          editor.frequency === f
                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]'
                            : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:text-[var(--ds-text-primary)]'
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
                  <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1.5">Giorni</label>
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
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]'
                              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:text-[var(--ds-text-primary)]'
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
                  <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1">Giorno del mese (1-28)</label>
                  <input
                    type="number"
                    min={1} max={28}
                    value={editor.month_day}
                    onChange={e => setEditor({ ...editor, month_day: Math.max(1, Math.min(28, parseInt(e.target.value, 10) || 1)) })}
                    className="w-28 h-10 px-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[14px] tabular text-[var(--ds-text-primary)]"
                  />
                  <p className="mt-1 text-[11px] text-[var(--ds-text-subtle)]">
                    Limitato a 28 per garantire l'esecuzione in tutti i mesi (incluso febbraio).
                  </p>
                </div>
              )}
              {/* Date (ONE_OFF) */}
              {editor.kind === 'ONE_OFF' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1">Data</label>
                  <input
                    type="date"
                    value={editor.schedule_date}
                    onChange={e => setEditor({ ...editor, schedule_date: e.target.value })}
                    className="h-10 px-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[14px] tabular text-[var(--ds-text-primary)]"
                  />
                </div>
              )}
              {/* Time */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1">Orario (HH:MM)</label>
                <input
                  type="time"
                  value={editor.schedule_time}
                  onChange={e => setEditor({ ...editor, schedule_time: e.target.value })}
                  className="h-10 px-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-row)] text-[14px] tabular text-[var(--ds-text-primary)]"
                />
              </div>
              {/* Roles */}
              <div>
                <label className="block text-[11px] font-semibold text-[var(--ds-text-muted)] mb-1.5">Destinatari</label>
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
                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]'
                            : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:text-[var(--ds-text-primary)]'
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
                  className="h-4 w-4 rounded border-[var(--ds-border-strong)] text-[var(--ds-arriving-text)] focus:ring-[var(--ds-border-focus)]"
                />
                <span className="text-[13px] text-[var(--ds-text-primary)]">Attivo</span>
              </label>
              {saveError && (
                <div className="p-2 rounded-lg bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] text-[12px] flex items-start gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
                  <span>{saveError}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--ds-border)] bg-[var(--ds-surface-row)]">
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
                className="px-4 py-2 rounded-full text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[13px] font-medium hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className="fixed inset-0 z-[85] bg-[var(--ds-backdrop)] flex items-center justify-center p-4" onClick={() => setConfirmDeleteId(null)}>
          <div className="bg-[var(--ds-surface)] rounded-2xl shadow-[var(--ds-shadow-raised)] w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <h4 className="font-semibold text-[15px] text-[var(--ds-text-primary)] mb-2">Eliminare il promemoria?</h4>
            <p className="text-[13px] text-[var(--ds-text-muted)] mb-4">
              L'azione non è reversibile. Il promemoria non verrà più eseguito.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 rounded-full text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => handleDelete(confirmDeleteId)}
                className="px-4 py-2 rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[13px] font-medium hover:bg-[var(--ds-critical-solid)]"
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
