import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout, StatusPill } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import {
  getWhatsAppSettings, saveWhatsAppSettings, getWhatsAppTemplates,
  type RemindersPolicy, type WhatsAppTemplateRow,
} from '../../services/whatsappApiService';

/* ── Promemoria con tasti ─────────────────────────────────────────────────
   Il promemoria della prenotazione con «Ci saremo», «Devo modificare» e
   «Annulla» al posto del link: il cliente risponde con un tocco, e il tocco
   si gestisce da solo anche con l'agente spento. Quando parte il promemoria
   resta deciso in Prenotazioni › Promemoria. Serve il template approvato
   da Meta: finché non c'è, parte quello di sempre. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export const WhatsAppRemindersCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [policy, setPolicy] = useState<RemindersPolicy | null>(null);
  const [template, setTemplate] = useState<WhatsAppTemplateRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getWhatsAppSettings(), getWhatsAppTemplates().catch(() => ({ templates: [] as WhatsAppTemplateRow[] }))])
      .then(([s, tpl]) => {
        if (cancelled) return;
        setPolicy(s.reminders ?? { quick_replies: false });
        setTemplate(tpl.templates.find(r => r.key === 'BOOKING_REMINDER_QR') ?? null);
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('reminders.loadError', 'Impostazioni non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!policy) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  const toggle = async () => {
    const next = !policy.quick_replies;
    setSaving(true);
    try {
      const r = await saveWhatsAppSettings({ reminders: { quick_replies: next } });
      setPolicy(r.reminders ?? { quick_replies: next });
    } catch (err: any) {
      showToast(err?.message || t('reminders.saveError', 'Non salvato'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const it = template?.languages.find(l => l.language === 'it');
  const ready = it?.configured && (it.approval === 'approved' || it.approval == null);

  return (
    <div className="space-y-3">
      <label className="flex min-h-[44px] items-center justify-between gap-3">
        <span className="text-[14px] text-[var(--ds-text-primary)]">{t('reminders.toggle', 'Promemoria con i tasti')}</span>
        <button
          type="button" role="switch" aria-checked={policy.quick_replies} aria-label={t('reminders.toggle', 'Promemoria con i tasti')}
          disabled={!canEdit || saving}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
            policy.quick_replies ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
          }`}
        >
          <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${policy.quick_replies ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
        </button>
      </label>
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {t('reminders.hint', 'Il promemoria arriva con «Ci saremo», «Devo modificare» e «Annulla». «Annulla» chiede conferma e rispetta la soglia d\'anticipo di «La tua prenotazione». Quando parte lo decidi in Prenotazioni › Promemoria.')}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-[var(--ds-text-secondary)]">{t('reminders.template', 'Template')}</span>
        <StatusPill tone={ready ? 'positive' : 'pending'}>
          {ready ? t('reminders.templateReady', 'attivo') : t('reminders.templateMissing', 'in attesa: finché non è attivo parte il promemoria di sempre')}
        </StatusPill>
      </div>
    </div>
  );
};
