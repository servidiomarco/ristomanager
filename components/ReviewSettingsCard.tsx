import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, Loader2, ChevronDown, ExternalLink } from 'lucide-react';
import {
    getReviewSettings, updateReviewSettings,
    type ReviewSettings, type ReviewRequestTiming, type ReviewRequestAudience, type ReviewReplyAutomation,
} from '../services/reviewsApiService';
import { useAuth } from '../contexts/AuthContext';

/* ── Recensioni ───────────────────────────────────────────────────────────
   L'interruttore della richiesta post-visita e le sue regole in una card
   sola: quando parte, a chi si manda, e il Place ID del profilo Google da
   cui nasce il link «scrivi una recensione». Il livello di automazione
   delle risposte si sceglie già da qui; diventa operativo con il profilo
   Google collegato (Fase B del piano recensioni). */

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/* Le opzioni portano la chiave e l'italiano: sono costanti di modulo, non
   possono chiamare hook, e il testo si risolve al render. */
const TIMING_OPTIONS: Array<{ value: ReviewRequestTiming; labelKey: string; label: string }> = [
    { value: 'next_morning', labelKey: 'rev.timing.nextMorning', label: 'La mattina dopo (10:30)' },
    { value: 'delay', labelKey: 'rev.timing.delay', label: 'Qualche ora dopo la visita' },
    { value: 'immediate', labelKey: 'rev.timing.immediate', label: 'Appena il tavolo si libera' },
];

const AUDIENCE_OPTIONS: Array<{ value: ReviewRequestAudience; labelKey: string; label: string; hintKey: string; hint: string }> = [
    { value: 'consent', labelKey: 'rev.audience.consent', label: 'Solo chi ha dato il consenso marketing', hintKey: 'rev.audience.consentHint', hint: 'La scelta prudente: si scrive solo a chi ha la spunta consenso sulla prenotazione o in rubrica.' },
    { value: 'all', labelKey: 'rev.audience.all', label: 'Tutti i clienti con un recapito', hintKey: 'rev.audience.allHint', hint: 'Trattata come comunicazione di servizio post-visita: più volume, la responsabilità della scelta è tua.' },
];

const AUTOMATION_OPTIONS: Array<{ value: ReviewReplyAutomation; labelKey: string; label: string; requiresGoogle: boolean }> = [
    { value: 'off', labelKey: 'rev.auto.off', label: 'Nessuna risposta', requiresGoogle: false },
    { value: 'draft', labelKey: 'rev.auto.draft', label: 'Bozza con approvazione', requiresGoogle: true },
    { value: 'auto_positive', labelKey: 'rev.auto.autoPositive', label: 'Automatica solo per le positive (4–5 stelle)', requiresGoogle: true },
    { value: 'auto_all', labelKey: 'rev.auto.autoAll', label: 'Completamente automatica', requiresGoogle: true },
];

const selectClass = 'w-full text-[13px] rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 py-2 disabled:opacity-50 disabled:cursor-not-allowed';

