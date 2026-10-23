import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, Loader2 } from 'lucide-react';
import {
  InventoryArea,
  InventoryLocation,
  InventoryMovementEntry,
  InventoryMovementReason,
  InventoryProduct,
} from '../../types';
import { getInventoryMovements } from '../../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../../utils/reservationTime';
import { toTitleCase } from '../../utils/text';
import { ModalShell, Sheet, SegmentedControl, SectionHeader, EmptyState, Callout, dsButton } from '../ds';

type TFn = (key: string, opts?: any) => string;

const ROME = 'Europe/Rome';

/* ── Come si legge una voce ────────────────────────────────────────────────
   Le stesse parole nella riga sotto il prodotto e nello storico, così «+10 kg
   · oggi 18:40 · Marco S.» dice la stessa cosa nei due posti. */

const numberFmt = new Map<string, Intl.NumberFormat>();
const formatNumber = (n: number, locale: string): string => {
  let f = numberFmt.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
    numberFmt.set(locale, f);
  }
  return f.format(n);
};

/** «+10 kg», «−2,5 l». Il meno è quello tipografico: il trattino si perde. */
export const formatDelta = (delta: number, unit: string | null | undefined, locale: string): string => {
  const sign = delta > 0 ? '+' : '−';
  const u = unit?.trim();
  return `${sign}${formatNumber(Math.abs(delta), locale)}${u ? ` ${u}` : ''}`;
};

export const movementLabel = (e: InventoryMovementEntry, t: TFn): string => {
  if (e.from_invoice) {
    return e.delta > 0
      ? t('movimenti.reason.invoiceIn', 'Da fattura')
      : t('movimenti.reason.invoiceOut', 'Fattura annullata');
  }
  switch (e.reason) {
    case InventoryMovementReason.CARICO: return t('movimenti.reason.CARICO', 'Carico');
    case InventoryMovementReason.SCARICO: return t('movimenti.reason.SCARICO', 'Scarico');
    case InventoryMovementReason.RETTIFICA: return t('movimenti.reason.RETTIFICA', 'Conteggio');
    default: return t('movimenti.reason.TRASFERIMENTO', 'Trasferimento');
  }
};

/** Il nome per intero nello storico; nella riga sotto il prodotto basta
 *  «Marco S.». I movimenti più vecchi hanno l'email come firma: se ne tiene
 *  la parte prima della chiocciola. */
export const authorName = (name: string | null | undefined, short = false): string => {
  const raw = (name ?? '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.slice(0, raw.indexOf('@'));
  if (!short) return raw;
  const words = raw.split(/\s+/);
  return words.length > 1 ? `${words[0]} ${words[words.length - 1][0]}.` : words[0];
};

const dayOffset = (iso: string): number => {
  const day = getRomeDatePart(iso);
  const today = getRomeDatePart(new Date());
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
};

const dateFmt = new Map<string, Intl.DateTimeFormat>();
const formatDate = (iso: string, locale: string, opts: Intl.DateTimeFormatOptions): string => {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dateFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: ROME, ...opts });
    dateFmt.set(key, f);
  }
  return f.format(new Date(iso));
};

const sameYear = (iso: string): boolean =>
  getRomeDatePart(iso).slice(0, 4) === getRomeDatePart(new Date()).slice(0, 4);

