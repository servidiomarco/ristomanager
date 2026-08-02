import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Search, X } from 'lucide-react';

/**
 * Page-level building blocks: the header, the list-plus-detail layout, the
 * section eyebrow, the avatar, the status pill, the search field, the callout
 * and the empty state.
 *
 * These exist because the three Comunicazioni pages each invented their own
 * version of all of them. One implementation means a change to row density or
 * badge contrast lands everywhere at once.
 */

/** Tracks a media query. Used to pick a container, not to style — the choice
 *  between a sheet and a pane, or a dropdown and a page, changes the tree,
 *  which CSS can't express. */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
};

/* ── SplitPane ────────────────────────────────────────────────────────────
   The list-plus-thread layout shared by all three Comunicazioni channels.

   Rows sit on the canvas as their own cards at every width, so a list reads
   the same whether it's the whole page or a sidebar.

   The detail changes container by size, not just by CSS. On desktop it's a
   pane beside the list. On a phone it's a full-screen sheet portaled to
   <body>: reading a call or a thread is a focused task, and leaving the top
   bar, the channel switcher and the bottom nav framing it just crowds the
   content. It renders in exactly one place at a time — mounting it twice would
   mean two audio elements and two fetches. */
export const SplitPane: React.FC<{
  /** A conversation is open. */
  detailOpen: boolean;
  /** Search and actions. Pinned on desktop, scrolls with the list on mobile. */
  toolbar: React.ReactNode;
  list: React.ReactNode;
  detail: React.ReactNode;
}> = ({ detailOpen, toolbar, list, detail }) => {
  const isWide = useMediaQuery('(min-width: 768px)');
  const asSheet = detailOpen && !isWide;

  // Lock the page behind the sheet, the way ModalShell does — otherwise a
  // scroll gesture over it moves the list underneath.
  useEffect(() => {
    if (!asSheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [asSheet]);

  return (
  <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)] md:flex-row">
    {asSheet && createPortal(
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex flex-col bg-[var(--ds-canvas)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {detail}
      </div>,
      document.body
    )}
    <aside
      // Wide enough that a name, a timestamp and a preview line all fit
      // without the preview collapsing to three words. Grows with the viewport
      // rather than staying at a phone-shaped 320px on a 27" screen.
      //
      // Never hidden: the sheet covers it, so the list keeps its scroll
      // position for when you come back.
      className="flex w-full min-h-0 flex-col overflow-y-auto px-4 md:w-[340px] md:overflow-hidden md:border-r md:border-[var(--ds-border)] lg:w-[400px] xl:w-[440px]"
    >
      {/* Sticky on mobile, where the whole pane scrolls: rows pass behind the
          toolbar instead of sliding up under the switcher and touching it. The
          vertical padding lives here, not on the aside, so nothing shows above
          it — and -mx-4/px-4 stretches the backing colour to the full pane
          width, otherwise rows show through the gutters either side of it.

          No top padding below lg: the channel switcher sits directly above and
          already owns that gap, so adding it here would double it. */}
      <div className="sticky top-0 z-10 -mx-4 flex-shrink-0 bg-[var(--ds-canvas)] px-4 pb-3 md:static lg:pt-4">
        {toolbar}
      </div>
      {/* The negative margin pushes the scrollbar out into the aside's own
          padding, so it rides the edge instead of pressing on the cards. */}
      <div className="pb-4 md:-mr-4 md:min-h-0 md:flex-1 md:overflow-y-auto md:pr-4">{list}</div>
    </aside>
    <section className="hidden min-w-0 flex-1 flex-col md:flex">
      {asSheet ? null : detail}
    </section>
  </div>
  );
};

/* ── PaneHeader ───────────────────────────────────────────────────────────
   The top of an open record. A card floating on the canvas rather than a flush
   bar, so the detail side is built from the same blocks as the list side. */
export const PaneHeader: React.FC<{
  /** Rendered as a circular button, mobile only — desktop shows the list. */
  onBack?: () => void;
  backLabel?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Sits inline after the title: a channel or status pill. */
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ onBack, backLabel = 'Indietro', title, subtitle, badge, actions }) => (
  // pb-4 is load-bearing. Below this sits an opaque scrolling region that
  // paints later, so with no bottom padding it covers this card's shadow and
  // cuts it with a hard line — and slices whatever card is scrolling past.
  // The gap has to live inside the fixed element, not the scrolling one.
  //
  // Horizontal padding matches the page ramp used elsewhere in the app, so the
  // detail column lines up with everything else rather than hugging its edge.
  <div className="flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 lg:px-8">
    <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] md:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            {title}
          </h2>
          {badge}
        </div>
        {subtitle && (
          <p className="truncate text-[13px] text-[var(--ds-text-muted)]">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  </div>
);

/* ── PanePlaceholder ──────────────────────────────────────────────────────
   What the detail side shows before anything is picked. Icon over one line,
   no heading — the pane is empty, and a title only adds something else to
   read. Shared so the three channels can't drift apart in wording. */
export const PanePlaceholder: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}> = ({ icon: Icon, children }) => (
  <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
    <Icon className="mb-3 h-10 w-10 text-[var(--ds-text-subtle)]" aria-hidden />
    <p className="text-[14px] text-[var(--ds-text-muted)]">{children}</p>
  </div>
);

