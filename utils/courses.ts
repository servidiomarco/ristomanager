// ---------------------------------------------------------------------------
// Le uscite della comanda, condivise fra client e server come utils/text.ts.
//
// Le uscite di cucina sono 1..6 (convenzione di sala, non un limite tecnico).
// Il Bar è un'uscita a parte con un course_no riservato: bibite, vini e
// amari non stanno nella sequenza delle portate — si preparano al banco e
// partono per conto loro. Il numero alto tiene il Bar fuori dai piedi della
// logica «prossima uscita» (MIN(course_no)) e non richiede migration: il
// CHECK su order_items è solo course_no > 0.
// ---------------------------------------------------------------------------

export const BAR_COURSE_NO = 99;

/** I Dolci sono la seconda uscita fuori numerazione, col meccanismo del Bar
 *  (partono da soli, senza chiamata) ma dal verso opposto: il Bar sta in
 *  testa al servizio, i dolci in coda. 98 < 99 così negli elenchi ordinati
 *  per course_no stanno subito dopo le portate. */
export const DESSERT_COURSE_NO = 98;

export const isBarCourse = (n: number): boolean => n === BAR_COURSE_NO;

export const isDessertCourse = (n: number): boolean => n === DESSERT_COURSE_NO;

/** Le uscite fuori dalla sequenza delle portate: partono da sole in ogni
 *  modalità automatica e non contano per la logica «prossima uscita». */
export const isOffSequenceCourse = (n: number): boolean =>
    isBarCourse(n) || isDessertCourse(n);

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];

/* Le etichette delle uscite si traducono QUI, una volta, e da qui le prendono
 * il palmare, le colonne delle uscite, i chip, il monitor di cucina e il
 * passe: sono la stessa parola sulla stessa comanda, e una divergenza fra due
 * schermi che il cameriere guarda di fila si nota subito.
 *
 * `t` arriva come parametro perché queste sono funzioni pure, chiamate anche
 * da moduli di vista senza hook — lo stesso contratto di reservationState.tsx.
 * Senza `t` si resta in italiano: è la lingua in cui l'applicazione è nata, e
 * un chiamante dimenticato deve leggersi, non sparire.
 *
 * Gli ordinali sono chiavi esplicite e non una formula: in italiano è il
 * femminile di «uscita» (1ª), in inglese è irregolare (1st, 2nd, 3rd, 4th).
 */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

/** «1ª»…«6ª», «Bar» e «Dolci» per le uscite fuori numerazione; oltre il 6 il
 *  numero nudo (non esprimibile dal palmare, ma un client sbagliato non deve
 *  rompere nulla). */
export const ordinal = (n: number, t?: TFunc): string => {
    if (isBarCourse(n)) return t ? t('courses.bar', 'Bar') : 'Bar';
    if (isDessertCourse(n)) return t ? t('courses.dessert', 'Dolci') : 'Dolci';
    const it = ORDINALS[n] ?? `${n}ª`;
    return t && n >= 1 && n <= 6 ? t(`courses.ord${n}`, it) : it;
};

/** «1ª uscita» … «6ª uscita», «Bar», «Dolci». */
export const courseLabel = (n: number, t?: TFunc): string => {
    if (isBarCourse(n) || isDessertCourse(n)) return ordinal(n, t);
    const ord = ordinal(n, t);
    return t ? t('courses.label', '{{ord}} uscita', { ord }) : `${ord} uscita`;
};

/** Come `courseLabel` ma stretta, per il monitor di cucina: «1ª usc.». */
export const courseLabelShort = (n: number, t?: TFunc): string => {
    if (isBarCourse(n) || isDessertCourse(n)) return ordinal(n, t);
    const ord = ordinal(n, t);
    return t ? t('courses.labelShort', '{{ord}} usc.', { ord }) : `${ord} usc.`;
};

/** «Uscita Bar» / «Uscita Dolci» / «1ª uscita»: la forma lunga che cucina e
 *  passe mettono in testa alla colonna, dove il nome deve stare da solo. */
export const courseLabelLong = (n: number, t?: TFunc): string => {
    if (isBarCourse(n)) return t ? t('courses.barLong', 'Uscita Bar') : 'Uscita Bar';
    if (isDessertCourse(n)) return t ? t('courses.dessertLong', 'Uscita Dolci') : 'Uscita Dolci';
    return courseLabel(n, t);
};
