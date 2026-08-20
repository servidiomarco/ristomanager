// Canali di risposta — per ogni fonte di prenotazione, con quale strumento
// rispondere all'ospite (richiesta, conferma, disdetta) e in che ordine.
//
// Il modello è una lista di priorità: il primo canale DISPONIBILE vince —
// disponibile vuol dire che l'ospite ha lasciato quel recapito e il provider
// è configurato. I canali spenti non si usano mai. "Email in copia" riproduce
// il comportamento storico (telefono + email in parallelo): l'email parte in
// aggiunta al canale scelto, quando c'è.
import React, { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown, Loader2, Save } from 'lucide-react';
import {
    getBookingChannelSettings,
    updateBookingChannelSettings,
    type BookingChannel,
    type BookingSource,
    type BookingChannelPolicyMap,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { dsButton, dsIconButton } from './ds';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const SOURCES: Array<{ source: BookingSource; label: string; hint: string }> = [
    { source: 'GOOGLE', label: 'Prenotazioni web', hint: 'dal form pubblico' },
    { source: 'VOICE', label: 'Agente vocale', hint: 'prenotate al telefono' },
    { source: 'WHATSAPP', label: 'WhatsApp', hint: 'nate in chat' },
    { source: 'MANUAL', label: 'Inserite a mano', hint: 'create dallo staff' },
];

const CHANNEL_LABEL: Record<BookingChannel, string> = {
    email: 'Email',
    whatsapp: 'WhatsApp',
    sms: 'SMS',
};

const ALL_CHANNELS: BookingChannel[] = ['email', 'whatsapp', 'sms'];

// Rappresentazione editabile: i tre canali sempre visibili, in ordine, con
// un interruttore. priority da salvare = i canali accesi nell'ordine mostrato.
interface SourceDraft {
    order: BookingChannel[];
    enabled: Record<BookingChannel, boolean>;
    email_copy: boolean;
}

const toDraft = (policy: { priority: BookingChannel[]; email_copy: boolean }): SourceDraft => {
    const order = [...policy.priority, ...ALL_CHANNELS.filter(c => !policy.priority.includes(c))];
    const enabled = {
        email: policy.priority.includes('email'),
        whatsapp: policy.priority.includes('whatsapp'),
        sms: policy.priority.includes('sms'),
    };
    return { order, enabled, email_copy: policy.email_copy };
};

const fromDraft = (draft: SourceDraft): { priority: BookingChannel[]; email_copy: boolean } => ({
    priority: draft.order.filter(c => draft.enabled[c]),
    email_copy: draft.email_copy,
});

export const BookingChannelsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [drafts, setDrafts] = useState<Record<BookingSource, SourceDraft> | null>(null);
    const [saved, setSaved] = useState<BookingChannelPolicyMap | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getBookingChannelSettings();
                if (cancelled) return;
                setSaved(data);
                setDrafts({
                    GOOGLE: toDraft(data.GOOGLE),
                    VOICE: toDraft(data.VOICE),
                    WHATSAPP: toDraft(data.WHATSAPP),
                    MANUAL: toDraft(data.MANUAL),
                });
            } catch (err: any) {
                if (!cancelled) showToast(err?.message || 'Errore nel caricamento dei canali', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [showToast]);

    const move = (source: BookingSource, index: number, delta: -1 | 1) => {
        setDrafts(prev => {
            if (!prev) return prev;
            const order = [...prev[source].order];
            const j = index + delta;
            if (j < 0 || j >= order.length) return prev;
            [order[index], order[j]] = [order[j], order[index]];
            return { ...prev, [source]: { ...prev[source], order } };
        });
    };

    const toggle = (source: BookingSource, channel: BookingChannel) => {
        setDrafts(prev => {
            if (!prev) return prev;
            const enabled = { ...prev[source].enabled, [channel]: !prev[source].enabled[channel] };
            return { ...prev, [source]: { ...prev[source], enabled } };
        });
    };

    const toggleEmailCopy = (source: BookingSource) => {
        setDrafts(prev => prev
            ? { ...prev, [source]: { ...prev[source], email_copy: !prev[source].email_copy } }
            : prev);
    };

    const dirty = !!drafts && !!saved && SOURCES.some(({ source }) => {
        const next = fromDraft(drafts[source]);
        const cur = saved[source];
        return next.email_copy !== cur.email_copy
            || next.priority.length !== cur.priority.length
            || next.priority.some((c, i) => cur.priority[i] !== c);
    });

    const invalidSources = drafts
        ? SOURCES.filter(({ source }) => fromDraft(drafts[source]).priority.length === 0)
        : [];

    const handleSave = async () => {
        if (!drafts || invalidSources.length > 0) return;
        setSaving(true);
        try {
            const payload: BookingChannelPolicyMap = {
                GOOGLE: fromDraft(drafts.GOOGLE),
                VOICE: fromDraft(drafts.VOICE),
                WHATSAPP: fromDraft(drafts.WHATSAPP),
                MANUAL: fromDraft(drafts.MANUAL),
            };
            const next = await updateBookingChannelSettings(payload);
            setSaved(next);
            showToast('Canali di risposta salvati', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Salvataggio non riuscito', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-4 text-[14px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Caricamento…
            </div>
        );
    }
    if (!drafts) return null;

    return (
        <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
                {SOURCES.map(({ source, label, hint }) => {
                    const draft = drafts[source];
                    const activeCount = draft.order.filter(c => draft.enabled[c]).length;
                    return (
                        <section key={source} className="rounded-[16px] bg-[var(--ds-surface-row)] p-4">
                            <div className="mb-3 flex items-baseline justify-between gap-2">
                                <h4 className="text-[14px] font-semibold text-[var(--ds-text-primary)]">{label}</h4>
                                <span className="text-[12px] text-[var(--ds-text-muted)]">{hint}</span>
                            </div>
                            <ol className="space-y-1.5">
                                {draft.order.map((channel, i) => {
                                    const on = draft.enabled[channel];
                                    // Numero d'ordine solo tra i canali accesi: è la
                                    // priorità reale, non la posizione in lista.
                                    const rank = on ? draft.order.slice(0, i + 1).filter(c => draft.enabled[c]).length : null;
                                    return (
                                        <li key={channel} className={`flex items-center gap-2 rounded-[12px] bg-[var(--ds-surface)] px-3 py-2 ${on ? '' : 'opacity-55'}`}>
                                            <span className="w-5 text-center text-[12px] font-semibold tabular-nums text-[var(--ds-text-muted)]" aria-hidden>
                                                {rank ?? '—'}
                                            </span>
                                            <span className="flex-1 text-[14px] text-[var(--ds-text-primary)]">{CHANNEL_LABEL[channel]}</span>
                                            {canEdit && (
                                                <>
                                                    <button type="button" className={dsIconButton} onClick={() => move(source, i, -1)} disabled={i === 0} aria-label={`${CHANNEL_LABEL[channel]} più in alto`}>
                                                        <ChevronUp className="h-4 w-4" aria-hidden />
                                                    </button>
                                                    <button type="button" className={dsIconButton} onClick={() => move(source, i, 1)} disabled={i === draft.order.length - 1} aria-label={`${CHANNEL_LABEL[channel]} più in basso`}>
                                                        <ChevronDown className="h-4 w-4" aria-hidden />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        role="switch"
                                                        aria-checked={on}
                                                        aria-label={`${CHANNEL_LABEL[channel]} ${on ? 'attivo' : 'spento'}`}
                                                        onClick={() => toggle(source, channel)}
                                                        disabled={on && activeCount === 1}
                                                        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${on ? 'bg-[var(--ds-action-bg)]' : 'bg-[var(--ds-border)]'}`}
                                                    >
                                                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#ffffff] shadow transition-[left] ${on ? 'left-[22px]' : 'left-0.5'}`} aria-hidden />
                                                    </button>
                                                </>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                            <label className={`mt-3 flex min-h-[44px] items-center gap-2.5 text-[13px] text-[var(--ds-text-secondary)] ${canEdit ? 'cursor-pointer' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={draft.email_copy}
                                    onChange={() => toggleEmailCopy(source)}
                                    disabled={!canEdit}
                                    className="h-4 w-4 accent-[var(--ds-action-bg)]"
                                />
                                Email sempre in copia, quando c'è
                            </label>
                        </section>
                    );
                })}
            </div>
            <p className="text-[13px] leading-snug text-[var(--ds-text-muted)]">
                Vince il primo canale disponibile: recapito lasciato dall'ospite e provider configurato.
                Se l'invio fallisce si passa al successivo.
            </p>
            {canEdit && (
                <div className="flex items-center justify-end gap-3">
                    {invalidSources.length > 0 && (
                        <span className="text-[13px] text-[var(--ds-critical-text)]">
                            Serve almeno un canale per ogni fonte.
                        </span>
                    )}
                    <button
                        type="button"
                        className={dsButton.primary}
                        onClick={handleSave}
                        disabled={!dirty || saving || invalidSources.length > 0}
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                        Salva
                    </button>
                </div>
            )}
        </div>
    );
};
