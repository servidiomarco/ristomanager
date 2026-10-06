// Il tavolo aperto nella cassa Passepartout, come condizione SQL per la
// disponibilità automatica (Sofia, /prenota, scelta del tavolo): un modulo
// senza dipendenze, così roomOccupancyService e elevenlabsService usano la
// stessa regola e non possono divergere.
//
// Regola: vale solo per OGGI (la cassa dice cosa succede adesso) e solo se
// il ristorante ha acceso «Tavoli aperti in cassa» con «Considera nella
// disponibilità». Un tavolo aperto blocca la richiesta se si libera DOPO:
//  - l'orario chiesto, quando il chiamante lo passa (doppio turno);
//  - altrimenti l'inizio del turno (11:00 pranzo, 17:00 cena): un tavolo
//    aperto a pranzo che si libera alle 15:30 non tocca la cena.
// La liberazione prevista (libero_previsto_at) la calcola il giro che legge
// la cassa: apertura + durata del turno, mai prima di adesso + 20 minuti.
// Lo staff che assegna a mano NON passa di qui (findTableConflicts): vede
// il tavolo occupato in sala e decide lui — il gruppo di prima può star
// pagando.

/**
 * `alias` è l'alias del tavolo nella query; le altre sono espressioni SQL
 * (di solito placeholder: '$5') per ristorante, data (YYYY-MM-DD), turno e,
 * se c'è, orario chiesto (timestamp senza fuso, ora di sala).
 */
export function nonApertoInCassaSql(
    alias: string,
    tenantExpr: string,
    dateExpr: string,
    shiftExpr: string,
    startExpr?: string,
): string {
    const quando = startExpr
        ? `${startExpr}::timestamp`
        : `(${dateExpr}::date + CASE WHEN ${shiftExpr} = 'LUNCH' THEN time '11:00' ELSE time '17:00' END)`;
    return `NOT EXISTS (
                  SELECT 1 FROM passepartout_tavoli_aperti pta
                    JOIN passepartout_config pcf ON pcf.tenant_id = pta.tenant_id
                         AND pcf.tavoli_aperti_enabled AND pcf.tavoli_aperti_disponibilita
                   WHERE pta.table_id = ${alias}.id AND pta.tenant_id = ${tenantExpr}
                     AND ${dateExpr}::date = (now() AT TIME ZONE 'Europe/Rome')::date
                     AND pta.libero_previsto_at > ${quando}
              )`;
}
