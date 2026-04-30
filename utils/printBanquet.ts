import { BanquetMenu, Dish } from '../types';

const ITALIAN_DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));

const formatEuro = (n: number | string | undefined | null): string => {
  const num = Number(n ?? 0);
  return `€ ${num.toFixed(2).replace('.', ',')}`;
};

const formatDate = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('it-IT', ITALIAN_DATE_OPTS);
};

const groupDishesByCategory = (
  dish_ids: number[],
  dishes: Dish[]
): { category: string; items: Dish[] }[] => {
  const order = ['Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Bevande'];
  const map = new Map<string, Dish[]>();
  for (const id of dish_ids) {
    const dish = dishes.find(d => d.id === id);
    if (!dish) continue;
    const key = dish.category || 'Altro';
    const arr = map.get(key) || [];
    arr.push(dish);
    map.set(key, arr);
  }
  const ordered = order
    .filter(k => map.has(k))
    .map(k => ({ category: k, items: map.get(k)! }));
  const extras = Array.from(map.keys())
    .filter(k => !order.includes(k))
    .map(k => ({ category: k, items: map.get(k)! }));
  return [...ordered, ...extras];
};

export const printBanquet = (menu: BanquetMenu, dishes: Dish[]): void => {
  const grouped = groupDishesByCategory(menu.dish_ids, dishes);
  const eventDate = formatDate(menu.event_date);
  const price = formatEuro(menu.price_per_person);
  const deposit = menu.deposit_amount != null ? formatEuro(menu.deposit_amount) : null;

  const dishesHtml = grouped
    .map(g => `
      <section class="category">
        <h3>${escapeHtml(g.category)}</h3>
        <ul>
          ${g.items.map(d => `<li>${escapeHtml(d.name)}</li>`).join('')}
        </ul>
      </section>
    `)
    .join('');

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Banchetto — ${escapeHtml(menu.name)}</title>
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
    border-bottom: 2px solid #4f46e5;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  h1 { margin: 0 0 6px; font-size: 28px; color: #1e1b4b; }
  .date { color: #4f46e5; font-size: 14px; font-weight: 600; text-transform: capitalize; }
  .description { color: #475569; margin: 16px 0 0; font-size: 14px; }
  .pricing {
    display: flex;
    gap: 24px;
    margin: 24px 0;
    padding: 16px;
    background: #f1f5f9;
    border-radius: 8px;
  }
  .pricing .item .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    font-weight: 600;
  }
  .pricing .item .value {
    font-size: 22px;
    font-weight: 700;
    color: #1e1b4b;
  }
  .pricing .item .unit { font-size: 12px; color: #64748b; font-weight: 400; }
  h2 {
    font-size: 16px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #64748b;
    margin: 0 0 12px;
  }
  .category { margin-bottom: 18px; page-break-inside: avoid; }
  .category h3 {
    margin: 0 0 6px;
    font-size: 15px;
    color: #4f46e5;
    border-bottom: 1px dashed #cbd5e1;
    padding-bottom: 4px;
  }
  .category ul { margin: 0; padding-left: 18px; }
  .category li { margin: 4px 0; font-size: 14px; }
  footer {
    margin-top: 40px;
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
    <h1>${escapeHtml(menu.name)}</h1>
    ${eventDate ? `<div class="date">${escapeHtml(eventDate)}</div>` : ''}
    ${menu.description ? `<p class="description">${escapeHtml(menu.description)}</p>` : ''}
  </header>

  <div class="pricing">
    <div class="item">
      <div class="label">Prezzo per persona</div>
      <div class="value">${price}<span class="unit"> / persona</span></div>
    </div>
    ${deposit ? `
    <div class="item">
      <div class="label">Acconto</div>
      <div class="value">${deposit}</div>
    </div>` : ''}
  </div>

  <h2>Composizione del menù</h2>
  ${dishesHtml || '<p style="color:#94a3b8;font-size:14px;">Nessun piatto selezionato.</p>'}

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
