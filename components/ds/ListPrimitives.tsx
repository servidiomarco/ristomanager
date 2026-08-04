import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronDown, ChevronRight, Search, X } from 'lucide-react';

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
  /** For a focus shortcut that lives outside this component. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** A passive hint parked inside the field — e.g. what Enter will do to the
   *  single remaining match. Never covers the clear button. */
  hint?: React.ReactNode;
}> = ({ value, onChange, placeholder, ariaLabel = 'Cerca', className = '', inputRef, onKeyDown, hint }) => (
  <div className={`relative ${className}`}>
    <Search
      className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
      aria-hidden
    />
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="h-11 w-full rounded-full bg-[var(--ds-surface)] pl-11 pr-11 text-[15px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    />
    {hint && (
      <span className="pointer-events-none absolute right-11 top-1/2 hidden -translate-y-1/2 lg:inline-flex">
        {hint}
      </span>
    )}
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
export type SectionTone = 'attention' | 'positive' | 'pending' | 'info' | 'muted';

const SECTION_TONE: Record<SectionTone, { text: string; dot: string | null }> = {
  attention: { text: 'text-[var(--ds-critical-text)]', dot: 'bg-[var(--ds-critical-solid)]' },
  positive: { text: 'text-[var(--ds-seated-text)]', dot: 'bg-[var(--ds-seated-solid)]' },
  pending: { text: 'text-[var(--ds-pending-text)]', dot: 'bg-[var(--ds-pending-solid)]' },
  info: { text: 'text-[var(--ds-arriving-text)]', dot: 'bg-[var(--ds-arriving-solid)]' },
  muted: { text: 'text-[var(--ds-text-muted)]', dot: null },
};

export const SectionHeader: React.FC<{
  tone?: SectionTone;
  /** A single text action, right-aligned — e.g. "Segna tutte". */
  action?: React.ReactNode;
  /** Muted text after the label — a count, a total. Stays neutral so the tone
   *  colour marks the group and doesn't shout the arithmetic too. */
  meta?: React.ReactNode;
  /** Makes the whole eyebrow a toggle, with a chevron on the right. */
  onToggle?: () => void;
  expanded?: boolean;
  children: React.ReactNode;
}> = ({ tone = 'muted', action, meta, onToggle, expanded = true, children }) => {
  const t = SECTION_TONE[tone];
  const label = (
    <span className={`flex min-w-0 flex-shrink-0 items-center gap-1.5 text-[13px] font-semibold ${t.text}`}>
      {t.dot && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  );

  if (!onToggle) {
    // Same box as the toggle variant so bands line up across pages, minus the
    // 44px floor and the pressed states — there's nothing here to press, and a
    // static row that lights up under the thumb is a lie.
    return (
      <div className="-mx-1 flex w-full items-center gap-2 px-2 py-2 text-left">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          {label}
          {meta && <span className="text-[13px] text-[var(--ds-text-muted)]">{meta}</span>}
        </span>
        {action}
      </div>
    );
  }

  return (
    // 44px minimum — this is the control that collapses a whole band of
    // bookings, and on a phone it sat at roughly 30px between two cards with
    // nothing to say it could be pressed.
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      // A resting tint, not just a hover one. On a page whose cards are white,
      // a transparent band reads as a caption; people scrolled past it without
      // realising the group collapses. Hover then deepens it rather than being
      // the only signal, which never existed on touch at all.
      //
      // The tint alone was not enough: surface-row (#f4f4f5) sits within a few
      // percent of both the canvas beneath it and the white card under it, so
      // on a phone the band bled into the first row of the group. The hairline
      // does the separating instead of a darker fill — deepening the fill would
      // have dropped the muted meta text below 4.5:1 at 13px. It reads as an
      // outlined band without touching the text contrast at all.
      //
      // The bottom margin only applies while the group is open, where it buys
      // air before the first card. Collapsed, consecutive headers should stack
      // tightly — an extra gap there would read as a missing group.
      className={`-mx-1 flex min-h-[44px] w-full items-center gap-2 rounded-[14px] border border-[var(--ds-border)] bg-[var(--ds-surface-row)] px-3 py-1.5 text-left transition-colors hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-border)] active:bg-[var(--ds-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
        expanded ? 'mb-2.5' : ''
      }`}
    >
      {/* Label and meta wrap as a pair: on a wide column they share one line,
          and where the column is too narrow the meta drops beneath the label
          instead of being cut off mid-word. The chevron sits outside the
          wrapping box so it stays put on the first line either way. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        {label}
        {meta && <span className="text-[13px] text-[var(--ds-text-muted)]">{meta}</span>}
      </span>
      {action}
      {/* A circle, not a bare glyph. The whole row is the target, but the
          chevron is what people aim at, and a 16px icon floating in space
          reads as decoration rather than a control. */}
      <span
        className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-transform ${
          expanded ? '' : '-rotate-90'
        }`}
        aria-hidden
      >
        <ChevronDown className="h-4 w-4" />
      </span>
    </button>
  );
};

/* ── StatStrip ────────────────────────────────────────────────────────────
   A row of headline numbers in one card, split by hairlines rather than sat in
   separate boxes: they're one reading of the same service, and four cards
   would say they're four unrelated things.

   A segment that needs acting on takes the pending tint and becomes a button.
   That's the whole reason the strip is tinted anywhere — the eye should land on
   the number that costs money, not on the tally of what's already fine. */
export type StatTone = 'neutral' | 'positive' | 'pending' | 'critical';

// Written out in full rather than composed: Tailwind extracts class names
// statically, so a template-built `bg-[var(--ds-${x}-tint)]` never ships.
const STAT_TONE: Record<StatTone, { value: string; label: string; dot: string; tint: string }> = {
  neutral: {
    value: 'text-[var(--ds-text-primary)]', label: 'text-[var(--ds-text-muted)]',
    dot: 'bg-[var(--ds-text-muted)]', tint: 'bg-[var(--ds-surface-row)]',
  },
  positive: {
    value: 'text-[var(--ds-seated-text)]', label: 'text-[var(--ds-seated-text)]',
    dot: 'bg-[var(--ds-seated-solid)]', tint: 'bg-[var(--ds-seated-tint)]',
  },
  pending: {
    value: 'text-[var(--ds-pending-text)]', label: 'text-[var(--ds-pending-text)]',
    dot: 'bg-[var(--ds-pending-solid)]', tint: 'bg-[var(--ds-pending-tint)]',
  },
  critical: {
    value: 'text-[var(--ds-critical-text)]', label: 'text-[var(--ds-critical-text)]',
    dot: 'bg-[var(--ds-critical-solid)]', tint: 'bg-[var(--ds-critical-tint)]',
  },
};

export interface Stat {
  /** The number. Rendered bold and tabular so segments don't jitter on update. */
  value: React.ReactNode;
  label: string;
  /** Colours the number and its label. Zero should read neutral — a green "0
   *  arrivati" claims something went right when nothing has happened yet. */
  tone?: StatTone;
  /** Adds the tone's tinted background. For the one segment that's a task
   *  rather than a fact — the tint is what makes it read as actionable. */
  tint?: boolean;
  onClick?: () => void;
  title?: string;
  /** Drops below the given breakpoint — for segments a phone has no room for. */
  hideBelow?: 'sm' | 'md' | 'lg';
}

const HIDE_BELOW: Record<NonNullable<Stat['hideBelow']>, string> = {
  sm: 'hidden sm:flex',
  md: 'hidden md:flex',
  lg: 'hidden lg:flex',
};

export const StatStrip: React.FC<{
  stats: Stat[];
  /** 'stacked' puts the number over its label — for a strip that's the page's
   *  headline. 'inline' keeps it on one line, for a strip that sits between
   *  other controls. */
  layout?: 'inline' | 'stacked';
  className?: string;
}> = ({ stats, layout = 'inline', className = '' }) => {
  const stacked = layout === 'stacked';
  return (
    <div
      className={`flex items-stretch overflow-hidden bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] ${
        stacked ? 'rounded-[20px]' : 'rounded-full'
      } ${className}`}
    >
      {stats.map((s, i) => {
        const t = STAT_TONE[s.tone ?? 'neutral'];
        const Tag = s.onClick ? 'button' : 'div';
        return (
          <Tag
            key={`${s.label}-${i}`}
            type={s.onClick ? 'button' : undefined}
            onClick={s.onClick}
            title={s.title}
            className={`${s.hideBelow ? HIDE_BELOW[s.hideBelow] : 'flex'} min-w-0 flex-1 whitespace-nowrap ${
              stacked ? 'flex-col items-center justify-center px-2 py-2.5' : 'items-center justify-center gap-1.5 px-3 py-2.5 text-[13px]'
            } ${i > 0 ? 'border-l border-[var(--ds-border)]' : ''} ${s.tint ? t.tint : ''} ${
              s.onClick ? 'transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]' : ''
            }`}
          >
            {!stacked && s.tint && t.dot && (
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden />
            )}
            <span
              className={`flex-shrink-0 font-semibold tabular-nums ${stacked ? 'text-[20px] leading-tight' : ''} ${t.value}`}
            >
              {s.value}
            </span>
            <span className={`truncate ${stacked ? 'text-[12px]' : ''} ${t.label}`}>{s.label}</span>
            {!stacked && s.onClick && (
              <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 ${t.label}`} aria-hidden />
            )}
          </Tag>
        );
      })}
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
  /** 'sm' is for a metadata line inside a row, where 40px would outweigh the
   *  text it belongs to. 'md' stays the default for list leading positions. */
  size?: 'sm' | 'md';
  badge?: React.ReactNode;
  className?: string;
}> = ({ name, icon: Icon, tone = 'neutral', size = 'md', badge, className = '' }) => {
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
      <div className={`flex items-center justify-center rounded-full font-semibold ${shell} ${
        size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-10 w-10 text-[13px]'
      }`}>
        {initials && !Icon ? initials : Icon ? <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'} /> : '—'}
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
