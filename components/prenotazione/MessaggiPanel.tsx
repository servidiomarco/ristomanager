import React, { useMemo, useState } from 'react';
import { BellRing, Loader2, Mail, Send } from 'lucide-react';
import type { OutboundMessage } from '../../services/apiService';
import { EmptyState, StatusPill } from '../ds';
import type { PillTone } from '../ds';

/* ── Comunicazione con il cliente ─────────────────────────────────────────
   Every SMS, WhatsApp and email on this booking, newest first.

   Was a timeline: a vertical rail, a dot per message, arrows for direction.
   At four messages that reads as a story; at thirty-four it reads as a wall,
   and the rail was spending horizontal room on a phone to say something the
   badge already said. Flat cards, one per message, with the channel and the
   outcome where the eye lands.

   The direction marker survives the redesign on purpose. An inbound reply
   looking identical to something we sent is how a customer's "we'll be two
   hours late" gets read as our own confirmation. */

const channelMeta = (channel: OutboundMessage['channel']): { label: string; tone: PillTone } => {
  if (channel === 'sms') return { label: 'SMS', tone: 'info' };
  if (channel === 'whatsapp') return { label: 'WhatsApp', tone: 'positive' };
  return { label: 'Email', tone: 'neutral' };
};

const outcome = (msg: OutboundMessage): { label: string; tone: PillTone } => {
  const s = (msg.status || '').toLowerCase();
  if (msg.direction === 'inbound') return { label: msg.in_reply_to ? 'Risposta' : 'Entrata', tone: 'positive' };
  if (s === 'delivered' || s === 'read') return { label: 'Consegnato', tone: 'positive' };
  if (s === 'sent' || s === 'queued' || s === 'accepted' || s === 'sending') return { label: 'Inviato', tone: 'info' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Fallito', tone: 'critical' };
  return { label: s || 'In coda', tone: 'neutral' };
};

const when = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString('it-IT', {
      timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

type Filter = 'all' | 'whatsapp' | 'sms' | 'email';

export const MessaggiPanel: React.FC<{
  messages: OutboundMessage[];
  loading: boolean;
  /** Contact details drive which compose actions make sense. */
  phone?: string | null;
  email?: string | null;
  onNewEmail: () => void;
  onSendConfirmation: () => void;
  /** Reminder manuale (WhatsApp col template, SMS finché non è approvato). */
  onSendReminder: () => void;
  reminderSending?: boolean;
  reminderSent?: boolean;
}> = ({ messages, loading, phone, email, onNewEmail, onSendConfirmation, onSendReminder, reminderSending, reminderSent }) => {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const acc = { all: messages.length, whatsapp: 0, sms: 0, email: 0 };
    for (const m of messages) acc[m.channel]++;
    return acc;
  }, [messages]);

  const shown = filter === 'all' ? messages : messages.filter(m => m.channel === filter);

  const chips: { v: Filter; l: string; n: number }[] = [
    { v: 'all', l: 'Tutto', n: counts.all },
    { v: 'whatsapp', l: 'WhatsApp', n: counts.whatsapp },
    { v: 'sms', l: 'SMS', n: counts.sms },
    { v: 'email', l: 'Email', n: counts.email },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Channels with nothing in them are dropped rather than shown at zero:
            a filter that can only ever empty the list is a dead control. */}
        {chips.filter(c => c.v === 'all' || c.n > 0).map(c => (
          <button
            key={c.v}
            type="button"
            onClick={() => setFilter(c.v)}
            aria-pressed={filter === c.v}
            className={`inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              filter === c.v
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {c.l}
            <span className="tabular-nums opacity-70">{c.n}</span>
          </button>
        ))}

        {(phone || email) && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {email && (
              <button
                type="button"
                onClick={onNewEmail}
                title="Componi un'email libera al cliente"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <Mail className="h-3.5 w-3.5" aria-hidden /> Nuova email
              </button>
            )}
            {phone && (
              <button
                type="button"
                onClick={onSendReminder}
                disabled={reminderSending}
                title={reminderSent
                  ? 'Reminder già inviato — un nuovo invio lo ripete'
                  : 'Ricorda la prenotazione al cliente (WhatsApp, o SMS finché il template non è approvato)'}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                {reminderSending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  : <BellRing className="h-3.5 w-3.5" aria-hidden />}
                {reminderSent ? 'Reinvia reminder' : 'Invia reminder'}
              </button>
            )}
            <button
              type="button"
              onClick={onSendConfirmation}
              title="Invia una conferma prenotazione al cliente"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Send className="h-3.5 w-3.5" aria-hidden /> Invia conferma
            </button>
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carico le comunicazioni…
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={Mail}>
          {messages.length === 0
            ? 'Nessuna comunicazione inviata per questa prenotazione.'
            : 'Nessun messaggio su questo canale.'}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {shown.map(msg => {
            const ch = channelMeta(msg.channel);
            const out = outcome(msg);
            const failed = out.tone === 'critical';
            const inbound = msg.direction === 'inbound';
            return (
              <article
                key={msg.id}
                className={`rounded-[16px] p-4 ${
                  failed ? 'bg-[var(--ds-critical-tint)]' : 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]'
                }`}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusPill tone={ch.tone}>{ch.label}</StatusPill>
                  {inbound && <StatusPill tone="positive">{out.label}</StatusPill>}
                  <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{when(msg.sent_at)}</span>
                  {!inbound && (
                    <span className={`ml-auto text-[13px] font-medium ${
                      out.tone === 'critical' ? 'text-[var(--ds-critical-text)]'
                      : out.tone === 'positive' ? 'text-[var(--ds-seated-text)]'
                      : 'text-[var(--ds-text-muted)]'
                    }`}>
                      {out.label}
                    </span>
                  )}
                </div>
                {msg.subject && (
                  <div className="mb-1 text-[14px] font-semibold text-[var(--ds-text-primary)]">{msg.subject}</div>
                )}
                {/* overflow-wrap:anywhere: i link lunghi delle email (token di
                    unsubscribe e simili) altrimenti sfondano la card. */}
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">
                  {msg.body}
                </p>
                {msg.error_message && (
                  <p className="mt-2 text-[13px] text-[var(--ds-critical-text)]">
                    {msg.error_code ? `${msg.error_code}: ` : ''}{msg.error_message}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