export const ReviewSettingsCard: React.FC<Props> = ({ showToast }) => {
    const { t } = useTranslation('canali', { useSuspense: false });
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('reviews:manage');

    const [settings, setSettings] = useState<ReviewSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [placeIdDraft, setPlaceIdDraft] = useState('');

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const s = await getReviewSettings();
                if (cancelled) return;
                setSettings(s);
                setPlaceIdDraft(s.google_place_id || '');
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || t('rev.err.load', 'Errore nel caricamento'), 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
        if (saving) return;
        setSaving(true);
        try {
            await fn();
            if (okMsg) showToast(okMsg, 'success');
        } catch (err: any) {
            showToast(err?.message || t('rev.err.operation', 'Operazione non riuscita'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const save = (input: Partial<ReviewSettings>, okMsg?: string) => act(async () => {
        const updated = await updateReviewSettings(input);
        setSettings(updated);
        setPlaceIdDraft(updated.google_place_id || '');
    }, okMsg);

    if (loading) {
        return (
            <div className="bg-[var(--ds-surface)] rounded-[var(--ds-radius)] border border-[var(--ds-border)] px-4 py-3 flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('rev.loading', 'Caricamento…')}
            </div>
        );
    }
    if (!settings) return null;

    const enabled = settings.review_requests_enabled;
    const missingPlaceId = !settings.google_place_id;
    const previewUrl = settings.google_place_id
        ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(settings.google_place_id)}`
        : null;
    const placeIdDirty = placeIdDraft.trim() !== (settings.google_place_id || '');

    return (
        <details className="group bg-[var(--ds-surface)] rounded-[var(--ds-radius)] shadow-[var(--ds-shadow-card)] overflow-hidden">
            <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--ds-surface-row)] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-secondary)] flex-shrink-0">
                        <Star className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--ds-text-primary)]">{t('rev.title', 'Richiesta di recensione')}</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                            {t('rev.subtitle', 'Dopo la visita, il cliente riceve il link per recensire su Google.')}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[12px] font-medium ${enabled ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                        {enabled ? t('rev.on', 'Attiva') : t('rev.off', 'Disattivata')}
                    </span>
                    <button
                        type="button" role="switch" aria-checked={enabled}
                        aria-label={t('rev.toggleAria', '{{azione}} richiesta di recensione', { azione: enabled ? t('rev.switchOff', 'Disattiva') : t('rev.switchOn', 'Attiva') })}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); if (canEdit) save({ review_requests_enabled: !enabled }, !enabled ? t('rev.toastOn', 'Richiesta di recensione attiva') : t('rev.toastOff', 'Richiesta di recensione disattivata')); }}
                        disabled={!canEdit || saving}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
                            enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                        }`}
                    >
                        <span aria-hidden="true"
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
                    </button>
                    <ChevronDown className="w-4 h-4 text-[var(--ds-text-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </div>
            </summary>

            <div className="border-t border-[var(--ds-border)] px-4 py-4 space-y-5">
                <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] border border-[var(--ds-border)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                    {t('rev.hint', 'Il messaggio parte da solo sui canali della prenotazione (WhatsApp, SMS o email), sempre tra le 10 e le 21, al massimo una volta ogni 60 giorni per lo stesso numero.')}
                </div>

                {enabled && missingPlaceId && (
                    <p className="rounded-[var(--ds-radius)] bg-[var(--ds-pending-tint)] px-3 py-2 text-[13px] text-[var(--ds-pending-text)]">
                        {t('rev.missingPlaceId', 'La funzione è attiva ma manca il Place ID del profilo Google: senza, il link non esiste e non parte nulla.')}
                    </p>
                )}

                <section className="space-y-1.5">
                    <h5 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('rev.whenToSend', 'Quando inviare')}</h5>
                    <select
                        value={settings.timing}
                        disabled={!canEdit || saving}
                        onChange={e => save({ timing: e.target.value as ReviewRequestTiming }, t('rev.timingSaved', 'Orario di invio aggiornato'))}
                        className={selectClass}
                    >
                        {TIMING_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey, o.label)}</option>)}
                    </select>
                    {settings.timing === 'delay' && (
                        <label className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                            {t('rev.waitFor', 'Attesa di')}
                            <input
                                type="number" min={1} max={24}
                                defaultValue={settings.delay_hours}
                                disabled={!canEdit || saving}
                                onBlur={e => {
                                    const n = Math.trunc(Number(e.target.value));
                                    if (Number.isFinite(n) && n >= 1 && n <= 24 && n !== settings.delay_hours) {
                                        save({ delay_hours: n }, t('rev.waitSaved', 'Attesa aggiornata'));
                                    }
                                }}
                                className="w-16 text-[13px] rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1.5 disabled:opacity-50"
                            />
                            {t('rev.hoursAfterVisit', 'ore dalla fine della visita')}
                        </label>
                    )}
                </section>

                <section className="space-y-1.5">
                    <h5 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('rev.whoToSend', 'A chi inviare')}</h5>
                    <select
                        value={settings.audience}
                        disabled={!canEdit || saving}
                        onChange={e => save({ audience: e.target.value as ReviewRequestAudience }, t('rev.audienceSaved', 'Destinatari aggiornati'))}
                        className={selectClass}
                    >
                        {AUDIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey, o.label)}</option>)}
                    </select>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {(() => {
                            const o = AUDIENCE_OPTIONS.find(x => x.value === settings.audience);
                            return o ? t(o.hintKey, o.hint) : null;
                        })()}
                    </p>
                </section>

                <section className="space-y-1.5">
                    <h5 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('rev.googleProfile', 'Profilo Google')}</h5>
                    <div className="flex gap-2">
                        <input
                            value={placeIdDraft}
                            onChange={e => setPlaceIdDraft(e.target.value)}
                            placeholder={t('rev.placeIdPlaceholder', 'Place ID (es. ChIJ…)')}
                            disabled={!canEdit || saving}
                            className="flex-1 min-w-0 text-[13px] font-mono rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 py-2 disabled:opacity-50"
                        />
                        {canEdit && (
                            <button
                                type="button"
                                disabled={saving || !placeIdDirty}
                                onClick={() => save({ google_place_id: placeIdDraft.trim() || null }, t('rev.placeIdSaved', 'Place ID salvato'))}
                                className="text-[13px] px-3 py-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-border)] disabled:opacity-50 flex-shrink-0"
                            >
                                {t('rev.save', 'Salva')}
                            </button>
                        )}
                    </div>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {t('rev.placeIdHint', 'Si trova con il Place ID Finder di Google cercando il nome del ristorante.')}
                        {previewUrl && (
                            <>
                                {' '}
                                <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--ds-text-secondary)] underline underline-offset-2">
                                    {t('rev.tryLink', 'Prova il link recensione')} <ExternalLink size={11} aria-hidden />
                                </a>
                            </>
                        )}
                    </p>
                </section>

                <section className="space-y-1.5">
                    <h5 className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('rev.replies', 'Risposte alle recensioni')}</h5>
                    <select
                        value={settings.reply_automation}
                        disabled={!canEdit || saving}
                        onChange={e => save({ reply_automation: e.target.value as ReviewReplyAutomation }, t('rev.repliesSaved', 'Risposte alle recensioni aggiornate'))}
                        className={selectClass}
                    >
                        {AUTOMATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey, o.label)}</option>)}
                    </select>
                    <p className="text-[12px] text-[var(--ds-text-muted)]">
                        {t('rev.repliesHint', "Diventa operativo quando il profilo Google è collegato: le recensioni arriveranno nella pagina Recensioni e l'AI preparerà le risposte secondo questa scelta.")}
                    </p>
                </section>
            </div>
        </details>
    );
};
