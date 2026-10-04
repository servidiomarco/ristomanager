import React from 'react';
import type { ActivityLine } from './model/activity';

export type { ActivityLine } from './model/activity';

/* La striscia delle attività: in basso a sinistra sopra la sala, le ultime
 * cose successe («4 (2 bambini) + cane → tavolo 40», «3 tavoli aggiornati»),
 * la più recente in alto. Chi guarda lo schermo all'ingresso vede che cosa è
 * cambiato anche se in quell'istante guardava altrove.
 *
 * I testi arrivano già composti dalla pagina (model/activity.ts), che sa i
 * nomi (solo a nomi accesi) e le traduzioni: qui niente i18n e niente
 * regista, solo il disegno. Non prende i tocchi: la sala sotto si trascina
 * anche da lì.
 *
 * Due testi per riga. Quello che si vede, diviso in due: chi (si accorcia
 * coi puntini se non ci sta) e dove (non si accorcia mai: su un telefono la
 * fine della riga, «→ 41», era proprio quella che spariva). E quello che si
 * sente, una frase senza frecce né «più», che lo screen reader legge una
 * volta: la pastiglia gli è nascosta.
 *
 * Sempre montata, anche vuota: uno screen reader annuncia di sicuro una riga
 * che entra in una regione viva che c'era già, non sempre una regione che
 * compare insieme al suo testo. */

export function ActivityStrip({ lines, label }: { lines: readonly ActivityLine[]; label: string }): React.JSX.Element {
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={label}
      className="pointer-events-none absolute bottom-3 left-3 flex max-w-[min(28rem,70%)] flex-col items-start gap-1.5"
    >
      {lines.map(line => (
        <div key={line.id} className="flex max-w-full">
          {/* Una pastiglia su --ds-surface come gli avvisi del palco: sul
              fondo della sala il testo da solo non arriverebbe al contrasto.
              animate-view-in è il keyframe dell'app; col movimento ridotto
              index.css lo annulla. */}
          <p
            aria-hidden="true"
            className="animate-view-in flex max-w-full items-baseline gap-1 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 py-1.5 text-[13px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]"
          >
            <span className="min-w-0 truncate">{line.lead}</span>
            {line.tail !== '' && <span className="flex-shrink-0 whitespace-nowrap">{line.tail}</span>}
          </p>
          <span className="sr-only">{line.spoken}</span>
        </div>
      ))}
    </div>
  );
}
