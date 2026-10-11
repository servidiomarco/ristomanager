import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout, dsButton, dsInput } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import { getWhatsAppSettings, saveWhatsAppSettings, type CampaignsPolicy } from '../../services/whatsappApiService';

/* ── Campagne: le regole ──────────────────────────────────────────────────
   Se il locale manda campagne, quando, quanto spesso allo stesso numero e
   fino a quanto al mese. Le campagne si creano in Messaggi › Campagne. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const DEFAULT: CampaignsPolicy = { enabled: false, send_from_hour: 10, send_to_hour: 21, pause_days: 7, monthly_budget_eur: 50 };

export const WhatsAppCampaignsCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [policy, setPolicy] = useState<CampaignsPolicy | null>(null);
  const [draft, setDraft] = useState<CampaignsPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppSettings()
      .then(s => { if (!cancelled) { const p = s.campaigns ?? DEFAULT; setPolicy(p); setDraft(p); } })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('campaignsPolicy.loadError', 'Impostazioni non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!policy || !draft) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);
  const save = async () => {
    setSaving(true);
    try {
      const r = await saveWhatsAppSettings({ campaigns: draft });
      const p = r.campaigns ?? draft;
      setPolicy(p); setDraft(p);
      showToast(t('campaignsPolicy.saved', 'Salvato'), 'success');
    } catch (err: any) {
      showToast(err?.data?.message || err?.message || t('campaignsPolicy.saveError', 'Non salvato: controlla i valori'), 'error');
    } finally {
      setSaving(false);
    }
  };
  const num = (key: keyof Omit<CampaignsPolicy, 'enabled'>, label: string, min: number, max: number) => (
    <label className="block">
      <span className="block text-[13px] text-[var(--ds-text-secondary)]">{label}</span>
      <input className={dsInput} type="number" min={min} max={max} value={draft[key]} disabled={!canEdit}
        onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="space-y-3">
      <label className="flex min-h-[44px] items-center justify-between gap-3">
        <span className="text-[14px] text-[var(--ds-text-primary)]">{t('campaignsPolicy.enabled', 'Manda campagne ai clienti')}</span>
        <button
          type="button" role="switch" aria-checked={draft.enabled} aria-label={t('campaignsPolicy.enabled', 'Manda campagne ai clienti')}
          disabled={!canEdit}
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
            draft.enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
          }`}
        >
          <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${draft.enabled ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
        </button>
      </label>
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {t('campaignsPolicy.hint', 'Le campagne si creano in Messaggi › Campagne. Arrivano solo a chi ha dato il consenso alle promozioni (anche dalla casella su /prenota e /ordina); chi risponde STOP non riceve più niente. Serve la modalità legale avanzata.')}
      </p>
      <div className="grid grid-cols-2 gap-3">
        {num('send_from_hour', t('campaignsPolicy.from', 'Invio dalle (ora)'), 0, 23)}
        {num('send_to_hour', t('campaignsPolicy.to', 'Fino alle (ora)'), 1, 24)}
        {num('pause_days', t('campaignsPolicy.pause', 'Giorni fra due campagne allo stesso numero'), 1, 90)}
        {num('monthly_budget_eur', t('campaignsPolicy.budget', 'Tetto di spesa al mese (€)'), 1, 5000)}
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <button type="button" className={dsButton.primary} disabled={!dirty || saving} onClick={save}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('campaignsPolicy.save', 'Salva')}
          </button>
        </div>
      )}
    </div>
  );
};
