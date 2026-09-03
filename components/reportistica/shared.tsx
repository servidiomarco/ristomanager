import React from 'react';
import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';

/* Elementi condivisi dei blocchi della Reportistica. Stesso linguaggio della
   pagina Consumi AI (MonitoringPage): card su --ds-surface, tile su
   --ds-surface-row, grafici recharts stilati coi token. */

export const nf = new Intl.NumberFormat('it-IT');
export const formatInt = (n: number | null | undefined): string => nf.format(Math.round(n ?? 0));

const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
export const formatEuroCents = (cents: number | null | undefined): string => euro.format((cents ?? 0) / 100);

// Secondi → "1h 23m" / "12m 05s" / "42s".
export const formatDuration = (totalSeconds: number | null | undefined): string => {
  const s = Math.max(0, Math.round(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
};

// Etichetta d'asse compatta dal giorno ISO (YYYY-MM-DD → "12/08").
export const shortDay = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

// Tick asse Y compatto: 2850 → "2,8k".
export const compactTick = (v: number): string => {
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1).replace('.', ',')}k`;
  }
  return String(v);
};

export const chartTooltip = {
  cursor: { fill: 'var(--ds-surface-row)' },
  contentStyle: { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: '12px', fontSize: '13px' },
  labelStyle: { color: 'var(--ds-text-muted)' },
} as const;

export const BAR_FILL = 'var(--ds-arriving-solid)';
export const BAR_MAX = 56;

// I sei solidi categoria del ds, per i dot dei mix (canali, sale, metodi).
// Sono categorie, non stati: dot e barre, mai colore dietro il testo.
export const CAT_DOTS = [
  'bg-[var(--ds-cat-1-solid)]',
  'bg-[var(--ds-cat-2-solid)]',
  'bg-[var(--ds-cat-3-solid)]',
  'bg-[var(--ds-cat-4-solid)]',
  'bg-[var(--ds-cat-5-solid)]',
  'bg-[var(--ds-cat-6-solid)]',
] as const;

/** Tutti i giorni ISO del range, estremi inclusi: le serie del backend hanno
 *  buchi nei giorni senza righe e il grafico li deve mostrare a zero. */
export const eachDayIso = (from: string, to: string): string[] => {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length <= 366) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

// ---- Confronto col periodo precedente ---------------------------------------

/** Variazione percentuale vs periodo precedente. `invert` per le metriche
 *  dove scendere è un bene (no-show, ammanchi): il verde resta "sta andando
 *  meglio", qualunque sia la direzione del numero. */
export const DeltaBadge: React.FC<{
  current: number;
  previous: number;
  invert?: boolean;
}> = ({ current, previous, invert = false }) => {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) {
    return <span className="text-[12px] font-medium text-[var(--ds-text-muted)]">prima: 0</span>;
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) {
    return <span className="text-[12px] font-medium text-[var(--ds-text-muted)]">stabile</span>;
  }
  const good = invert ? pct < 0 : pct > 0;
  const Arrow = pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[12px] font-semibold ${
      good ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'
    }`}>
      <Arrow className="h-3.5 w-3.5" aria-hidden />
      {pct > 0 ? '+' : ''}{nf.format(pct)}%
    </span>
  );
};

// ---- Contenitori -------------------------------------------------------------

export const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, actions, children }) => (
  <section className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
    <header className="mb-4 flex items-start gap-3">
      <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">{title}</h2>
        <p className="text-[13px] text-[var(--ds-text-muted)]">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </header>
    {children}
  </section>
);

export const StatTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  delta?: React.ReactNode;
}> = ({ icon, label, value, hint, delta }) => (
  <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
    <div className="mb-1 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">
      <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-muted)]">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </div>
    <div className="flex items-baseline gap-2">
      <span className="tabular text-[22px] font-bold leading-tight text-[var(--ds-text-primary)]">{value}</span>
      {delta}
    </div>
    {hint && <div className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{hint}</div>}
  </div>
);

export const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex h-[180px] items-center justify-center rounded-[16px] bg-[var(--ds-surface-row)] px-4 text-center text-[13px] text-[var(--ds-text-muted)]">
    {message}
  </div>
);

/** Riga di un mix (canale, sala, metodo): dot categoria, etichetta, barra di
 *  quota e valore. La barra usa il solido categoria; il testo resta sui token
 *  di testo, mai sopra il colore. */
export const ShareRow: React.FC<{
  colorClass: string;
  label: string;
  value: string;
  share: number; // 0..1
  hint?: string;
}> = ({ colorClass, label, value, share, hint }) => (
  <div className="flex items-center gap-3 py-1.5">
    <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${colorClass}`} aria-hidden />
    <span className="min-w-0 flex-shrink truncate text-[13px] text-[var(--ds-text-primary)]">{label}</span>
    {hint && <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">{hint}</span>}
    <div className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-[var(--ds-border)]">
      <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
    <span className="tabular w-24 flex-shrink-0 text-right text-[13px] font-semibold text-[var(--ds-text-primary)]">{value}</span>
  </div>
);

export const CsvButton: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label = 'Esporta csv' }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
  >
    <Download className="h-3.5 w-3.5" aria-hidden />
    {label}
  </button>
);

// Nomi leggibili dei canali di prenotazione (reservations.source).
export const CHANNEL_LABELS: Record<string, string> = {
  MANUAL: 'Inserite dallo staff',
  WHATSAPP: 'WhatsApp',
  VOICE: 'Sofia (telefono)',
  GOOGLE: 'Pagina di prenotazione',
};
export const channelLabel = (key: string): string => CHANNEL_LABELS[key] || key;

// Nomi leggibili dei metodi del libro cassa.
export const METHOD_LABELS: Record<string, string> = {
  CONTANTI: 'Contanti',
  POS_FISICO: 'Pos',
  SATISPAY: 'Satispay',
  BUONO_PASTO: 'Buoni pasto',
  GIFT_CARD: 'Gift card',
  SOSPESO: 'Sospeso',
  OMAGGIO: 'Omaggio',
  LINK_ONLINE: 'Link online',
};
export const methodLabel = (key: string): string => METHOD_LABELS[key] || key;

// EXTRACT(DOW): 0 = domenica.
export const DOW_LABELS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'] as const;
