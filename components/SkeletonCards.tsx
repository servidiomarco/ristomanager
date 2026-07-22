import React from 'react';

// Reusable skeleton primitives for list-heavy pages. All variants use
// `motion-safe:animate-pulse` so users with `prefers-reduced-motion: reduce`
// see static placeholders instead of the throbbing shimmer.
//
// Design rules:
//  - Placeholder shapes must roughly match the real content dimensions
//    (min-h, header row, meta row) so the page doesn't reflow when data
//    lands. Loosely varied widths so a stack of skeletons doesn't look like
//    a machine-generated grid.
//  - No text labels — the shimmer conveys "loading" without needing copy.
//  - Consumers gate the render on `isInitialLoading && data.length === 0`
//    so background refetches never flash the skeleton over real data.

// Reservation-style card (Reception, Prenotazioni). Header row with a time
// slot + status pill, primary line for the name, meta line with 2 chips.
export const SkeletonReservationCard: React.FC<{ variant?: 'wide' | 'narrow'; className?: string }> = ({
    variant = 'wide',
    className,
}) => (
    <div
        aria-hidden="true"
        className={`w-full rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 min-h-[88px] motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-center justify-between gap-2 mb-2">
            <div className="h-5 w-14 rounded bg-[var(--color-surface-3)]" />
            <div className="h-4 w-16 rounded-full bg-[var(--color-surface-3)]" />
        </div>
        <div className={`h-4 rounded bg-[var(--color-surface-3)] mb-2 ${variant === 'wide' ? 'w-3/5' : 'w-2/5'}`} />
        <div className="flex items-center gap-3">
            <div className="h-3 w-10 rounded bg-[var(--color-surface-3)]" />
            <div className="h-3 w-24 rounded bg-[var(--color-surface-3)]" />
        </div>
    </div>
);

// Group placeholder: a section title bar + N skeleton cards.
export const SkeletonReservationGroup: React.FC<{
    titleWidth?: 'sm' | 'md' | 'lg';
    count?: number;
    className?: string;
}> = ({ titleWidth = 'md', count = 3, className }) => {
    const w = titleWidth === 'sm' ? 'w-20' : titleWidth === 'lg' ? 'w-40' : 'w-28';
    const variants: ('wide' | 'narrow')[] = ['wide', 'narrow', 'wide', 'narrow', 'wide'];
    return (
        <div className={`mb-3 ${className ?? ''}`}>
            <div className={`h-3 ${w} rounded bg-[var(--color-surface-3)] mb-2 motion-safe:animate-pulse`} aria-hidden="true" />
            <div className="space-y-2">
                {Array.from({ length: count }).map((_, i) => (
                    <SkeletonReservationCard key={i} variant={variants[i % variants.length]} />
                ))}
            </div>
        </div>
    );
};

// Composite: multiple groups stacked. Sensible default for the initial load
// of Reception/Prenotazioni ("Adesso", "Prossima ora", "Più tardi" pattern).
export const SkeletonReservationList: React.FC<{
    groups?: { count: number; titleWidth?: 'sm' | 'md' | 'lg' }[];
    className?: string;
}> = ({
    groups = [
        { count: 3, titleWidth: 'lg' },
        { count: 2, titleWidth: 'md' },
    ],
    className,
}) => (
    <div className={className}>
        {groups.map((g, i) => (
            <SkeletonReservationGroup key={i} count={g.count} titleWidth={g.titleWidth} />
        ))}
    </div>
);

// Inbox-style row: circular avatar + two text lines + right-side timestamp.
// Used by Conversazioni (voice-call list), Messaggi (WA/SMS conversations),
// Email inbox, Notifiche.
export const SkeletonInboxRow: React.FC<{ withBadge?: boolean; className?: string }> = ({
    withBadge = false,
    className,
}) => (
    <div
        aria-hidden="true"
        className={`w-full flex items-start gap-3 px-4 py-3 border-b border-[var(--color-line)] motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-[var(--color-surface-3)]" />
        <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
                <div className="h-4 w-28 rounded bg-[var(--color-surface-3)]" />
                <div className="h-3 w-8 rounded bg-[var(--color-surface-3)]" />
            </div>
            <div className="h-3 w-4/5 rounded bg-[var(--color-surface-3)]" />
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className="h-3 w-12 rounded bg-[var(--color-surface-3)]" />
            {withBadge && <div className="h-4 w-4 rounded-full bg-[var(--color-surface-3)]" />}
        </div>
    </div>
);

// Skeleton list of inbox rows. `count` defaults to 6 which fills the visible
// viewport on both mobile and desktop sidebars.
export const SkeletonInboxList: React.FC<{ count?: number; className?: string }> = ({
    count = 6,
    className,
}) => (
    <div className={className} aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonInboxRow key={i} withBadge={i % 3 === 0} />
        ))}
    </div>
);

