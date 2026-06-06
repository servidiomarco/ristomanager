export const toTitleCase = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

// First name + last-name initial, e.g. "Andrea Cisareo" → "Andrea C.".
// Single-token names are returned as-is. Keeps map name pills a consistent width.
export const formatShortName = (name?: string | null): string => {
  const titled = toTitleCase(name);
  if (!titled) return '';
  const parts = titled.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return titled;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

export const getInitials = (name?: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
};
