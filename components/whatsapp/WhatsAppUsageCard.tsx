import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Callout, StatStrip } from '../ds';
import { getWhatsAppUsage, type WhatsAppUsage } from '../../services/whatsappApiService';

/* ── Consumi del mese ─────────────────────────────────────────────────────
   Quanti messaggi sono arrivati e partiti, quanti non sono arrivati, e
   quanto è costata l'AI che li legge. Il costo dei messaggi si aggiunge
   quando il provider lo comunica (numero del locale collegato a Meta). */

export const WhatsAppUsageCard: React.FC = () => {
  const { t, i18n } = useTranslation('whatsapp', { useSuspense: false });
  const [usage, setUsage] = useState<WhatsAppUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppUsage()
      .then(u => { if (!cancelled) setUsage(u); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || t('usage.loadError', 'Consumi non disponibili')); });
    return () => { cancelled = true; };
  }, [t]);

  if (error) return <Callout tone="critical">{error}</Callout>;
  if (!usage) {
    return (
      <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--ds-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading', 'Caricamento…')}
      </div>
    );
  }

  const monthLabel = usage.month
    ? new Date(`${usage.month}T12:00:00`).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'it-IT', { month: 'long', year: 'numeric' })
    : '';
  const euro = (n: number) => n.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'it-IT', { style: 'currency', currency: 'EUR' });
  const wa = usage.whatsapp;

  return (
    <div className="space-y-3">
      <div className="text-[13px] text-[var(--ds-text-muted)]">{monthLabel}</div>
      <StatStrip
        layout="stacked"
        stats={[
          { value: wa.inbound, label: t('usage.inbound', 'ricevuti') },
          { value: wa.outboundStaff, label: t('usage.staff', 'scritti dallo staff') },
          { value: wa.outboundAutomatic, label: t('usage.automatic', 'automatici') },
          { value: wa.failed, label: t('usage.failed', 'non consegnati'), tone: wa.failed > 0 ? 'critical' : 'neutral' },
        ]}
      />
      <div className="flex flex-wrap justify-between gap-2 text-[13px] text-[var(--ds-text-secondary)]">
        <span>{t('usage.sms', 'SMS inviati: {{n}}', { n: usage.sms.outbound })}</span>
        <span>
          {t('usage.ai', 'AI dei messaggi: {{runs}} richieste, {{cost}}', { runs: usage.ai.runs, cost: euro(usage.ai.costEur) })}
        </span>
      </div>
    </div>
  );
};
