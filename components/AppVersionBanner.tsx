import React from 'react';
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

    if (!isOutdated) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed top-0 left-0 right-0 z-[60] bg-indigo-600 text-white shadow-md"
        >
            <div className="mx-auto max-w-6xl px-3 sm:px-4 py-2 flex items-center gap-3">
                <RefreshCw className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0 text-[13px] sm:text-sm">
                    <span className="font-semibold">Nuova versione disponibile.</span>
                    <span className="hidden sm:inline"> Aggiorna la pagina per applicare le ultime modifiche.</span>
                    {remoteVersion && (
                        <span className="ml-2 hidden md:inline text-[11px] font-mono text-white/70 tabular">
                            (v{remoteVersion})
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={reload}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-white text-indigo-700 text-[12px] font-semibold hover:bg-indigo-50 transition-colors whitespace-nowrap"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Ricarica
                </button>
                <button
                    type="button"
                    onClick={dismiss}
                    aria-label="Chiudi banner"
                    className="p-1 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
};
