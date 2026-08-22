import React, { useState } from 'react';
import { Ban, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { PaymentRequest } from '../../types';
import { StatusPill } from '../ds';
import type { PillTone } from '../ds';

/* ── Una richiesta di acconto già inviata ─────────────────────────────────
   Amount first, then what it was for: scanning this list is asking "did the
   150 euro deposit land?", not "what happened at 13:50". The timestamp and
   the link go right, out of the reading path. */

const euro = (cents: number): string => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  PENDING: { label: 'In attesa', tone: 'pending' },
  AUTHORISED: { label: 'Autorizzato', tone: 'info' },
  COMPLETED: { label: 'Pagato', tone: 'positive' },
  PAID: { label: 'Pagato', tone: 'positive' },
  CANCELLED: { label: 'Annullato', tone: 'neutral' },
  FAILED: { label: 'Fallito', tone: 'critical' },
  EXPIRED: { label: 'Scaduto', tone: 'neutral' },
  REFUNDED: { label: 'Rimborsato', tone: 'info' },
};

export const PaymentRequestRow: React.FC<{
  request: PaymentRequest;
  copied: boolean;
  onCopy: () => void;
  /** Card #28 — revoca del link (solo se ancora payabile); assente = niente bottone. */
  onRevoke?: () => Promise<void> | void;
  revoking?: boolean;
}> = ({ request, copied, onCopy, onRevoke, revoking }) => {
  // Two-tap come il rimborso: il primo tocco arma, il secondo esegue,
  // il blur disarma — su un phone mid-servizio i tocchi involontari esistono.
  const [revokeArmed, setRevokeArmed] = useState(false);
  const state = STATUS[request.status] ?? { label: request.status, tone: 'neutral' as PillTone };
  const isRevocable = (request.status === 'PENDING' || request.status === 'AUTHORISED')
    && request.table_bill_split_id == null;
  const isPaid = state.label === 'Pagato';
  const when = (() => {
    try {
      return new Date(request.created_at).toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '';
    }
  })();

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[14px] bg-[var(--ds-surface-row)] px-3.5 py-2.5">
      <StatusPill tone={state.tone}>{state.label}</StatusPill>
      <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
        {euro(request.amount_cents)}
      </span>
      {request.description && (
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ds-text-muted)]">
          {request.description}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {when && <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{when}</span>}
        {onRevoke && isRevocable && (
          <button
            type="button"
            onClick={() => {
              if (!revokeArmed) { setRevokeArmed(true); return; }
              setRevokeArmed(false);
              void onRevoke();
            }}
            onBlur={() => setRevokeArmed(false)}
            disabled={revoking}
            title="Annulla il link al provider: il cliente non potrà più pagarlo"
            className={`inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              revokeArmed
                ? 'bg-[var(--ds-critical-solid)] text-[#ffffff]'
                : 'text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)]'
            }`}
          >
            {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            {revoking ? 'Revoca…' : revokeArmed ? 'Confermi?' : 'Revoca'}
          </button>
        )}
        {request.checkout_url && (
          <>
            <button
              type="button"
              onClick={onCopy}
              title="Copia link"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[var(--ds-seated-text)]" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {/* "Ricevuta" only once it is paid — before that the same URL is a
                checkout the customer has not been through yet, and calling it a
                receipt would be a lie about the state of the money. */}
            <a
              href={request.checkout_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--ds-text-primary)] underline underline-offset-2"
            >
              {isPaid ? 'Ricevuta' : 'Apri link'}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </>
        )}
      </span>
    </li>
  );
};