// Payment-style row: amount left, status pill right, meta line below.
// Slightly denser than the reservation card because Pagamenti fits more per
// screen.
export const SkeletonPaymentRow: React.FC<{ className?: string }> = ({ className }) => (
    <div
        aria-hidden="true"
        className={`w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-center justify-between gap-3 mb-2">
            <div className="h-5 w-24 rounded bg-[var(--color-surface-3)]" />
            <div className="h-4 w-16 rounded-full bg-[var(--color-surface-3)]" />
        </div>
        <div className="flex items-center gap-3">
            <div className="h-3 w-32 rounded bg-[var(--color-surface-3)]" />
            <div className="h-3 w-20 rounded bg-[var(--color-surface-3)]" />
        </div>
    </div>
);

export const SkeletonPaymentList: React.FC<{ count?: number; className?: string }> = ({
    count = 5,
    className,
}) => (
    <div className={`space-y-2 ${className ?? ''}`} aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonPaymentRow key={i} />
        ))}
    </div>
);

// Customer-style card: name line (+ optional badges), city line, phone + email
// rows, optional preference chips. Rendered in a 1/2/3-column responsive grid
// by SkeletonCustomerGrid to match the real Clienti page.
export const SkeletonCustomerCard: React.FC<{ variant?: 'compact' | 'full'; className?: string }> = ({
    variant = 'full',
    className,
}) => (
    <div
        aria-hidden="true"
        className={`bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-sm p-4 flex flex-col gap-2 motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
                <div className="h-4 w-3/4 rounded bg-[var(--color-surface-3)] mb-2" />
                <div className="h-3 w-1/3 rounded bg-[var(--color-surface-3)]" />
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
                <div className="h-6 w-6 rounded-lg bg-[var(--color-surface-3)]" />
                <div className="h-6 w-6 rounded-lg bg-[var(--color-surface-3)]" />
            </div>
        </div>
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
                <div className="h-3.5 w-3.5 rounded bg-[var(--color-surface-3)]" />
                <div className="h-3 w-2/3 rounded bg-[var(--color-surface-3)]" />
            </div>
            {variant === 'full' && (
                <div className="flex items-center gap-1.5">
                    <div className="h-3.5 w-3.5 rounded bg-[var(--color-surface-3)]" />
                    <div className="h-3 w-3/4 rounded bg-[var(--color-surface-3)]" />
                </div>
            )}
        </div>
        {variant === 'full' && (
            <div className="flex flex-wrap gap-1.5 mt-1">
                <div className="h-5 w-16 rounded-full bg-[var(--color-surface-3)]" />
                <div className="h-5 w-20 rounded-full bg-[var(--color-surface-3)]" />
            </div>
        )}
    </div>
);

// Responsive customer grid (1/2/3 columns) matching CustomerList's real
// layout. `count` defaults to 6 so a stack of 2 rows appears on desktop.
export const SkeletonCustomerGrid: React.FC<{ count?: number; className?: string }> = ({
    count = 6,
    className,
}) => (
    <div
        className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 ${className ?? ''}`}
        aria-hidden="true"
    >
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonCustomerCard key={i} variant={i % 4 === 3 ? 'compact' : 'full'} />
        ))}
    </div>
);

// Notification-style row: circular category icon on left, title + timestamp
// on top-right, body preview below, optional action row.
export const SkeletonNotificationRow: React.FC<{ withBody?: boolean; unread?: boolean; className?: string }> = ({
    withBody = true,
    unread = false,
    className,
}) => (
    <div
        aria-hidden="true"
        className={`rounded-xl border p-3 md:p-4 motion-safe:animate-pulse ${
            unread
                ? 'bg-indigo-50/40 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30'
                : 'bg-[var(--color-surface)] border-[var(--color-line)]'
        } ${className ?? ''}`}
    >
        <div className="flex items-start gap-3">
            <div className="flex-shrink-0 h-8 w-8 rounded-full bg-[var(--color-surface-3)]" />
            <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="h-4 w-3/5 rounded bg-[var(--color-surface-3)]" />
                    <div className="h-3 w-12 rounded bg-[var(--color-surface-3)] flex-shrink-0" />
                </div>
                {withBody && (
                    <>
                        <div className="h-3 w-full rounded bg-[var(--color-surface-3)] mb-1.5" />
                        <div className="h-3 w-4/5 rounded bg-[var(--color-surface-3)]" />
                    </>
                )}
            </div>
        </div>
    </div>
);

export const SkeletonNotificationList: React.FC<{ count?: number; className?: string }> = ({
    count = 6,
    className,
}) => (
    <div className={`space-y-2 ${className ?? ''}`} aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonNotificationRow
                key={i}
                withBody={i % 3 !== 2}
                unread={i < 2}
            />
        ))}
    </div>
);

// Task-style row: checkbox left, title + optional meta row (priority chip +
// due date). Used by Attività.
export const SkeletonTaskRow: React.FC<{ className?: string }> = ({ className }) => (
    <div
        aria-hidden="true"
        className={`p-3 rounded-lg border bg-[var(--color-surface)] border-[var(--color-line)] motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-start gap-3">
            <div className="flex-shrink-0 h-5 w-5 rounded bg-[var(--color-surface-3)]" />
            <div className="flex-1 min-w-0">
                <div className="h-4 w-3/4 rounded bg-[var(--color-surface-3)] mb-2" />
                <div className="flex items-center gap-2">
                    <div className="h-4 w-16 rounded-full bg-[var(--color-surface-3)]" />
                    <div className="h-3 w-20 rounded bg-[var(--color-surface-3)]" />
                </div>
            </div>
        </div>
    </div>
);

export const SkeletonTaskList: React.FC<{ count?: number; className?: string }> = ({
    count = 5,
    className,
}) => (
    <div className={`space-y-2 ${className ?? ''}`} aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonTaskRow key={i} />
        ))}
    </div>
);

