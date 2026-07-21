import { COMMON_ALLERGENS } from '../types';

// Dietary flags on a reservation are persisted inside the free-text `notes`
// field as two labelled segments: "Allergie: X, Y | Intolleranze: Z". Allergie
// (allergies) are the serious, safety-critical ones; Intolleranze
// (intolerances) are the milder ones. Kept in `notes` so no schema/back-end
// change is needed, and matched against the known preset list so free-text
// notes never leak into the chips. Backward compatible: older bookings with
// only an "Intolleranze:" segment (or none) still parse cleanly.

const ALLERGIE_RE = /Allergie:\s*([^|]*)/i;
const INTOLLERANZE_RE = /Intolleranze:\s*([^|]*)/i;

export interface Dietary {
  allergies: string[];
  intolerances: string[];
}

/** Parse the Allergie/Intolleranze segments from a notes string, keeping only
 *  values that match a known preset (so stray note text isn't treated as an
 *  allergen). Pass a custom preset list when the tenant configured one. */
export function parseDietary(notes: string | null | undefined, presets: string[] = COMMON_ALLERGENS): Dietary {
  const text = notes || '';
  const pick = (re: RegExp): string[] => {
    const seg = text.match(re)?.[1] || '';
    const low = seg.toLowerCase();
    return presets.filter(p => low.includes(p.toLowerCase()));
  };
  return { allergies: pick(ALLERGIE_RE), intolerances: pick(INTOLLERANZE_RE) };
}

/** Build the "Allergie: … | Intolleranze: …" prefix (empty when both empty). */
export function buildDietaryNote(allergies: string[], intolerances: string[]): string {
  const parts: string[] = [];
  if (allergies.length) parts.push(`Allergie: ${allergies.join(', ')}`);
  if (intolerances.length) parts.push(`Intolleranze: ${intolerances.join(', ')}`);
  return parts.join(' | ');
}

/** Strip both dietary segments from a notes string, leaving the free-text rest. */
export function stripDietaryNote(notes: string | null | undefined): string {
  return (notes || '')
    .replace(/Allergie:\s*[^|]*(\s*\|\s*)?/gi, '')
    .replace(/Intolleranze:\s*[^|]*(\s*\|\s*)?/gi, '')
    .replace(/^\s*\|\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

/** True when the notes carry any allergy or intolerance. */
export function hasDietary(notes: string | null | undefined): boolean {
  const { allergies, intolerances } = parseDietary(notes);
  return allergies.length > 0 || intolerances.length > 0;
}
