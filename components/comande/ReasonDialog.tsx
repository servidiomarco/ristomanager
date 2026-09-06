import React, { useState } from 'react';
import { Loader2, Minus, Plus } from 'lucide-react';
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
  /** Sopra 1 compare il selettore di quantità: «erano 2, ne torna indietro
   *  1». Parte dalla riga intera, che resta lo storno di sempre. */
  maxQty?: number;
  onCancel: () => void;
  onConfirm: (reason: string, qty?: number) => void;
}> = ({ title, hint, confirmLabel, busy, maxQty, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState(maxQty ?? 1);
  const partial = maxQty != null && maxQty > 1;
  const PRESETS = ['Errore di battitura', 'Cliente ha cambiato idea', 'Piatto non riuscito', 'Ingrediente finito'];
  const stepper =
    'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
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
          onClick={() => onConfirm(reason.trim(), partial ? qty : undefined)}
          disabled={busy || reason.trim().length < 3}
          className={dsButton.critical}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {partial && qty < maxQty! ? `Storna ${qty} di ${maxQty}` : confirmLabel}
        </button>
      }
    >
      {partial && (
        <div className="flex items-center justify-between gap-3 rounded-[14px] bg-[var(--ds-surface-row)] p-2 pl-4">
          <span className="text-[14px] text-[var(--ds-text-secondary)]">Quantità</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setQty(q => Math.max(1, q - 1))}
              disabled={busy || qty <= 1}
              aria-label="Storna un pezzo in meno"
              className={stepper}
            >
              <Minus size={16} />
            </button>
            <span className="min-w-[64px] text-center text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {qty} di {maxQty}
            </span>
            <button
              type="button"
              onClick={() => setQty(q => Math.min(maxQty!, q + 1))}
              disabled={busy || qty >= maxQty!}
              aria-label="Storna un pezzo in più"
              className={stepper}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
      )}
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
