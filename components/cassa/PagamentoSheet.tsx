import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { billsApiService, getOpenBills, getBillOrder, printBill, setBillDiscount, type OpenBillRow } from '../../services/billsApiService';
import { voidItem } from '../../services/ordersApiService';
import type { OrderItem, OrderWithItems } from '../../types';
import { ReasonDialog } from '../comande/ReasonDialog';
import { DiscountDialog } from '../comande/DiscountDialog';
import { isSystemLine } from '../comande/orderView';
import { euro } from './cassaView';
import type { SettleOpts } from '../pagamenti/BillSheet';
import { BillSheet, InvoiceDialog } from '../pagamenti/BillSheet';
import { ModalShell } from '../ds';
import { socketClient } from '../../services/socketClient';
import { Loader } from '../Loader';
import { Pagamento } from './Pagamento';
import { DividiConto } from './DividiConto';
import { EsitoChiusura, esitoOf, type Esito } from './EsitoChiusura';

/* ── Il pannello di incasso della Cassa, apribile da qualunque schermata ──
   Estrazione prevista dal piano (docs/cassa-plan.md §1, «estrazione
   additiva»): il pannello Pagamento/DividiConto/EsitoChiusura era già puro,
   qui c'è solo l'orchestrazione che in CassaPage vive nella pagina. Un solo
   motore di incasso, due punti d'ingresso: il banco (Cassa) e il tavolo
   (Comande, per il cameriere col permesso di cassa).

   La sessione di cassa non va threadata: è una parentesi temporale, non una
   FK — un incasso registrato da qui entra nel servizio come quelli battuti
   al banco. */

interface PagamentoSheetProps {
  billId: number;
  /** Il servizio della vista chiamante: stesso filtro di /bills/open. */
  service: { service_date: string; shift?: 'LUNCH' | 'DINNER' };
  onClose: () => void;
  /** Il conto è stato chiuso: il chiamante ricarica le sue liste. */
  onBillClosed: () => void;
}

type Screen = 'payment' | 'split' | 'esito' | 'correggi';

