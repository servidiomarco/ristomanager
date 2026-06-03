export const toTitleCase = (input: string | null | undefined): string => {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
};

export const getInitials = (name?: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
};
