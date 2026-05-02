import React from 'react';
import { Trash2 } from 'lucide-react';

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title?: string;
  message: React.ReactNode;
  itemName?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  isOpen,
  title = 'Conferma Eliminazione',
  message,
  itemName,
  confirmLabel = 'Elimina',
  cancelLabel = 'Annulla',
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[70] p-4">
      <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
        <div className="px-5 py-6 text-center">
          <div className="mx-auto w-12 h-12 bg-rose-50 border border-rose-100 rounded-full flex items-center justify-center mb-4">
            <Trash2 className="h-5 w-5 text-rose-600" />
          </div>
          <h3 className="text-[15px] font-semibold text-[var(--color-fg)] mb-2">{title}</h3>
          <p className="text-sm text-[var(--color-fg-muted)] mb-1">{message}</p>
          {itemName && (
            <p className="text-base font-medium text-[var(--color-fg)] mb-3">{itemName}</p>
          )}
          <p className="text-xs text-[var(--color-fg-subtle)]">Questa azione non può essere annullata.</p>
        </div>
        <div className="flex gap-2 justify-end px-5 py-3 border-t border-[var(--color-line)]">
          <button
            onClick={onCancel}
            className="rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-full px-4 py-2 bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 transition"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