/* ── StatusPill ───────────────────────────────────────────────────────────
   Every state badge in the app, one component. Each tone pairs a tint with the
   text colour proven against it, so no caller has to re-derive contrast. */
export type PillTone = 'neutral' | 'positive' | 'pending' | 'critical' | 'info';

const PILL_TONE: Record<PillTone, string> = {
  neutral: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]',
  positive: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  pending: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
  critical: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]',
  info: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]',
};

export const StatusPill: React.FC<{
  tone?: PillTone;
  title?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = 'neutral', title, className = '', children }) => (
  <span
    title={title}
    className={`inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium ${PILL_TONE[tone]} ${className}`}
  >
    {children}
  </span>
);

/* ── CountBadge ───────────────────────────────────────────────────────────
   A count is always a circle in this app, never bare text beside a heading.
   The pill shape is what separates "3 of these" from a stray numeral. */
export const CountBadge: React.FC<{
  count: number;
  /** 'alert' for anything unread or unhandled; 'neutral' for a plain total. */
  tone?: 'neutral' | 'alert';
  /** Counts above this render as "99+" rather than stretching the row. */
  max?: number;
  className?: string;
}> = ({ count, tone = 'neutral', max = 99, className = '' }) => (
  <span
    className={`inline-flex h-6 min-w-[24px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums ${
      tone === 'alert'
        ? 'bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)]'
        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
    } ${className}`}
  >
    {count > max ? `${max}+` : count}
  </span>
);

/* ── iconButton ───────────────────────────────────────────────────────────
   The round control that sits beside a search field. White on the canvas, not
   the recessed grey: a level-2 surface on the canvas measures about 1.03:1 and
   effectively disappears, leaving a bare glyph with no hit area you can see. */
export const dsIconButton =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/* ── SearchField ──────────────────────────────────────────────────────────
   Always visible, never behind a toggle: on a list you filter before you
   scroll, and a hidden search costs a tap plus the memory that it's there.
   White for the same reason as the icon buttons above. */
export const SearchField: React.FC<{
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}> = ({ value, onChange, placeholder, ariaLabel = 'Cerca', className = '' }) => (
  <div className={`relative ${className}`}>
    <Search
      className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
      aria-hidden
    />
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="h-11 w-full rounded-full bg-[var(--ds-surface)] pl-11 pr-11 text-[15px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        aria-label="Svuota ricerca"
        className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
      >
        <X className="h-4 w-4" />
      </button>
    )}
  </div>
);

