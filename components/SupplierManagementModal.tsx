import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShopping } from '../contexts/ShoppingContext';
import { ShoppingCategory, Supplier } from '../services/shoppingApiService';
import { Plus, Loader2, Edit2, Trash2, Check, Truck } from 'lucide-react';
import {
  Callout, EmptyState, Field, FormCard, ModalShell, StatusPill,
  dsButton, dsInput, dsTextarea,
} from './ds';
import { categoryLabel } from './spesa/shoppingView';

/* ── Gestione fornitori ───────────────────────────────────────────────────
   Reached from the shopping list, where it is the only way to create the
   suppliers those items get assigned to. Restyled onto the shared modal
   frame: on a phone it was a centred 90vh box with its own backdrop, its own
   header and hand-rolled inputs, so it looked like a different application
   from the page that opened it.

   A supplier can serve more than one category, which is why the categories are
   toggles rather than a single choice — and why at least one must stay on. */

interface SupplierManagementModalProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: ShoppingCategory;
}

const CATEGORIES: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];

const sortedCategories = (cats: ShoppingCategory[]): ShoppingCategory[] =>
  CATEGORIES.filter(c => cats.includes(c));

const CategoryChips: React.FC<{ categories: ShoppingCategory[] }> = ({ categories }) => {
  const { t } = useTranslation('spesa', { useSuspense: false });
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {sortedCategories(categories).map(c => (
        <StatusPill key={c} tone="neutral">{categoryLabel(c, t)}</StatusPill>
      ))}
    </span>
  );
};

