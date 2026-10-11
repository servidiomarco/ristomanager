import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, Globe, Loader2, MessageCircle } from 'lucide-react';
import {
    getFeatureFlags,
    FeatureFlags,
    getChannelSettings,
    updateChannelSettings,
    ChannelSettings,
    ScheduledSuspension,
    PublicBookingBlock,
} from '../services/apiService';
import { getWhatsAppStatus, getAgentPolicy } from '../services/whatsappApiService';
import { useAuth } from '../contexts/AuthContext';

// Full-shift time windows in Europe/Rome. Mirror the LUNCH_SLOTS/DINNER_SLOTS
// grid used everywhere else; a click on the voice icon books a suspension
// covering the whole service window on the selected date. Exported: the
// Settings suspension rows offer the same Pranzo/Cena shortcut, and the two
// UIs must agree on what "a shift" means to recognize each other's entries.
export const SHIFT_WINDOWS: Record<'LUNCH' | 'DINNER', { start: string; end: string }> = {
    LUNCH: { start: '12:30', end: '14:30' },
    DINNER: { start: '19:30', end: '23:30' },
};

interface Props {
    date: string;                       // YYYY-MM-DD (Europe/Rome)
    shift: 'LUNCH' | 'DINNER';          // 'ALL' non è supportato — la barra
                                        //  è nascosta in quel caso
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Compact status widget: two icons in the header showing whether Voice and
// Web bookings are open right now for the selected (date, shift), plus
// WhatsApp when the venue has it connected (status only, with «a»/«m»). Click
// toggles by adding/removing the corresponding scheduled entry — so a change
// made from here shows up verbatim in Settings → Prenotazioni web (or
// Agente vocale), and vice versa. Requires `settings:full` to be editable;
// read-only for other roles.
export const BookingChannelsBar: React.FC<Props> = ({ date, shift, showToast }) => {
  const { t } = useTranslation('canali', { useSuspense: false });
    const { hasPermission, hasFeature } = useAuth();
    const canEdit = hasPermission('settings:full');
    // WhatsApp: solo se il locale ha il modulo e chi guarda può leggerne le
    // impostazioni (le due rotte chiedono settings:view).
    const canSeeWhatsApp = hasFeature('whatsapp') && hasPermission('settings:view');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [channels, setChannels] = useState<ChannelSettings | null>(null);
    const [savingKey, setSavingKey] = useState<'voice' | 'web' | null>(null);
    // null = non si mostra (modulo assente, numero non collegato, errore).
    // auto: l'agente prenota da solo («Azioni» con la creazione accesa);
    // altrimenti le prenotazioni in chat le fa lo staff.
    const [whatsapp, setWhatsapp] = useState<{ auto: boolean } | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [f, c] = await Promise.all([getFeatureFlags(), getChannelSettings()]);
            setFlags(f);
            setChannels(c);
        } catch {
            // Silent — the header just doesn't render the icons on failure.
        }
    }, []);

    // Re-fetch whenever the selected day/shift changes so the color reflects
    // the effective state for what the user is looking at right now.
    useEffect(() => { refresh(); }, [refresh, date, shift]);

    // WhatsApp non ha sospensioni per turno: si legge una volta.
    useEffect(() => {
        if (!canSeeWhatsApp) { setWhatsapp(null); return; }
        let alive = true;
        Promise.all([getWhatsAppStatus(), getAgentPolicy()])
            .then(([status, settings]) => {
                if (!alive) return;
                if (!status.connected) { setWhatsapp(null); return; }
                const agent = settings.agent;
                setWhatsapp({ auto: agent?.mode === 'actions' && agent.auto_actions?.create !== false });
            })
            .catch(() => { if (alive) setWhatsapp(null); });
        return () => { alive = false; };
    }, [canSeeWhatsApp]);

    if (!flags || !channels) return null;

    const shiftWindow = SHIFT_WINDOWS[shift];

    // Voice state — booleans layered from most-general to most-specific.
    const voiceGloballyOff = !flags.voice_agent_enabled || flags.voice_bookings_suspended;
    const voiceShiftSuspensions = (channels.voice_bookings_suspension_schedule || []).filter(e =>
        e.date === date && !(e.end_time <= shiftWindow.start || e.start_time >= shiftWindow.end)
    );
    const voiceShiftBlocked = voiceShiftSuspensions.length > 0;
    const voiceOpen = !voiceGloballyOff && !voiceShiftBlocked;

    // Web state
    const webGloballyOff = !flags.public_bookings_enabled;
    const webDayBlockedAll = (channels.public_bookings_blocks || []).some(b => b.date === date && b.shift === 'ALL');
    const webShiftBlocked = (channels.public_bookings_blocks || []).some(b => b.date === date && b.shift === shift);
    const webBlocked = webDayBlockedAll || webShiftBlocked;
    const webOpen = !webGloballyOff && !webBlocked;

    const toggleVoice = async () => {
        if (!canEdit || voiceGloballyOff || savingKey) return;
        setSavingKey('voice');
        try {
            const schedule = channels.voice_bookings_suspension_schedule || [];
            let updated: ScheduledSuspension[];
            if (voiceShiftBlocked) {
                // Rimuove tutte le entry che intersecano il turno su questa
                // data — comprese eventuali finestre parziali. Aggressivo
                // ma coerente con "riattiva il turno".
                updated = schedule.filter(e => !(e.date === date && !(e.end_time <= shiftWindow.start || e.start_time >= shiftWindow.end)));
            } else {
                updated = [...schedule, { date, start_time: shiftWindow.start, end_time: shiftWindow.end }];
            }
            const res = await updateChannelSettings({ voice_bookings_suspension_schedule: updated });
            setChannels(res);
            showToast(voiceShiftBlocked ? t('bar.voiceResumed', 'Agente vocale riattivato per questo turno') : t('bar.voicePaused', 'Agente vocale sospeso per questo turno'), 'success');
        } catch (err: any) {
            showToast(err?.message || t('bar.errVoice', 'Errore aggiornamento agente vocale'), 'error');
        } finally {
            setSavingKey(null);
        }
    };

    const toggleWeb = async () => {
        if (!canEdit || webGloballyOff || savingKey) return;
        // Un blocco intera-giornata sovrasta il concetto di turno — non è
        // rimovibile da qui perché rimuoverlo aprirebbe anche l'altro turno,
        // decisione da prendere in Impostazioni con contesto pieno.
        if (webDayBlockedAll) {
            showToast("Questo giorno ha un blocco per l'intera giornata — modifica in Impostazioni", 'info');
            return;
        }
        setSavingKey('web');
        try {
            const blocks = channels.public_bookings_blocks || [];
            let updated: PublicBookingBlock[];
            if (webShiftBlocked) {
                updated = blocks.filter(b => !(b.date === date && b.shift === shift));
            } else {
                updated = [...blocks, { date, shift }];
            }
            const res = await updateChannelSettings({ public_bookings_blocks: updated });
            setChannels(res);
            showToast(webShiftBlocked ? t('bar.webResumed', 'Prenotazioni web riattivate per questo turno') : t('bar.webPaused', 'Prenotazioni web sospese per questo turno'), 'success');
        } catch (err: any) {
            showToast(err?.message || t('bar.errWeb', 'Errore aggiornamento prenotazioni web'), 'error');
        } finally {
            setSavingKey(null);
        }
    };

    // Styling shared da entrambi gli icon-button. `globallyOff` disables
    // interactivity and applies a muted look — l'unico modo di riabilitare
    // è cambiare il flag globale da Impostazioni.
    const iconClass = (open: boolean, globallyOff: boolean, saving: boolean) =>
        `inline-flex items-center justify-center h-9 w-9 rounded-[var(--ds-radius-control)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
            globallyOff
                ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-subtle)] opacity-60'
                : open
                    ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:brightness-95'
                    : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] hover:brightness-95'
        } ${canEdit && !globallyOff && !saving ? 'cursor-pointer' : 'cursor-default'} disabled:cursor-not-allowed`;

    return (
        <div className="flex items-center gap-1.5">
            <button
                type="button"
                onClick={toggleVoice}
                disabled={!canEdit || voiceGloballyOff || savingKey === 'voice'}
                className={iconClass(voiceOpen, voiceGloballyOff, savingKey === 'voice')}
                title={
                    voiceGloballyOff
                        ? "Agente vocale disattivato globalmente — riattiva da Impostazioni → Canali di prenotazione"
                        : voiceOpen
                            ? t('bar.voiceOnTitle', 'Agente vocale attivo per questo turno · click per sospendere')
                            : t('bar.voiceOffTitle', 'Agente vocale sospeso per questo turno · click per riattivare')
                }
                aria-label={t('bar.voiceAria', 'Stato agente vocale per questo turno')}
            >
                {savingKey === 'voice' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
            </button>
            <button
                type="button"
                onClick={toggleWeb}
                disabled={!canEdit || webGloballyOff || savingKey === 'web'}
                className={iconClass(webOpen, webGloballyOff, savingKey === 'web')}
                title={
                    webGloballyOff
                        ? "Prenotazioni web disattivate globalmente — riattiva da Impostazioni → Canali di prenotazione"
                        : webDayBlockedAll
                            ? "Bloccato per intera giornata — modifica in Impostazioni"
                            : webOpen
                                ? t('bar.webOnTitle', 'Prenotazioni web attive per questo turno · click per bloccare')
                                : t('bar.webOffTitle', 'Prenotazioni web bloccate per questo turno · click per sbloccare')
                }
                aria-label={t('bar.webAria', 'Stato prenotazioni web per questo turno')}
            >
                {savingKey === 'web' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            </button>
            {whatsapp && (
                // Solo stato, non un interruttore: la modalità dell'agente vale
                // per tutti i turni e si cambia in Impostazioni › WhatsApp.
                // «a» automatica (l'agente prenota da solo), «m» manuale (lo
                // staff). Minuscole come chiesto, e come vuole il §5.2.
                <span
                    role="img"
                    className="relative inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]"
                    title={whatsapp.auto
                        ? t('bar.waAutoTitle', 'WhatsApp · l\'agente prenota da solo (a) — si cambia in Impostazioni › WhatsApp')
                        : t('bar.waManualTitle', 'WhatsApp · le prenotazioni le fa lo staff (m) — si cambia in Impostazioni › WhatsApp')}
                    aria-label={whatsapp.auto
                        ? t('bar.waAutoAria', 'WhatsApp attivo, prenotazioni automatiche')
                        : t('bar.waManualAria', 'WhatsApp attivo, prenotazioni manuali')}
                >
                    <MessageCircle className="h-4 w-4" aria-hidden />
                    <span
                        aria-hidden
                        className={`absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-[var(--ds-radius-control)] px-1 text-[10px] font-semibold leading-none ring-2 ring-[var(--ds-surface)] ${
                            whatsapp.auto
                                ? 'bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)]'
                                : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
                        }`}
                    >
                        {whatsapp.auto ? 'a' : 'm'}
                    </span>
                </span>
            )}
        </div>
    );
};
