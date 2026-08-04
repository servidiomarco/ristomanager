import React, { useMemo, useState } from 'react';
import { CreditCard, Receipt } from 'lucide-react';
import type { PaymentRequest } from '../../services/paymentsApiService';
import { toTitleCase } from '../../utils/text';
import { EmptyState, SectionHeader, StatusPill } from '../ds';
import type { PillTone } from '../ds';
import { PeriodTrigger, type Period } from './PeriodPicker';
import { formatDateTime, formatEuro, paymentStatusView, reservationStatusView } from './paymentsView';

/* ── Link di pagamento ────────────────────────────────────────────────────
   Was a table with a Stato / Importo / Cliente / Prenotazione header. A table
   is the wrong instrument here: the columns were already collapsing on a
   tablet and on a phone the row wrapped into an unreadable block. Rows carry
   the same four facts, ordered by what the operator scans for — the amount
   first, then who owes it.

   Split payments of one table bill still render as a single group, exactly as
   before: they are one bill being settled by several people, and listing them
   flat made a table of six look like six unrelated payments. */

export type StatusFilter = 'all' | 'pending' | 'paid' | 'failed' | 'expired';

/** Tile behind the leading status glyph. Full literals per branch — Tailwind
 *  reads these statically and a template-built class never ships. */
const STATUS_TILE: Record<PillTone, string> = {
  positive: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  pending: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
  critical: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]',
  info: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]',
  neutral: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]',
};

/** Day heading for the group a payment falls into — "Oggi", "Ieri", or the date. */
const dayKey = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
  } catch {
    return iso.slice(0, 10);
  }
};

const dayLabel = (iso: string): string => {
  const today = new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
  const key = dayKey(iso);
  if (key === today) return 'Oggi';
  if (key === yesterday) return 'Ieri';
  try {
    return new Date(iso).toLocaleDateString('it-IT', {
      timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'short',
    });
  } catch {
    return key;
  }
};

const PaymentRow: React.FC<{
  item: PaymentRequest;
  /** Inside a bill group the table and booking are already on the group header. */
  inGroup?: boolean;
  onOpen: () => void;
}> = ({ item, inGroup = false, onOpen }) => {
  const status = paymentStatusView(item.status);
  const StatusIcon = status.Icon;
  const resStatus = reservationStatusView(item.reservation_status);
  const who = inGroup ? item.claimant_label : item.reservation_customer_name;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
        inGroup ? '' : 'rounded-[16px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]'
      }`}
    >
      {/* The state, before the number. Scanning this list is looking for the
          two that failed, not reading twenty amounts in order — a tinted tile
          at the left edge answers that in one pass down the column, where a
          pill on the right edge makes the eye cross every row to find it. The
          pill stays: colour alone is not a label. */}
      <span className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] ${STATUS_TILE[status.tone]}`}>
        <StatusIcon className="h-4 w-4" />
      </span>
      <span className="w-[104px] flex-shrink-0 text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
        {formatEuro(item.amount_cents, item.currency)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-[var(--ds-text-primary)]">
          {who ? toTitleCase(who) : <span className="font-normal text-[var(--ds-text-muted)]">senza nominativo</span>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[var(--ds-text-muted)]">
          {item.reservation_phone && <span className="tabular-nums">{item.reservation_phone}</span>}
          {!inGroup && item.table_name && <span>tav. {item.table_name}</span>}
          <span className="tabular-nums">{formatDateTime(item.created_at)}</span>
        </span>
      </span>
      <span className="flex flex-shrink-0 flex-col items-end gap-1">
        {/* Text only — the glyph now leads the row, and repeating it here
            said the same thing twice within one line. */}
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        {!inGroup && resStatus && (
          <span className="hidden text-[12px] text-[var(--ds-text-muted)] sm:block">{resStatus.label}</span>
        )}
      </span>
    </button>
  );
};

