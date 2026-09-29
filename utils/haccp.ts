/* Postazioni del registro temperature HACCP.
 *
 * Vive in utils/ perché la leggono tutt'e due i lati: il frontend per il
 * modulo giornaliero, il server per l'avviso «temperatura fuori soglia» e per
 * il promemoria «rilevazioni mancanti», che deve sapere quante postazioni
 * aspettarsi. Due copie divergerebbero al primo frigo nuovo, e il promemoria
 * segnalerebbe mancante una postazione che il modulo non chiede più.
 */
export interface HaccpTemperatureLocation {
  location: string;
  targetMax: number;
}

export const HACCP_TEMPERATURE_LOCATIONS: HaccpTemperatureLocation[] = [
  { location: 'Cella 1', targetMax: 4 },
  { location: 'Cella 2', targetMax: 4 },
  { location: 'Cella 3', targetMax: 4 },
  { location: 'Cella 4', targetMax: 4 },
  { location: 'Banco cella grill', targetMax: 4 },
  { location: 'Frigo antipasti', targetMax: 4 },
  { location: 'Frigo primi', targetMax: 4 },
  { location: 'Frigo office', targetMax: 4 },
  { location: 'Congelatore 1c', targetMax: -18 },
  { location: 'Congelatore 2c', targetMax: -18 },
  { location: 'Congelatore gelati', targetMax: -18 },
];

/** Il tag della push «fuori soglia» di una postazione in un giorno. Senza
 *  spazi: finisce nell'URL (?ntag=) quando si tocca la notifica. */
export const haccpTemperatureTag = (date: string, location: string): string =>
  `haccp-temp-${date}-${location.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** Il tag della push «rilevazioni mancanti» di un giorno. */
export const haccpMissingTag = (date: string): string => `haccp-missing-${date}`;
