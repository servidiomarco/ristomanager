import {
  AlertCircle, Ban, CheckCircle2, Hourglass, Mail, MessageCircle, MessageSquare,
  RotateCcw, XCircle,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { PillTone } from '../ds';

/* ── Presentation vocabulary for Pagamenti ────────────────────────────────
   Both surfaces on this page — the open bills and the payment links — used to
   carry their own hardcoded palettes (`bg-emerald-50`, `text-rose-700`), which
   is why the same "in attesa" appeared in three different ambers depending on
   which list you were looking at. Every state now resolves to a DS tone family
   here, once, and the components only ever ask for a tone.

   The mapping is deliberately lossy in the same places the old one was: a
   status the operator cannot act on differently does not deserve a colour of
   its own. */

export const formatEuro = (cents: number, currency: string = 'EUR'): string => {
  const symbol = currency === 'EUR' ? '€' : currency;
  return `${symbol} ${(cents / 100).toFixed(2).replace('.', ',')}`;
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

/** Day label for a `YYYY-MM-DD` service date. Built at noon on purpose: the
 *  pg DATE parser hands back a plain date string and `new Date('…T00:00')`
 *  lands on the previous day once the clock is west of Rome. */
export const formatServiceDay = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });

export const shiftLabel = (shift: 'LUNCH' | 'DINNER'): string =>
  shift === 'LUNCH' ? 'pranzo' : 'cena';

export type StatusView = {
  label: string;
  tone: PillTone;
  Icon: ComponentType<{ className?: string }>;
};

/** COMPLETED and PAID are the same event with two names from two gateways.
 *  AUTHORISED reads as pending because the money has not moved yet. */
export const paymentStatusView = (status: string | null | undefined): StatusView => {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETED':
    case 'PAID':
      return { label: 'Pagato', tone: 'positive', Icon: CheckCircle2 };
    case 'PENDING':
      return { label: 'In attesa', tone: 'pending', Icon: Hourglass };
    case 'AUTHORISED':
      return { label: 'Autorizzato', tone: 'info', Icon: Hourglass };
    case 'FAILED':
      return { label: 'Fallito', tone: 'critical', Icon: XCircle };
    case 'CANCELLED':
      return { label: 'Annullato', tone: 'neutral', Icon: Ban };
    case 'EXPIRED':
      return { label: 'Scaduto', tone: 'neutral', Icon: Ban };
    case 'REFUNDED':
      return { label: 'Rimborsato', tone: 'info', Icon: RotateCcw };
    default:
      return { label: status || 'Sconosciuto', tone: 'neutral', Icon: AlertCircle };
  }
};

export type ChannelView = {
  label: string;
  tone: PillTone;
  Icon: ComponentType<{ className?: string }>;
};

/** WhatsApp has no lucide glyph; MessageCircle is the closest generic and the
 *  green tone is what actually identifies it in the timeline. */
export const channelView = (channel: string): ChannelView => {
  const c = (channel || '').toLowerCase();
  if (c === 'sms') return { label: 'SMS', tone: 'info', Icon: MessageSquare };
  if (c === 'whatsapp') return { label: 'WhatsApp', tone: 'positive', Icon: MessageCircle };
  if (c === 'email') return { label: 'Email', tone: 'neutral', Icon: Mail };
  return { label: channel || 'Altro', tone: 'neutral', Icon: MessageSquare };
};

export const messageStatusView = (status: string | null | undefined): { label: string; tone: PillTone } => {
  const s = (status || '').toLowerCase();
  if (s === 'delivered' || s === 'read') return { label: 'Consegnato', tone: 'positive' };
  if (s === 'sent' || s === 'queued' || s === 'accepted' || s === 'sending') return { label: 'Inviato', tone: 'info' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Fallito', tone: 'critical' };
  return { label: s || 'In coda', tone: 'neutral' };
};

export const reservationStatusView = (status: string | null | undefined): { label: string; tone: PillTone } | null => {
  if (!status) return null;
  switch (status) {
    case 'CONFIRMED': return { label: 'Confermata', tone: 'positive' };
    case 'CANCELLED': return { label: 'Annullata', tone: 'critical' };
    case 'PENDING': return { label: 'In attesa', tone: 'pending' };
    default: return { label: status, tone: 'neutral' };
  }
};

/** Human name of the gateway that owns a payment. Never hardcode "Revolut":
 *  a payment carries its own provider and SumUp orders reconcile the same way. */
export const providerName = (provider: string | null | undefined): string =>
  provider === 'sumup' ? 'SumUp'
  : provider === 'revolut' ? 'Revolut'
  : (provider || 'il gateway');