/* ── SectionHeader ────────────────────────────────────────────────────────
   The eyebrow above a group of rows. A leading dot marks a group that wants
   attention; the plain muted variant marks the remainder. Sentence case, never
   caps — capitals are harder to read at small sizes and screen readers can
   spell them out letter by letter. Weight and colour carry the hierarchy. */
export type SectionTone = 'attention' | 'positive' | 'muted';

const SECTION_TONE: Record<SectionTone, { text: string; dot: string | null }> = {
  attention: { text: 'text-[var(--ds-critical-text)]', dot: 'bg-[var(--ds-critical-solid)]' },
  positive: { text: 'text-[var(--ds-seated-text)]', dot: 'bg-[var(--ds-seated-solid)]' },
  muted: { text: 'text-[var(--ds-text-muted)]', dot: null },
};

export const SectionHeader: React.FC<{
  tone?: SectionTone;
  /** A single text action, right-aligned — e.g. "Segna tutte". */
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ tone = 'muted', action, children }) => {
  const t = SECTION_TONE[tone];
  return (
    <div className="flex items-center justify-between gap-3 px-1 pb-1 pt-2">
      <span className={`flex min-w-0 items-center gap-1.5 text-[13px] font-semibold ${t.text}`}>
        {t.dot && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden />}
        <span className="truncate">{children}</span>
      </span>
      {action}
    </div>
  );
};

/* ── Avatar ───────────────────────────────────────────────────────────────
   Initials, or an icon when there's no name to initialise. The optional badge
   tucks under the bottom edge — it labels the channel without stealing a
   column from the row. */
export const Avatar: React.FC<{
  /** Full name; the first two words' initials are used. */
  name?: string | null;
  /** Shown instead of initials when there is no usable name. */
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'critical' | 'info';
  badge?: React.ReactNode;
  className?: string;
}> = ({ name, icon: Icon, tone = 'neutral', badge, className = '' }) => {
  const initials = (name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
  const shell =
    tone === 'critical' ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
    : tone === 'info' ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]';
  return (
    <div className={`relative flex-shrink-0 ${badge ? 'pb-1' : ''} ${className}`}>
      <div className={`flex h-10 w-10 items-center justify-center rounded-full text-[13px] font-semibold ${shell}`}>
        {initials && !Icon ? initials : Icon ? <Icon className="h-4 w-4" /> : '—'}
      </div>
      {badge && (
        <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2">{badge}</span>
      )}
    </div>
  );
};

/* ── Callout ──────────────────────────────────────────────────────────────
   A tinted notice. The tint carries the meaning, so the text takes the
   matching -text token rather than a hand-picked shade — that pairing is
   already contrast-checked. */
export type CalloutTone = 'critical' | 'positive' | 'info' | 'pending';

const CALLOUT_TONE: Record<CalloutTone, string> = {
  critical: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]',
  positive: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  info: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]',
  pending: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
};

export const Callout: React.FC<{
  tone: CalloutTone;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  /** Pulled to the right of the text — a single inline action. */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ tone, icon: Icon, title, action, className = '', children }) => (
  <div className={`flex items-start gap-2.5 rounded-[16px] p-4 text-[14px] leading-relaxed ${CALLOUT_TONE[tone]} ${className}`}>
    {Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />}
    <div className="min-w-0 flex-1">
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      {children}
    </div>
    {action && <div className="flex-shrink-0">{action}</div>}
  </div>
);

/* ── EmptyState ───────────────────────────────────────────────────────────
   Same card as the list it replaces, so the page doesn't reflow when the last
   row is filtered away. */
export const EmptyState: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ icon: Icon, children, action }) => (
  <div className="rounded-[20px] bg-[var(--ds-surface)] px-6 py-12 text-center shadow-[var(--ds-shadow-card)]">
    <Icon className="mx-auto mb-3 h-8 w-8 text-[var(--ds-text-subtle)]" aria-hidden />
    <p className="text-[14px] text-[var(--ds-text-muted)]">{children}</p>
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);
