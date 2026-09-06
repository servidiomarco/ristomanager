/**
 * Pronto automatico per partita (Impostazioni → Sala & Cucina).
 *
 * Una partita che lavora solo di carta — stampante sì, monitor KDS no,
 * come gli Antipasti al Vecchio Frantoio — non ha nessuno che possa
 * premere «pronto»: le sue righe restavano SENT per sempre e l'uscita
 * intera non risultava mai pronta al passe. Col flag acceso le righe
 * della partita nascono già READY al lancio (la comanda esce comunque
 * dalla termica), così l'uscita aspetta solo le partite col monitor.
 */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE stations ADD COLUMN IF NOT EXISTS auto_ready BOOLEAN NOT NULL DEFAULT false;`);
};

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE stations DROP COLUMN IF EXISTS auto_ready;`);
};
