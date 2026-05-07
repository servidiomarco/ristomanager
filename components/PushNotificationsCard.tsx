import React, { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import {
    isPushSupported,
    getNotificationPermission,
    getCurrentSubscription,
    enablePushNotifications,
    disablePushNotifications,
    sendTestPush,
} from '../services/pushClient';

export const PushNotificationsCard: React.FC = () => {
    const [supported, setSupported] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null);

    useEffect(() => {
        const ok = isPushSupported();
        setSupported(ok);
        setPermission(getNotificationPermission());
        if (ok) {
            getCurrentSubscription().then(sub => setEnabled(!!sub)).catch(() => setEnabled(false));
        }
    }, []);

    const handleToggle = async () => {
        if (!supported) return;
        setBusy(true);
        setFeedback(null);
        try {
            if (enabled) {
                await disablePushNotifications();
                setEnabled(false);
                setFeedback({ kind: 'info', message: 'Notifiche push disattivate.' });
            } else {
                await enablePushNotifications();
                setEnabled(true);
                setPermission(getNotificationPermission());
                setFeedback({ kind: 'success', message: 'Notifiche push attivate.' });
            }
        } catch (err: any) {
            setFeedback({ kind: 'error', message: err?.message || 'Operazione fallita' });
            setPermission(getNotificationPermission());
        } finally {
            setBusy(false);
        }
    };

    const handleTest = async () => {
        setBusy(true);
        setFeedback(null);
        try {
            await sendTestPush();
            setFeedback({ kind: 'success', message: 'Notifica di test inviata.' });
        } catch (err: any) {
            setFeedback({ kind: 'error', message: err?.message || 'Invio fallito' });
        } finally {
            setBusy(false);
        }
    };

    const isStandalone = typeof window !== 'undefined'
        && (window.matchMedia('(display-mode: standalone)').matches
            || (window.navigator as any).standalone === true);
    const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
    const iosPwaWarning = isIOS && !isStandalone;

    return (
        <div className="mb-8">
            <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Notifiche</h3>
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center flex-shrink-0">
                            {enabled ? <Bell className="w-5 h-5 text-[var(--color-fg)]" /> : <BellOff className="w-5 h-5 text-[var(--color-fg)]" />}
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Notifiche push</h4>
                            <p className="text-[13px] text-[var(--color-fg-muted)]">
                                Ricevi avvisi su questo dispositivo per nuove prenotazioni e todo assegnati.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleToggle}
                        disabled={!supported || busy || permission === 'denied'}
                        className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition flex-shrink-0 ${
                            enabled
                                ? 'bg-[var(--color-fg)] text-white border-[var(--color-fg)]'
                                : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                        {enabled ? 'Attive' : 'Attiva'}
                    </button>
                </div>

                {!supported && (
                    <p className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-md px-2.5 py-1.5">
                        Il tuo browser non supporta le notifiche push.
                    </p>
                )}

                {supported && permission === 'denied' && (
                    <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2.5 py-1.5">
                        Permesso notifiche negato. Per attivarle modifica le impostazioni del browser per questo sito.
                    </p>
                )}

                {iosPwaWarning && (
                    <p className="mt-3 text-xs text-[var(--color-fg-muted)] bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md px-2.5 py-1.5">
                        Su iPhone/iPad le notifiche push richiedono iOS 16.4+ e che l'app sia installata sulla schermata Home (Safari → Condividi → "Aggiungi alla schermata Home").
                    </p>
                )}

                {enabled && (
                    <div className="mt-3 flex justify-end">
                        <button
                            type="button"
                            onClick={handleTest}
                            disabled={busy}
                            className="text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
                        >
                            Invia notifica di test
                        </button>
                    </div>
                )}

                {feedback && (
                    <p className={`mt-3 text-xs rounded-md px-2.5 py-1.5 border ${
                        feedback.kind === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                        : feedback.kind === 'error' ? 'bg-rose-50 text-rose-700 border-rose-100'
                        : 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
                    }`}>
                        {feedback.message}
                    </p>
                )}
            </div>
        </div>
    );
};
