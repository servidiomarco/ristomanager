// Stato "dati fermi" della modalità ibrida, per gli schermi di servizio.
//
// Quando il nodo di sala serve una copia perché il cloud non risponde, la
// risposta porta X-Sala-Node: stale e apiRouting lo propaga con un evento
// globale (nessuna firma cambiata nei servizi). Lo schermo resta VIVO — è il
// punto della tappa 3 — ma la sala deve sapere di essere in modalità isola,
// non scoprirlo dai WhatsApp che non partono: da qui il banner con l'ora
// dell'ultima copia buona.

import { useEffect, useState } from 'react';

export interface SalaNodeStaleState {
    stale: boolean;
    /** Istante dell'ultima copia buona (ora - età dichiarata dal nodo). */
    asOf: Date | null;
}

export function useSalaNodeStale(): SalaNodeStaleState {
    const [state, setState] = useState<SalaNodeStaleState>({ stale: false, asOf: null });

    useEffect(() => {
        const onStale = (e: Event) => {
            const age = (e as CustomEvent).detail?.ageSeconds;
            setState({
                stale: true,
                asOf: Number.isFinite(age) ? new Date(Date.now() - age * 1000) : null,
            });
        };
        const onFresh = () => setState({ stale: false, asOf: null });
        window.addEventListener('sala-node:stale', onStale);
        window.addEventListener('sala-node:fresh', onFresh);
        return () => {
            window.removeEventListener('sala-node:stale', onStale);
            window.removeEventListener('sala-node:fresh', onFresh);
        };
    }, []);

    return state;
}

export const formatStaleAsOf = (asOf: Date | null): string =>
    asOf
        ? asOf.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
        : '';
