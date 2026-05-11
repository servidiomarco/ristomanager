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
  // Optional visual overrides for reuse as a generic confirm modal.
  // Defaults preserve the original "delete" appearance.
  icon?: React.ReactNode;
  iconWrapperClassName?: string;
  confirmClassName?: string;
  showIrreversibleWarning?: boolean;
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
  icon,
  iconWrapperClassName = 'mx-auto w-12 h-12 bg-rose-50 border border-rose-100 dark:bg-rose-500/15 dark:border-rose-500/30 rounded-full flex items-center justify-center mb-4',
  confirmClassName = 'rounded-full px-4 py-2 bg-rose-600 text-[#ffffff] text-sm font-medium hover:bg-rose-700 transition',
  showIrreversibleWarning = true,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={onCancel}>
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-sm p-5 animate-in fade-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
        <div className="text-center">
          <div className={iconWrapperClassName}>
            {icon ?? <Trash2 className="h-5 w-5 text-rose-600" />}
          </div>
          <h3 className="text-[15px] font-semibold text-[var(--color-fg)] mb-2">{title}</h3>
          <p className="text-sm text-[var(--color-fg-muted)] mb-1">{message}</p>
          {itemName && (
            <p className="text-base font-medium text-[var(--color-fg)] mb-3">{itemName}</p>
          )}
          {showIrreversibleWarning && (
            <p className="text-xs text-[var(--color-fg-subtle)]">Questa azione non può essere annullata.</p>
          )}
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={confirmClassName}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
