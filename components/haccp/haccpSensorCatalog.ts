/* I sensori che il webhook sa leggere (services/haccpRoutes.ts,
   parseSensorPayload), con i passi per collegarli. Il testo vive nelle
   traduzioni (namespace haccp, sensors.catalog.*): qui solo la struttura e i
   fallback italiani. Un fornitore nuovo nel parser → una voce qui. */

export type HaccpSensorVendor = 'milesight' | 'monnit' | 'lorawan' | 'generic';

export interface HaccpSensorCatalogEntry {
  id: HaccpSensorVendor;
  /** Marca e modelli: non si traducono. */
  name: string;
  /** Per le voci che non sono un marchio («Formato generico»). */
  nameKey?: string;
  /** Registratore conforme alla EN 12830 (Reg. CE 37/2005, surgelati). */
  en12830: boolean;
  recommended?: boolean;
  /** I dati passano dal cloud del produttore (spesso in abbonamento). */
  cloud: boolean;
  summary: [key: string, fallback: string];
  steps: Array<[key: string, fallback: string]>;
  note?: [key: string, fallback: string];
  /** Un esempio di messaggio, per chi programma il gateway da sé. */
  sample?: string;
}

export const HACCP_SENSOR_CATALOG: HaccpSensorCatalogEntry[] = [
  {
    id: 'milesight',
    name: 'Milesight TS301 / TS302',
    en12830: true,
    recommended: true,
    cloud: false,
    summary: ['sensors.catalog.milesight.summary', 'Sonda per alimenti col display: una sonda (TS301) o due (TS302, un sensore per due celle). Serve un gateway Milesight UG63 o UG65 collegato al router.'],
    steps: [
      ['sensors.catalog.milesight.step1', 'Collega il gateway al router col cavo di rete e apri la sua pagina di configurazione.'],
      ['sensors.catalog.milesight.step2', 'In Network Server attiva il server integrato, banda EU868.'],
      ['sensors.catalog.milesight.step3', 'Crea un\'applicazione con Metadata attivo e una destinazione HTTP: l\'indirizzo qui sopra, intestazione X-Haccp-Sensor-Token col token.'],
      ['sensors.catalog.milesight.step4', 'Aggiungi i sensori col decoder TS301 o TS302. DevEUI e AppKey sono sull\'etichetta, o si leggono con l\'app Milesight ToolBox avvicinando il telefono.'],
      ['sensors.catalog.milesight.step5', 'Con ToolBox imposta l\'invio ogni 5–10 minuti. La sonda va in cella, col cavo che passa dalla guarnizione della porta.'],
      ['sensors.catalog.milesight.step6', 'Alla prima lettura il sensore compare qui sotto: assegnalo alla sua postazione. Un TS302 compare due volte, una per sonda.'],
    ],
    note: ['sensors.catalog.milesight.note', 'Gateway senza l\'opzione Metadata (firmware vecchio): aggiungi in fondo all\'indirizzo ?device=$devEUI'],
  },
  {
    id: 'monnit',
    name: 'Monnit ALTA',
    en12830: false,
    cloud: true,
    summary: ['sensors.catalog.monnit.summary', 'I sensori parlano col gateway Monnit; le letture passano dal portale iMonnit, che le inoltra con un webhook.'],
    steps: [
      ['sensors.catalog.monnit.step1', 'Nel portale iMonnit crea un webhook dei dati verso l\'indirizzo qui sopra.'],
      ['sensors.catalog.monnit.step2', 'Se il portale non permette intestazioni, metti il token in fondo all\'indirizzo: ?token=…'],
      ['sensors.catalog.monnit.step3', 'Alla prima lettura i sensori compaiono qui sotto: assegnali alle postazioni.'],
    ],
  },
  {
    id: 'lorawan',
    name: 'ChirpStack · The Things Network',
    en12830: false,
    cloud: false,
    summary: ['sensors.catalog.lorawan.summary', 'Qualsiasi sensore di temperatura LoRaWAN su una rete che hai già, se il decoder restituisce temperature (o temperature_chn1, temperature_chn2).'],
    steps: [
      ['sensors.catalog.lorawan.step1', 'Aggiungi un\'integrazione HTTP verso l\'indirizzo qui sopra, con l\'intestazione X-Haccp-Sensor-Token.'],
      ['sensors.catalog.lorawan.step2', 'Il sensore si riconosce dal DevEUI e compare qui sotto alla prima lettura.'],
    ],
  },
  {
    id: 'generic',
    name: 'Formato generico',
    nameKey: 'sensors.catalog.generic.name',
    en12830: false,
    cloud: false,
    summary: ['sensors.formatGeneric', 'JSON con una lettura o un elenco: valore in °C, ora facoltativa.'],
    steps: [],
    sample: '{ "readings": [ { "sensor": "cella-01", "value": 3.2, "at": "2026-10-05T09:00:00Z", "battery": 90 } ] }',
  },
];

/** Il nome del fornitore accanto all'ID del sensore in elenco. */
export const HACCP_SENSOR_VENDOR_NAMES: Record<string, string> = {
  milesight: 'Milesight',
  monnit: 'Monnit',
  lorawan: 'LoRaWAN',
};
