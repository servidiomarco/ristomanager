import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

// Barra di navigazione del telefono: una pillola di sole icone con
// l'indicatore che scivola sotto la scheda attiva, e accanto un pulsante
// tondo che TRASFORMA la pillola nel pannello delle azioni «Crea» invece di
// aprire un foglio sopra. Il pannello nasce dove c'era la barra, quindi il
// pollice non fa strada: le azioni compaiono dove stava già guardando.
// Le animazioni vivono in index.css (blocco «Barra mobile»), il componente
// si limita a dichiarare gli stati con data-attribute.

export interface MobileTab {
  key: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}

export interface MobileAction {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

interface MobileTabBarProps {
  tabs: MobileTab[];
  /** Vuoto = niente pulsante «+» (vista Piattaforma). */
  actions: MobileAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden?: boolean;
  ariaLabel: string;
  createLabel: string;
  closeLabel: string;
}

const MobileTabBar: React.FC<MobileTabBarProps> = ({
  tabs, actions, open, onOpenChange, hidden = false, ariaLabel, createLabel, closeLabel,
}) => {
  const panelId = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [slotW, setSlotW] = useState(0);
  const [gridH, setGridH] = useState(0);

  // Il pannello cresce fino all'altezza vera della griglia (cambia col
  // numero di azioni, che dipende dai permessi) e i due strati interni
  // restano larghi quanto la barra anche mentre il contenitore si stringe:
  // così durante la trasformazione il contenuto viene ritagliato, non
  // schiacciato in tre colonne sempre più strette.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const grid = gridRef.current;
    if (!slot) return;
    const measure = () => {
      setSlotW(slot.offsetWidth);
      if (grid) setGridH(grid.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(slot);
    if (grid) ro.observe(grid);
    return () => ro.disconnect();
  }, [actions.length]);

  // Le animazioni «una tantum» (stiramento dell'indicatore, colpo del «+»,
  // pizzico del contenitore) ripartono alternando due keyframe identici:
  // rimontare l'elemento le farebbe ripartire ma interromperebbe la rotazione
  // del «+» e perderebbe il focus. Zero = mai mosso, nessuna animazione al
  // primo render. I contatori si aggiornano durante il render (stato
  // derivato), non in un effetto: così il keyframe parte nello stesso
  // fotogramma del cambio, non in quello dopo.
  const activeIndex = tabs.findIndex(tab => tab.active);
  const [moved, setMoved] = useState({ index: activeIndex, n: 0 });
  if (moved.index !== activeIndex) {
    setMoved({ index: activeIndex, n: moved.index !== -1 && activeIndex !== -1 ? moved.n + 1 : moved.n });
  }
  const [toggled, setToggled] = useState({ open, n: 0 });
  if (toggled.open !== open) setToggled({ open, n: toggled.n + 1 });
  const moves = moved.n;
  const toggles = toggled.n;

  const [presses, setPresses] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const hasActions = actions.length > 0;
  const isOpen = open && hasActions;
  const parity = (n: number) => (n === 0 ? undefined : n % 2 ? 'a' : 'b');

  return (
    <>
      <div
        aria-hidden
        onClick={() => onOpenChange(false)}
        className={`fixed inset-0 z-[29] bg-[var(--ds-backdrop)] transition-opacity duration-300 lg:hidden ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${hidden ? 'hidden' : ''}`}
      />
      <nav
        aria-label={ariaLabel}
        className={`ds-tabbar fixed inset-x-4 z-30 flex items-end gap-2 lg:hidden ${hidden ? 'hidden' : ''}`}
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        <div ref={slotRef} className="relative h-[60px] min-w-0 flex-1">
          <div
            className="ds-tabbar-morph ds-tabbar-glass"
            data-open={isOpen ? 'true' : 'false'}
            data-toggle={parity(toggles)}
            style={{
              '--ds-tabbar-w': slotW ? `${slotW}px` : '100%',
              '--ds-tabbar-h': `${Math.max(gridH, 60)}px`,
            } as React.CSSProperties}
          >
            {/* Schede */}
            <div className="ds-tabbar-layer ds-tabbar-tabs" inert={isOpen}>
              <span
                aria-hidden
                className="ds-tabbar-indicator"
                data-move={parity(moves)}
                style={{
                  width: `calc((100% - 12px) / ${Math.max(tabs.length, 1)})`,
                  transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
                  opacity: activeIndex === -1 ? 0 : 1,
                }}
              >
                <span className="ds-tabbar-indicator-blob" />
              </span>
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={tab.onClick}
                  aria-current={tab.active ? 'page' : undefined}
                  aria-label={tab.label}
                  className={`ds-tabbar-tab relative z-[1] flex h-full min-w-0 flex-1 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    tab.active ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)]'
                  }`}
                >
                  <span className="relative [&>svg]:size-[22px]">
                    {tab.icon}
                    {tab.badge !== undefined && tab.badge > 0 && (
                      <span className="absolute -top-1.5 -right-2 flex h-4 min-w-[16px] items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-critical-solid)] px-1 text-[9px] font-semibold tabular-nums text-[var(--ds-critical-fg)] ring-2 ring-[var(--ds-surface)]">
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>

            {/* Azioni «Crea» */}
            {hasActions && (
              <div
                ref={gridRef}
                id={panelId}
                className="ds-tabbar-layer ds-tabbar-grid grid grid-cols-3 gap-x-2 gap-y-3 p-3"
                inert={!isOpen}
              >
                {actions.map(action => (
                  <button
                    key={action.key}
                    type="button"
                    onClick={action.onClick}
                    className="ds-tabbar-tile flex min-w-0 flex-col items-center gap-1.5 rounded-[var(--ds-radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <span className="ds-tabbar-tile-face flex h-14 w-full max-w-[64px] items-center justify-center rounded-[var(--ds-radius)] text-[var(--ds-text-primary)] [&>svg]:size-6">
                      {action.icon}
                    </span>
                    <span className="max-w-full truncate text-[12px] font-medium text-[var(--ds-text-secondary)]">
                      {action.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {hasActions && (
          <button
            type="button"
            onClick={() => { setPresses(n => n + 1); onOpenChange(!open); }}
            aria-expanded={isOpen}
            aria-controls={panelId}
            aria-label={isOpen ? closeLabel : createLabel}
            className="ds-tabbar-fab relative h-[60px] w-[60px] shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            data-press={parity(presses)}
          >
            <span className="ds-tabbar-fab-face ds-tabbar-glass absolute inset-0 flex items-center justify-center rounded-full text-[var(--ds-text-primary)]">
              <span aria-hidden className="ds-tabbar-fab-flash absolute inset-0 rounded-full" />
              <Plus
                className="ds-tabbar-fab-icon relative h-6 w-6"
                style={{ transform: isOpen ? 'rotate(135deg)' : 'rotate(0deg)' }}
              />
            </span>
          </button>
        )}
      </nav>
    </>
  );
};

export default MobileTabBar;
