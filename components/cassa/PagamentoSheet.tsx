import React, { useCallback, useEffect, useState } from 'react';
import { billsApiService, getOpenBills, getBillOrder, type OpenBillRow } from '../../services/billsApiService';
import { voidItem } from '../../services/ordersApiService';
import type { OrderItem, OrderWithItems } from '../../types';
import { ReasonDialog } from '../comande/ReasonDialog';
import { isSystemLine } from '../comande/orderView';
import { euro } from './cassaView';
import type { SettleOpts } from '../pagamenti/BillSheet';
import { BillSheet } from '../pagamenti/BillSheet';
import { ModalShell } from '../ds';
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
  const [bill, setBill] = useState<OpenBillRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('payment');
  const [quotaCents, setQuotaCents] = useState<number | null>(null);
  const [esito, setEsito] = useState<{ kind: Esito; bill: OpenBillRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fiscalReady, setFiscalReady] = useState(false);
  const [qrBill, setQrBill] = useState<OpenBillRow | null>(null);
  const [closed, setClosed] = useState(false);
  // Correzione del conto: la comanda dietro (con gli id delle righe) e la
  // riga in storno. Il totale si riallinea dal server, non si tocca a mano.
  const [editOrder, setEditOrder] = useState<OrderWithItems | null>(null);
  const [voidTarget, setVoidTarget] = useState<OrderItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOpenBills(service, { status: 'open' })
      .then(r => {
        if (cancelled) return;
        const row = r.bills.find(b => b.id === billId) ?? null;
        if (row) setBill(row);
        else setLoadError('Conto non trovato fra quelli aperti del servizio.');
      })
      .catch(err => { if (!cancelled) setLoadError(err?.message ?? 'Conto non caricato'); });
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

  const openCorreggi = useCallback(async () => {
    setError(null);
    try {
      setEditOrder(await getBillOrder(billId));
      setScreen('correggi');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Comanda non trovata');
    }
  }, [billId]);

  const stornaRiga = useCallback(async (item: OrderItem, reason: string) => {
    setBusy(true); setError(null);
    try {
      setEditOrder(await voidItem(item.id, reason));
      setVoidTarget(null);
      await reloadBill();
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Storno non riuscito');
    } finally {
      setBusy(false);
    }
  }, [reloadBill]);

  const settle = useCallback(async (opts?: SettleOpts) => {
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
      setEsito({ kind, bill: row ?? { ...bill, closed_at: result.closed_at } });
      setScreen('esito');
    } catch (err: any) {
      setError(err?.data?.error ?? err?.message ?? 'Chiusura non riuscita');
    } finally {
      setBusy(false);
    }
  }, [bill, service, onBillClosed]);

  return (
    <ModalShell
      open
      onClose={onClose}
      title={bill?.table_name ? `Incasso · T${bill.table_name}` : 'Incasso'}
      // Due colonne (scelta di Marco, 30/08: le tre a tutta larghezza erano
      // dispersive): lg le fa respirare senza occupare l'intero schermo.
      size="lg"
      closeOnEscape
      bodyClassName="p-4 sm:p-5"
    >
      {loadError ? (
        <p className="py-8 text-center text-[14px] text-[var(--ds-text-muted)]">{loadError}</p>
      ) : !bill ? (
        <div className="flex justify-center py-10"><Loader label="Carico il conto…" size={40} /></div>
      ) : screen === 'esito' && esito ? (
        <EsitoChiusura
          esito={esito.kind}
          totalCents={esito.bill.total_cents}
          tableName={esito.bill.table_name}
          closedAt={esito.bill.closed_at ?? null}
          docNumber={esito.bill.fiscal_ref ?? esito.bill.fiscal_doc_number ?? null}
          busy={busy}
          onRetryDocument={async () => {
            setBusy(true);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Emissione non riuscita'); }
            finally { setBusy(false); }
          }}
          onMarkProforma={async () => {
            setBusy(true);
            try { await billsApiService.markProforma(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Non riuscito'); }
            finally { setBusy(false); }
          }}
          onIssueReceipt={async () => {
            setBusy(true);
            try { await billsApiService.emitFiscalDoc(esito.bill.id); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Emissione non riuscita'); }
            finally { setBusy(false); }
          }}
          onIssueInvoice={() => {
            setError('La fattura si emette dal conto, in Pagamenti: servono i dati del cliente.');
          }}
          onReopen={async () => {
            setBusy(true);
            try { await billsApiService.reopenBill(esito.bill.id); onBillClosed(); onClose(); }
            catch (err: any) { setError(err?.data?.error ?? err?.message ?? 'Riapertura non riuscita'); }
            finally { setBusy(false); }
          }}
          onBackToQueue={onClose}
        />
      ) : screen === 'correggi' && editOrder ? (
        <div className="space-y-3">
          <p className="text-[14px] text-[var(--ds-text-secondary)]">
            Storna la portata contestata: resta in comanda come riga annullata con la
            motivazione, e il totale del conto si riallinea da solo.
          </p>
          <ul className="divide-y divide-[var(--ds-border)] rounded-[16px] bg-[var(--ds-surface-row)] px-3">
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
                    className="flex-shrink-0 rounded-full bg-[var(--ds-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-critical-text)] ring-1 ring-inset ring-[var(--ds-border-strong)] transition-colors hover:bg-[var(--ds-critical-tint)] disabled:opacity-40"
                  >
                    Storna
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-[14px] bg-[var(--ds-surface-row)] px-3.5 py-2.5">
            <span className="text-[14px] font-semibold text-[var(--ds-text-primary)]">Residuo aggiornato</span>
            <span className="text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{euro(bill.residual_cents)}</span>
          </div>
          <button
            type="button"
            onClick={() => setScreen('payment')}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[16px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)]"
          >
            Torna al pagamento
          </button>
        </div>
      ) : screen === 'split' ? (
        <DividiConto
          bill={bill}
          residualCents={bill.residual_cents}
          onBack={() => setScreen('payment')}
          onUseAmount={cents => { setQuotaCents(cents); setScreen('payment'); }}
        />
      ) : (
        <Pagamento
          bill={bill}
          busy={busy}
          error={error}
          fiscalReady={fiscalReady}
          quotaCents={quotaCents}
          onBack={onClose}
          onSettle={settle}
          onSplit={() => setScreen('split')}
          onShowQr={() => setQrBill(bill)}
          onEdit={openCorreggi}
          embedded
        />
      )}

      {/* «Chiedi al cliente»: il QR del pay-at-table, in sola lettura — il
          saldo qui dentro passa dal pannello, non dal BillSheet. */}
      {voidTarget && (
        <ReasonDialog
          title={`Storna ${voidTarget.qty}× ${voidTarget.name_snapshot}`}
          hint="Il cliente non l'ha ricevuta: la motivazione resta sul conto e in cucina."
          confirmLabel="Storna la riga"
          busy={busy}
          onCancel={() => setVoidTarget(null)}
          onConfirm={reason => stornaRiga(voidTarget, reason)}
        />
      )}

      {qrBill && !closed && (
        <BillSheet bill={qrBill} busy={busy} onClose={() => setQrBill(null)} />
      )}
    </ModalShell>
  );
};
