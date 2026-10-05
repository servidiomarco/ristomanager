import type { HaccpAllergenDish } from '../services/haccpApiService';
import { HACCP_EU_ALLERGENS } from './haccp';
import { printHtmlDocument, PRINT_TOKENS_CSS } from './printDocument';

/* Il libro allergeni: per ogni piatto attivo, quali dei 14 allergeni del Reg.
 * UE 1169/2011 (All. II) contiene, come li ha scritti il menu. La legge vuole
 * l'informazione per iscritto e consultabile dal cliente (D.Lgs. 231/2017):
 * questo è il foglio da tenere in sala. I piatti senza nessun allergene
 * indicato si segnalano: «nessuno» o «non ancora compilato» non si
 * distinguono, e va verificato in Menu.
 *
 * Fuori dall'i18n come gli altri fogli HACCP: è un documento per l'ASL. */

const ACCENT = '#0f766e';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export const buildAllergenBookHtml = (dishes: HaccpAllergenDish[], restaurantName: string | null): string => {
  const byCategory = new Map<string, HaccpAllergenDish[]>();
  for (const d of dishes) {
    const key = d.category || 'Altro';
    byCategory.set(key, [...(byCategory.get(key) ?? []), d]);
  }
  const lower = (s: string) => s.trim().toLowerCase();
  const head = HACCP_EU_ALLERGENS.map(a => `<th class="al"><span>${escapeHtml(a)}</span></th>`).join('');
  const body = [...byCategory.entries()].map(([category, rows]) => `
    <tr class="cat"><td colspan="${HACCP_EU_ALLERGENS.length + 1}">${escapeHtml(category)}</td></tr>
    ${rows.map(d => {
      const has = new Set(d.allergens.map(lower));
      const cells = HACCP_EU_ALLERGENS.map(a => `<td class="mark">${has.has(lower(a)) ? '●' : ''}</td>`).join('');
      const unknown = d.allergens.filter(a => !HACCP_EU_ALLERGENS.some(eu => lower(eu) === lower(a)));
      const flag = d.allergens.length === 0 ? '<div class="flag">nessun allergene indicato: da verificare</div>' : '';
      const other = unknown.length ? `<div class="flag">anche: ${escapeHtml(unknown.join(', '))}</div>` : '';
      return `<tr><td class="dish">${escapeHtml(d.name)}${flag}${other}</td>${cells}</tr>`;
    }).join('')}`).join('');
  const missing = dishes.filter(d => d.allergens.length === 0).length;
  const today = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Libro allergeni${restaurantName ? ` — ${escapeHtml(restaurantName)}` : ''}</title>
<style>
${PRINT_TOKENS_CSS}
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: var(--ds-print-ink); margin: 0; padding: 20px; background: #fff; font-size: 11px; }
  header { border-bottom: 2px solid ${ACCENT}; padding-bottom: 8px; margin-bottom: 12px; }
  .eyebrow { color: ${ACCENT}; font-size: 12px; font-weight: 700; }
  h1 { margin: 2px 0; font-size: 19px; }
  .sub { color: var(--ds-print-ink-secondary); font-size: 11px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid var(--ds-print-rule); padding: 3px 4px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th.dish-col { width: 62mm; text-align: left; background: var(--ds-print-fill); font-size: 10px; }
  th.al { background: var(--ds-print-fill); height: 30mm; vertical-align: bottom; font-size: 9px; font-weight: 600; }
  th.al span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; }
  td.dish { font-size: 11px; }
  td.mark { text-align: center; font-size: 12px; color: var(--ds-print-ink); }
  tr.cat td { background: #f8fafc; font-weight: 700; font-size: 10px; color: var(--ds-print-ink-secondary); }
  .flag { font-size: 8px; color: #b45309; }
  .legend { margin-top: 10px; font-size: 9px; color: var(--ds-print-ink-muted); line-height: 1.5; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <header>
    <div class="eyebrow">Informazioni sugli allergeni</div>
    <h1>Libro allergeni${restaurantName ? ` — ${escapeHtml(restaurantName)}` : ''}</h1>
    <div class="sub">Aggiornato al ${escapeHtml(today)} · ${dishes.length} piatti${missing ? ` · ${missing} senza allergeni indicati` : ''}</div>
  </header>
  <table>
    <thead><tr><th class="dish-col">Piatto</th>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${HACCP_EU_ALLERGENS.length + 1}">Nessun piatto attivo.</td></tr>`}</tbody>
  </table>
  <p class="legend">
    ● = l'allergene è presente fra gli ingredienti del piatto. Elenco dei 14 allergeni del Reg. UE 1169/2011, Allegato II.
    Le informazioni sono a disposizione dei clienti: per allergie e intolleranze chiedere al personale prima di ordinare.
  </p>
</body>
</html>`;
};

export const printAllergenBook = (dishes: HaccpAllergenDish[], restaurantName: string | null): void => {
  printHtmlDocument(buildAllergenBookHtml(dishes, restaurantName), { popupMessage: 'Sblocca i popup per stampare il libro allergeni.' });
};
