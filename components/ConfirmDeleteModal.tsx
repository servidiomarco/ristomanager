import React from 'react';
import { Trash2 } from 'lucide-react';
import { ModalShell, dsButton } from './ds';

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
  iconWrapperClassName = 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-critical-tint)]',
  // §7.5: la conferma distruttiva e' l'unico posto dove `critical` porta
  // peso pieno — l'intenzione e' gia' stata presa.
  confirmClassName = dsButton.critical,
  showIrreversibleWarning = true,
}) => {
  if (!isOpen) return null;

  return (
    <ModalShell
      open={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      // Si apre spesso sopra un altro modal: teniamo lo z-index esplicito
      // invece di affidarci all'ordine di pittura.
      className="!z-[60]"
      bodyClassName="px-5 py-5 sm:px-6"
      footer={
        <>
          <button type="button" onClick={onCancel} className={dsButton.secondary}>
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className={confirmClassName}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-center">
        <div className={iconWrapperClassName}>
          {icon ?? <Trash2 className="h-5 w-5 text-[var(--ds-critical-text)]" aria-hidden />}
        </div>
        <p className="mb-1 text-[15px] text-[var(--ds-text-secondary)]">{message}</p>
        {itemName && (
          <p className="mb-3 text-[15px] font-semibold text-[var(--ds-text-primary)]">{itemName}</p>
        )}
        {showIrreversibleWarning && (
          <p className="text-[13px] text-[var(--ds-text-muted)]">Questa azione non può essere annullata.</p>
        )}
      </div>
    </ModalShell>
  );
};
