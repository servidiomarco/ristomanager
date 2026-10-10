// ============================================
// Il fornitore della fattura, ritrovato in anagrafica dal nome
// ============================================
// «Mollo» ↔ «Mollo Ortofrutta S.R.L.», «Cash De Caprio» ↔ «DE CAPRIO S.R.L.»:
// si contano le parole che contano, senza forme societarie e parole di
// servizio. Serve la prima volta: poi il fornitore ha la P.IVA e si collega
// da solo.

const PAROLE_VUOTE = new Set([
    'srl', 'srls', 'spa', 'snc', 'sas', 'sapa', 'scarl', 'scrl', 'soc', 'societa', 'coop', 'cooperativa',
    'ditta', 'flli', 'lli', 'fratelli', 'di', 'de', 'del', 'della', 'dei', 'e', 'and', 'the', 'cash', 'carry', 'ingrosso',
    'group', 'gruppo', 'italia', 'it', 'unipersonale', 'semplificata',
]);

export function paroleNome(nome: string): string[] {
    return nome
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/s\.\s*r\.\s*l\.?|s\.\s*p\.\s*a\.?|s\.\s*n\.\s*c\.?|s\.\s*a\.\s*s\.?/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter(p => p.length >= 3 && !PAROLE_VUOTE.has(p));
}

export function fornitoreSimile<T extends { name: string }>(nomeFattura: string, fornitori: T[]): T | null {
    const parole = new Set(paroleNome(nomeFattura));
    let migliore: T | null = null;
    let punti = 0;
    for (const s of fornitori) {
        const sue = paroleNome(s.name);
        if (sue.length === 0) continue;
        const comuni = sue.filter(p => parole.has(p)).length;
        // Tutte le parole del fornitore in anagrafica devono stare nel nome
        // della fattura: «Mollo» sì, «Mollo Carni» no.
        if (comuni === sue.length && comuni > punti) {
            migliore = s;
            punti = comuni;
        }
    }
    return migliore;
}
