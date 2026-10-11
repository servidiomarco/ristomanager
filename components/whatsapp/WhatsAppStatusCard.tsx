import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Copy, Check } from 'lucide-react';
import { Callout, StatusPill } from '../ds';
import { getWhatsAppStatus, type WhatsAppStatus } from '../../services/whatsappApiService';

/* ── Numero e stato ───────────────────────────────────────────────────────
   Il numero da cui il locale scrive ai clienti, e se manda davvero. Prima
   lo sapeva solo chi aveva le variabili d'ambiente di Railway sotto gli
   occhi: un locale senza mittente vedeva i messaggi scendere su SMS o email
   senza sapere perché. */

const CopyRow: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* il testo resta selezionabile */ }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-[var(--ds-text-muted)]">{label}</div>
        <div className="truncate font-mono text-[12px] text-[var(--ds-text-secondary)]" title={value}>{value}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
        aria-label={t('status.copy', 'Copia')}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
};

export const WhatsAppStatusCard: React.FC = () => {
  const { t } = useTranslation('whatsapp', { useSuspense: false });
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppStatus()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('status.loadError', 'Stato non disponibile')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!status) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{status.phone}</div>
            <div className="text-[13px] text-[var(--ds-text-muted)]">
              {status.provider === 'twilio' && status.source === 'env'
                ? t('status.twilioEnv', 'Twilio · account principale')
                : t('status.provider', 'Provider: {{p}}', { p: status.provider ?? '—' })}
            </div>
          </div>
          <StatusPill tone="positive">{t('status.connected', 'Collegato')}</StatusPill>
        </div>
      ) : (
        <Callout tone="pending" title={t('status.notConnectedTitle', 'Nessun numero collegato')}>
          {t('status.notConnected', 'I messaggi ai clienti partono per email, se configurata. Il collegamento del numero del locale arriva con un prossimo aggiornamento.')}
        </Callout>
      )}

      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="text-[var(--ds-text-secondary)]">{t('status.sms', 'Ripiego SMS')}</span>
        <StatusPill tone={status.sms_ready ? 'positive' : 'neutral'}>
          {status.sms_ready ? t('status.on', 'Attivo') : t('status.off', 'Spento')}
        </StatusPill>
      </div>

      {status.webhooks && (
        <div className="space-y-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
          <CopyRow label={t('status.webhookInbound', 'Messaggi in arrivo')} value={status.webhooks.inbound} />
          <CopyRow label={t('status.webhookStatus', 'Esito dei messaggi')} value={status.webhooks.status} />
        </div>
      )}
    </div>
  );
};
