import React, { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useAppVersion } from '../hooks/useAppVersion';

// Fixed banner that appears at the top of the app when the running bundle is
// older than the version the server is currently serving. Dismissible per
// version — dismissing shelves the banner until an even newer deploy lands,
// so an operator mid-service can finish the task and reload when convenient.
//
// Sits above every view (z-index 60) but below toast overlays and modals so
// urgent dialogs still win visually. Height stays small (~40px) to avoid
// stealing screen real-estate from the working area.
export const AppVersionBanner: React.FC = () => {
    const { isOutdated, remoteVersion, dismiss, reload } = useAppVersion();
    // Feedback state for the "Ricarica" button: without it the click looks
    // unresponsive for the ~1s SW skipWaiting → location.reload() window.
    // Flipping to true spins the icon and disables the button; we then let
    // the browser paint once (rAF) before invoking reload, otherwise the
    // page navigates before the spinner has a chance to render.
    const [isReloading, setIsReloading] = useState(false);

    if (!isOutdated) return null;

    const handleReload = () => {
        if (isReloading) return;
        setIsReloading(true);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                reload();
            });
        });
    };

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed top-0 left-0 right-0 z-[60] bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)] shadow-[var(--ds-shadow-card)]"
        >
            <div className="mx-auto max-w-6xl px-3 sm:px-4 py-2 flex items-center gap-3">
                <RefreshCw className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0 text-[13px] sm:text-sm">
                    <span className="font-semibold">Nuova versione disponibile.</span>
                    <span className="hidden sm:inline"> Aggiorna la pagina per applicare le ultime modifiche.</span>
                    {remoteVersion && (
                        <span className="ml-2 hidden md:inline text-[11px] font-mono opacity-70 tabular-nums">
                            (v{remoteVersion})
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleReload}
                    disabled={isReloading}
                    aria-live="polite"
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--ds-surface)] text-[var(--ds-arriving-text)] text-[12px] font-semibold hover:bg-[var(--ds-arriving-tint)] disabled:opacity-80 disabled:cursor-progress transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-surface)]"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isReloading ? 'animate-spin' : ''}`} />
                    {isReloading ? 'Ricarico…' : 'Ricarica'}
                </button>
                <button
                    type="button"
                    onClick={dismiss}
                    disabled={isReloading}
                    aria-label="Chiudi banner"
                    className="p-1 rounded-full text-[var(--ds-arriving-fg)] opacity-80 hover:opacity-100 hover:bg-[var(--ds-arriving-fg)]/10 disabled:opacity-50 transition-opacity flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-surface)]"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
};
