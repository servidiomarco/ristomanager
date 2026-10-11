import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import { getWhatsAppSettings, saveWhatsAppSettings, type MediaPolicy } from '../../services/whatsappApiService';

/* ── Vocali e foto ────────────────────────────────────────────────────────
   I vocali dei clienti trascritti (li legge lo staff in Messaggi e li legge
   l'agente) e le foto che l'agente guarda. Spenti di serie: la
   trascrizione usa i crediti ElevenLabs di Sofia, le foto costano token. */

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export const WhatsAppMediaCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');
  const [policy, setPolicy] = useState<MediaPolicy | null>(null);
  const [ready, setReady] = useState(true);
  const [saving, setSaving] = useState<keyof MediaPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppSettings()
      .then(s => {
        if (cancelled) return;
        setPolicy(s.media ?? { transcribe_voice: false, read_photos: false });
        setReady(s.transcription_ready !== false);
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('media.loadError', 'Impostazioni non disponibili')); });
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

  const toggle = async (key: keyof MediaPolicy) => {
    setSaving(key);
    try {
      const r = await saveWhatsAppSettings({ media: { [key]: !policy[key] } });
      if (r.media) setPolicy(r.media);
    } catch (err: any) {
      showToast(err?.message || t('media.saveError', 'Non salvato'), 'error');
    } finally {
      setSaving(null);
    }
  };

  const riga = (key: keyof MediaPolicy, label: string, hint: string, disabled = false) => (
    <div className="py-2">
      <label className="flex min-h-[44px] items-center justify-between gap-3">
        <span className="text-[14px] text-[var(--ds-text-primary)]">{label}</span>
        <button
          type="button" role="switch" aria-checked={policy[key]} aria-label={label}
          disabled={!canEdit || saving != null || disabled}
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
      {riga('transcribe_voice', t('media.transcribe', 'Trascrivi i vocali'),
        ready
          ? t('media.transcribeHint', 'In Messaggi il vocale compare anche scritto, e l\'agente lo legge come un messaggio. Usa i crediti ElevenLabs di Sofia.')
          : t('media.transcribeMissing', 'Manca la chiave ElevenLabs sul server: la trascrizione non può partire.'),
        !ready && !policy.transcribe_voice)}
      {riga('read_photos', t('media.photos', 'Fai leggere le foto all\'agente'),
        t('media.photosHint', 'L\'agente guarda le foto che il cliente manda (al massimo tre per risposta): uno screenshot di una prenotazione, un biglietto, un menu.'))}
    </div>
  );
};
