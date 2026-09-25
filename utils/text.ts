export const toTitleCase = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

// Il nome dell'ospite come entra in un messaggio che parte dal mittente del
// ristorante: SMS, WhatsApp, email, variabili dei template. Il nome arriva
// da superfici pubbliche (/prenota, Sofia, rubrica che ne discende) come
// testo libero fino a 80 caratteri, e «Mario https://… chiama il 333…»
// diventava un messaggio di phishing firmato dal ristorante, con il suo
// numero e il suo dominio (audit isolamento, anche sul /prenota del
// Frantoio). Qui restano solo lettere, spazi e la punteggiatura che vive
// dentro i nomi veri — apostrofo e trattino fra due lettere, l'apostrofo
// dell'elisione («de' Medici»), il punto dopo una lettera: «D'Amico»,
// «Anne-Marie», «J. R. R.». Cifre, @, due punti, barre e i pezzi che
// somigliano a un link spariscono; poi si taglia a una parola intera entro
// 40 caratteri. Il nome salvato e mostrato nel CRM resta com'è: si pulisce
// solo la copia che esce. Vuoto → '', e il chiamante usa il saluto senza
// nome che già aveva («Ciao,» / «Hi,», «—» nei template).
//
// Niente lookbehind nelle regex: il file lo importa anche la SPA, e i
// Safari dei palmari più vecchi non li conoscono (errore di parsing
// dell'intero bundle, non della sola funzione).
const GUEST_NAME_MAX = 40;
// Una nota fra parentesi è dello staff, non del nome: togliendone solo cifre
// e simboli, «Rossi (2 persone)» usciva «Ciao Rossi Persone,». Via tutta,
// anche quando la parentesi non si chiude.
const BRACKETED_NOTE = /\([^)]*(?:\)|$)|\[[^\]]*(?:\]|$)|\{[^}]*(?:\}|$)/gu;
// Un pezzo che è un link o un recapito sparisce intero: togliendo solo i
// caratteri vietati, «evil.example» resterebbe cliccabile.
const LINK_TOKEN = /:\/\/|www\.|@/iu;
// Una parola con una cifra non è un nome («x2», «tav5», un telefono): via
// intera, invece di lasciarne le lettere attaccate al nome («Rossi X»).
const DIGIT_TOKEN = /\p{N}/u;
// Lettera, punto, due lettere: un dominio («evil.example», «t.me») oppure
// un'iniziale o un titolo attaccati al cognome («A.Rossi», «Mr.Smith»).
// Quando è un nome il punto prende uno spazio («A. Rossi»), e lo spazio
// basta a spezzare qualunque link; altrimenti il pezzo sparisce intero.
const DOTTED_TOKEN = /[\p{L}\p{M}]\.[\p{L}\p{M}]{2,}/u;
// È un nome se prima di ogni punto c'è una lettera sola (un'iniziale) o se
// dopo c'è una maiuscola. L'iniziale conta da sola perché i chiamanti
// passano spesso il nome da toTitleCase, che dopo il punto abbassa:
// «A.Rossi» arriva come «A.rossi». «Dott.ssa», «Sig.ra» ed «evil.example»
// non passano e spariscono (resta il cognome che segue); «x.com» diventa
// «X. Com», innocuo.
const dottedTokenIsName = (token: string): boolean => {
  if (/[\/\\]/.test(token)) return false;
  const parts = token.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const after = parts[i + 1];
    if (!/^[\p{L}\p{M}]/u.test(after)) continue;
    const before = parts[i].match(/[\p{L}\p{M}]+$/u)?.[0] ?? '';
    if (Array.from(before).length > 1 && !/^\p{Lu}/u.test(after)) return false;
  }
  return true;
};
const isNameLetter = (c: string | undefined): boolean => !!c && /[\p{L}\p{M}]/u.test(c);

