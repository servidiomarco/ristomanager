import { useCallback, useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Persist the dismissed version so the banner doesn't reappear on every mount
// while the user is deciding when to reload. When a newer version ships,
// dismissedVersion no longer matches remoteVersion and the banner returns.
const DISMISSED_KEY = 'ristomanager_dismissed_version';

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
 * Polls the server's build version and flags the UI when it diverges from the
 * one baked into the current bundle. Used by <AppVersionBanner /> to tell the
 * operator that a new deploy is live and they should reload to pick it up.
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
            const res = await fetch(`${API_URL}/version`, { cache: 'no-store' });
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
        window.addEventListener('focus', check);
        return () => {
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
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
        // If the service worker has a waiting version, activate it before
        // reloading — otherwise the user gets the same cached bundle back.
        // Failure is silent: worst case the SPA reloads without the SW swap,
        // still fetching the new bundle from network because we clear the
        // dismiss token so the banner would reappear if we ended up on the
        // old code.
        try { localStorage.removeItem(DISMISSED_KEY); } catch { /* ignore */ }
        (async () => {
            try {
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.getRegistration();
                    if (reg?.waiting) {
                        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                    }
                }
            } catch { /* best-effort */ }
            window.location.reload();
        })();
    }, []);

    return { currentVersion, remoteVersion, isOutdated, dismiss, reload };
}
