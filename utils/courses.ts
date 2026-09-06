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

export const isBarCourse = (n: number): boolean => n === BAR_COURSE_NO;

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];

/** «1ª»…«6ª», «Bar» per l'uscita bar; oltre il 6 il numero nudo (non
 *  esprimibile dal palmare, ma un client sbagliato non deve rompere nulla). */
export const ordinal = (n: number): string =>
    isBarCourse(n) ? 'Bar' : ORDINALS[n] ?? `${n}ª`;

/** «1ª uscita» … «6ª uscita», «Bar». */
export const courseLabel = (n: number): string =>
    isBarCourse(n) ? 'Bar' : `${ordinal(n)} uscita`;
