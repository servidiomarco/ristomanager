import { ShoppingCategory, ShoppingItem } from '../services/shoppingApiService';

const ITALIAN_DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
};

const CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  CUCINA: 'Cucina',
  BAR: 'Bar',
  ALTRO: 'Altro',
};

const CATEGORY_ACCENT: Record<ShoppingCategory, string> = {
  CUCINA: '#c2410c',
  BAR: '#b45309',
  ALTRO: '#475569',
};

const DEFAULT_ACCENT = '#1e1b4b';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const formatDate = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('it-IT', ITALIAN_DATE_OPTS);
};

const formatCreatedAt = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
};

const normalizePhoneForWhatsApp = (raw: string): string => {
  // wa.me wants digits only, with country code. Best-effort: strip non-digits, keep leading 39 if present.
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  // If starts with 00, drop leading zeros
  if (digits.startsWith('00')) return digits.replace(/^0+/, '');
  // If 10 digits and no country code, assume Italy
  if (digits.length === 10) return `39${digits}`;
  return digits;
};

export interface PrintOptions {
  /** Main title shown in big — typically the category name, "Selezione", or supplier name */
  title: string;
  /** Optional smaller line above the title (uppercase) — e.g., "Lista della spesa · Cucina" */
  eyebrow?: string;
  /** Optional subtitle below the title — e.g., supplier phone / note */
  subtitle?: string;
  /** Optional date string (YYYY-MM-DD) — shown in friendly Italian format if provided */
  date?: string;
  /** Optional accent color (defaults to category accent or neutral) */
  accent?: string;
  /** If true, group items visually by category in the printed output (used for mixed selections) */
  groupByCategory?: boolean;
}

