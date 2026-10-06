import React, { useEffect, useState } from 'react';
import { Callout, FormCard } from '../ds';
import { formatEuro } from './paymentsView';
import { useAuth } from '../../contexts/AuthContext';
import { getRiscontroCassa, type RiscontroCassa as Riscontro } from '../../services/passepartoutApiService';

/* Il riscontro CRM↔cassa Passepartout del giorno: il «delta zero» che a fine
   serata si faceva a mano (docs/serata-pilota-comande.md). Ogni conto del
   CRM nato da una comanda della cassa deve avere il suo conto in cassa con
   lo stesso importo, e ogni conto della cassa pagato «esterno» deve avere
   il suo conto nel CRM. Solo col modulo Passepartout; niente scheda se nel
   giorno non c'è niente da confrontare. */
export const RiscontroCassa: React.FC<{ date: string }> = ({ date }) => {
  const { hasFeature } = useAuth();
  const attivo = hasFeature('passepartout');
  const [r, setR] = useState<Riscontro | null>(null);

  useEffect(() => {
    if (!attivo) return;
    let cancelled = false;
    setR(null);
    getRiscontroCassa(date)
      .then((x) => { if (!cancelled) setR(x); })
      .catch(() => { /* niente scheda */ });
    return () => { cancelled = true; };
  }, [date, attivo]);

  if (!attivo || !r) return null;
  if (!r.importato && r.conti_crm_da_cassa === 0) return null;
  const problemi = r.mancanti_in_cassa.length + r.importi_diversi.length + r.esterni_senza_crm.length;
  const tav = (t: string | null) => (t ? `tavolo ${t}` : 'tavolo —');

  return (
    <FormCard title="Riscontro con la cassa · giornata">
      {!r.importato ? (
        <p className="text-[14px] text-[var(--ds-text-muted)]">
          I conti della cassa di questo giorno non sono ancora stati letti.
        </p>
      ) : problemi === 0 ? (
        <Callout tone="positive">
          {r.conti_crm_da_cassa > 0
            ? `Tutto torna: ${r.conti_crm_da_cassa} conti del CRM chiusi in cassa con lo stesso importo.`
            : 'Tutto torna: nessun conto del CRM da confrontare.'}
        </Callout>
      ) : (
        <div className="space-y-3">
          {r.mancanti_in_cassa.length > 0 && (
            <Callout tone="critical" title="Chiusi nel CRM, non in cassa">
              <ul className="space-y-0.5">
                {r.mancanti_in_cassa.map((m) => (
                  <li key={m.bill_id}>{tav(m.tavolo)} · {formatEuro(m.totale_cents)}</li>
                ))}
              </ul>
            </Callout>
          )}
          {r.importi_diversi.length > 0 && (
            <Callout tone="pending" title="Importi diversi">
              <ul className="space-y-0.5">
                {r.importi_diversi.map((d) => (
                  <li key={d.bill_id}>{tav(d.tavolo)} · CRM {formatEuro(d.crm_cents)} · cassa {formatEuro(d.cassa_cents)}</li>
                ))}
              </ul>
            </Callout>
          )}
          {r.esterni_senza_crm.length > 0 && (
            <Callout tone="pending" title="Pagati «esterno» in cassa, senza conto nel CRM">
              <ul className="space-y-0.5">
                {r.esterni_senza_crm.map((e) => (
                  <li key={e.pp_conto_id}>
                    {tav(e.tavolo)} · {formatEuro(e.totale_cents)}{e.numero_scontrino ? ` · scontrino ${e.numero_scontrino}` : ''}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      )}
      {r.importato && r.cassa_solo.conti > 0 && (
        <p className="mt-3 text-[13px] text-[var(--ds-text-muted)]">
          Chiusi solo in cassa: {r.cassa_solo.conti} conti · {formatEuro(r.cassa_solo.totale_cents)}
        </p>
      )}
    </FormCard>
  );
};
