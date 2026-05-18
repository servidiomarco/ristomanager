import { BanquetMenu, Dish, Shift } from '../types';

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

const shiftLabel = (s?: Shift): string => {
  if (s === Shift.LUNCH) return 'Pranzo';
  if (s === Shift.DINNER) return 'Cena';
  return '';
};

const renderNoteBlock = (title: string, content?: string): string => {
  const trimmed = content?.trim();
  if (!trimmed) return '';
  return `
    <section class="note-block">
      <h3>${escapeHtml(title)}</h3>
      <div class="note-content">${escapeHtml(trimmed).replace(/\n/g, '<br/>')}</div>
    </section>
  `;
};

export interface PrintBanquetOptions {
  showPrice?: boolean;
  kitchenMode?: boolean;
}

export const printBanquet = (menu: BanquetMenu, dishes: Dish[], options: PrintBanquetOptions = {}): void => {
  const kitchenMode = options.kitchenMode === true;
  const showPrice = kitchenMode ? false : options.showPrice !== false;
  const eventDate = formatDate(menu.event_date);
  const price = formatEuro(menu.price_per_person);
  const deposit = menu.deposit_amount != null ? formatEuro(menu.deposit_amount) : null;
  const shift = shiftLabel(menu.shift);
  const guests = menu.guests != null && menu.guests > 0 ? menu.guests : null;
  const children = menu.children != null && menu.children > 0 ? menu.children : null;
  const adults = guests != null && children != null ? guests - children : null;
  const childrenPrice = menu.children_price != null ? formatEuro(menu.children_price) : null;
  const notesHtml = [
    renderNoteBlock('Note Portate (Cucina)', menu.notes_courses),
    renderNoteBlock('Note Servizio (Sala)', menu.notes_service),
    renderNoteBlock('Note Mise en Place', menu.notes_mise_en_place),
  ].join('');

  let dishesHtml = '';
  if (menu.courses && menu.courses.length > 0) {
    dishesHtml = menu.courses
      .map(course => {
        const items = course.dish_ids
          .map(id => dishes.find(d => d.id === id))
          .filter((d): d is Dish => !!d);
        if (items.length === 0) return '';
        const noteHtml = course.notes && course.notes.trim()
          ? `<p class="course-note">${escapeHtml(course.notes)}</p>`
          : '';
        return `
          <section class="category">
            <h3>${escapeHtml(course.name)}</h3>
            <ul>
              ${items.map(d => `<li>${escapeHtml(d.name)}</li>`).join('')}
            </ul>
            ${noteHtml}
          </section>
        `;
      })
      .join('');
  } else {
    const grouped = groupDishesByCategory(menu.dish_ids, dishes);
    dishesHtml = grouped
      .map(g => `
        <section class="category">
          <h3>${escapeHtml(g.category)}</h3>
          <ul>
            ${g.items.map(d => `<li>${escapeHtml(d.name)}</li>`).join('')}
          </ul>
        </section>
      `)
      .join('');
  }

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
    padding: 24px;
    background: #fff;
    line-height: 1.45;
    font-size: 15px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    border-bottom: 2px solid #4f46e5;
    padding-bottom: 14px;
    margin-bottom: 20px;
  }
  .header-main { flex: 1; min-width: 0; }
  .header-meta {
    display: flex;
    gap: 18px;
    flex-shrink: 0;
    align-items: flex-start;
  }
  .meta-item { display: flex; flex-direction: column; text-align: right; }
  .meta-item .meta-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .meta-item .meta-value {
    font-size: 20px;
    font-weight: 700;
    color: #1e1b4b;
    line-height: 1.1;
  }
  .meta-item .meta-sub {
    font-size: 11px;
    color: #64748b;
    font-weight: 500;
    margin-top: 4px;
  }
  .kitchen-cover {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 14px 22px;
    border-radius: 12px;
    background: #eef2ff;
    border: 2px solid #4f46e5;
    min-width: 130px;
  }
  .kitchen-cover.children {
    background: #fef3c7;
    border-color: #d97706;
  }
  .kitchen-cover .kitchen-cover-label {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #4338ca;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .kitchen-cover.children .kitchen-cover-label {
    color: #b45309;
  }
  .kitchen-cover .kitchen-cover-value {
    font-size: 56px;
    font-weight: 800;
    color: #1e1b4b;
    line-height: 1;
  }
  .kitchen-cover.children .kitchen-cover-value {
    color: #78350f;
  }
  h1 { margin: 0 0 6px; font-size: 32px; color: #1e1b4b; }
  .date { color: #4f46e5; font-size: 16px; font-weight: 600; text-transform: capitalize; }
  .description { color: #475569; margin: 12px 0 0; font-size: 15px; }
  .badge {
    display: inline-block;
    margin-left: 10px;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    vertical-align: middle;
  }
  .badge.lunch { background: #fef3c7; color: #b45309; }
  .badge.dinner { background: #e0e7ff; color: #4338ca; }
  h2 {
    font-size: 17px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #64748b;
    margin: 0 0 10px;
  }
  .notes-section { margin-top: 20px; }
  .note-block {
    margin-bottom: 12px;
    padding: 10px 14px;
    background: #fffbeb;
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    page-break-inside: avoid;
  }
  .note-block h3 {
    margin: 0 0 6px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #b45309;
  }
  .note-block .note-content {
    font-size: 15px;
    color: #1e293b;
    white-space: pre-wrap;
  }
  .category { margin-bottom: 14px; page-break-inside: avoid; }
  .category h3 {
    margin: 0 0 6px;
    font-size: 18px;
    color: #4f46e5;
    border-bottom: 1px dashed #cbd5e1;
    padding-bottom: 4px;
  }
  .category ul { margin: 0; padding-left: 22px; }
  .category li { margin: 4px 0; font-size: 16px; }
  .course-note {
    margin: 8px 0 0;
    font-size: 14px;
    font-style: italic;
    color: #475569;
    white-space: pre-wrap;
  }
  footer {
    margin-top: 24px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    color: #94a3b8;
    font-size: 11px;
    text-align: center;
  }
  @media print {
    body { padding: 12mm; }
    header { break-after: avoid; }
  }
</style>
</head>
<body>
  <header>
    <div class="header-main">
      <h1>
        ${escapeHtml(menu.name)}
        ${menu.shift === Shift.LUNCH ? '<span class="badge lunch">Pranzo</span>' : ''}
        ${menu.shift === Shift.DINNER ? '<span class="badge dinner">Cena</span>' : ''}
      </h1>
      ${eventDate ? `<div class="date">${escapeHtml(eventDate)}${shift ? ` &middot; ${escapeHtml(shift)}` : ''}</div>` : ''}
      ${menu.description ? `<p class="description">${escapeHtml(menu.description)}</p>` : ''}
    </div>
    <div class="header-meta">
      ${kitchenMode && guests != null ? `
      ${children != null && adults != null ? `
      <div class="kitchen-cover">
        <span class="kitchen-cover-label">Adulti</span>
        <span class="kitchen-cover-value">${adults}</span>
      </div>
      <div class="kitchen-cover children">
        <span class="kitchen-cover-label">Bambini</span>
        <span class="kitchen-cover-value">${children}</span>
      </div>` : `
      <div class="kitchen-cover">
        <span class="kitchen-cover-label">Coperti</span>
        <span class="kitchen-cover-value">${guests}</span>
      </div>`}
      ` : ''}
      ${!kitchenMode && guests != null ? `
      <div class="meta-item">
        <span class="meta-label">Coperti</span>
        <span class="meta-value">${guests}</span>
        ${children ? `<span class="meta-sub">${guests - children} adulti + ${children} bambin${children === 1 ? 'o' : 'i'}</span>` : ''}
      </div>` : ''}
      ${showPrice ? `
      <div class="meta-item">
        <span class="meta-label">Per persona</span>
        <span class="meta-value">${price}</span>
        ${childrenPrice ? `<span class="meta-sub">${childrenPrice} bambini</span>` : ''}
      </div>
      ${deposit ? `
      <div class="meta-item">
        <span class="meta-label">Acconto</span>
        <span class="meta-value">${deposit}</span>
      </div>` : ''}` : ''}
    </div>
  </header>

  <h2>Composizione del menù</h2>
  ${dishesHtml || '<p style="color:#94a3b8;font-size:14px;">Nessun piatto selezionato.</p>'}

  ${notesHtml ? `
  <div class="notes-section">
    <h2>Note operative</h2>
    ${notesHtml}
  </div>` : ''}

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
