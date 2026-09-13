// Lucchetto sulla categoria di un piatto importato dalla cassa: il sync
// Passepartout riscrive `category` a ogni giro (la cassa la possiede), ma
// certe curatele del CRM devono sopravvivere — il caso che l'ha chiesto è la
// carta dei vini divisa per colore (Vini bianchi / Vini rosé) mentre la cassa
// conosce solo «Vini bianchi-rosé». Con il lucchetto alzato il sync lascia la
// categoria del CRM; tutto il resto (nome, prezzo, IVA, attivo) resta della
// cassa. Si alza da solo cambiando categoria a mano su un piatto pp dalla
// scheda piatto.
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS category_locked boolean NOT NULL DEFAULT false`);
};
