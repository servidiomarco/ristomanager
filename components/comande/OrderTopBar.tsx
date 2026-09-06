import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRightLeft, Ban, Check, MoreVertical, Minus, Percent, Plus, Receipt, Rows3, Search, Trash2, Users,
} from 'lucide-react';
import { Sheet, StatusPill } from '../ds';
import { euro, rowCountLabel } from './orderView';

// ---------------------------------------------------------------------------
// La testata del palmare: chi è al tavolo, quanto sta spendendo, quanti sono, e
// le due uscite dalla schermata — il conto e il menu di ciò che non si fa tutti
// i giorni.
// ---------------------------------------------------------------------------

interface OrderTopBarProps {
  tableName: string;
  guestName: string | null;
  /** Ordine più bozze: è il numero che il cliente sentirebbe se chiedesse ora. */
  totalCents: number;
  rows: number;
  covers: number;
  /** Uscite già partite. Zero non si annuncia. */
  sentCourses: number;
  busy: boolean;
  billDisabled: boolean;
  clearDisabled: boolean;
  wide: boolean;
  /** Apre la ricerca piatti sul velo. Solo palmare: su schermo largo la
   *  ricerca sta inline nel menu, un secondo punto d'ingresso confonderebbe. */
  onSearch?: () => void;
  /** Vista compatta della lista piatti — preferenza personale dell'operatore,
   *  quindi vive nel menu ⋮ del tavolo, dove nasce il bisogno, non nelle
   *  Impostazioni. Solo palmare: la griglia larga non ha densità. */
  densityCompact?: boolean;
  onToggleDensity?: () => void;
  onBack: () => void;
  onCovers: (delta: number) => void;
  onBill: () => void;
  onDiscount: () => void;
  onTransfer: () => void;
  onClearDrafts: () => void;
  /** Elimina la comanda INTERA (righe battute comprese), finché non c'è un
   *  conto. Assente = chi guarda non ha il permesso di storno: la voce non
   *  compare. */
  onDeleteOrder?: () => void;
}

