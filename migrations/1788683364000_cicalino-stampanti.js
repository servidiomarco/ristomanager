/**
 * Cicalino alla stampa, per stampante.
 *
 * La termica di cucina deve farsi sentire quando arriva una comanda: il
 * cuoco è di spalle e una stampa muta resta appesa. Il flag vive nel
 * registro stampanti (Impostazioni → Sala & Cucina) e arriva all'agente
 * LAN via /print-agent/config: acceso, l'agente antepone il comando
 * ESC/POS di beep a ogni job verso quella stampante. Spento di default:
 * il banco dei preconti non deve suonare a ogni conto.
 */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE printers ADD COLUMN IF NOT EXISTS buzzer BOOLEAN NOT NULL DEFAULT false;`);
};

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE printers DROP COLUMN IF EXISTS buzzer;`);
};
