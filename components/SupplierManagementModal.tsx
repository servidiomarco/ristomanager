import React, { useMemo, useState } from 'react';
import { useShopping } from '../contexts/ShoppingContext';
import { ShoppingCategory, Supplier } from '../services/shoppingApiService';
import { ChefHat, Coffee, Package, Plus, Loader2, X, Edit2, Trash2, Check } from 'lucide-react';

interface SupplierManagementModalProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: ShoppingCategory;
}

const CATEGORIES: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];

const CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  CUCINA: 'Cucina',
  BAR: 'Bar',
  ALTRO: 'Altro',
};

const CATEGORY_ICONS: Record<ShoppingCategory, React.ReactNode> = {
  CUCINA: <ChefHat className="h-4 w-4" />,
  BAR: <Coffee className="h-4 w-4" />,
  ALTRO: <Package className="h-4 w-4" />,
};

export const SupplierManagementModal: React.FC<SupplierManagementModalProps> = ({
  open,
  onClose,
  initialCategory,
}) => {
  const { suppliers, addSupplier, updateSupplier, deleteSupplier } = useShopping();
  const [activeCategory, setActiveCategory] = useState<ShoppingCategory>(initialCategory || 'CUCINA');

  // Add form
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newNote, setNewNote] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit row
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editNote, setEditNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete confirmation (inline)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  React.useEffect(() => {
    if (open && initialCategory) setActiveCategory(initialCategory);
  }, [open, initialCategory]);

  const suppliersInCategory = useMemo(
    () =>
      suppliers
        .filter(s => s.category === activeCategory)
        .sort((a, b) => a.name.localeCompare(b.name, 'it')),
    [suppliers, activeCategory],
  );

  if (!open) return null;

  const resetAddForm = () => {
    setNewName('');
    setNewPhone('');
    setNewNote('');
    setAddError(null);
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name || isAdding) return;
    try {
      setIsAdding(true);
      setAddError(null);
      await addSupplier({
        name,
        category: activeCategory,
        phone: newPhone.trim() || undefined,
        note: newNote.trim() || undefined,
      });
      resetAddForm();
    } catch (err: any) {
      setAddError(err?.message || 'Errore durante la creazione');
    } finally {
      setIsAdding(false);
    }
  };

  const startEdit = (s: Supplier) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditPhone(s.phone || '');
    setEditNote(s.note || '');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditPhone('');
    setEditNote('');
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editingId || isSaving) return;
    const name = editName.trim();
    if (!name) return;
    try {
      setIsSaving(true);
      setEditError(null);
      await updateSupplier(editingId, {
        name,
        phone: editPhone.trim() || null,
        note: editNote.trim() || null,
      });
      cancelEdit();
    } catch (err: any) {
      setEditError(err?.message || 'Errore durante il salvataggio');
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
    <div
      className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
          <div>
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Gestione fornitori</h3>
            <p className="text-xs text-[var(--color-fg-muted)]">Crea o modifica i fornitori per categoria</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex items-center gap-1.5 p-3 border-b border-[var(--color-line)] overflow-x-auto">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => {
                setActiveCategory(cat);
                cancelEdit();
                resetAddForm();
                setPendingDeleteId(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                activeCategory === cat
                  ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
              }`}
            >
              {CATEGORY_ICONS[cat]}
              {CATEGORY_LABELS[cat]}
              <span className="tabular opacity-70">
                ({suppliers.filter(s => s.category === cat).length})
              </span>
            </button>
          ))}
        </div>

        {/* Supplier list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {suppliersInCategory.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-fg-subtle)]">
              Nessun fornitore in questa categoria. Aggiungine uno qui sotto.
            </p>
          ) : (
            suppliersInCategory.map(s => {
              const isEditing = editingId === s.id;
              const isPendingDelete = pendingDeleteId === s.id;
              if (isEditing) {
                return (
                  <div
                    key={s.id}
                    className="p-3 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] space-y-2"
                  >
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="Nome"
                      autoFocus
                      className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-fg)]"
                    />
                    <input
                      type="tel"
                      value={editPhone}
                      onChange={e => setEditPhone(e.target.value)}
                      placeholder="Telefono (opzionale)"
                      className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-fg)]"
                    />
                    <textarea
                      value={editNote}
                      onChange={e => setEditNote(e.target.value)}
                      placeholder="Note (opzionali)"
                      rows={2}
                      className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-fg)] resize-none"
                    />
                    {editError && <p className="text-xs text-rose-600">{editError}</p>}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={cancelEdit}
                        disabled={isSaving}
                        className="text-xs px-3 py-1.5 rounded-full border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                      >
                        Annulla
                      </button>
                      <button
                        onClick={saveEdit}
                        disabled={!editName.trim() || isSaving}
                        className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] inline-flex items-center gap-1.5 disabled:opacity-40 hover:opacity-90"
                      >
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Salva
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={s.id}
                  className="p-3 rounded-lg border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-fg)] truncate">{s.name}</p>
                      {s.phone && (
                        <p className="text-xs text-[var(--color-fg-muted)] tabular mt-0.5">{s.phone}</p>
                      )}
                      {s.note && (
                        <p className="text-xs text-[var(--color-fg-subtle)] mt-1 whitespace-pre-wrap break-words">
                          {s.note}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => startEdit(s)}
                        className="p-1.5 rounded text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                        title="Modifica"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDeleteId(s.id)}
                        className="p-1.5 rounded text-[var(--color-fg-subtle)] hover:text-rose-600"
                        title="Elimina"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {isPendingDelete && (
                    <div className="mt-2 p-2 rounded bg-rose-50 dark:bg-rose-500/15 border border-rose-100 dark:border-rose-500/30 flex items-center justify-between gap-2">
                      <p className="text-xs text-rose-700 dark:text-rose-300">
                        Eliminare? I prodotti collegati resteranno senza fornitore.
                      </p>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => setPendingDeleteId(null)}
                          disabled={isDeleting}
                          className="text-xs px-2 py-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)]/70"
                        >
                          No
                        </button>
                        <button
                          onClick={() => handleDelete(s.id)}
                          disabled={isDeleting}
                          className="text-xs px-2 py-1 rounded bg-rose-500 hover:bg-rose-600 text-white inline-flex items-center gap-1"
                        >
                          {isDeleting && <Loader2 className="h-3 w-3 animate-spin" />}
                          Elimina
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Add form */}
        <div className="border-t border-[var(--color-line)] p-3 sm:p-4 space-y-2 bg-[var(--color-surface-2)]">
          <p className="text-xs font-medium text-[var(--color-fg-muted)] uppercase tracking-wide">
            Aggiungi a {CATEGORY_LABELS[activeCategory]}
          </p>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="Nome fornitore"
            className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2.5 py-2 focus:outline-none focus:border-[var(--color-fg)]"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="tel"
              value={newPhone}
              onChange={e => setNewPhone(e.target.value)}
              placeholder="Telefono (opzionale)"
              className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2.5 py-2 focus:outline-none focus:border-[var(--color-fg)]"
            />
            <input
              type="text"
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              placeholder="Nota breve (opzionale)"
              className="w-full text-sm bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-2.5 py-2 focus:outline-none focus:border-[var(--color-fg)]"
            />
          </div>
          {addError && <p className="text-xs text-rose-600">{addError}</p>}
          <div className="flex justify-end">
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || isAdding}
              className="text-sm px-3 py-1.5 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] inline-flex items-center gap-2 disabled:opacity-40 hover:opacity-90"
            >
              {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Aggiungi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