const stepper =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const OrderTopBar: React.FC<OrderTopBarProps> = ({
  tableName, guestName, totalCents, rows, covers, sentCourses, busy,
  billDisabled, clearDisabled, wide,
  onSearch, densityCompact, onToggleDensity,
  onBack, onCovers, onBill, onDiscount, onTransfer, onClearDrafts, onDeleteOrder,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Il menu ancorato si chiude cliccando fuori e con Escape. Il foglio si
  // chiude da solo — ha uno sfondo che dice dov'è il fuori.
  useEffect(() => {
    if (!menuOpen || !wide) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, wide]);

  interface MenuAction {
    icon: typeof Percent;
    label: string;
    onClick: () => void;
    disabled: boolean;
    critical: boolean;
    /** Presente solo sugli interruttori: spunta a destra quando attivo. */
    active?: boolean;
  }
  const actions: MenuAction[] = [
    { icon: Percent, label: 'Sconto', onClick: onDiscount, disabled: false, critical: false },
    { icon: ArrowRightLeft, label: 'Sposta tavolo', onClick: onTransfer, disabled: false, critical: false },
    ...(onToggleDensity ? [{
      icon: Rows3, label: 'Vista compatta', onClick: onToggleDensity,
      disabled: false, critical: false, active: densityCompact === true,
    }] : []),
    { icon: Trash2, label: 'Svuota le righe non inviate', onClick: onClearDrafts, disabled: clearDisabled, critical: true },
    // In fondo, dopo lo svuota-bozze: è il gesto più pesante del menu — via
    // TUTTA la comanda, righe già in cucina comprese.
    ...(onDeleteOrder ? [{
      icon: Ban, label: 'Elimina la comanda', onClick: onDeleteOrder,
      disabled: false, critical: true,
    }] : []),
  ];

  const menuTrigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setMenuOpen(v => !v)}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label="Altre azioni sulla comanda"
      // Cerchio incassato, non un glifo nudo: un'icona sospesa nel vuoto legge
      // come decorazione e non come bersaglio. Il grigio vale a entrambe le
      // larghezze perché a entrambe il bottone sta DENTRO la scheda di testata:
      // un livello 2 appoggiato sulla tela misura 1,03:1 e sparisce (§8.8), ed
      // è il motivo per cui anche sul telefono la testata è una scheda.
      className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    >
      <MoreVertical size={20} aria-hidden />
    </button>
  );

  const coversControl = (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[14px] text-[var(--ds-text-muted)]">
        <Users size={14} aria-hidden /> Coperti
      </span>
      <button
        type="button"
        onClick={() => onCovers(-1)}
        disabled={busy || covers <= 1}
        aria-label="Un coperto in meno"
        className={stepper}
      >
        <Minus size={16} />
      </button>
      <span className="w-7 text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
        {covers}
      </span>
      <button
        type="button"
        onClick={() => onCovers(+1)}
        disabled={busy}
        aria-label="Un coperto in più"
        className={stepper}
      >
        <Plus size={16} />
      </button>
    </div>
  );

  const billButton = (
    <button
      type="button"
      onClick={onBill}
      disabled={busy || billDisabled}
      title="Chiudi la comanda e apri il conto"
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
        billDisabled
          ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-subtle)]'
          : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
      }`}
    >
      <Receipt size={16} aria-hidden /> Conto
    </button>
  );

  const menuPanel = wide && menuOpen && (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full z-30 mt-2 w-[280px] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
    >
      {actions.map(a => (
        <button
          key={a.label}
          type="button"
          role={a.active !== undefined ? 'menuitemcheckbox' : 'menuitem'}
          aria-checked={a.active}
          disabled={a.disabled}
          onClick={() => { setMenuOpen(false); a.onClick(); }}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 ${
            a.critical ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
          }`}
        >
          <a.icon
            className={`h-4 w-4 flex-shrink-0 ${a.critical ? '' : 'text-[var(--ds-text-muted)]'}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          {a.active && <Check className="h-4 w-4 flex-shrink-0" aria-hidden />}
        </button>
      ))}
    </div>
  );

  const touchMenu = (
    <Sheet
      open={menuOpen && !wide}
      onClose={() => setMenuOpen(false)}
      title="Comanda"
      subtitle={`Tav. ${tableName}`}
      ariaLabel="Altre azioni sulla comanda"
      bodyClassName="px-4 py-4"
    >
      <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
        {actions.map((a, i) => (
          <button
            key={a.label}
            type="button"
            aria-pressed={a.active}
            disabled={a.disabled}
            onClick={() => { setMenuOpen(false); a.onClick(); }}
            className={`flex min-h-[56px] w-full items-center gap-3 px-4 text-left text-[16px] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40 ${
              i > 0 ? 'border-t border-[var(--ds-border)]' : ''
            } ${a.critical ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}
          >
            <a.icon
              className={`h-5 w-5 flex-shrink-0 ${a.critical ? '' : 'text-[var(--ds-text-muted)]'}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            {a.active && <Check className="h-5 w-5 flex-shrink-0" aria-hidden />}
          </button>
        ))}
      </div>
    </Sheet>
  );

  if (wide) {
    return (
      <>
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla scelta del tavolo"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0">
            <div className="truncate text-[19px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
              Tav. {tableName}
            </div>
            <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
              {guestName ? `${guestName} · ` : ''}Totale {euro(totalCents)}
            </div>
          </div>
          <span className="h-9 w-px flex-shrink-0 bg-[var(--ds-border)]" aria-hidden />
          {coversControl}
          <div className="ml-auto flex flex-shrink-0 items-center gap-2">
            {sentCourses > 0 && (
              <StatusPill tone="positive" className="h-8 px-3">
                {sentCourses === 1 ? '1 uscita inviata' : `${sentCourses} uscite inviate`}
              </StatusPill>
            )}
            {billButton}
            <div className="relative">
              {menuTrigger}
              {menuPanel}
            </div>
          </div>
        </div>
        {touchMenu}
      </>
    );
  }

  // Una scheda sola invece di controlli sparsi sulla tela. Serve a due cose:
  // raggruppa ciò che non cambia mentre si compone (chi è al tavolo, i coperti,
  // il conto), e dà ai bottoni incassati un livello 1 su cui appoggiarsi —
  // sulla tela nuda sarebbero invisibili.
  return (
    <>
      <div className="rounded-[20px] bg-[var(--ds-surface)] p-2.5 shadow-[var(--ds-shadow-card)]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla scelta del tavolo"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[20px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)]">
              Tav. {tableName}
            </div>
            <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
              {guestName ? `${guestName} · ` : ''}
              {rows === 0 ? 'nessuna riga' : `${rowCountLabel(rows)} · ${euro(totalCents)}`}
            </div>
          </div>
          {/* La lente accanto ai puntini, stessa forma incassata: la ricerca
              piatti non occupa più una riga del menu. */}
          {onSearch && (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Cerca un piatto"
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Search size={20} aria-hidden />
            </button>
          )}
          {menuTrigger}
        </div>

        {/* Coperti e conto sulla stessa riga: sono le due cose che si toccano
            senza guardare, e stanno sopra la pista delle uscite perché non
            cambiano mentre si compone. */}
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--ds-border)] pt-2">
          <div className="flex-shrink-0">{coversControl}</div>
          <div className="min-w-0 flex-1 [&>button]:w-full">{billButton}</div>
        </div>
      </div>
      {touchMenu}
    </>
  );
};
