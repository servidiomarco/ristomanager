// Each banquet gets a stable color so two events in the same room are visually
// distinguishable on the floor plan (hull tint + label tint travel together).
// 5 variants cover the typical 1-3 banquets per shift with margin. The palette
// is defined in index.css as `.banquet-color-{0..4}` classes that override the
// --color-banquet-* CSS vars — descendants reading those vars (hulls, the
// BanquetLabel pill, the booking-modal banquet container) automatically pick
// up the per-banquet tint.

const PALETTE_SIZE = 5;

export function getBanquetColorIndex(banquetId: number): number {
  return ((banquetId % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}

export function banquetColorClass(banquetId: number): string {
  return `banquet-color-${getBanquetColorIndex(banquetId)}`;
}
