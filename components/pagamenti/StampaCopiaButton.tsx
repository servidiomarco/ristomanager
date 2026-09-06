import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Printer } from 'lucide-react';

// ---------------------------------------------------------------------------
// «Stampa copia» con l'esito addosso. La termica è in un'altra stanza: senza
// un segnale sul bottone il cameriere non sa se il tocco è passato, e lo
// ripete — due copie in stampa. Tre stati: fermo, in invio (spinner), inviato
// (verde `seated` + spunta, che entra con `view-in` e rientra da solo).
// L'errore compare sotto, non in un flash di pagina che i modal coprono —
// è il motivo per cui questo componente esiste.
// ---------------------------------------------------------------------------

interface StampaCopiaButtonProps {
  /** Manda la stampa; il rifiuto diventa il messaggio d'errore sotto il bottone. */
  onPrint: () => Promise<unknown>;
  /** 'row' sta su una superficie piena; 'outline' su un fondo già a tono di
   *  riga, dove il grigio incassato sparirebbe. */
  variant?: 'row' | 'outline';
  /** Il documento in stampa, quando non è la copia dello scontrino
   *  (es. «Stampa proforma» / «Proforma in stampa»). */
  label?: string;
  sentLabel?: string;
  className?: string;
}

const SENT_MS = 4000;

export const StampaCopiaButton: React.FC<StampaCopiaButtonProps> = ({ onPrint, variant = 'row', label = 'Stampa copia', sentLabel = 'Copia in stampa', className = '' }) => {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);

  const print = async () => {
    if (state === 'sending') return;
    setError(null);
    setState('sending');
    try {
      await onPrint();
      setState('sent');
      timer.current = window.setTimeout(() => setState('idle'), SENT_MS);
    } catch (err: any) {
      setState('idle');
      setError(err?.data?.message ?? err?.data?.error ?? err?.message ?? 'Stampa non riuscita');
    }
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={print}
        disabled={state === 'sending'}
        aria-live="polite"
        className={`inline-flex h-11 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
          state === 'sent'
            ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
            : variant === 'outline'
              ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-border)] disabled:opacity-60'
              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-60'
        }`}
      >
        {state === 'sent' ? (
          <span className="animate-view-in inline-flex items-center gap-1.5">
            <Check size={15} aria-hidden /> {sentLabel}
          </span>
        ) : state === 'sending' ? (
          <>
            <Loader2 size={15} className="animate-spin" aria-hidden /> Stampa…
          </>
        ) : (
          <>
            <Printer size={15} aria-hidden /> {label}
          </>
        )}
      </button>
      {error && (
        <p className="animate-view-in mt-2 text-[13px] leading-snug text-[var(--ds-critical-text)]">
          {error}
        </p>
      )}
    </div>
  );
};