/** «oggi 18:40», «ieri 9:05», «21 ott», «21 ott 2025». */
export const whenShort = (iso: string, t: TFn, locale: string): string => {
  const offset = dayOffset(iso);
  if (offset === 0) return t('movimenti.todayAt', { time: getRomeTimePart(iso), defaultValue: 'oggi {{time}}' });
  if (offset === 1) return t('movimenti.yesterdayAt', { time: getRomeTimePart(iso), defaultValue: 'ieri {{time}}' });
  return formatDate(iso, locale, sameYear(iso)
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};

const dayHeading = (iso: string, t: TFn, locale: string): string => {
  const offset = dayOffset(iso);
  if (offset === 0) return t('movimenti.today', 'Oggi');
  if (offset === 1) return t('movimenti.yesterday', 'Ieri');
  return formatDate(iso, locale, sameYear(iso)
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

export const dateLocale = (language: string | undefined): string =>
  language?.startsWith('en') ? 'en-GB' : 'it-IT';

/* ── Lo storico ────────────────────────────────────────────────────────────
   Di un prodotto (aperto dalla sua riga) o di tutta l'area (dal menu ⋮).
   Le voci arrivano già sommate dal server; qui si dividono per giorno. */

type Kind = 'all' | 'in' | 'out';

// Una pagina filtrata può non avere nessuna voce (400 righe tutte di scarichi
// guardando i carichi): si va avanti da soli qualche pagina prima di arrendersi
// e chiedere «Carica altri».
const AUTO_PAGES = 5;

interface Props {
  open: boolean;
  onClose: () => void;
  area: InventoryArea;
  areaLabel: string;
  /** null = tutta l'area. */
  product: InventoryProduct | null;
  products: InventoryProduct[];
  locations: InventoryLocation[];
  isWide: boolean;
}

export const Movimenti: React.FC<Props> = ({ open, onClose, area, areaLabel, product, products, locations, isWide }) => {
  const { t, i18n } = useTranslation('inventario', { useSuspense: false });
  const locale = dateLocale(i18n.language);

  const [kind, setKind] = useState<Kind>('all');
  const [entries, setEntries] = useState<InventoryMovementEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productId = product?.id ?? null;
  // Una lettura per volta conta: cambiando filtro mentre «Carica altri» è in
  // volo, la pagina vecchia non deve finire in coda alla lista nuova.
  const request = useRef(0);

  // Ogni apertura riparte da «Tutti»: il filtro di ieri sera non è la domanda
  // di stamattina. Alla chiusura, così la prima lettura è già quella giusta.
  useEffect(() => { if (!open) setKind('all'); }, [open]);

  const load = async (before: string | null) => {
    const mine = request.current;
    const cancelled = () => mine !== request.current;
    setLoading(true);
    setError(null);
    try {
      let cursor = before;
      const found: InventoryMovementEntry[] = [];
      for (let i = 0; i < AUTO_PAGES; i++) {
        const page = await getInventoryMovements({
          ...(productId != null ? { product_id: productId } : { area }),
          kind: kind === 'all' ? undefined : kind,
          before: cursor,
        });
        if (cancelled()) return;
        found.push(...(Array.isArray(page.entries) ? page.entries : []));
        cursor = typeof page.next_before === 'string' ? page.next_before : null;
        if (found.length > 0 || !cursor) break;
      }
      setEntries(prev => (before ? [...prev, ...found] : found));
      setNext(cursor);
    } catch (err: any) {
      if (!cancelled()) setError(err?.message || t('movimenti.loadError', 'Errore caricamento movimenti'));
    } finally {
      if (!cancelled()) setLoading(false);
    }
  };

  useEffect(() => {
    request.current += 1;
    if (!open) return;
    setEntries([]);
    setNext(null);
    load(null);
  }, [open, productId, area, kind]);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const locationById = useMemo(() => new Map(locations.map(l => [l.id, l])), [locations]);
  // Il nome della cella dice qualcosa solo dove ce n'è più d'una.
  const showCell = locations.length > 1;

  const days = useMemo(() => {
    const out: { day: string; label: string; items: InventoryMovementEntry[] }[] = [];
    for (const e of entries) {
      const day = getRomeDatePart(e.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, label: dayHeading(e.at, t, locale), items: [e] });
    }
    return out;
  }, [entries, locale, t]);

  const kindOptions: { value: Kind; label: string }[] = [
    { value: 'all', label: t('movimenti.all', 'Tutti') },
    { value: 'in', label: t('movimenti.in', 'Carichi') },
    { value: 'out', label: t('movimenti.out', 'Scarichi') },
  ];

  const renderEntry = (e: InventoryMovementEntry, first: boolean) => {
    const p = product ?? productById.get(e.product_id) ?? null;
    const cell = locationById.get(e.location_id);
    const who = authorName(e.user_name);
    // Nello storico di un prodotto il titolo è cosa è successo; in quello
    // dell'area è il prodotto, e cosa è successo scende nella riga sotto.
    const title = product ? movementLabel(e, t) : (p?.name ?? t('product'));
    // Chi prima della cella: su un telefono la riga si taglia da destra.
    const meta = [
      product ? null : movementLabel(e, t),
      who || null,
      showCell && cell ? toTitleCase(cell.name) : null,
    ].filter(Boolean).join(' · ');
    return (
      <li
        key={`${e.id}-${e.first_at}`}
        className={`flex items-start gap-3 px-4 py-3 sm:px-5 ${first ? '' : 'border-t border-[var(--ds-border)]'}`}
      >
        {/* L'ora dell'ultimo tocco: quella del primo, in una voce di dieci
            tocchi, è di solito lo stesso minuto e costava mezza riga. */}
        <span className="w-11 flex-shrink-0 pt-0.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
          {getRomeTimePart(e.at)}
        </span>
        {/* La quantità sta sulla riga del titolo, non accanto a tutto il
            blocco: così chi e dove hanno la larghezza intera sotto. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{title}</span>
            <span className="flex-shrink-0 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {formatDelta(e.delta, p?.unit, locale)}
            </span>
          </div>
          {meta && <div className="truncate text-[13px] text-[var(--ds-text-muted)]">{meta}</div>}
          {e.notes && <div className="truncate text-[13px] text-[var(--ds-text-muted)]">{e.notes}</div>}
        </div>
      </li>
    );
  };

  const emptyText =
    kind === 'in' ? t('movimenti.emptyIn', 'Nessun carico')
    : kind === 'out' ? t('movimenti.emptyOut', 'Nessuno scarico')
    : t('movimenti.empty', 'Nessun movimento');

  const body = (
    <div className="space-y-4">
      {error && <Callout tone="critical">{error}</Callout>}

      {!error && loading && entries.length === 0 && (
        <p className="flex items-center justify-center gap-2 py-8 text-[14px] text-[var(--ds-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t('movimenti.loading', 'Carico i movimenti…')}
        </p>
      )}

      {!error && !loading && entries.length === 0 && (
        <EmptyState icon={History}>{emptyText}</EmptyState>
      )}

      {days.map(d => (
        <section key={d.day}>
          <div className="px-1">
            <SectionHeader tone="muted">{d.label}</SectionHeader>
          </div>
          <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {d.items.map((e, i) => renderEntry(e, i === 0))}
          </ul>
        </section>
      ))}

      {next && entries.length > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => load(next)}
            disabled={loading}
            className={dsButton.secondary}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('movimenti.loadMore', 'Carica altri')}
          </button>
        </div>
      )}
    </div>
  );

  const title = product ? product.name : t('movimenti.title', 'Movimenti');
  const subtitle = product ? t('movimenti.title', 'Movimenti') : areaLabel;
  const filter = (
    <SegmentedControl<Kind>
      value={kind}
      onChange={setKind}
      options={kindOptions}
      ariaLabel={t('movimenti.filter', 'Mostra')}
    />
  );

  if (isWide) {
    return (
      <ModalShell
        open={open}
        onClose={onClose}
        title={title}
        subtitle={subtitle}
        size="md"
        closeOnEscape
        fixedHeight
        subheader={filter}
        bodyClassName="px-5 py-4 sm:px-6"
      >
        {body}
      </ModalShell>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      ariaLabel={title}
      subheader={filter}
      bodyClassName="px-4 py-4"
    >
      {body}
    </Sheet>
  );
};
