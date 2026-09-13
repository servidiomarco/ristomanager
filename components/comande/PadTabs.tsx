import React from 'react';
import { BookOpen, ClipboardList, LayoutGrid } from 'lucide-react';

// ---------------------------------------------------------------------------
// La barra inferiore della variante a pagine (stile cassa): Tavoli, Comanda,
// Menu — le tre sezioni di chi arriva dall'app di Passepartout, dove stavano
// esattamente qui. Il Menu è la pagina residente (evidenziata), la Comanda
// apre il foglio comanda, Tavoli esce dal tavolo.
//
// Il pallino su Comanda dice «ci sono bozze da inviare»: è la stessa
// grammatica dei pallini sulle pastiglie uscita (§4.3) — c'è o non c'è,
// il colore non porta l'informazione da solo.
// ---------------------------------------------------------------------------

interface PadTabsProps {
  onTables: () => void;
  onComanda: () => void;
  /** Torna alla pagina delle categorie quando si è dentro una categoria. */
  onMenu: () => void;
  /** Bozze non ancora inviate: pallino accanto a «Comanda». */
  comandaMarked?: boolean;
}

const tabClass =
  'flex flex-1 flex-col items-center gap-0.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[14px]';

export const PadTabs: React.FC<PadTabsProps> = ({ onTables, onComanda, onMenu, comandaMarked }) => (
  // La barra è a tutta larghezza dentro un contenitore col padding: i margini
  // negativi la portano ai bordi, il padding interno rimette i contenuti in
  // colonna col resto. Il safe-area sta qui: la barra possiede lo spazio
  // sotto di sé (regola 10).
  <div className="-mx-4 flex flex-shrink-0 gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-6 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5">
    <button type="button" onClick={onTables} className={tabClass}>
      <span className="flex h-8 w-14 items-center justify-center rounded-full text-[var(--ds-text-muted)]">
        <LayoutGrid size={21} aria-hidden />
      </span>
      <span className="text-[12px] font-semibold text-[var(--ds-text-muted)]">Tavoli</span>
    </button>
    <button type="button" onClick={onComanda} className={tabClass}>
      <span className="flex h-8 w-14 items-center justify-center rounded-full text-[var(--ds-text-muted)]">
        <ClipboardList size={21} aria-hidden />
      </span>
      <span className="flex items-center gap-1 text-[12px] font-semibold text-[var(--ds-text-muted)]">
        Comanda
        {comandaMarked && (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-text-muted)]" aria-hidden />
        )}
      </span>
    </button>
    <button type="button" onClick={onMenu} aria-current="page" className={tabClass}>
      <span className="flex h-8 w-14 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]">
        <BookOpen size={21} aria-hidden />
      </span>
      <span className="text-[12px] font-semibold text-[var(--ds-text-primary)]">Menu</span>
    </button>
  </div>
);
