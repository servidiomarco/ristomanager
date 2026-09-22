import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Phone, MapPin, Sun, Sunset, Users, MessageCircle, Globe } from 'lucide-react';
import { QUOTE_NAMESPACE, SupportedLanguage } from '../i18n/config';
import { PublicLanguageToggle } from './PublicLanguageToggle';

/* ── Preventivo banchetto (pagina pubblica /preventivo/:token) ────────────
   Il cliente apre il link ricevuto su WhatsApp o email e trova il documento
   da inoltrare alla famiglia: menù per uscite, tariffe, totale. Come /pay e
   /scontrino è un albero standalone senza AuthProvider — nessun login, il
   token è la capability.

   La pagina legge sempre lo stato attuale: il ristorante che ritocca il
   menù non deve rimandare nessun link. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

interface QuoteView {
  business: {
    name: string;
    tagline: string | null;
    phone: string | null;
    whatsapp: string | null;
    address: string | null;
    maps_url: string | null;
    website_url: string | null;
    logo_url: string | null;
  };
  currency?: string;
  quote: {
    name: string;
    status: 'QUOTE' | 'CONFIRMED';
    event_date: string | null;
    shift: 'LUNCH' | 'DINNER' | null;
    guests: number | null;
    children: number | null;
    price_per_person: number | null;
    children_price: number | null;
    discount_type: 'PERCENT' | 'AMOUNT' | null;
    discount_value: number | null;
    deposit_amount: number | null;
    totals: { gross: number; discount: number; total: number } | null;
    courses: { name: string; notes: string | null; dishes: { name: string; description: string | null; allergens: string[] }[] }[];
  };
}

// Formato diverso per lingua (12,34 € vs €12.34), come su /pay: la VALUTA
// però non dipende dalla lingua, è quella del ristorante e arriva nel payload.
const euro = (n: number, lang: SupportedLanguage, currency: string = 'EUR') =>
  new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'it-IT', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

const dateLabel = (iso: string | null, lang: SupportedLanguage): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
};

const tokenFromPath = (): string => {
  const m = window.location.pathname.match(/^\/preventivo\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

export const PublicQuotePage: React.FC = () => {
  const { t, i18n, ready } = useTranslation(QUOTE_NAMESPACE, { useSuspense: false });
  const lang: SupportedLanguage = (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const [view, setView] = useState<QuoteView | null>(null);
  // La valuta del preventivo vale per tutti i suoi importi.
  const eur = (n: number): string => euro(n, lang, view?.currency);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const token = tokenFromPath();
    if (!token) { setNotFound(true); return; }
    fetch(`${API_URL}/preventivo/${encodeURIComponent(token)}`)
      .then(async r => {
        if (!r.ok) throw new Error(String(r.status));
        setView(await r.json() as QuoteView);
      })
      .catch(() => setNotFound(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.title = view
      ? t('meta.titleFull', { name: view.quote.name, business: view.business.name })
      : t('meta.title');
  }, [ready, t, lang, view]);

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] p-6">
        <div className="max-w-sm rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-6 text-center shadow-[var(--ds-shadow-card)]">
          <p className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{t('notFound.title')}</p>
          <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
            {t('notFound.hint')}
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !view) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ds-canvas)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-text-muted)]" aria-label={t('loadingAria')} />
      </div>
    );
  }

  const { business, quote } = view;
  const isQuote = quote.status === 'QUOTE';
  const adults = Math.max(0, (quote.guests ?? 0) - (quote.children ?? 0));
  const showChildrenRow = (quote.children ?? 0) > 0 && quote.children_price != null;

  return (
    <div className="min-h-screen bg-[var(--ds-canvas)] pb-12">
      <div className="mx-auto max-w-lg px-4 pt-8 sm:px-6">
        <div className="mb-3 flex justify-end">
          <PublicLanguageToggle namespace={QUOTE_NAMESPACE} />
        </div>
        <header className="text-center">
          {business.logo_url && (
            <img
              src={business.logo_url}
              alt=""
              className="mx-auto mb-3 h-16 w-auto max-w-[240px] object-contain"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <p className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{business.name}</p>
          <span className={`mt-3 inline-flex h-7 items-center rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium ${
            isQuote
              ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
              : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
          }`}>
            {isQuote ? t('status.quote') : t('status.confirmed')}
          </span>
          <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {quote.name}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[14px] text-[var(--ds-text-secondary)]">
            {quote.event_date && <span>{dateLabel(quote.event_date, lang)}</span>}
            {quote.shift === 'LUNCH' && (
              <span className="inline-flex items-center gap-1"><Sun className="h-3.5 w-3.5" aria-hidden /> {t('shift.lunch')}</span>
            )}
            {quote.shift === 'DINNER' && (
              <span className="inline-flex items-center gap-1"><Sunset className="h-3.5 w-3.5" aria-hidden /> {t('shift.dinner')}</span>
            )}
            {quote.guests != null && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {t('covers', { count: quote.guests })}{(quote.children ?? 0) > 0 ? t('childrenSuffix', { count: quote.children ?? 0 }) : ''}
              </span>
            )}
          </p>
        </header>

        {quote.courses.length > 0 && (
          <div className="mt-6 space-y-3">
            {quote.courses.map((course, i) => (
              <section key={`${course.name}-${i}`} className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)]">
                <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">{course.name}</h2>
                <ul className="mt-2 space-y-2.5">
                  {course.dishes.map((d, j) => (
                    <li key={`${d.name}-${j}`}>
                      <p className="text-[15px] font-medium leading-snug text-[var(--ds-text-primary)]">{d.name}</p>
                      {d.description && (
                        <p className="mt-0.5 text-[13px] leading-snug text-[var(--ds-text-muted)]">{d.description}</p>
                      )}
                      {d.allergens.length > 0 && (
                        <p className="mt-0.5 text-[12px] text-[var(--ds-critical-text)]">
                          {t('allergens', { list: d.allergens.join(', ').toLowerCase() })}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {course.notes && (
                  <p className="mt-3 border-t border-[var(--ds-border)] pt-2.5 text-[13px] italic text-[var(--ds-text-secondary)] whitespace-pre-wrap">{course.notes}</p>
                )}
              </section>
            ))}
          </div>
        )}

        {quote.totals && (
          <section className="mt-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)]">
            <h2 className="text-[13px] font-semibold text-[var(--ds-text-muted)]">{t('rates.title')}</h2>
            <dl className="mt-2 space-y-1.5 text-[14px] text-[var(--ds-text-primary)]">
              {quote.price_per_person != null && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--ds-text-secondary)]">{t('rates.adults', { count: adults, price: eur(quote.price_per_person) })}</dt>
                  <dd className="tabular-nums">{eur(adults * quote.price_per_person)}</dd>
                </div>
              )}
              {showChildrenRow && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--ds-text-secondary)]">{t('rates.children', { count: quote.children ?? 0, price: eur(quote.children_price!) })}</dt>
                  <dd className="tabular-nums">{eur(quote.children! * quote.children_price!)}</dd>
                </div>
              )}
              {quote.totals.discount > 0 && (
                <div className="flex items-baseline justify-between gap-3 text-[var(--ds-seated-text)]">
                  <dt>
                    {t('rates.discount')}{quote.discount_type === 'PERCENT' && quote.discount_value != null ? ` ${quote.discount_value}%` : ''}
                  </dt>
                  <dd className="tabular-nums">−{eur(quote.totals.discount)}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-[var(--ds-border)] pt-2 text-[16px] font-semibold">
                <dt>{t('rates.total')}</dt>
                <dd className="tabular-nums">{eur(quote.totals.total)}</dd>
              </div>
              {quote.deposit_amount != null && quote.deposit_amount > 0 && (
                <div className="flex items-baseline justify-between gap-3 text-[13px] text-[var(--ds-text-muted)]">
                  <dt>{t('rates.deposit')}</dt>
                  <dd className="tabular-nums">{eur(quote.deposit_amount)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        <footer className="mt-6 text-center text-[13px] text-[var(--ds-text-muted)]">
          {isQuote && <p>{t('footer.notBinding')}</p>}
          {/* La carta d'identità del ristorante: chi manda il preventivo e
              come raggiungerlo con un tocco. */}
          <div className="mt-4 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-5 py-4 shadow-[var(--ds-shadow-card)]">
            <p className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{business.name}</p>
            {business.tagline && (
              <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">{business.tagline}</p>
            )}
            {business.address && (
              business.maps_url ? (
                <a
                  href={business.maps_url}
                  target="_blank"
                  rel="noopener"
                  className="mt-2 inline-flex min-h-11 items-center justify-center gap-1 text-[var(--ds-text-secondary)] underline decoration-[var(--ds-border-strong)] underline-offset-2"
                >
                  <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />{business.address}
                </a>
              ) : (
                <p className="mt-2 inline-flex min-h-11 items-center justify-center gap-1 text-[var(--ds-text-secondary)]">
                  <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />{business.address}
                </p>
              )
            )}
            <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
              {business.phone && (
                <a href={`tel:${business.phone.replace(/\s+/g, '')}`} className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]">
                  <Phone className="h-3.5 w-3.5" aria-hidden />{business.phone}
                </a>
              )}
              {business.whatsapp && (
                <a
                  href={`https://wa.me/${business.whatsapp.replace(/\D/g, '').replace(/^00/, '')}`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]"
                >
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden />WhatsApp
                </a>
              )}
              {business.website_url && (
                <a
                  href={business.website_url}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-11 items-center gap-1.5 text-[var(--ds-text-secondary)]"
                >
                  <Globe className="h-3.5 w-3.5" aria-hidden />
                  {business.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
};
