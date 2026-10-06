import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatStrip } from './ds';
import { formatMoneyMinor } from '../utils/money';
import { getSpesaCliente, type SpesaCliente as Spesa } from '../services/passepartoutApiService';

/* La spesa del cliente nella sua scheda: i conti CRM chiusi delle sue
   prenotazioni più, con la cassa Passepartout, i tavoli chiusi solo in
   cassa. Niente striscia finché non c'è almeno un conto: un «€ 0,00» su
   ogni cliente direbbe meno di niente (è il motivo per cui la scheda non
   aveva lo «Speso totale» del mockup). */
export const SpesaCliente: React.FC<{ customerId: number }> = ({ customerId }) => {
  const { t } = useTranslation('clienti', { useSuspense: false });
  const [spesa, setSpesa] = useState<Spesa | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSpesa(null);
    getSpesaCliente(customerId)
      .then((s) => { if (!cancelled) setSpesa(s); })
      .catch(() => { /* la scheda resta senza la striscia: non è un errore da mostrare */ });
    return () => { cancelled = true; };
  }, [customerId]);

  if (!spesa || spesa.totale_cents <= 0) return null;
  return (
    <StatStrip
      layout="stacked"
      stats={[
        { value: formatMoneyMinor(spesa.totale_cents), label: t('spendTotal', 'speso') },
        { value: spesa.visite, label: t('spendVisits', 'visite con conto') },
        {
          value: spesa.medio_coperto_cents != null ? formatMoneyMinor(spesa.medio_coperto_cents) : '—',
          label: t('spendPerCover', 'medio a coperto'),
        },
      ]}
    />
  );
};
