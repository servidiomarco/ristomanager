import React from 'react';
import { Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { TableBill } from '../../types';
import { StatusPill } from '../ds';
import { StampaCopiaButton } from '../pagamenti/StampaCopiaButton';
import { euro } from './cassaView';
import { getRomeTimePart } from '../../utils/reservationTime';

/* ── Passo 5 · chiusura, i tre esiti ──────────────────────────────────────
   Quando il residuo arriva a zero il conto si chiude e il tavolo si libera.

   Il documento fiscale è un SECONDO BINARIO: può fallire da solo, e in quel
   caso lo stato dice che i soldi ci sono e il documento no. Mai «pagamento
   fallito» — il pagamento è andato, il tavolo è libero, e dire il contrario
   manderebbe il cassiere a richiedere denaro già incassato. */

export type Esito = 'saldato' | 'da-verificare' | 'proforma';

export const esitoOf = (
  bill: Pick<TableBill, 'status'>,
  fiscalStatus: string | null | undefined,
  docType: string | null | undefined,
): Esito => {
  if (fiscalStatus === 'FAILED') return 'da-verificare';
  if (docType === 'PROFORMA' || !fiscalStatus) return 'proforma';
  return 'saldato';
};

interface EsitoChiusuraProps {
  esito: Esito;
  totalCents: number;
  tableName: string | null;
  closedAt: string | null;
  docNumber: string | null;
  /** Presente quando lo scontrino nativo è CONFIRMED: il QR per l'ospite
   *  (/scontrino/<token>) compare direttamente nell'esito — è il momento in
   *  cui il cliente è ancora davanti alla cassa. */
  receiptToken?: string | null;
  /** Promessa vera, non fire-and-forget: l'esito (spunta o errore) lo mostra
   *  il bottone stesso, addosso al gesto. */
  onPrintReceipt?: () => Promise<unknown>;
  /** Stampa della proforma sulla termica: il foglio del preconto col titolo
   *  giusto, da consegnare al cliente che lo chiede. Resta possibile anche
   *  dopo, dal conto in Pagamenti. */
  onPrintProforma?: () => Promise<unknown>;
  busy: boolean;
  onRetryDocument: () => void;
  /** Rinuncia al documento: il conto resta chiuso, senza fiscale. */
  onMarkProforma: () => void;
  onIssueReceipt: () => void;
  onIssueInvoice: () => void;
  onReopen: () => void;
  onBackToQueue: () => void;
}

const HEAD: Record<Esito, { label: string; tone: 'positive' | 'pending' | 'neutral' }> = {
  saldato: { label: 'Saldato', tone: 'positive' },
  'da-verificare': { label: 'Pagato · da verificare fiscale', tone: 'pending' },
  proforma: { label: 'Chiuso con proforma', tone: 'neutral' },
};

export const EsitoChiusura: React.FC<EsitoChiusuraProps> = ({
  esito, totalCents, tableName, closedAt, docNumber, receiptToken, onPrintReceipt, onPrintProforma, busy,
  onRetryDocument, onMarkProforma, onIssueReceipt, onIssueInvoice, onReopen, onBackToQueue,
}) => {
  const head = HEAD[esito];

  const body =
    esito === 'saldato'
      ? `Tavolo ${tableName ?? '—'} liberato${closedAt ? ` alle ${getRomeTimePart(closedAt)}` : ''}.${docNumber ? ` Scontrino emesso, numero ${docNumber}.` : ' Scontrino emesso.'}`
      : esito === 'da-verificare'
        ? 'I soldi sono incassati e il tavolo è libero. Lo scontrino non è partito: si ritenta da qui o da Pagamenti.'
        : 'Nessun documento fiscale. Scontrino e fattura restano emettibili dal conto, anche nei giorni successivi.';

  const secondary =
    esito === 'saldato'
      ? [{ label: 'Apri il conto', onClick: onReopen }]
      : esito === 'da-verificare'
        ? [{ label: 'Chiudi con proforma', onClick: onMarkProforma }]
        : [
            { label: 'Emetti scontrino', onClick: onIssueReceipt },
            { label: 'Emetti fattura', onClick: onIssueInvoice },
          ];

  return (
    <div className="flex h-full min-h-0 items-center justify-center px-4 py-8">
      <div className="w-full max-w-[480px] rounded-[24px] bg-[var(--ds-surface)] p-6 shadow-[var(--ds-shadow-card)]">
        <StatusPill tone={head.tone}>{head.label}</StatusPill>

        <div className="mt-3 text-[40px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
          {euro(totalCents)}
        </div>

        <p className="mt-3 text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">{body}</p>

        {/* Lo scontrino si consegna adesso, col cliente ancora davanti: QR
            da inquadrare col telefono, o copia di cortesia dalla termica. */}
        {esito === 'saldato' && receiptToken && (
          <div className="mt-4 flex items-center gap-4 rounded-[16px] bg-[var(--ds-surface-row)] p-3.5">
            <div className="rounded-[10px] bg-white p-2" aria-hidden>
              <QRCodeSVG value={`${window.location.origin}/scontrino/${receiptToken}`} size={104} level="M" />
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-[13px] leading-snug text-[var(--ds-text-secondary)]">
                L'ospite lo inquadra e ha lo scontrino digitale sul telefono.
              </p>
              {onPrintReceipt && (
                <StampaCopiaButton onPrint={onPrintReceipt} variant="outline" />
              )}
            </div>
          </div>
        )}

        {esito === 'proforma' && onPrintProforma && (
          <StampaCopiaButton
            onPrint={onPrintProforma}
            label="Stampa proforma"
            sentLabel="Proforma in stampa"
            className="mt-4"
          />
        )}

        <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--ds-border)] pt-4">
          {secondary.map(a => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              disabled={busy}
              className="inline-flex h-11 items-center rounded-full bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
            >
              {a.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={esito === 'da-verificare' ? onRetryDocument : onBackToQueue}
          disabled={busy}
          className="mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {esito === 'da-verificare' ? 'Ritenta lo scontrino' : 'Torna alla coda'}
        </button>
      </div>
    </div>
  );
};
