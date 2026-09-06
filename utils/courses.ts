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

/** «1ª»…«6ª», «Bar» e «Dolci» per le uscite fuori numerazione; oltre il 6 il
 *  numero nudo (non esprimibile dal palmare, ma un client sbagliato non deve
 *  rompere nulla). */
export const ordinal = (n: number): string =>
    isBarCourse(n) ? 'Bar' : isDessertCourse(n) ? 'Dolci' : ORDINALS[n] ?? `${n}ª`;

/** «1ª uscita» … «6ª uscita», «Bar», «Dolci». */
export const courseLabel = (n: number): string =>
    isBarCourse(n) ? 'Bar' : isDessertCourse(n) ? 'Dolci' : `${ordinal(n)} uscita`;
