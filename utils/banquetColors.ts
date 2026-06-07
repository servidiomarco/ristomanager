// Each banquet gets a stable color so two events in the same room are visually
// distinguishable on the floor plan (hull tint + label tint travel together).
// 5 variants cover the typical 1-3 banquets per shift with margin. The palette
// is defined in index.css as `.banquet-color-{0..4}` classes that override the
// --color-banquet-* CSS vars — descendants reading those vars (hulls, the
// BanquetLabel pill, the booking-modal banquet container) automatically pick
// up the per-banquet tint.

const PALETTE_SIZE = 5;

// Assigns a color class to each banquet currently visible in a view by
// sequential order (sorted by id) — NOT by id modulo. Two distinct banquets
// in the same scope are guaranteed distinct as long as the scope has
// ≤ PALETTE_SIZE banquets; beyond that the palette cycles. Build the map per
// view scope (room map, booking modal) so colors are stable within a render.
export function buildBanquetColorClassMap(banquetIds: Iterable<number>): Map<number, string> {
  const unique = [...new Set([...banquetIds])].sort((a, b) => a - b);
  const m = new Map<number, string>();
  unique.forEach((id, i) => {
    m.set(id, `banquet-color-${i % PALETTE_SIZE}`);
  });
  return m;
}
