export const toTitleCase = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

// Denominazioni che sui titoli del menu restano sigle: «Barolo DOCG», non
// «Barolo Docg» — vale per i vini e per le DOP/IGP alimentari. La lista è
// chiusa apposta: parole corte vere (Do, Salame al Doc?) non devono
// diventare sigle per sbaglio, quindi niente euristica «tutto maiuscolo se
// corto». Replicata byte per byte nella migration titoli-menu-title-case:
// toccarla qui significa toccarla anche là, o i confronti esatti divergono.
const MENU_ACRONYMS = /\b(Doc|Docg|Igt|Igp|Dop|Stg|Aoc|Aop)\b/g;

// Sigle puntate: una sequenza di almeno due coppie lettera-punto è una
// sigla («d.o.p.» → «D.O.P.», «s.p.a.» → «S.P.A.»). Il minimo di due
// coppie protegge le abbreviazioni vere («Mel.», «Pat.»), che di coppia
// ne hanno una sola.
const DOTTED_ACRONYMS = /\b(?:\p{L}\.){2,}/gu;

// Title Case all'italiana: preposizioni, articoli e congiunzioni restano
// minuscoli quando non aprono il titolo — «Filetto ai Porcini», non
// «Filetto Ai Porcini». Lista chiusa come per le sigle.
const MENU_MINOR_WORDS = new Set([
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'senza',
  'e', 'ed', 'o', 'od',
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
  'del', 'dello', 'della', 'dei', 'degli', 'delle',
  'al', 'allo', 'alla', 'ai', 'agli', 'alle',
  'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle',
  'nel', 'nello', 'nella', 'nei', 'negli', 'nelle',
  'sul', 'sullo', 'sulla', 'sui', 'sugli', 'sulle',
  'col', 'coi',
]);

// Le stesse, elise: «Spaghetti all'Aglio», non «All'Aglio». Sant'/San
// restano fuori apposta: sono pezzi di nome proprio.
const MENU_ELISION_PREFIXES = new Set(['d', 'l', 'un', 'all', 'dell', 'dall', 'nell', 'sull', 'coll']);

const lowerMinorWords = (titled: string): string =>
  titled
    .split(' ')
    .map((w, idx) => {
      if (idx === 0) return w;
      if (MENU_MINOR_WORDS.has(w.toLowerCase())) return w.toLowerCase();
      const m = w.match(/^(\p{L}+)(['’])(.*)$/u);
      if (m && MENU_ELISION_PREFIXES.has(m[1].toLowerCase())) {
        return m[1].toLowerCase() + m[2] + m[3];
      }
      return w;
    })
    .join(' ');

// Title Case per i titoli del menu (piatti, categorie, varianti,
// ingredienti): come toTitleCase, ma le denominazioni tornano maiuscole
// (puntate o no) e preposizioni/articoli/congiunzioni minuscoli quando non
// aprono il titolo. Replicato nelle migration titoli-menu-title-case e
// rifinitura-titoli-menu: toccare qui significa una migration nuova di
// riallineamento, o i confronti esatti divergono.
export const toMenuTitleCase = (input: string | null | undefined): string =>
  lowerMinorWords(
    toTitleCase(input)
      .replace(MENU_ACRONYMS, (m) => m.toUpperCase())
      .replace(DOTTED_ACRONYMS, (m) => m.toUpperCase()),
  );

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
