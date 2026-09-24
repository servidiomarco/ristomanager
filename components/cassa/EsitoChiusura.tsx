import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { TableBill, TipMethod } from '../../types';
import { StatusPill } from '../ds';
import { StampaCopiaButton } from '../pagamenti/StampaCopiaButton';
import { euro } from './cassaView';
import { methodLabel } from '../pagamenti/settleView';
import { timePart } from '../../utils/displayTime';

/* ── Passo 5 · chiusura, i tre esiti ──────────────────────────────────────
   Quando il residuo arriva a zero il conto si chiude e il tavolo si libera.

   Il documento fiscale è un SECONDO BINARIO: può fallire da solo, e in quel
   caso lo stato dice che i soldi ci sono e il documento no. Mai «pagamento
   fallito» — il pagamento è andato, il tavolo è libero, e dire il contrario
   manderebbe il cassiere a richiedere denaro già incassato. */

export type Esito = 'saldato' | 'da-verificare' | 'proforma' | 'parziale';

export const esitoOf = (
  bill: Pick<TableBill, 'status'>,
  fiscalStatus: string | null | undefined,
  docType: string | null | undefined,
): Esito => {
  // Quota incassata, residuo ancora sul conto: dire «chiuso» col totale del
  // tavolo manderebbe il cassiere a credere che sia tutto pagato.
  if (bill.status === 'SETTLED_PARTIAL') return 'parziale';
  if (fiscalStatus === 'FAILED') return 'da-verificare';
  if (docType === 'PROFORMA' || !fiscalStatus) return 'proforma';
  return 'saldato';
};

interface EsitoChiusuraProps {
  esito: Esito;
  totalCents: number;
  /** Esito «parziale»: quanto è entrato con QUESTO incasso e quanto resta. */
  paidNowCents?: number | null;
  residualCents?: number | null;
  /** Mancia registrata con la chiusura: fuori dal totale del conto, quindi
   *  detta a parte — prima non compariva da nessuna parte in Cassa. */
  tipCents?: number;
  tipMethod?: TipMethod | null;
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

// Mappa di modulo: porta la chiave accanto all'italiano, come le altre.
const HEAD: Record<Esito, { label: string; labelKey?: string; tone: 'positive' | 'pending' | 'neutral' }> = {
  saldato: { label: 'Saldato', labelKey: 'esito.settled', tone: 'positive' },
  'da-verificare': { label: 'Pagato · da verificare fiscale', labelKey: 'esito.toVerify', tone: 'pending' },
  proforma: { label: 'Chiuso con proforma', labelKey: 'closedWithProforma', tone: 'neutral' },
  parziale: { label: 'Incassata una parte', labelKey: 'esito.partial', tone: 'pending' },
};

export const EsitoChiusura: React.FC<EsitoChiusuraProps> = ({
  esito, totalCents, paidNowCents = null, residualCents = null, tipCents = 0, tipMethod = null, tableName, closedAt, docNumber, receiptToken, onPrintReceipt, onPrintProforma, busy,
  onRetryDocument, onMarkProforma, onIssueReceipt, onIssueInvoice, onReopen, onBackToQueue,
}) => {
  const { t } = useTranslation('cassa', { useSuspense: false });
  const head = HEAD[esito];
  const headLabel = head.labelKey ? t(head.labelKey, head.label) : head.label;
  const residuo = Math.max(0, residualCents ?? 0);
  // In grande c'è quello che è entrato ADESSO, non il totale del tavolo.
  const bigCents = esito === 'parziale'
    ? (paidNowCents ?? Math.max(0, totalCents - residuo))
    : totalCents;

  const body =
    esito === 'saldato'
      ? t('esitoSettledBody', {
          tavolo: tableName ?? '—',
          quando: closedAt ? t('esitoAtTime', { ora: timePart(closedAt) }) : '',
          documento: docNumber ? t('esitoReceiptNo', { numero: docNumber }) : t('esitoReceiptIssued'),
        })
      : esito === 'da-verificare'
        ? t('esitoToVerifyBody')
        : esito === 'parziale'
          ? t('esitoPartialBody', { residuo: euro(residuo), totale: euro(totalCents) })
          : t('esitoProformaBody');

  const secondary =
    esito === 'saldato'
      ? [{ label: t('openBill'), onClick: onReopen }]
      : esito === 'da-verificare'
        ? [{ label: t('closeWithProforma'), onClick: onMarkProforma }]
        : esito === 'parziale'
          ? [{ label: t('reopenAndContinue'), onClick: onReopen }]
          : [
              { label: t('issueReceipt'), onClick: onIssueReceipt },
              { label: t('issueInvoice'), onClick: onIssueInvoice },
            ];

  return (
    <div className="flex h-full min-h-0 items-center justify-center px-4 py-8">
      <div className="w-full max-w-[480px] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-6 shadow-[var(--ds-shadow-card)]">
        <StatusPill tone={head.tone}>{headLabel}</StatusPill>

        <div className="mt-3 text-[40px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-[var(--ds-text-primary)]">
          {euro(bigCents)}
        </div>

        <p className="mt-3 text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">{body}</p>

        {tipCents > 0 && (
          <p className="mt-2 text-[14px] text-[var(--ds-text-secondary)]">
            {t('tipLine', { importo: euro(tipCents) })}
            {tipMethod && <span className="text-[var(--ds-text-muted)]"> · {methodLabel(tipMethod)}</span>}
          </p>
        )}

        {/* Lo scontrino si consegna adesso, col cliente ancora davanti: QR
            da inquadrare col telefono, o copia di cortesia dalla termica. */}
        {esito === 'saldato' && receiptToken && (
          <div className="mt-4 flex items-center gap-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3.5">
            <div className="rounded-[var(--ds-radius)] bg-white p-2" aria-hidden>
              <QRCodeSVG value={`${window.location.origin}/scontrino/${receiptToken}`} size={104} level="M" />
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-[13px] leading-snug text-[var(--ds-text-secondary)]">
                {t('receiptQrHint')}
              </p>
              {onPrintReceipt && (
                <StampaCopiaButton onPrint={onPrintReceipt} variant="outline" />
              )}
            </div>
          </div>
        )}

        {(esito === 'proforma' || esito === 'parziale') && onPrintProforma && (
          <StampaCopiaButton
            onPrint={onPrintProforma}
            label={t('printProforma')}
            sentLabel={t('proformaPrinting')}
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
              className="inline-flex h-11 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
            >
              {a.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={esito === 'da-verificare' ? onRetryDocument : onBackToQueue}
          disabled={busy}
          className="mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {t(esito === 'da-verificare' ? 'retryReceipt' : 'backToQueue')}
        </button>
      </div>
    </div>
  );
};
