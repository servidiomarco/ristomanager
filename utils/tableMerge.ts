import type { Table, TableMerge } from '../types';

// Compose raw tables with per-shift merges into "display" tables. The primary
// of each merge group is rewritten with the joined name, summed seats, and a
// `merged_with` array of secondary IDs — matching the shape that all existing
// display logic already understands. Secondary tables are returned unchanged
// (they get hidden by callers that filter on other tables' merged_with arrays).
export const applyMerges = (rawTables: readonly Table[], merges: readonly TableMerge[]): Table[] => {
  if (merges.length === 0) return rawTables.map(t => ({ ...t, merged_with: undefined }));

  const tableById = new Map(rawTables.map(t => [t.id, t]));
  const mergesByPrimary = new Map(merges.map(m => [m.primary_id, m.merged_ids]));

  return rawTables.map(table => {
    const mergedIds = mergesByPrimary.get(table.id);
    if (!mergedIds || mergedIds.length === 0) {
      return { ...table, merged_with: undefined };
    }
    const others = mergedIds.map(id => tableById.get(id)).filter((t): t is Table => !!t);
    return {
      ...table,
      name: [table.name, ...others.map(o => o.name)].join('+'),
      seats: table.seats + others.reduce((sum, o) => sum + o.seats, 0),
      merged_with: mergedIds,
    };
  });
};
