// Misure reali dei tavoli per la pianta di sala. width_cm/length_cm sono
// facoltativi nel DB: quando mancano si stimano dai posti, così una sala
// con pianta resta disegnabile anche prima che il titolare prenda il metro.
// I default vivono qui e non nel DB, deliberatamente: «non misurato» resta
// distinguibile e un ritocco alle formule si applica retroattivamente.
//
// Nessun import: il file è condiviso fra SPA e server (regola estensioni
// .js sugli import server), quindi accetta parametri strutturali e
// confronta la forma come stringa (nel DB shape è VARCHAR libero).

export interface TableDimensionsInput {
  shape: string; // 'RECTANGLE' | 'CIRCLE' | 'SQUARE'
  seats: number;
  width_cm?: number | null;
  length_cm?: number | null;
}

export interface TableDimensionsCm {
  // Lato corto (profondità) per i rettangoli; lato/diametro per
  // quadrati e cerchi. Convenzione identica alle colonne del DB.
  w_cm: number;
  // Lato lungo; per quadrati e cerchi coincide con w_cm.
  l_cm: number;
}

const round5 = (v: number) => Math.round(v / 5) * 5;

/**
 * Misure reali se presenti, altrimenti default per forma con lo standard
 * dei 60 cm a coperto (arrotondati ai 5 cm).
 */
export function getEffectiveDimensionsCm(table: TableDimensionsInput): TableDimensionsCm {
  const seats = Math.max(1, table.seats || 1);

  if (table.width_cm && table.length_cm) {
    return { w_cm: table.width_cm, l_cm: table.length_cm };
  }
  // Una sola misura inserita: per quadrati e cerchi basta, per i
  // rettangoli si completa col default dell'altro lato.
  const measured = table.width_cm || table.length_cm || null;

  if (table.shape === 'CIRCLE') {
    const d = measured ?? round5(Math.min(200, Math.max(70, 45 + 13 * seats)));
    return { w_cm: d, l_cm: d };
  }

  if (table.shape === 'SQUARE') {
    const side = measured ?? (seats <= 2 ? 70 : seats <= 4 ? 90 : 110);
    return { w_cm: side, l_cm: side };
  }

  // RECTANGLE: coperti distribuiti sui due lati lunghi.
  const chairsPerSide = Math.ceil(seats / 2);
  const defaultLength = Math.max(80, chairsPerSide * 60 + 20);
  const w = table.width_cm ?? 80;
  const l = table.length_cm ?? defaultLength;
  return { w_cm: Math.min(w, l), l_cm: Math.max(w, l) };
}