// Product-style row (Inventory): dense flex row with name, unit chip, and
// stepper controls on the right.
export const SkeletonProductRow: React.FC<{ isFirst?: boolean; className?: string }> = ({
    isFirst = false,
    className,
}) => (
    <div
        aria-hidden="true"
        className={`flex items-center gap-3 p-3 sm:p-4 motion-safe:animate-pulse ${!isFirst ? 'border-t border-[var(--color-line)]' : ''} ${className ?? ''}`}
    >
        <div className="flex-1 min-w-0">
            <div className="h-4 w-3/5 rounded bg-[var(--color-surface-3)] mb-2" />
            <div className="h-3 w-1/4 rounded bg-[var(--color-surface-3)]" />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
            <div className="h-8 w-8 rounded-full bg-[var(--color-surface-3)]" />
            <div className="h-6 w-12 rounded bg-[var(--color-surface-3)]" />
            <div className="h-8 w-8 rounded-full bg-[var(--color-surface-3)]" />
        </div>
    </div>
);

export const SkeletonProductList: React.FC<{ count?: number; className?: string }> = ({
    count = 6,
    className,
}) => (
    <div
        className={`bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden ${className ?? ''}`}
        aria-hidden="true"
    >
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonProductRow key={i} isFirst={i === 0} />
        ))}
    </div>
);

