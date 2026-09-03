export const toTitleCase = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

// Particelle che aprono un cognome composto: se il nome registrato inizia
// così, la prima parola NON è un nome di battesimo. "De Franco Chiara"
// troncato alla prima parola produceva saluti e conferme "Ciao De" /
// "Confermato De" (estate 2026): in quel caso si usa il nome intero, che
// non è mai sbagliato, solo meno confidenziale.
const SURNAME_PARTICLES = new Set([
  'de', 'di', 'del', 'della', 'dello', 'dei', 'degli', 'delle',
  'da', 'dal', 'dalla', 'dallo', 'la', 'lo', 'le', 'li',
  'van', 'von', 'mc', 'mac', 'san', 'santa', 'santo',
]);

// Prima parola del nome per saluti e conferme a voce; il nome intero quando
// la prima parola è una particella di cognome.
export const spokenFirstName = (name?: string | null): string => {
  const trimmed = (name || '').trim();
  if (!trimmed) return '';
  const first = trimmed.split(/\s+/)[0];
  return SURNAME_PARTICLES.has(first.toLowerCase()) ? trimmed : first;
};

// First name + last-name initial, e.g. "Andrea Cisareo" → "Andrea C.".
// Single-token names are returned as-is. Keeps map name pills a consistent width.
export const formatShortName = (name?: string | null): string => {
  const titled = toTitleCase(name);
  if (!titled) return '';
  const parts = titled.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return titled;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

export const getInitials = (name?: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
};
