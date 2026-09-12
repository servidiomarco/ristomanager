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
import { useToast } from '../contexts/ToastContext';

export const PushNotificationsCard: React.FC = () => {
    const [supported, setSupported] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
    const [busy, setBusy] = useState(false);
    const { addToast } = useToast();

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
        try {
            if (enabled) {
                await disablePushNotifications();
                setEnabled(false);
                addToast('Notifiche push disattivate.', 'info');
            } else {
                await enablePushNotifications();
                setEnabled(true);
                setPermission(getNotificationPermission());
                addToast('Notifiche push attivate.', 'success');
            }
        } catch (err: any) {
            addToast(err?.message || 'Operazione fallita', 'error');
            setPermission(getNotificationPermission());
        } finally {
            setBusy(false);
        }
    };

    const handleTest = async () => {
        setBusy(true);
        try {
            await sendTestPush();
            addToast('Notifica di test inviata.', 'success');
        } catch (err: any) {
            addToast(err?.message || 'Invio fallito', 'error');
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
        <section className="mb-6">
            <h3 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2 px-1">Notifiche</h3>
            <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-md bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0">
                            {enabled ? <Bell className="w-5 h-5 text-[var(--ds-text-primary)]" /> : <BellOff className="w-5 h-5 text-[var(--ds-text-primary)]" />}
                        </div>
                        <div className="min-w-0">
                            <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">Notifiche push</h4>
                            <p className="text-[13px] text-[var(--ds-text-muted)]">
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
                                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]'
                                : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                        {enabled ? 'Attive' : 'Attiva'}
                    </button>
                </div>

                {!supported && (
                    <p className="mt-3 text-xs text-[var(--ds-critical-text)] bg-[var(--ds-critical-tint)] border border-[var(--ds-critical-solid)] rounded-md px-2.5 py-1.5">
                        Il tuo browser non supporta le notifiche push.
                    </p>
                )}

                {supported && permission === 'denied' && (
                    <p className="mt-3 text-xs text-[var(--ds-pending-text)] bg-[var(--ds-pending-tint)] border border-[var(--ds-pending-solid)] rounded-md px-2.5 py-1.5">
                        Permesso notifiche negato. Per attivarle modifica le impostazioni del browser per questo sito.
                    </p>
                )}

                {iosPwaWarning && (
                    <p className="mt-3 text-xs text-[var(--ds-text-muted)] bg-[var(--ds-surface-row)] border border-[var(--ds-border)] rounded-md px-2.5 py-1.5">
                        Su iPhone/iPad le notifiche push richiedono iOS 16.4+ e che l'app sia installata sulla schermata Home (Safari → Condividi → "Aggiungi alla schermata Home").
                    </p>
                )}

                {enabled && (
                    <div className="mt-3 flex justify-end">
                        <button
                            type="button"
                            onClick={handleTest}
                            disabled={busy}
                            className="text-xs font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                        >
                            Invia notifica di test
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
};
