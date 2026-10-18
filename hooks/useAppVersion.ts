import { useCallback, useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Persist the dismissed version so the banner doesn't reappear on every mount
// while the user is deciding when to reload. When a newer version ships,
// dismissedVersion no longer matches remoteVersion and the banner returns.
const DISMISSED_KEY = 'ristomanager_dismissed_version';

// Quanto il «Ricarica» aspetta il SW nuovo: il precache scarica la shell
// intera, su una rete lenta ci mette qualche secondo. Oltre, si ricarica
// comunque — la navigazione passa dalla rete (pwa/sw.js, directoryIndex).
const SW_ACTIVATION_TIMEOUT_MS = 8000;

/** Si risolve quando il worker è attivo (o scartato), al più dopo timeoutMs.
 *  Il nostro sw.js chiama skipWaiting() già all'install; il messaggio vale
 *  per un worker rimasto in attesa. */
const untilActivated = (worker: ServiceWorker, timeoutMs: number): Promise<void> => new Promise(resolve => {
    const finished = () => worker.state === 'activated' || worker.state === 'redundant';
    if (finished()) { resolve(); return; }
    const done = () => {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        resolve();
    };
    const onChange = () => {
        if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
        if (finished()) done();
    };
    const timer = setTimeout(done, timeoutMs);
    worker.addEventListener('statechange', onChange);
    if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
});

interface AppVersionState {
    // The build baked into the running bundle. 'dev' means local Vite dev
    // server — banner is disabled in that case so it doesn't fire during HMR.
    currentVersion: string;
    // The build the server is currently serving. `null` while the first poll
    // is in flight (or if the network is offline).
    remoteVersion: string | null;
    // True when server version differs from current AND the user hasn't
    // dismissed the banner for that specific server version.
    isOutdated: boolean;
    // Explicit dismiss — persists in localStorage keyed by the version so a
    // fresh version brings the banner back.
    dismiss: () => void;
    // Force-reload — clears the SW's waiting worker (if any) and reloads.
    reload: () => void;
}

/**
 * Polls the deployed frontend's build version (version.json, same origin and
 * same atomic deploy as the bundle) and flags the UI when it diverges from
 * the one baked into the current bundle. Used by <AppVersionBanner /> to tell
 * the operator that a new deploy is live and a reload will pick it up.
 *
 * Poll cadence: every 5 minutes, plus on tab re-focus (visibilitychange) so
 * a PWA that woke up from background catches an overnight deploy immediately.
 */
export function useAppVersion(): AppVersionState {
    const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
    const [remoteVersion, setRemoteVersion] = useState<string | null>(null);
    const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
        try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
    });

    const check = useCallback(async () => {
        try {
            // version.json è emesso dalla build Vite accanto a index.html e
            // servito dalla STESSA origin del bundle (Vercel), nello stesso
            // deploy atomico. Non si interroga /version del backend Railway:
            // i due deploy non finiscono insieme, e nella finestra «Railway
            // nuovo, Vercel non ancora» il banner ricompariva subito dopo
            // ogni «Ricarica» — il reload non poteva che riscaricare il
            // bundle vecchio. Così invece il banner compare solo quando il
            // reload porterà davvero la versione nuova.
            const res = await fetch('/version.json', { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data.version === 'string') {
                setRemoteVersion(data.version);
            }
        } catch {
            // Network glitch — try again on the next tick.
        }
    }, []);

    useEffect(() => {
        // Never fire during local dev: the bundle is 'dev' but the server
        // may report a real SHA (or vice versa) causing false positives.
        if (currentVersion === 'dev') return;

        // Kick off the first poll immediately, then on interval + focus.
        check();
        const id = setInterval(check, POLL_INTERVAL_MS);
        const onVisible = () => {
            if (document.visibilityState === 'visible') check();
        };
        document.addEventListener('visibilitychange', onVisible);
        // pageshow: la PWA di iOS che riprende una pagina sospesa.
        window.addEventListener('pageshow', onVisible);
        window.addEventListener('focus', check);
        return () => {
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('pageshow', onVisible);
            window.removeEventListener('focus', check);
        };
    }, [currentVersion, check]);

    const isOutdated = currentVersion !== 'dev'
        && remoteVersion !== null
        && remoteVersion !== currentVersion
        && remoteVersion !== dismissedVersion;

    const dismiss = useCallback(() => {
        if (!remoteVersion) return;
        try { localStorage.setItem(DISMISSED_KEY, remoteVersion); } catch { /* private mode etc. */ }
        setDismissedVersion(remoteVersion);
    }, [remoteVersion]);

    const reload = useCallback(() => {
        // Activate the new service worker before reloading — otherwise the
        // user gets the same cached bundle back. Failure is silent: worst
        // case the SPA reloads without the SW swap, and since we clear the
        // dismiss token the banner reappears if we ended up on the old code.
        try { localStorage.removeItem(DISMISSED_KEY); } catch { /* ignore */ }
        (async () => {
            try {
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.getRegistration();
                    if (reg) {
                        // Chiedi subito al browser di scaricare l'eventuale
                        // sw.js nuovo: senza update() il check partirebbe
                        // solo con la navigazione stessa e il reload
                        // potrebbe ripartire col precache vecchio.
                        try { await reg.update(); } catch { /* offline ecc. */ }
                        // update() si risolve appena il SW nuovo comincia a
                        // installarsi, non quando ha finito: ricaricare lì
                        // lasciava la pagina al SW vecchio e alla sua shell,
                        // e il banner tornava a ogni clic finché il nuovo
                        // non era attivo (18/10). Si aspetta che lo sia.
                        const incoming = reg.installing ?? reg.waiting;
                        if (incoming) await untilActivated(incoming, SW_ACTIVATION_TIMEOUT_MS);
                    }
                }
            } catch { /* best-effort */ }
            window.location.reload();
        })();
    }, []);

    return { currentVersion, remoteVersion, isOutdated, dismiss, reload };
}