const CategoryCheckboxes: React.FC<{
  value: ShoppingCategory[];
  onChange: (next: ShoppingCategory[]) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation('spesa', { useSuspense: false });
  const toggle = (c: ShoppingCategory) => {
    if (value.includes(c)) {
      const next = value.filter(x => x !== c);
      if (next.length === 0) return; // a supplier serving nothing cannot be assigned
      onChange(next);
    } else {
      onChange([...value, c]);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {CATEGORIES.map(c => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => toggle(c)}
            aria-pressed={on}
            className={`inline-flex h-10 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              on
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {categoryLabel(c, t)}
          </button>
        );
      })}
    </div>
  );
};

export const SupplierManagementModal: React.FC<SupplierManagementModalProps> = ({
  open,
  onClose,
  initialCategory,
}) => {
  const { t } = useTranslation('spesa', { useSuspense: false });
  const { suppliers, addSupplier, updateSupplier, deleteSupplier } = useShopping();

  // Add form
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newCategories, setNewCategories] = useState<ShoppingCategory[]>(
    initialCategory ? [initialCategory] : ['CUCINA'],
  );
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit row
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editCategories, setEditCategories] = useState<ShoppingCategory[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation (inline)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  React.useEffect(() => {
    if (open && initialCategory) setNewCategories([initialCategory]);
  }, [open, initialCategory]);

  const sortedSuppliers = useMemo(
    () => [...suppliers].sort((a, b) => a.name.localeCompare(b.name, 'it')),
    [suppliers],
  );

  if (!open) return null;

  const resetAddForm = () => {
    setNewName('');
    setNewPhone('');
    setNewNote('');
    setNewCategories(initialCategory ? [initialCategory] : ['CUCINA']);
    setAddError(null);
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name || isAdding || newCategories.length === 0) return;
    try {
      setIsAdding(true);
      setAddError(null);
      await addSupplier({
        name,
        categories: newCategories,
        phone: newPhone.trim() || undefined,
        note: newNote.trim() || undefined,
      });
      resetAddForm();
    } catch (err: any) {
      setAddError(err?.message || t('forn.errCreate', 'Errore durante la creazione'));
    } finally {
      setIsAdding(false);
    }
  };

  const startEdit = (s: Supplier) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditPhone(s.phone || '');
    setEditNote(s.note || '');
    setEditCategories(s.categories.length > 0 ? [...s.categories] : ['CUCINA']);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditPhone('');
    setEditNote('');
    setEditCategories([]);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editingId || isSaving) return;
    const name = editName.trim();
    if (!name || editCategories.length === 0) return;
    try {
      setIsSaving(true);
      setEditError(null);
      await updateSupplier(editingId, {
        name,
        categories: editCategories,
        phone: editPhone.trim() || null,
        note: editNote.trim() || null,
      });
      cancelEdit();
    } catch (err: any) {
      setEditError(err?.message || t('forn.errSave', 'Errore durante il salvataggio'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      setIsDeleting(true);
      await deleteSupplier(id);
      setPendingDeleteId(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t('forn.title', 'Gestione fornitori')}
      subtitle={t('forn.subtitle', 'Un fornitore può servire più categorie')}
      size="md"
      closeOnEscape
      bodyClassName="space-y-3 p-4 sm:p-5"
    >
      {/* Adding comes first: this modal is opened to create a supplier far more
          often than to correct one, and on a phone a form pinned under a
          scrolling list is a form nobody reaches. */}
      <FormCard title={t('forn.add', 'Aggiungi fornitore')}>
        <div className="space-y-4">
          <Field label={t('forn.name', 'Nome')}>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
              placeholder={t('forn.namePlaceholder', 'Nome fornitore')}
              className={dsInput}
            />
          </Field>
          <Field label={t('forn.categories', 'Categorie servite')}>
            <CategoryCheckboxes value={newCategories} onChange={setNewCategories} disabled={isAdding} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('forn.phone', 'Telefono')}>
              <input
                type="tel"
                value={newPhone}
                onChange={e => setNewPhone(e.target.value)}
                placeholder={t('forn.optional', 'Opzionale')}
                className={dsInput}
              />
            </Field>
            <Field label={t('forn.note', 'Nota')}>
              <input
                type="text"
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder={t('forn.optional', 'Opzionale')}
                className={dsInput}
              />
            </Field>
          </div>
          {addError && <Callout tone="critical">{addError}</Callout>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newName.trim() || newCategories.length === 0 || isAdding}
              className={`w-full sm:w-auto ${dsButton.primary}`}
            >
              {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('forn.addButton', 'Aggiungi')}
            </button>
          </div>
        </div>
      </FormCard>

      {sortedSuppliers.length === 0 ? (
        <EmptyState icon={Truck}>{t('forn.empty', 'Nessun fornitore. Aggiungine uno qui sopra.')}</EmptyState>
      ) : (
        sortedSuppliers.map(s => {
          const isEditing = editingId === s.id;
          const isPendingDelete = pendingDeleteId === s.id;

          if (isEditing) {
            return (
              <FormCard key={s.id}>
                <div className="space-y-4">
                  <Field label={t('forn.name', 'Nome')}>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      autoFocus
                      className={dsInput}
                    />
                  </Field>
                  <Field label={t('forn.categories', 'Categorie servite')}>
                    <CategoryCheckboxes value={editCategories} onChange={setEditCategories} disabled={isSaving} />
                  </Field>
                  <Field label={t('forn.phone', 'Telefono')}>
                    <input
                      type="tel"
                      value={editPhone}
                      onChange={e => setEditPhone(e.target.value)}
                      placeholder={t('forn.optional', 'Opzionale')}
                      className={dsInput}
                    />
                  </Field>
                  <Field label={t('forn.notes', 'Note')}>
                    <textarea
                      value={editNote}
                      onChange={e => setEditNote(e.target.value)}
                      placeholder={t('forn.optionalPlural', 'Opzionali')}
                      rows={2}
                      className={`${dsTextarea} resize-none`}
                    />
                  </Field>
                  {editError && <Callout tone="critical">{editError}</Callout>}
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <button type="button" onClick={cancelEdit} disabled={isSaving} className={dsButton.quiet}>
                      {t('forn.cancel', 'Annulla')}
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={!editName.trim() || editCategories.length === 0 || isSaving}
                      className={dsButton.primary}
                    >
                      {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      {t('forn.save', 'Salva')}
                    </button>
                  </div>
                </div>
              </FormCard>
            );
          }

          return (
            <FormCard key={s.id} className="p-4 sm:p-4">
              <div className="flex items-start gap-3">
                <Truck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{s.name}</p>
                  <div className="mt-1.5"><CategoryChips categories={s.categories} /></div>
                  {s.phone && (
                    <p className="mt-1.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{s.phone}</p>
                  )}
                  {s.note && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-[var(--ds-text-muted)]">
                      {s.note}
                    </p>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(s)}
                    aria-label={t('forn.edit', 'Modifica {{nome}}', { nome: s.name })}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDeleteId(s.id)}
                    aria-label={t('forn.delete', 'Elimina {{nome}}', { nome: s.name })}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {isPendingDelete && (
                <div className="mt-3 rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] p-3">
                  <p className="text-[14px] text-[var(--ds-critical-text)]">
                    {t('forn.confirmDelete', 'Eliminare? I prodotti collegati resteranno senza fornitore.')}
                  </p>
                  <div className="mt-2.5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingDeleteId(null)}
                      disabled={isDeleting}
                      className="inline-flex h-10 items-center rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium text-[var(--ds-critical-text)] transition-opacity hover:opacity-80 disabled:opacity-50"
                    >
                      {t('forn.cancel', 'Annulla')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(s.id)}
                      disabled={isDeleting}
                      className="inline-flex h-10 items-center gap-1.5 rounded-[var(--ds-radius-control)] bg-[var(--ds-critical-solid)] px-4 text-[14px] font-semibold text-[var(--ds-critical-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      {isDeleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t('forn.deleteButton', 'Elimina')}
                    </button>
                  </div>
                </div>
              )}
            </FormCard>
          );
        })
      )}
    </ModalShell>
  );
};
