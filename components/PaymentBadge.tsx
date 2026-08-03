import React from 'react';
import { CreditCard } from 'lucide-react';
import { Reservation, PaymentStatus } from '../types';

// Compact date-time formatter for payment tooltips. Falls back to '—' when
// the input is missing/invalid so the tooltip never surfaces "Invalid Date".
const formatPaymentTs = (iso?: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
};

// Whether the reservation has an unsettled deposit link — used by the
// pending-confirm modal to warn before flipping the booking to CONFIRMED
// while the customer still hasn't paid. `null`/no link means "no deposit
// was requested" and confirmation proceeds without a warning.
export const hasUnpaidDeposit = (res: Pick<Reservation, 'latest_payment_status'>): boolean => {
    const s = res.latest_payment_status;
    if (!s) return false;
    return s !== 'COMPLETED';
};

// Card icon that surfaces the latest payment_request state at a glance.
// Priority: an active payment_request (link created via Revolut) wins over
// the operator-marked `payment_status` — the two mostly agree in steady
// state (COMPLETED → PAID_FULL), but the payment_request tells the truer
// story while a link is in flight or has failed. Returns null when neither
// signal has anything to say (fresh reservation, no link, no cash marked).
export const PaymentBadge: React.FC<{ reservation: Reservation; size?: 'sm' | 'md' }> = ({ reservation: res, size = 'sm' }) => {
    const box = size === 'md' ? 'w-7 h-7' : 'w-6 h-6';
    const icon = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
    const base = `inline-flex items-center justify-center ${box} rounded-full flex-shrink-0`;
    const linkStatus = res.latest_payment_status || null;

    if (linkStatus) {
        const amount = typeof res.latest_payment_amount_cents === 'number'
            ? (res.latest_payment_amount_cents / 100).toLocaleString('it-IT', { style: 'currency', currency: res.latest_payment_currency || 'EUR' })
            : null;
        const channel = res.latest_payment_delivery_channel === 'sms' ? 'SMS'
            : res.latest_payment_delivery_channel === 'whatsapp' ? 'WhatsApp'
            : null;
        const sentTs = formatPaymentTs(res.latest_payment_created_at);
        const paidTs = res.latest_payment_completed_at ? formatPaymentTs(res.latest_payment_completed_at) : null;

        // One family per outcome, not a shade per status: paid is settled
        // (green), a live link is in flight (indigo), an unpaid one is waiting
        // on the guest (amber), and anything that went wrong is red. An
        // expired link is nothing more than history, so it stays neutral.
        let cls = 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]';
        let label = 'Stato pagamento';
        switch (linkStatus) {
            case 'COMPLETED':
                cls = 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]';
                label = 'Pagato';
                break;
            case 'AUTHORISED':
                cls = 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]';
                label = 'Autorizzato';
                break;
            case 'PENDING':
                cls = 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]';
                label = 'In attesa di pagamento';
                break;
            case 'FAILED':
                cls = 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]';
                label = 'Pagamento fallito';
                break;
            case 'CANCELLED':
                cls = 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]';
                label = 'Pagamento annullato';
                break;
            case 'EXPIRED':
                cls = 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]';
                label = 'Link scaduto';
                break;
        }

        const parts: string[] = [];
        if (amount) parts.push(amount);
        parts.push(label);
        if (channel) parts.push(`via ${channel}`);
        parts.push(`inviato il ${sentTs}`);
        if (paidTs) parts.push(`pagato il ${paidTs}`);
        const title = parts.join(' · ');

        return (
            <span className={`${base} ${cls}`} title={title} aria-label={title}>
                <CreditCard className={icon} />
            </span>
        );
    }

    // Fallback: operator marked the reservation as paid/refunded without
    // going through the online link (cash, POS at the venue, etc.).
    if (res.payment_status && res.payment_status !== PaymentStatus.PENDING) {
        const label =
            res.payment_status === PaymentStatus.PAID_FULL ? 'Saldato'
            : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'Acconto'
            : 'Rimborsato';
        return (
            <span className={`${base} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]`} title={label} aria-label={label}>
                <CreditCard className={icon} />
            </span>
        );
    }

    return null;
};