// HACCP section: Card wrapper + header (icon + title + status pill) + 3-4
// row skeletons that resemble a temperature reading form (label + input).
export const SkeletonHaccpSection: React.FC<{ rows?: number; className?: string }> = ({
    rows = 4,
    className,
}) => (
    <div
        aria-hidden="true"
        className={`bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] overflow-hidden motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-line)]">
            <div className="h-4 w-4 rounded bg-[var(--color-surface-3)]" />
            <div className="h-4 w-40 rounded bg-[var(--color-surface-3)]" />
            <div className="ml-auto h-4 w-24 rounded-full bg-[var(--color-surface-3)]" />
        </div>
        <div className="p-4 space-y-2.5">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                    <div className="h-3 w-1/3 rounded bg-[var(--color-surface-3)]" />
                    <div className="h-8 w-24 rounded bg-[var(--color-surface-3)] ml-auto" />
                </div>
            ))}
        </div>
    </div>
);

export const SkeletonHaccpSections: React.FC<{ className?: string }> = ({ className }) => (
    <div className={`space-y-4 ${className ?? ''}`} aria-hidden="true">
        <SkeletonHaccpSection rows={5} />
        <SkeletonHaccpSection rows={3} />
        <SkeletonHaccpSection rows={4} />
    </div>
);

// Staff column (Sala or Cucina): header + 2 sub-groups with 3 avatar rows
// each. Matches the real StaffManagement layout.
export const SkeletonStaffColumn: React.FC<{ label?: 'Sala' | 'Cucina'; className?: string }> = ({ label, className }) => (
    <div
        aria-hidden="true"
        className={`bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-line)]">
            <div className="h-4 w-4 rounded bg-[var(--color-surface-3)]" />
            <div className="h-3 w-16 rounded bg-[var(--color-surface-3)]" />
            <div className="ml-auto h-3 w-6 rounded bg-[var(--color-surface-3)]" />
        </div>
        <div className="p-2">
            {[0, 1].map(group => (
                <div key={group} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                        <div className="h-4 w-20 rounded-full bg-[var(--color-surface-3)]" />
                        <div className="h-3 w-6 rounded bg-[var(--color-surface-3)]" />
                        <div className="flex-1 h-px bg-[var(--color-line)]" />
                    </div>
                    {[0, 1, 2].map(row => (
                        <div key={row} className="flex items-center gap-3 p-2.5 rounded-md mb-1">
                            <div className="w-9 h-9 rounded-full bg-[var(--color-surface-3)] flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="h-4 w-3/4 rounded bg-[var(--color-surface-3)] mb-1.5" />
                                <div className="h-3 w-1/3 rounded bg-[var(--color-surface-3)]" />
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    </div>
);

// KPI card (Dashboard top row): rounded corner card with a small icon,
// large number, and label underneath. Used for the initial-load "Ospiti /
// Tavoli / Prenotazioni / Banchetti" strip.
export const SkeletonKpiCard: React.FC<{ className?: string }> = ({ className }) => (
    <div
        aria-hidden="true"
        className={`bg-[var(--color-surface)] p-4 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] motion-safe:animate-pulse ${className ?? ''}`}
    >
        <div className="h-4 w-20 rounded bg-[var(--color-surface-3)] mb-4" />
        <div className="h-9 w-9 rounded-full bg-[var(--color-surface-3)] mb-3" />
        <div className="flex items-baseline gap-3">
            <div>
                <div className="h-2.5 w-10 rounded bg-[var(--color-surface-3)] mb-1.5" />
                <div className="h-6 w-8 rounded bg-[var(--color-surface-3)]" />
            </div>
            <div className="flex-1">
                <div className="h-2.5 w-12 rounded bg-[var(--color-surface-3)] mb-1.5" />
                <div className="h-6 w-8 rounded bg-[var(--color-surface-3)]" />
            </div>
        </div>
    </div>
);

export const SkeletonKpiRow: React.FC<{ count?: number; className?: string }> = ({
    count = 4,
    className,
}) => (
    <div
        className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 lg:gap-8 ${className ?? ''}`}
        aria-hidden="true"
    >
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonKpiCard key={i} />
        ))}
    </div>
);
