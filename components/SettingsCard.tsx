import React, { createContext, useContext } from 'react';
import { ChevronRight, Settings as Cog } from 'lucide-react';

/* ── Impostazioni: i mattoni della pagina ─────────────────────────────────
   Un blocco con titolo e una riga che dice a cosa serve, una griglia di card
   su due colonne quando c'è spazio, e card tutte con la stessa testata:
   icona, titolo, spiegazione, a destra lo stato e la rotella che apre le
   regolazioni.

   La testata era ricopiata a mano in una quindicina di componenti, ognuno
   con la sua variante (14 o 15px, descrizione troncata o no, freccia o
   niente): qui ce n'è una, e chi ha bisogno della sua card la usa invece di
   riscriverla.

   La card resta un <details>: l'apertura non è stato applicativo e non deve
   passare per React, e il corpo resta nel DOM anche chiuso — è lì che lo
   cerca la ricerca (components/settingsSearch.ts). */

type IconType = React.ComponentType<{ className?: string }>;
export type SettingsIconTone = 'neutral' | 'pending' | 'positive' | 'ai';

/** Quali blocchi sono a schermo: quelli della scheda scelta, o tutti mentre
 *  si cerca. Fuori dalla pagina Impostazioni ogni blocco è visibile. */
export const SettingsVisibleContext = createContext<(id?: string) => boolean>(() => true);

/** La card: superficie, raggio delle scatole, ombra. Per i componenti che
 *  hanno bisogno del loro <details> (stato a destra, corpo proprio). Aperta,
 *  prende tutta la riga della griglia (vedi settingsGridClass): la regola sta
 *  sulla card e non sulla griglia perché tante card arrivano dentro un
 *  componente che ne monta più d'una. */
export const settingsCardClass = 'group overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] @4xl:open:col-span-2';

/** La griglia delle card di un blocco. Due colonne da 56rem di contenitore
 *  in su (la colonna della pagina è un @container): sotto, una colonna
 *  larga meno di ~440px schiaccia titolo, stato e interruttore in una riga.
 *  Una card aperta prende tutta la riga — dentro ci sono tabelle, orari,
 *  editor che a metà larghezza non stanno. Le card di settingsCardClass lo
 *  fanno da sé; qui la stessa regola per un figlio che ha la card dentro
 *  (un involucro, un error boundary che disegna il suo div) e per le card a
 *  stato React (aria-expanded). */
export const settingsGridClass =
  'grid grid-cols-1 gap-3 @4xl:grid-cols-2 ' +
  '@4xl:[&>*:has(details[open])]:col-span-2 @4xl:[&>*:has([aria-expanded=true])]:col-span-2';

/** Per una card che è già una lista aperta (attività, promemoria): sempre
 *  su tutta la riga. */
export const settingsWideClass = '@4xl:col-span-2';

export const SettingsSection: React.FC<{
  id?: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ id, label, description, children }) => {
  const isVisible = useContext(SettingsVisibleContext);
  return (
    // scroll-mt: quando un collegamento salta qui, l'intestazione non finisce
    // sotto la testata incollata in cima. I data-imp-* sono i segni che legge
    // la ricerca: le card da filtrare sono le figlie di [data-imp-lista], o
    // del contenuto se manca.
    <section
      id={id}
      hidden={!isVisible(id)}
      className="mb-10 scroll-mt-36 last:mb-0"
      data-imp-sezione=""
      data-imp-etichetta={label}
    >
      <h2 className="px-1 text-[16px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{label}</h2>
      {description && (
        <p className="mt-0.5 px-1 text-[13px] leading-snug text-[var(--ds-text-muted)]">{description}</p>
      )}
      <div className="mt-3" data-imp-contenuto="">{children}</div>
    </section>
  );
};

/** L'icona a sinistra di ogni card. Il raggio è quello delle cose dentro una
 *  scatola, non della scatola stessa. */
