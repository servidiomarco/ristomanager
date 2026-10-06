import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Receipt } from 'lucide-react';
import { FormCard } from '../ds';
import { formatMoneyMinor } from '../../utils/money';
import { getContoCassaPrenotazione, type ContoCassa } from '../../services/passepartoutApiService';

/* Il conto chiuso in cassa Passepartout per questa prenotazione (il tavolo
   aperto dal planning porta il suo id): tavolo, coperti, totale e
   documento. Niente scheda se la cassa non ha conti per lei — senza
   l'integrazione, o finché il tavolo non è chiuso. */
export const ContoCassaPrenotazione: React.FC<{ reservationId: number }> = ({ reservationId }) => {
  const { t } = useTranslation('prenotazioni', { useSuspense: false });
  const [conti, setConti] = useState<ContoCassa[]>([]);

  useEffect(() => {
    let cancelled = false;
    setConti([]);
    getContoCassaPrenotazione(reservationId)
      .then((r) => { if (!cancelled) setConti(r.conti); })
      .catch(() => { /* niente scheda: non è un errore da mostrare */ });
    return () => { cancelled = true; };
  }, [reservationId]);

  if (conti.length === 0) return null;
  const totale = conti.reduce((s, c) => s + c.totale_cents, 0);
  return (
    <div className="px-4 pb-4 sm:px-6">
      <FormCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Receipt className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
          <h4 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{t('contoCassa.title', 'Conto in cassa')}</h4>
          <span className="ml-auto text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{formatMoneyMinor(totale)}</span>
        </div>
        <ul className="space-y-1">
          {conti.map((c) => (
            <li key={c.pp_conto_id} className="text-[13px] text-[var(--ds-text-muted)]">
              {[
                c.tavolo ? t('contoCassa.table', { tavolo: c.tavolo, defaultValue: 'Tavolo {{tavolo}}' }) : null,
                c.coperti ? t('contoCassa.covers', { count: c.coperti }) : null,
                formatMoneyMinor(c.totale_cents),
                c.numero_scontrino
                  ? t('contoCassa.receipt', { numero: c.numero_scontrino, defaultValue: 'scontrino {{numero}}' })
                  : c.tipo_documento ? c.tipo_documento.toLowerCase() : null,
              ].filter(Boolean).join(' · ')}
            </li>
          ))}
        </ul>
      </FormCard>
    </div>
  );
};
