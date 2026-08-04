import type { ShoppingCategory, ShoppingItem } from '../../services/shoppingApiService';
import type { PillTone } from '../ds';

/* ── Vocabolario della lista della spesa ──────────────────────────────────
   The page used to carry three parallel colour maps — a border set, a text
   set and a print accent — each with its own hardcoded palette, which is how
   Cucina ended up orange in a chip and a different orange on paper. One tone
   per category now, resolved from the DS families.

   Cucina takes the gold, Bar the indigo, Altro stays neutral: they are
   labels, not states, so the point is telling them apart, not ranking them. */

export const CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  CUCINA: 'Cucina',
  BAR: 'Bar',
  ALTRO: 'Altro',
};

export const CATEGORY_TONE: Record<ShoppingCategory, PillTone> = {
  CUCINA: 'pending',
  BAR: 'info',
  ALTRO: 'neutral',
};

/** The dot on a filter chip. Full literals — Tailwind cannot see a built one. */
export const CATEGORY_DOT: Record<ShoppingCategory, string> = {
  CUCINA: 'bg-[var(--ds-pending-solid)]',
  BAR: 'bg-[var(--ds-arriving-solid)]',
  ALTRO: 'bg-[var(--ds-text-subtle)]',
};

/** Kept for the printed sheet, which needs a concrete hex rather than a var. */
export const CATEGORY_ACCENT: Record<ShoppingCategory, string> = {
  CUCINA: '#b8860b',
  BAR: '#5250c9',
  ALTRO: '#52525b',
};

export const ALL_CATEGORIES: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];

/** Sentinel for the "no supplier assigned" filter bucket. */
export const NO_SUPPLIER = '__NONE__';

export const parseQty = (text: string): number | null => {
  const cleaned = text.trim().replace(',', '.');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
};

/** "30 kg", "2 ct", or empty when no quantity was given — an item without a
 *  number is normal here ("brillantante"), not a missing value to apologise for. */
export const formatQty = (q?: number | null, u?: string | null): string => {
  if (q == null || q <= 0) return '';
  const num = Number.isInteger(q) ? String(q) : String(q).replace('.', ',');
  return u ? `${num} ${u}` : num;
};

/** The server sends whatever it has for the author, which in practice is often
 *  the login email. A full address is not a name — it wrapped the row and gave
 *  the avatar a single useless initial — so the domain is dropped and the
 *  separators become spaces: "p.caputo@…" → "p caputo" → "PC". */
export const personName = (raw?: string | null): string => {
  if (!raw) return '';
  const local = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  return local.replace(/[._-]+/g, ' ').trim();
};

/** "oggi", "ieri", or "4 ago" — the list is worked through in days, not hours. */
export const formatAddedAt = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => x.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
  const now = new Date();
  if (day(d) === day(now)) return 'oggi';
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return 'ieri';
  return d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' });
};

/** Newest first. `createdAt` is optional on the row, so `date` is the fallback
 *  and the id breaks ties — without a stable tiebreak two items added in the
 *  same second swap places on every re-render. */
export const byNewest = <T extends { createdAt?: string; date?: string; id: string }>(a: T, b: T): number => {
  const ka = a.createdAt || a.date || '';
  const kb = b.createdAt || b.date || '';
  if (ka !== kb) return ka < kb ? 1 : -1;
  return a.id < b.id ? 1 : -1;
};

/** What the undo toast says after an action, e.g. "panna hopla 2 ct presa". */
export const itemSummary = (item: ShoppingItem): string => {
  const qty = formatQty(item.quantity, item.unit);
  return qty ? `${item.name} ${qty}` : item.name;
};
