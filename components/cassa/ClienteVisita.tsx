import React from 'react';
import { ExternalLink, Loader2, UserPlus } from 'lucide-react';
import type { Reservation } from '../../types';
import { Avatar, Callout, Sheet, StatusPill } from '../ds';

/* ── Il cliente della visita ──────────────────────────────────────────────
   Si apre dalla pill in testata, unico ingresso. Un pannello laterale, non un
   modale sopra un modale: il tavolo resta visibile dietro.

   Il cliente appartiene alla VISITA, non al tavolo — e nel modello la visita è
   la prenotazione (docs/cassa-plan.md §2). Associare un cliente a un walk-in
   quindi crea una prenotazione «adesso», già seduta, e la aggancia alla
   comanda: non c'è un'entità «visita» separata da inventare per l'occasione.

   Senza cliente si incassa lo stesso. Il nome serve alla fattura e allo
   storico, non al pagamento — e dirlo evita che qualcuno lo cerchi a tutti i
   costi con il tavolo che aspetta. */

interface ClienteVisitaProps {
  open: boolean;
  tableName: string;
  reservation: Reservation | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Apre il picker della rubrica: associare crea la visita walk-in. */
  onAssociate: () => void;
  onRemove: () => void;
  onOpenProfile: (customerId: number | null) => void;
}

export const ClienteVisita: React.FC<ClienteVisitaProps> = ({
  open, tableName, reservation, busy, error, onClose, onAssociate, onRemove, onOpenProfile,
}) => {
  const hasCustomer = reservation != null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      ariaLabel="Cliente della visita"
      title="Cliente della visita"
      subtitle={`Tavolo ${tableName} · ${hasCustomer ? 'dalla prenotazione' : 'walk-in'}`}
      bodyClassName="space-y-3 px-4 pb-5 pt-4 sm:px-5"
    >
      {error && <Callout tone="critical">{error}</Callout>}

      {hasCustomer ? (
        <>
          <div className="rounded-[16px] bg-[var(--ds-arriving-tint)] p-4">
            <div className="flex items-center gap-3">
              <Avatar name={reservation!.customer_name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[17px] font-semibold text-[var(--ds-text-primary)]">
                  {reservation!.customer_name}
                </div>
                <div className="truncate text-[13px] text-[var(--ds-arriving-text)]">
                  {reservation!.phone ?? 'nessun telefono'}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {reservation!.customer_is_vip && <StatusPill tone="pending">VIP</StatusPill>}
              {reservation!.customer_preferred_table_name && (
                <StatusPill tone="neutral">
                  Tavolo preferito {reservation!.customer_preferred_table_name}
                </StatusPill>
              )}
            </div>
          </div>

          {reservation!.customer_dietary_notes && (
            <Callout tone="pending">{reservation!.customer_dietary_notes}</Callout>
          )}
          {reservation!.notes && (
            <Callout tone="info">{reservation!.notes}</Callout>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onAssociate}
              disabled={busy}
              className="inline-flex h-11 items-center rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              Cambia cliente
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="inline-flex h-11 items-center rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
              Rimuovi
            </button>
            <button
              type="button"
              onClick={() => onOpenProfile(null)}
              className="inline-flex h-11 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
            >
              Apri profilo <ExternalLink size={14} aria-hidden />
            </button>
          </div>
        </>
      ) : (
        <>
          <Callout tone="info">
            Nessun cliente sulla visita. Si può incassare così: il cliente serve per
            la fattura e per lo storico.
          </Callout>

          <button
            type="button"
            onClick={onAssociate}
            disabled={busy}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} aria-hidden />}
            Associa un cliente
          </button>

          <p className="text-center text-[12px] text-[var(--ds-text-muted)]">
            Associare crea una visita walk-in per questo servizio e vi collega il
            cliente. Il tavolo non resta legato a lui.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-full items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[14px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)]"
          >
            Prosegui anonimo
          </button>
        </>
      )}
    </Sheet>
  );
};