export const printShoppingList = (items: ShoppingItem[], options: PrintOptions): void => {
  const accent = options.accent || DEFAULT_ACCENT;
  const dateLabel = formatDate(options.date);
  const checked = items.filter(i => i.checked).length;
  const total = items.length;

  const renderItem = (item: ShoppingItem): string => {
    const author = item.createdByUserName ? item.createdByUserName.split('@')[0] : 'Anonimo';
    const when = formatCreatedAt(item.createdAt);
    const supplierTag = item.supplierName ? `<span class="tag">${escapeHtml(item.supplierName)}</span>` : '';
    const meta = [author, when].filter(Boolean).join(' • ');
    return `
      <li class="${item.checked ? 'checked' : ''}">
        <span class="box">${item.checked ? '&#10003;' : ''}</span>
        <div class="content">
          <div class="name">${escapeHtml(item.name)}${supplierTag}</div>
          ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
        </div>
      </li>
    `;
  };

  let body: string;
  if (total === 0) {
    body = '<p class="empty">Nessun prodotto in questa selezione.</p>';
  } else if (options.groupByCategory) {
    const order: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];
    const groups = order
      .map(cat => ({ cat, items: items.filter(i => i.category === cat) }))
      .filter(g => g.items.length > 0);
    body = groups
      .map(
        g => `
          <h2 class="cat-heading" style="color:${CATEGORY_ACCENT[g.cat]}">${escapeHtml(CATEGORY_LABELS[g.cat])}</h2>
          <ul>${g.items.map(renderItem).join('')}</ul>
        `,
      )
      .join('');
  } else {
    body = `<ul>${items.map(renderItem).join('')}</ul>`;
  }

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Lista della spesa — ${escapeHtml(options.title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #1e293b;
    margin: 0;
    padding: 32px;
    background: #fff;
    line-height: 1.45;
  }
  header {
    border-bottom: 2px solid ${accent};
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  h1 { margin: 0 0 6px; font-size: 26px; color: #1e1b4b; }
  .section { color: ${accent}; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .date { color: #475569; font-size: 13px; margin-top: 4px; text-transform: capitalize; }
  .subtitle { color: #475569; font-size: 13px; margin-top: 4px; }
  .summary {
    display: inline-block;
    margin-top: 8px;
    padding: 4px 10px;
    background: #f1f5f9;
    color: #475569;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
  }
  ul { list-style: none; margin: 0 0 16px; padding: 0; }
  li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px dashed #e2e8f0;
    page-break-inside: avoid;
  }
  li.checked .name { text-decoration: line-through; color: #94a3b8; }
  .box {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border: 2px solid #94a3b8;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: #1e293b;
    margin-top: 1px;
  }
  li.checked .box { background: #e2e8f0; border-color: #64748b; }
  .content { flex: 1 1 auto; min-width: 0; }
  .name { font-size: 15px; font-weight: 500; color: #1e293b; }
  .tag {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    background: #eef2ff;
    color: #4338ca;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    vertical-align: middle;
  }
  .meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .cat-heading {
    margin: 18px 0 6px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .empty { padding: 24px 0; color: #94a3b8; font-size: 14px; text-align: center; }
  footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    color: #94a3b8;
    font-size: 11px;
    text-align: center;
  }
  @media print {
    body { padding: 16mm; }
    header { break-after: avoid; }
  }
</style>
</head>
<body>
  <header>
    ${options.eyebrow ? `<div class="section">${escapeHtml(options.eyebrow)}</div>` : ''}
    <h1>${escapeHtml(options.title)}</h1>
    ${options.subtitle ? `<div class="subtitle">${escapeHtml(options.subtitle)}</div>` : ''}
    ${dateLabel ? `<div class="date">${escapeHtml(dateLabel)}</div>` : ''}
    <div class="summary">${checked}/${total} completati</div>
  </header>

  ${body}

  <footer>Documento generato il ${escapeHtml(new Date().toLocaleDateString('it-IT'))}</footer>

  <script>
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 200);
    });
  </script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Sblocca i popup per scaricare il PDF.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
};

export interface ShareOptions {
  /** Title for the share sheet / message header */
  title: string;
  /** Optional subtitle line below the title (e.g., supplier phone) */
  subtitle?: string;
  /** Optional date string for friendly Italian date in the message */
  date?: string;
  /** If true, group items by category in the message body */
  groupByCategory?: boolean;
  /** If provided, share directly to this WhatsApp number (digits with country code) */
  whatsappPhone?: string;
}

const buildShareText = (items: ShoppingItem[], options: ShareOptions): string => {
  const dateLabel = formatDate(options.date);
  const lines: string[] = [];
  lines.push(`*${options.title}*`);
  if (options.subtitle) lines.push(options.subtitle);
  if (dateLabel) lines.push(dateLabel);
  lines.push('');

  if (items.length === 0) {
    lines.push('_Nessun prodotto._');
    return lines.join('\n');
  }

  if (options.groupByCategory) {
    const order: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];
    for (const cat of order) {
      const sub = items.filter(i => i.category === cat);
      if (sub.length === 0) continue;
      lines.push(`*${CATEGORY_LABELS[cat]}*`);
      for (const item of sub) {
        const mark = item.checked ? '☑' : '☐';
        const sup = item.supplierName ? ` _(${item.supplierName})_` : '';
        lines.push(`${mark} ${item.name}${sup}`);
      }
      lines.push('');
    }
  } else {
    for (const item of items) {
      const mark = item.checked ? '☑' : '☐';
      const sup = item.supplierName ? ` _(${item.supplierName})_` : '';
      lines.push(`${mark} ${item.name}${sup}`);
    }
  }
  return lines.join('\n').trimEnd();
};

export const shareShoppingList = async (items: ShoppingItem[], options: ShareOptions): Promise<void> => {
  const text = buildShareText(items, options);

  // If a phone number is provided, send directly to that contact on WhatsApp
  if (options.whatsappPhone) {
    const normalized = normalizePhoneForWhatsApp(options.whatsappPhone);
    if (normalized) {
      const url = `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
  }

  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: options.title, text });
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }
  }

  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
};