export const PagamentoSheet: React.FC<PagamentoSheetProps> = ({ billId, service, onClose, onBillClosed }) => {
  const { t } = useTranslation('cassa', { useSuspense: false });
  const [bill, setBill] = useState<OpenBillRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('payment');
  const [quotaCents, setQuotaCents] = useState<number | null>(null);
  const [quotaItemUnits, setQuotaItemUnits] = useState<{ order_item_id: number; units: number }[] | null>(null);
  const [esito, setEsito] = useState<{ kind: Esito; bill: OpenBillRow; paidNowCents?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fiscalReady, setFiscalReady] = useState(false);
  // Un flag, non una copia del conto: il foglio QR deve leggere `bill`, che
  // reloadBill tiene fresco sugli eventi — la copia restava allo snapshot
  // del tocco e barra/totali non si muovevano più (visto al collaudo).
  const [qrOpen, setQrOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  // Correzione del conto: la comanda dietro (con gli id delle righe) e la
  // riga in storno. Il totale si riallinea dal server, non si tocca a mano.
  const [editOrder, setEditOrder] = useState<OrderWithItems | null>(null);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOpenBills(service, { status: 'open' })
      .then(r => {
        if (cancelled) return;
        const row = r.bills.find(b => b.id === billId) ?? null;
        if (row) setBill(row);
        else setLoadError(t('err.billNotInOpen'));
      })
      .catch(err => { if (!cancelled) setLoadError(err?.message ?? t('err.billNotLoaded')); });
    billsApiService.getFiscalSettings()
      .then(f => { if (!cancelled) setFiscalReady(f.provider !== 'none'); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [billId, service]);

  const reloadBill = useCallback(async () => {
    const r = await getOpenBills(service, { status: 'open' });
    const row = r.bills.find(b => b.id === billId) ?? null;
    if (row) setBill(row);
  }, [service, billId]);

  // Il cliente paga la sua quota col QR/link mentre il conto è aperto in
  // cassa: senza questo ascolto il residuo restava lo snapshot di apertura.
  // Ora si rilegge e si fa avanzare il pulse, che accende il feedback in
  // Pagamento (lampeggio + suono + vibrazione).
  const [paymentPulse, setPaymentPulse] = useState(0);
  useEffect(() => {
    const socket = socketClient.getSocket();
    const onPaid = (payload: any) => {
      if (payload?.bill_id !== billId) return;
      reloadBill();
      setPaymentPulse(p => p + 1);
    };
    // Claim e rilascio: si rilegge (il residuo li sconta, e «sta pagando»
    // deve comparire nelle Quote del foglio QR), ma senza pulse — il suono
    // è dei soldi arrivati, non delle intenzioni. Il poll di cortesia fa
    // sparire i claim scaduti, che non emettono nessun evento (TTL 5′).
    const onClaim = (payload: any) => { if (payload?.bill_id === billId) reloadBill(); };
    socket?.on('bill:split-paid', onPaid);
    socket?.on('bill:settled', onPaid);
    socket?.on('bill:split-claimed', onClaim);
    socket?.on('bill:split-released', onClaim);
    const poll = setInterval(reloadBill, 15_000);
    return () => {
      socket?.off('bill:split-paid', onPaid); socket?.off('bill:settled', onPaid);
      socket?.off('bill:split-claimed', onClaim); socket?.off('bill:split-released', onClaim);
      clearInterval(poll);
    };
  }, [billId, reloadBill]);

  const openCorreggi = useCallback(async () => {
    setError(null);
    try {
      setEditOrder(await getBillOrder(billId));
      setScreen('correggi');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? t('err.orderNotFound'));
    }
  }, [billId]);

  const stornaRiga = useCallback(async (item: OrderItem, reason: string, qty?: number) => {
    setBusy(true); setError(null);
    try {
      setEditOrder(await voidItem(item.id, reason, qty));
      setVoidTarget(null);
      await reloadBill();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? t('err.void'));
    } finally {
      setBusy(false);
    }
  }, [reloadBill]);

  const applyDiscount = useCallback(async (
    p: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string } | null,
  ) => {
    if (!bill) return;
    setBusy(true); setError(null);
    try {
      await setBillDiscount(bill.id, p);
      await reloadBill();
      setDiscountOpen(false);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? t('err.discount'));
      // Il dialog copre il Callout dell'errore: si chiude per farlo leggere.
      setDiscountOpen(false);
    } finally { setBusy(false); }
  }, [bill, reloadBill]);

  const settle = useCallback(async (opts?: SettleOpts, meta?: { invoiceIntent?: boolean }) => {
    if (!bill) return;
    setBusy(true);
    setError(null);
    try {
      const result = await billsApiService.closeBill(bill.id, opts ?? {});
      setClosed(true);
      onBillClosed();
      // Come in CassaPage: lo stato fiscale si rilegge dai conti chiusi,
      // l'emissione del documento è asincrona.
      const closedRows = await getOpenBills(service, { status: 'closed' });
      const row = closedRows.bills.find(b => b.id === bill.id);
      const kind = esitoOf(
        { status: result.status },
        row?.fiscal_status ?? null,
        row?.fiscal_doc_type ?? null,
      );
      const paidNowCents = (opts?.payments ?? []).reduce((s, p) => s + p.amount_cents, 0);
      setEsito({ kind, bill: row ?? { ...bill, closed_at: result.closed_at, tip_cents: result.tip_cents, tip_method: result.tip_method }, paidNowCents });
      setScreen('esito');
      // Intento «Fattura»: niente strada a metà — l'emissione si apre da
      // sola, precompilata col cliente della visita se c'è.
      if (meta?.invoiceIntent) setInvoiceOpen(true);
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? t('err.close'));
    } finally {
      setBusy(false);
    }
  }, [bill, service, onBillClosed]);

  return (
    <ModalShell
      open
      onClose={onClose}
      title={bill?.table_name ? t('takingTitleTable', { tavolo: bill.table_name }) : t('takingTitle')}
      // Due colonne (scelta di Marco, 30/08: le tre a tutta larghezza erano
      // dispersive): lg le fa respirare senza occupare l'intero schermo.
      size="lg"
      closeOnEscape
      bodyClassName="p-4 sm:p-5"
    >
      {loadError ? (
        <p className="py-8 text-center text-[14px] text-[var(--ds-text-muted)]">{loadError}</p>
      ) : !bill ? (
        <div className="flex justify-center py-10"><Loader label={t('loadingBill')} size={40} /></div>
      ) : screen === 'esito' && esito ? (
        <EsitoChiusura
          esito={esito.kind}
          totalCents={esito.bill.total_cents}
          paidNowCents={esito.paidNowCents ?? null}
          tipCents={esito.bill.tip_cents ?? 0}
          tipMethod={esito.bill.tip_method ?? null}
          residualCents={esito.bill.residual_cents ?? null}
          tableName={esito.bill.table_name}
          closedAt={esito.bill.closed_at ?? null}
          docNumber={esito.bill.fiscal_ref ?? esito.bill.fiscal_doc_number ?? null}
          onPrintProforma={() => printBill(esito.bill.id, 'PROFORMA')}
          busy={busy}
          onRetryDocument={async () => {
            setBusy(true);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? t('err.issue')); }
            finally { setBusy(false); }
          }}
          onMarkProforma={async () => {
            setBusy(true);
            try { await billsApiService.markProforma(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? t('err.generic')); }
            finally { setBusy(false); }
          }}
          onIssueReceipt={async () => {
            setBusy(true);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? t('err.issue')); }
            finally { setBusy(false); }
          }}
          onIssueInvoice={() => setInvoiceOpen(true)}
          onReopen={async () => {
            setBusy(true);
            try { await billsApiService.reopenBill(esito.bill.id); onBillClosed(); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? t('err.reopen')); }
            finally { setBusy(false); }
          }}
          onBackToQueue={onClose}
        />
      ) : screen === 'correggi' && editOrder ? (
        <div className="space-y-3">
          <p className="text-[14px] text-[var(--ds-text-secondary)]">
            {t('voidDisputedHint')}
          </p>
          <ul className="divide-y divide-[var(--ds-border)] rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-3">
            {editOrder.items.filter(i => !isSystemLine(i)).map(i => (
              <li key={i.id} className="flex items-center gap-3 py-2.5">
                <span className={`min-w-0 flex-1 text-[15px] ${i.status === 'VOIDED' ? 'text-[var(--ds-text-muted)] line-through' : 'text-[var(--ds-text-primary)]'}`}>
                  <span className="tabular-nums">{i.qty}×</span> {i.name_snapshot}
                  {i.status === 'VOIDED' && i.void_reason ? (
                    <span className="ml-2 text-[12px] no-underline">({i.void_reason})</span>
                  ) : null}
                </span>
                <span className="flex-shrink-0 tabular-nums text-[14px] text-[var(--ds-text-secondary)]">
                  {euro(i.unit_price_cents * i.qty)}
                </span>
                {i.status !== 'VOIDED' && (
                  <button
                    type="button"
                    onClick={() => setVoidTarget(i)}
                    disabled={busy}
                    className="flex-shrink-0 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-critical-text)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-critical-tint)] disabled:opacity-40"
                  >
                    {t('voidLabel')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] px-3.5 py-2.5">
            <span className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{t('remainingUpdated')}</span>
            <span className="text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{euro(bill.residual_cents)}</span>
          </div>
          <button
            type="button"
            onClick={() => setScreen('payment')}
            className="inline-flex h-12 w-full items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)]"
          >
            {t('backToPayment')}
          </button>
        </div>
      ) : screen === 'split' ? (
        <DividiConto
          bill={bill}
          residualCents={bill.residual_cents}
          onBack={() => setScreen('payment')}
          onUseAmount={(cents, itemUnits) => { setQuotaCents(cents); setQuotaItemUnits(itemUnits ?? null); setScreen('payment'); }}
        />
      ) : (
        <Pagamento
          bill={bill}
          busy={busy}
          error={error}
          fiscalReady={fiscalReady}
          quotaCents={quotaCents}
          quotaItemUnits={quotaItemUnits}
          onBack={onClose}
          onSettle={settle}
          onSplit={() => setScreen('split')}
          onShowQr={() => setQrOpen(true)}
          onEdit={openCorreggi}
          onDiscount={() => setDiscountOpen(true)}
          embedded
          paymentPulse={paymentPulse}
        />
      )}

      {/* «Chiedi al cliente»: il QR del pay-at-table, in sola lettura — il
          saldo qui dentro passa dal pannello, non dal BillSheet. */}
      {invoiceOpen && (esito?.bill ?? bill) && (
        <InvoiceDialog
          bill={(esito?.bill ?? bill)!}
          initialQuery={(esito?.bill ?? bill)!.customer_name ?? undefined}
          onCancel={() => setInvoiceOpen(false)}
          onDone={() => { setInvoiceOpen(false); onClose(); }}
        />
      )}

      {bill && discountOpen && (
        <DiscountDialog
          title={t('billDiscount')}
          currentReason={bill.discount_reason ?? null}
          hasDiscount={bill.discount_type != null}
          reasonRequired={false}
          busy={busy}
          onCancel={() => setDiscountOpen(false)}
          onClear={() => applyDiscount(null)}
          onConfirm={applyDiscount}
        />
      )}

      {voidTarget && (
        <ReasonDialog
          title={t(voidTarget.qty > 1 ? 'void.title' : 'void.titleOne', { piatto: voidTarget.name_snapshot })}
          hint={t('void.hintSheet')}
          confirmLabel={t('void.confirmLine')}
          busy={busy}
          maxQty={voidTarget.qty}
          onCancel={() => setVoidTarget(null)}
          onConfirm={(reason, qty) => stornaRiga(voidTarget, reason, qty)}
        />
      )}

      {qrOpen && bill && !closed && (
        <BillSheet bill={bill} busy={busy} onClose={() => setQrOpen(false)} />
      )}
    </ModalShell>
  );
};
