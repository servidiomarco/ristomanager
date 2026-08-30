import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ModalShell, dsButton, dsInput } from '../ds';

// Estratto da OrderPad quando Cassa ha avuto bisogno dello stesso dialogo
// (docs/cassa-plan.md §8): stornare una riga chiede una motivazione in tutti
// e due i posti, e la route la pretende comunque (rifiuta sotto i 3
// caratteri). Il testo che la sala scrive qui è anche quello che ferma la
// cucina, quindi non è burocrazia.

// Dialogo con motivazione obbligatoria. Usato per gli storni: senza un motivo
// scritto, a fine mese lo scarto è un ammanco che nessuno sa spiegare.
export const ReasonDialog: React.FC<{
  title: string;
  hint: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}> = ({ title, hint, confirmLabel, busy, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const PRESETS = ['Errore di battitura', 'Cliente ha cambiato idea', 'Piatto non riuscito', 'Ingrediente finito'];
  return (
    <ModalShell
      open
      onClose={onCancel}
      title={title}
      subtitle={hint}
      size="sm"
      closeOnEscape
      bodyClassName="space-y-3 p-5 sm:p-6"
      footer={
        <button
          type="button"
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || reason.trim().length < 3}
          className={dsButton.critical}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(pr => (
          <button
            key={pr}
            type="button"
            onClick={() => setReason(pr)}
            aria-pressed={reason === pr}
            className={`inline-flex h-11 items-center rounded-full px-3.5 text-[14px] font-medium transition-colors ${
              reason === pr
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
            }`}
          >
            {pr}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        autoFocus
        placeholder="Motivazione"
        aria-label="Motivazione"
        className={dsInput}
      />
    </ModalShell>
  );
};
