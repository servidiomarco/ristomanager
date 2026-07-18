import { useEffect, useRef } from 'react';

// Web App Badging API — MDN: navigator.setAppBadge / clearAppBadge.
// Requires the site to be installed as a PWA (add-to-home-screen o installa).
// Silenzioso su Safari macOS / Firefox: feature-detect + early return.

type BadgingNavigator = Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

// Guard against the API being unavailable OR failing at call time (e.g. the
// user hasn't granted the necessary permission on some platforms).
async function writeBadge(count: number): Promise<void> {
    const nav = navigator as BadgingNavigator;
    if (typeof nav.setAppBadge !== 'function') return;
    try {
        if (count > 0) {
            await nav.setAppBadge(count);
        } else if (typeof nav.clearAppBadge === 'function') {
            await nav.clearAppBadge();
        } else {
            await nav.setAppBadge(0);
        }
    } catch {
        // API present but call rejected — no fallback, badging is best-effort.
    }
}

/**
 * Aggiorna il badge sull'icona PWA in base al totale "cose da attenzionare".
 * Passa la somma di tutti gli indicatori che vuoi far comparire come singolo
 * numero — di solito prenotazioni PENDING + chiamate voice da ricontattare.
 *
 * Chiama clearAppBadge() automaticamente quando count torna a 0. Il valore
 * viene deduplicato via ref così setAppBadge non spara ogni render.
 */
export function useAppBadge(count: number): void {
    const lastRef = useRef<number | null>(null);
    useEffect(() => {
        const normalized = Math.max(0, Math.floor(count));
        if (lastRef.current === normalized) return;
        lastRef.current = normalized;
        void writeBadge(normalized);
    }, [count]);

    // Ripulisci il badge quando l'app viene smontata (logout, chiusura). Non
    // strettamente necessario — la maggior parte dei browser tiene il badge
    // ultimo — ma evita "numero fantasma" dopo un logout.
    useEffect(() => {
        return () => {
            void writeBadge(0);
        };
    }, []);
}
