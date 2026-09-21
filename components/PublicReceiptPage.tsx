import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Printer } from 'lucide-react';
import { RECEIPT_NAMESPACE, SupportedLanguage } from '../i18n/config';
import { PublicLanguageToggle } from './PublicLanguageToggle';

/* ── Scontrino digitale (pagina pubblica /scontrino/:token) ───────────────
   L'ospite inquadra il QR sull'esito di chiusura (o sulla copia di cortesia)
   e arriva qui: la copia leggibile del documento commerciale, salvabile e
   stampabile dal telefono. Come /pay è un albero standalone senza
   AuthProvider — nessun login, il token è la capability.

   NON è il documento fiscale: quello è il corrispettivo telematico trasmesso
   dal provider. La pagina lo dice in piede, sempre.

   Bilingue IT/EN come /pay (namespace `receipt`). La semantica fiscale resta
   italiana anche in inglese: l'EN nomina gli istituti («documento
   commerciale», Agenzia delle Entrate) invece di fingere equivalenti. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

interface ReceiptView {
  business: { name: string; address: string | null; vat_number: string | null };
  receipt: {
    status: 'CONFIRMED' | 'VOIDED';
    /** PROFORMA = copia non fiscale: la pagina lo dice in testa e in piede. */
    doc_type?: 'RECEIPT' | 'PROFORMA';
    doc_number: string | null;
    document_date: string | null;
    voided_at: string | null;
    table_name: string | null;
    total_cents: number;
    items: { description: string; quantity: number; unit_price_cents: number; vat_rate_code: string }[];
    cash_cents: number;
    electronic_cents: number;
    ticket_cents: number;
  };
}

// Stesso simbolo, formato diverso per lingua (12,34 € vs €12.34), come
// formatEur di PublicPayPage: la valuta resta EUR, è un documento italiano.
const euro = (cents: number, lang: SupportedLanguage) =>
  new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);

const dateLabel = (iso: string | null, lang: SupportedLanguage): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Fuso di Roma in entrambe le lingue: l'ora del documento è quella del
  // ristorante, non del telefono che lo legge.
  //
  // Roma è cablata di proposito, come la valuta sopra: lo scontrino è un
  // documento fiscale italiano e i tenant esteri non hanno il modulo
  // (entitlement 'fiscal'), quindi da questa pagina non ci passano.
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(d);
};

const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/scontrino\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

export const PublicReceiptPage: React.FC = () => {
  const { t, i18n, ready } = useTranslation(RECEIPT_NAMESPACE, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const [view, setView] = useState<ReceiptView | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const token = tokenFromPath();
    if (!token) { setNotFound(true); return; }
    fetch(`${API_URL}/scontrino/${encodeURIComponent(token)}`)
      .then(async r => {
        if (!r.ok) throw new Error(String(r.status));
        setView(await r.json() as ReceiptView);
      })
      .catch(() => setNotFound(true));
  }, []);

  useEffect(() => {
    if (ready) document.title = t(view?.receipt?.doc_type === 'PROFORMA' ? 'meta.titleProforma' : 'meta.title');
  }, [ready, t, lang, view?.receipt?.doc_type]);

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] px-6">
        <p className="text-center text-[15px] text-[var(--ds-text-secondary)]">
          {t('notFound')}
        </p>
      </div>
    );
  }
  if (!ready || !view) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)]">
        <Loader2 size={22} className="animate-spin text-[var(--ds-text-muted)]" aria-label={t('loadingAria')} />
      </div>
    );
  }

  const { business, receipt } = view;
  const paymentRows = [
    { label: t('payments.cash'), cents: receipt.cash_cents },
    { label: t('payments.electronic'), cents: receipt.electronic_cents },
    { label: t('payments.ticket'), cents: receipt.ticket_cents },
  ].filter(r => r.cents > 0);

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-3 flex w-full max-w-[420px] justify-end print:hidden">
        <PublicLanguageToggle namespace={RECEIPT_NAMESPACE} />
      </div>
      <div className="mx-auto w-full max-w-[420px] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-6 shadow-[var(--ds-shadow-card)] print:max-w-none print:rounded-none print:shadow-none">
        <div className="text-center">
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{business.name}</h1>
          {business.address && <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">{business.address}</p>}
          {business.vat_number && <p className="text-[13px] text-[var(--ds-text-muted)]">{t('vatLabel', { vat: business.vat_number })}</p>}
          <p className="mt-3 text-[13px] font-medium text-[var(--ds-text-secondary)]">
            {receipt.doc_type === 'PROFORMA' ? t('docType.proforma') : t('docType.copy')}
          </p>
          {receipt.status === 'VOIDED' && (
            <p className="mt-2 inline-block rounded-[var(--ds-radius-control)] bg-[var(--ds-critical-tint)] px-3 py-1 text-[13px] font-semibold text-[var(--ds-critical-text)]">
              {receipt.voided_at ? t('voidedOn', { date: dateLabel(receipt.voided_at, lang) }) : t('voided')}
            </p>
          )}
        </div>

        <div className="mt-5 border-t border-dashed border-[var(--ds-border-strong)] pt-4">
          <ul className="space-y-1.5">
            {receipt.items.map((i, idx) => (
              <li key={idx} className="flex items-baseline justify-between gap-3 text-[14px]">
                <span className="min-w-0 text-[var(--ds-text-primary)]">
                  {i.quantity !== 1 ? `${i.quantity}× ` : ''}{i.description}
                </span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-primary)]">
                  {euro(Math.round(i.unit_price_cents * i.quantity), lang)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-baseline justify-between border-t border-[var(--ds-border)] pt-3">
            <span className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('total')}</span>
            <span className="text-[20px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{euro(receipt.total_cents, lang)}</span>
          </div>
          {paymentRows.length > 0 && (
            <ul className="mt-2 space-y-1">
              {paymentRows.map(r => (
                <li key={r.label} className="flex items-baseline justify-between text-[13px] text-[var(--ds-text-secondary)]">
                  <span>{r.label}</span>
                  <span className="tabular-nums">{euro(r.cents, lang)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-dashed border-[var(--ds-border-strong)] pt-3 text-center text-[13px] text-[var(--ds-text-muted)]">
          {receipt.doc_number && <p>{t('docNumber', { number: receipt.doc_number })}</p>}
          {receipt.document_date && <p>{t('docDate', { date: dateLabel(receipt.document_date, lang) })}</p>}
          {receipt.table_name && <p>{t('table', { name: receipt.table_name })}</p>}
          <p className="mt-2">
            {receipt.doc_type === 'PROFORMA' ? t('footer.proforma') : t('footer.copy')}
          </p>
        </div>

        <button
          type="button"
          onClick={() => window.print()}
          className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-action-bg)] text-[15px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] print:hidden"
        >
          <Printer size={16} aria-hidden /> {t('print')}
        </button>
      </div>
    </div>
  );
};
