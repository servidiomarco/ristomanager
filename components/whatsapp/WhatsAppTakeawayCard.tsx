import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import { getWhatsAppSettings, saveWhatsAppSettings, type TakeawayChatPolicy } from '../../services/whatsappApiService';

/* ── Asporto in chat ──────────────────────────────────────────────────────
   L'agente WhatsApp prende gli ordini d'asporto con le regole del banco
   (capienza, stop, minuti di preparazione), e il cliente riceve «il tuo
   ordine è pronto». Serve l'add-on Asporto; spento di serie. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export const WhatsAppTakeawayCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [policy, setPolicy] = useState<TakeawayChatPolicy | null>(null);
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppSettings()
      .then(s => {
        if (cancelled) return;
        setPolicy(s.takeaway ?? { enabled: false, notify_ready: false });
        setAvailable(s.takeaway_available !== false);
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('takeawayChat.loadError', 'Impostazioni non disponibili')); });
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
  if (!available) return <Callout tone="info">{t('takeawayChat.noAddon', "Serve l'add-on Asporto.")}</Callout>;

  const toggle = async (key: keyof TakeawayChatPolicy) => {
    setSaving(true);
    try {
      const r = await saveWhatsAppSettings({ takeaway: { [key]: !policy[key] } });
      if (r.takeaway) setPolicy(r.takeaway);
    } catch (err: any) {
      showToast(err?.message || t('takeawayChat.saveError', 'Non salvato'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const riga = (key: keyof TakeawayChatPolicy, label: string, hint: string) => (
    <div className="py-2">
      <label className="flex min-h-[44px] items-center justify-between gap-3">
        <span className="text-[14px] text-[var(--ds-text-primary)]">{label}</span>
        <button
          type="button" role="switch" aria-checked={policy[key]} aria-label={label}
          disabled={!canEdit || saving}
          onClick={() => toggle(key)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
            policy[key] ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
          }`}
        >
          <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${policy[key] ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
        </button>
      </label>
      <p className="text-[13px] text-[var(--ds-text-muted)]">{hint}</p>
    </div>
  );

  return (
    <div className="divide-y divide-[var(--ds-border)]">
      {riga('enabled', t('takeawayChat.toggle', "L'agente prende gli ordini d'asporto"),
        t('takeawayChat.toggleHint', "In chat mostra il menu, propone gli orari di ritiro liberi e, dopo il sì del cliente, registra l'ordine sulla board."))}
      {riga('notify_ready', t('takeawayChat.ready', "Avvisa quando l'ordine è pronto"),
        t('takeawayChat.readyHint', "Quando l'ordine passa a «Pronto» il cliente riceve un WhatsApp."))}
    </div>
  );
};
