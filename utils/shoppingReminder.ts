/* Il testo del promemoria della lista della spesa (system_key SHOPPING_LIST).
 *
 * Vive in utils/ perché è pura composizione di stringhe: il server lo usa
 * allo scatto, i test API lo verificano senza dover aspettare lo scheduler.
 */
export interface PendingShoppingItem {
    name: string;
    supplier: string | null;
}

/** Il corpo del promemoria. Con almeno un fornitore assegnato dice a chi
 *  ordinare — «Metro 3, Ortofrutta Rossi 2, senza fornitore 2» — perché è
 *  la domanda di chi fa la spesa; senza fornitori elenca i primi articoli. */
export function shoppingReminderBody(rows: PendingShoppingItem[]): string {
    const bySupplier = new Map<string, number>();
    let unassigned = 0;
    for (const r of rows) {
        if (r.supplier) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + 1);
        else unassigned++;
    }
    if (bySupplier.size === 0) {
        const shown = rows.slice(0, 3).map(r => r.name).join(', ');
        return rows.length > 3 ? `${shown} e altri ${rows.length - 3}` : shown;
    }
    // Più voci prima: è l'ordine che conviene fare per primo. A parità,
    // alfabetico, così due scatti con la stessa lista dicono la stessa cosa.
    const groups = [...bySupplier.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it'))
        .map(([name, n]) => `${name} ${n}`);
    const shown = groups.slice(0, 4);
    const others = groups.length - shown.length;
    if (others > 0) shown.push(others === 1 ? 'un altro fornitore' : `altri ${others} fornitori`);
    if (unassigned > 0) shown.push(`senza fornitore ${unassigned}`);
    return shown.join(', ');
}
