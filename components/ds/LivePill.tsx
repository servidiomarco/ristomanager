import React from 'react';

// ---------------------------------------------------------------------------
// Lo stato della connessione e l'ora, in una pastiglia sola.
//
// Estratta dalla testata globale quando Comande ha smesso di averla: a schermo
// pieno la chrome è della pagina, ma «Live 19:12» deve restare — è l'unico
// posto in cui il palmare dice di essere ancora attaccato al server, e un
// cameriere che batte offline non se ne accorge da nient'altro.
//
// Il pallino pulsa, ma sotto prefers-reduced-motion diventa colore fermo: il
// segnale non si toglie mai, si toglie solo il movimento.
// ---------------------------------------------------------------------------

interface LivePillProps {
  connected: boolean;
  /** L'ora da mostrare. Chi possiede la pastiglia possiede anche il suo tick. */
  time: Date;
  /** 'pill' è la testata (fondo tinto); 'dot' è il solo pallino del telefono. */
  variant?: 'pill' | 'dot';
  className?: string;
}

export const LivePill: React.FC<LivePillProps> = ({ connected, time, variant = 'pill', className = '' }) => {
  const label = connected ? 'Connesso' : 'Non connesso';

  if (variant === 'dot') {
    return (
      <span
        className={`relative flex h-2.5 w-2.5 ${className}`}
        role="status"
        aria-live={connected ? 'polite' : 'assertive'}
        aria-label={label}
        title={label}
      >
        {connected && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden" aria-hidden></span>
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}
          aria-hidden
        ></span>
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 pl-2.5 pr-3 h-10 rounded-full text-[15px] font-medium ${
        connected
          ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
          : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
      } ${className}`}
      role="status"
      aria-live={connected ? 'polite' : 'assertive'}
      aria-label={label}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {connected && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden"></span>
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}></span>
      </span>
      <span className="whitespace-nowrap tabular-nums">
        {connected
          ? `Live ${time.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
          : 'Offline'}
      </span>
    </div>
  );
};
