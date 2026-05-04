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

export const printShoppingList = (
  items: ShoppingItem[],
  category: ShoppingCategory,
  date: string
): void => {
  const label = CATEGORY_LABELS[category];
  const accent = CATEGORY_ACCENT[category];
  const dateLabel = formatDate(date);
  const checked = items.filter(i => i.checked).length;
  const total = items.length;

  const itemsHtml = items
    .map(item => {
      const author = item.createdByUserName ? item.createdByUserName.split('@')[0] : 'Anonimo';
      const when = formatCreatedAt(item.createdAt);
      const meta = [author, when].filter(Boolean).join(' • ');
      return `
        <li class="${item.checked ? 'checked' : ''}">
          <span class="box">${item.checked ? '&#10003;' : ''}</span>
          <div class="content">
            <div class="name">${escapeHtml(item.name)}</div>
            ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
          </div>
        </li>
      `;
    })
    .join('');

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Lista della spesa — ${escapeHtml(label)}</title>
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
  ul { list-style: none; margin: 0; padding: 0; }
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
  .meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
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
    <div class="section">Lista della spesa &middot; ${escapeHtml(label)}</div>
    <h1>${escapeHtml(label)}</h1>
    ${dateLabel ? `<div class="date">${escapeHtml(dateLabel)}</div>` : ''}
    <div class="summary">${checked}/${total} completati</div>
  </header>

  ${total === 0
    ? '<p class="empty">Nessun prodotto in questa sezione.</p>'
    : `<ul>${itemsHtml}</ul>`}

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

const buildShareText = (
  items: ShoppingItem[],
  category: ShoppingCategory,
  date: string
): string => {
  const label = CATEGORY_LABELS[category];
  const dateLabel = formatDate(date);
  const lines: string[] = [];
  lines.push(`*Lista della spesa — ${label}*`);
  if (dateLabel) lines.push(dateLabel);
  lines.push('');
  if (items.length === 0) {
    lines.push('_Nessun prodotto in questa sezione._');
  } else {
    for (const item of items) {
      const mark = item.checked ? '☑' : '☐';
      lines.push(`${mark} ${item.name}`);
    }
  }
  return lines.join('\n');
};

export const shareShoppingListWhatsApp = async (
  items: ShoppingItem[],
  category: ShoppingCategory,
  date: string
): Promise<void> => {
  const text = buildShareText(items, category, date);
  const title = `Lista della spesa — ${CATEGORY_LABELS[category]}`;

  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title, text });
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }
  }

  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
};