export const guestNameForMessage = (input: string | null | undefined): string => {
  if (!input) return '';
  const tokens = String(input)
    .normalize('NFC')
    .replace(BRACKETED_NOTE, ' ')
    .split(/\s+/)
    .filter(token => token && !LINK_TOKEN.test(token) && !DIGIT_TOKEN.test(token))
    .map(token => {
      if (!DOTTED_TOKEN.test(token)) return token;
      return dottedTokenIsName(token) ? token.replace(/\.(?=[\p{L}\p{M}])/gu, '. ') : '';
    })
    .filter(Boolean);
  const chars = Array.from(tokens.join(' '));
  let kept = '';
  chars.forEach((c, i) => {
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (c === ' ' || isNameLetter(c)) kept += c;
    else if ((c === "'" || c === '’' || c === '-') && isNameLetter(prev) && isNameLetter(next)) kept += c;
    else if ((c === "'" || c === '’') && isNameLetter(prev) && next === ' ') kept += c;
    else if (c === '.' && isNameLetter(prev)) kept += c;
    else kept += ' ';
  });
  let name = '';
  for (const word of kept.split(' ').filter(Boolean)) {
    const candidate = name ? `${name} ${word}` : word;
    if (Array.from(candidate).length > GUEST_NAME_MAX) {
      // Una parola sola più lunga del tetto: si taglia lei, senza lasciare
      // un apostrofo o un trattino appeso in fondo.
      if (!name) name = Array.from(word).slice(0, GUEST_NAME_MAX).join('').replace(/['’\-]+$/u, '');
      break;
    }
    name = candidate;
  }
  // toTitleCase non conosce il punto come separatore: «J.R.R.» diventerebbe
  // «J.r.r.». Le iniziali tornano maiuscole qui, senza toccare la funzione
  // condivisa.
  return toTitleCase(name).replace(/\.(\p{Ll})/gu, (_, ch: string) => '.' + ch.toUpperCase());
};

// Denominazioni che sui titoli del menu restano sigle: «Barolo DOCG», non
// «Barolo Docg» — vale per i vini e per le DOP/IGP alimentari. La lista è
// chiusa apposta: parole corte vere (Do, Salame al Doc?) non devono
// diventare sigle per sbaglio, quindi niente euristica «tutto maiuscolo se
// corto». Replicata byte per byte nella migration titoli-menu-title-case:
// toccarla qui significa toccarla anche là, o i confronti esatti divergono.
const MENU_ACRONYMS = /\b(Doc|Docg|Igt|Igp|Dop|Stg|Aoc|Aop|Ipa)\b/g;

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

// Unità di misura dopo una quantità: «33 cl», «½ l», «0,5 kg» — mai «Cl».
// Lista chiusa come le sigle, e il vincolo del numero davanti protegge le
// parole vere («G» iniziale di un nome non c'entra con i grammi). Replicata
// nella migration unita-di-misura-minuscole, stessa regola byte per byte.
const MENU_UNIT_WORDS = new Set(['cl', 'l', 'ml', 'lt', 'g', 'kg']);
const MENU_QUANTITY_TOKEN = /^([0-9.,]+|[½¼¾])$/;

const lowerMinorWords = (titled: string): string =>
  titled
    .split(' ')
    .map((w, idx, all) => {
      if (idx === 0) return w;
      if (MENU_MINOR_WORDS.has(w.toLowerCase())) return w.toLowerCase();
      if (MENU_UNIT_WORDS.has(w.toLowerCase()) && MENU_QUANTITY_TOKEN.test(all[idx - 1])) {
        return w.toLowerCase();
      }
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

// Chiave di confronto fra telefoni: il numero NAZIONALE, non le ultime 10
// cifre. right-10 sbaglia sui cellulari storici a 9 cifre ("+39 330 581013"
// → "9330581013": pesca la 9 del prefisso e non combacia mai col
// "330581013" salvato in rubrica — caso Pisciotta 2026-09-18, thread
// WhatsApp sdoppiato in due conversazioni). Il prefisso italiano si toglie
// solo quando la lunghezza lo rende inequivocabile: 11 cifre = 39+9, 12 =
// 39+10; un nazionale che inizia per 39 (prefisso 393…, 10 cifre) resta
// intatto.
export function phoneMatchKey(input: string | null | undefined): string {
  const d = String(input ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) return phoneMatchKey(d.slice(2));
  if ((d.length === 11 || d.length === 12) && d.startsWith('39')) return d.slice(2);
  return d;
}

// Il gemello SQL di phoneMatchKey, per i confronti che devono avvenire nel
// database. Vive qui e non in server.ts perché le due logiche devono restare
// identiche: separate, una delle due prima o poi cambia da sola.
// Attenzione: `col` finisce nell'SQL così com'è — nome di colonna o
// segnaposto ($1), mai testo che arrivi dal client.
export const PHONE_MATCH_KEY_SQL = (col: string): string => `
    CASE
      WHEN length(regexp_replace(${col}, '[^0-9]', '', 'g')) IN (11, 12)
       AND left(regexp_replace(${col}, '[^0-9]', '', 'g'), 2) = '39'
      THEN substr(regexp_replace(${col}, '[^0-9]', '', 'g'), 3)
      ELSE regexp_replace(${col}, '[^0-9]', '', 'g')
    END`;

// Le forme in cui la stessa utenza può stare in una colonna "cifre nude"
// (to/from_phone_digits): nazionale, col 39, col 0039. Un confronto
// `= ANY(...)` su queste tre usa gli indici pieni delle colonne, dove
// right(..., 10) non è indicizzato.
export function phoneDigitsVariants(input: string | null | undefined): string[] {
  const key = phoneMatchKey(input);
  return key ? [key, `39${key}`, `0039${key}`] : [];
}

// Varianti per i confronti su right(..., 10) (gli indici last10 di rubrica e
// prenotazioni): per i numeri da 10 cifre in su le due forme coincidono, per
// i cellulari storici a 9 la seconda copre le righe salvate col prefisso.
export function phoneLast10Variants(input: string | null | undefined): string[] {
  const key = phoneMatchKey(input);
  if (!key) return [];
  return [...new Set([key.slice(-10), `39${key}`.slice(-10)])];
}