export const LinkDiPagamento: React.FC<{
  items: PaymentRequest[];
  total: number;
  statusFilter: StatusFilter;
  onStatusFilter: (next: StatusFilter) => void;
  period: Period;
  /** Span the loaded results cover — names the period chip when no filter is set. */
  span?: Period | null;
  onOpenPeriod: () => void;
  onSelect: (p: PaymentRequest) => void;
}> = ({ items, total, statusFilter, onStatusFilter, period, span, onOpenPeriod, onSelect }) => {
  // Counts come from the loaded page, like the totals in the header — the list
  // request is capped at 200 and there is no aggregate endpoint to ask.
  const counts = useMemo(() => {
    const acc = { all: items.length, pending: 0, paid: 0, failed: 0, expired: 0 };
    for (const p of items) {
      const s = (p.status || '').toUpperCase();
      if (s === 'PENDING' || s === 'AUTHORISED') acc.pending++;
      else if (s === 'COMPLETED' || s === 'PAID') acc.paid++;
      else if (s === 'FAILED' || s === 'CANCELLED') acc.failed++;
      else if (s === 'EXPIRED') acc.expired++;
    }
    return acc;
  }, [items]);

  /** Group by day, and within a day keep bill splits together. */
  const days = useMemo(() => {
    const out: { key: string; label: string; groups: { billId: number | null; items: PaymentRequest[] }[] }[] = [];
    const byDay = new Map<string, typeof out[number]>();
    const byBill = new Map<string, PaymentRequest[]>();
    for (const p of items) {
      const key = dayKey(p.created_at);
      let day = byDay.get(key);
      if (!day) {
        day = { key, label: dayLabel(p.created_at), groups: [] };
        byDay.set(key, day);
        out.push(day);
      }
      if (p.table_bill_id != null) {
        const billKey = `${key}:${p.table_bill_id}`;
        const existing = byBill.get(billKey);
        if (existing) { existing.push(p); continue; }
        const arr = [p];
        byBill.set(billKey, arr);
        day.groups.push({ billId: p.table_bill_id, items: arr });
      } else {
        day.groups.push({ billId: null, items: [p] });
      }
    }
    return out;
  }, [items]);

  const chips: { v: StatusFilter; l: string; n: number }[] = [
    { v: 'all', l: 'Tutti', n: counts.all },
    { v: 'pending', l: 'In attesa', n: counts.pending },
    { v: 'paid', l: 'Pagati', n: counts.paid },
    { v: 'failed', l: 'Falliti', n: counts.failed },
    { v: 'expired', l: 'Scaduti', n: counts.expired },
  ];

  return (
    <div className="space-y-4">
      {/* One scrolling row: period first, then the status filters. On a phone
          this is the only horizontal scroll on the page and it is a short one. */}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <PeriodTrigger period={period} span={span} count={total} onClick={onOpenPeriod} />
        <span className="h-5 w-px flex-shrink-0 bg-[var(--ds-border)]" aria-hidden />
        {chips.map(c => (
          <button
            key={c.v}
            type="button"
            onClick={() => onStatusFilter(c.v)}
            aria-pressed={statusFilter === c.v}
            className={`inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              statusFilter === c.v
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {c.l}
            <span className="tabular-nums opacity-70">{c.n}</span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState icon={CreditCard}>
          Nessun pagamento{statusFilter !== 'all' ? ' per questo filtro' : ' in questo periodo'}.
        </EmptyState>
      ) : (
        days.map(day => (
          <section key={day.key}>
            <SectionHeader
              tone="muted"
              meta={`${day.groups.reduce((s, g) => s + g.items.length, 0)} pagamenti`}
            >
              {day.label}
            </SectionHeader>
            <div className="space-y-2">
              {day.groups.map(group => {
                if (group.billId == null) {
                  const only = group.items[0];
                  return <PaymentRow key={only.id} item={only} onOpen={() => onSelect(only)} />;
                }
                const first = group.items[0];
                const paid = group.items.reduce((s, p) => {
                  const st = (p.status || '').toUpperCase();
                  return s + ((st === 'COMPLETED' || st === 'PAID') ? p.amount_cents : 0);
                }, 0);
                const billTotal = first.bill_total_cents || 0;
                const pct = billTotal > 0 ? Math.min(100, Math.round((paid / billTotal) * 100)) : 0;
                return (
                  <div
                    key={`bill-${day.key}-${group.billId}`}
                    className="overflow-hidden rounded-[16px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-[var(--ds-surface-row)] px-4 py-2.5">
                      <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text-primary)]">
                        <Receipt className="h-4 w-4 text-[var(--ds-text-muted)]" aria-hidden />
                        {first.table_name ? `Tavolo ${first.table_name}` : `Conto #${group.billId}`}
                      </span>
                      {first.reservation_customer_name && (
                        <span className="min-w-0 truncate text-[13px] text-[var(--ds-text-muted)]">
                          {toTitleCase(first.reservation_customer_name)}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                        <span className="font-medium text-[var(--ds-seated-text)]">{formatEuro(paid)}</span>
                        {billTotal > 0 && <>/ {formatEuro(billTotal)}</>}
                        {billTotal > 0 && (
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--ds-border)]">
                            <span className="block h-full rounded-full bg-[var(--ds-seated-solid)]" style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="divide-y divide-[var(--ds-border)]">
                      {group.items.map(p => (
                        <PaymentRow key={p.id} item={p} inGroup onOpen={() => onSelect(p)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
};
