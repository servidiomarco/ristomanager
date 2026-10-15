import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { SettingsStatus, SettingsSummary, SettingsSwitch, settingsCardClass } from './SettingsCard';

export const PushNotificationsCard: React.FC = () => {
    const { t } = useTranslation('impostazioni', { useSuspense: false });
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
                addToast(t('push.off', 'Notifiche push disattivate.'), 'info');
            } else {
                await enablePushNotifications();
                setEnabled(true);
                setPermission(getNotificationPermission());
                addToast(t('push.on', 'Notifiche push attivate.'), 'success');
            }
        } catch (err: any) {
            addToast(err?.message || t('push.errToggle', 'Operazione fallita'), 'error');
            setPermission(getNotificationPermission());
        } finally {
            setBusy(false);
        }
    };

    const handleTest = async () => {
        setBusy(true);
        try {
            await sendTestPush();
            addToast(t('push.testSent', 'Notifica di test inviata.'), 'success');
        } catch (err: any) {
            addToast(err?.message || t('push.errTest', 'Invio fallito'), 'error');
        } finally {
            setBusy(false);
        }
    };

    const isStandalone = typeof window !== 'undefined'
        && (window.matchMedia('(display-mode: standalone)').matches
            || (window.navigator as any).standalone === true);
    const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
    const iosPwaWarning = isIOS && !isStandalone;

    // In testata l'interruttore; quando il browser non le permette, al suo
    // posto il perché in una parola, e dentro la card la spiegazione.
    const blocked = supported && permission === 'denied';

    return (
        // Una card della griglia di Impostazioni → Profilo, chiusa con la
        // rotella come le vicine.
        <details className={settingsCardClass}>
            <SettingsSummary
                icon={enabled ? Bell : BellOff}
                tone={enabled ? 'positive' : 'neutral'}
                title={t('push.title', 'Notifiche push')}
                description={t('push.subtitle', 'Ricevi avvisi su questo dispositivo per nuove prenotazioni e todo assegnati.')}
                trailing={
                    !supported ? <SettingsStatus>{t('push.statusUnsupported', 'Non supportate')}</SettingsStatus>
                    : blocked ? <SettingsStatus tone="pending">{t('push.statusDenied', 'Bloccate')}</SettingsStatus>
                    : (
                        <span className="flex items-center gap-2">
                            {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
                            <SettingsSwitch
                                checked={enabled}
                                onChange={handleToggle}
                                disabled={busy}
                                label={t('push.title', 'Notifiche push')}
                            />
                        </span>
                    )
                }
            />
            <div className="space-y-3 border-t border-[var(--ds-border)] px-4 pb-4 pt-3">
                <p className="text-[13px] leading-snug text-[var(--ds-text-muted)]">
                    {t('push.perDevice', 'Valgono solo per questo dispositivo: su ogni telefono o computer si accendono a parte.')}
                </p>

                {!supported && (
                    <p className="text-xs text-[var(--ds-critical-text)] bg-[var(--ds-critical-tint)] border border-[var(--ds-critical-solid)] rounded-[var(--ds-radius)] px-2.5 py-1.5">
                        {t('push.unsupported', 'Il tuo browser non supporta le notifiche push.')}
                    </p>
                )}

                {blocked && (
                    <p className="text-xs text-[var(--ds-pending-text)] bg-[var(--ds-pending-tint)] border border-[var(--ds-pending-solid)] rounded-[var(--ds-radius)] px-2.5 py-1.5">
                        {t('push.denied', 'Permesso notifiche negato. Per attivarle modifica le impostazioni del browser per questo sito.')}
                    </p>
                )}

                {iosPwaWarning && (
                    <p className="text-xs text-[var(--ds-text-muted)] bg-[var(--ds-surface-row)] border border-[var(--ds-border)] rounded-[var(--ds-radius)] px-2.5 py-1.5">
                        {t('push.ios', 'Su iPhone/iPad le notifiche push richiedono iOS 16.4+ e che l\'app sia installata sulla schermata Home (Safari → Condividi → "Aggiungi alla schermata Home").')}
                    </p>
                )}

                {enabled && (
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={handleTest}
                            disabled={busy}
                            className="text-xs font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                        >
                            {t('push.sendTest', 'Invia notifica di test')}
                        </button>
                    </div>
                )}
            </div>
        </details>
    );
};