export const SettingsIcon: React.FC<{ icon: IconType; tone?: SettingsIconTone }> = ({ icon: Icon, tone = 'neutral' }) => (
  <span
    className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-sm)] ${
      tone === 'pending' ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
      : tone === 'positive' ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
      : tone === 'ai' ? 'bg-[var(--ds-surface-row)] text-[var(--ds-arriving-text)]'
      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
    }`}
  >
    <Icon className="h-[18px] w-[18px]" />
  </span>
);

/* La rotella: dice «qui dentro si regola», al posto della freccia. Non è un
   bottone a sé — il bersaglio è la riga intera — e si accende quando la card
   è aperta. Il selettore guarda il <details> di questa testata e non uno più
   esterno: con group-open una card chiusa dentro una aperta sembrava aperta. */
const CogMark: React.FC<{ expanded?: boolean }> = ({ expanded }) => (
  <span
    aria-hidden
    className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] transition-colors ${
      expanded
        ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
        : 'text-[var(--ds-text-muted)] [details[open]>summary>&]:bg-[var(--ds-surface-row)] [details[open]>summary>&]:text-[var(--ds-text-primary)]'
    }`}
  >
    <Cog className="h-4 w-4" />
  </span>
);

const rowClass =
  'flex min-h-[72px] w-full cursor-pointer select-none list-none items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] [&::-webkit-details-marker]:hidden';

const SummaryBody: React.FC<{
  icon: IconType;
  tone?: SettingsIconTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  trailing?: React.ReactNode;
}> = ({ icon, tone, title, description, badge, trailing }) => (
  <>
    <SettingsIcon icon={icon} tone={tone} />
    {/* Testo e stato vanno a capo insieme: quando al testo resterebbero meno
        di 10rem (il telefono, uno stato lungo come «Non configurato») lo
        stato scende sotto la spiegazione invece di stringerla in una
        colonna di sei righe. L'interruttore, corto, resta a destra. */}
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-[10rem] flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{title}</span>
          {badge}
        </span>
        {description && (
          <span className="mt-0.5 block text-[13px] leading-snug text-[var(--ds-text-muted)]">{description}</span>
        )}
      </span>
      {trailing && <span className="flex flex-shrink-0 items-center gap-2">{trailing}</span>}
    </span>
  </>
);

/** La testata di una card di Impostazioni, da mettere come primo figlio del
 *  suo <details className={settingsCardClass}>. `trailing` è lo stato a
 *  destra (pastiglia, interruttore): chi ci mette un bottone fermi il click
 *  (preventDefault + stopPropagation), o aprirebbe la card. */
export const SettingsSummary: React.FC<{
  icon: IconType;
  tone?: SettingsIconTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  trailing?: React.ReactNode;
}> = props => (
  <summary className={rowClass}>
    <SummaryBody {...props} />
    <CogMark />
  </summary>
);

/** La stessa testata per le card che si aprono con uno stato React invece
 *  che con un <details> (quelle che montano il corpo solo da aperte). */
export const SettingsSummaryButton: React.FC<{
  icon: IconType;
  tone?: SettingsIconTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  trailing?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  controls?: string;
}> = ({ expanded, onToggle, controls, ...props }) => (
  <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={controls} className={rowClass}>
    <SummaryBody {...props} />
    <CogMark expanded={expanded} />
  </button>
);

/** Una card che si apre in posto. */
export const SettingsDisclosure: React.FC<{
  icon: IconType;
  iconTone?: SettingsIconTone;
  title: string;
  description: string;
  badge?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, iconTone, title, description, badge, trailing, children }) => (
  <details className={settingsCardClass}>
    <SettingsSummary icon={icon} tone={iconTone} title={title} description={description} badge={badge} trailing={trailing} />
    <div className="border-t border-[var(--ds-border)] px-4 pb-4 pt-3">{children}</div>
  </details>
);

/** Una card che porta da un'altra parte: stessa anatomia, freccia a destra. */
export const SettingsNavCard: React.FC<{
  icon: IconType;
  title: string;
  description: string;
  onClick: () => void;
}> = ({ icon, title, description, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`${settingsCardClass} ${rowClass}`}
  >
    <SummaryBody icon={icon} title={title} description={description} />
    <span aria-hidden className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center text-[var(--ds-text-muted)]">
      <ChevronRight className="h-4 w-4" />
    </span>
  </button>
);
