/* Export csv lato client, estratto dal pattern di CustomerList (marketing).
   Il BOM UTF-8 in testa serve a Excel: senza, le accentate italiane arrivano
   spezzate. Le celle sono sempre tra virgolette, con il raddoppio interno. */

const csvCell = (value: string | number | null | undefined): string => {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
};

export const downloadCsv = (
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][]
): void => {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
