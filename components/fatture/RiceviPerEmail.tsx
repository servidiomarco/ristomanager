import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Mail } from 'lucide-react';
import { fattureFornitoriApi, type FfEmail, type FfEmailRicevuta } from '../../services/fattureFornitoriApiService';
import { onSocketEvent } from '../../services/socketEvents';
import { getRomeDatePart, getRomeTimePart } from '../../utils/reservationTime';
import { ConfirmDeleteModal } from '../ConfirmDeleteModal';
import { dsButton } from '../ds';

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const quando = (iso: string): string => {
  const [y, m, d] = getRomeDatePart(iso).split('-');
  return `${d}/${m}/${y.slice(2)} ${getRomeTimePart(iso)}`;
};

/* L'indirizzo a cui il commercialista (o il fornitore) inoltra le fatture.
   Sta in cima all'elenco delle fatture, dove si guarda quando una «non è
   arrivata»: per questo sotto ci sono le ultime email ricevute con il loro
   esito. Se la piattaforma non riceve ancora email, non c'è. */
export const RiceviPerEmail: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('fatture', { useSuspense: false });
  const [dati, setDati] = useState<FfEmail | null>(null);
  const [copiato, setCopiato] = useState(false);
  const [aperte, setAperte] = useState(false);
  const [conferma, setConferma] = useState(false);

  const leggi = useCallback(() => {
    fattureFornitoriApi.email().then(setDati).catch(() => setDati(null));
  }, []);
  useEffect(() => { leggi(); }, [leggi]);
  useEffect(() => onSocketEvent('fatture:changed', leggi), [leggi]);

  if (!dati?.attivo || !dati.indirizzo) return null;

  const copia = async () => {
    try {
      await navigator.clipboard.writeText(dati.indirizzo!);
      setCopiato(true);
      setTimeout(() => setCopiato(false), 2000);
    } catch {
      showToast(t('email.copiaErrore', 'Copia non riuscita: seleziona l\'indirizzo'), 'error');
    }
  };

  const rigenera = async () => {
    setConferma(false);
    try {
      const r = await fattureFornitoriApi.rigeneraEmail();
      setDati(prev => (prev ? { ...prev, indirizzo: r.indirizzo } : prev));
      showToast(t('email.rigenerato', 'Indirizzo cambiato: dallo a chi inoltra le fatture'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('errore', 'Non salvato'), 'error');
    }
  };

  // Una riga per email: cosa ne è venuto fuori, nelle parole di chi la legge.
  const esito = (r: FfEmailRicevuta): string => {
    const nuove = r.esito.filter(e => e.esito === 'nuova');
    const caricate = nuove.filter(e => e.caricata).length;
    const doppioni = r.esito.filter(e => e.esito === 'doppione').length;
    const scartati = r.esito.filter(e => e.esito === 'scartato');
    const parti = [
      nuove.length - caricate > 0 ? t('email.esito.daControllare', '{{count}} da controllare', { count: nuove.length - caricate }) : null,
      caricate > 0 ? t('email.esito.caricate', '{{count}} caricate da sole', { count: caricate }) : null,
      doppioni > 0 ? t('email.esito.doppioni', '{{count}} già presenti', { count: doppioni }) : null,
    ].filter(Boolean);
    if (parti.length) return parti.join(' · ');
    return scartati[0]?.motivo || t('email.esito.niente', 'Nessuna fattura');
  };

  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text-primary)]">
        <Mail className="h-4 w-4 text-[var(--ds-text-muted)]" aria-hidden />
        {t('email.titolo', 'Ricevi per email')}
      </div>
      <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
        {t('email.spiegazione', 'Le email inoltrate a questo indirizzo con l\'XML, il p7m o lo zip entrano da sole fra le fatture da controllare.')}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all truncate rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[14px] text-[var(--ds-text-primary)]">
          {dati.indirizzo}
        </code>
        <button type="button" onClick={copia} className={`${dsButton.secondary} flex-shrink-0 px-4`}>
          {copiato ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copiato ? t('email.copiato', 'Copiato') : t('email.copia', 'Copia')}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {dati.ricevute.length > 0 && (
          <button type="button" onClick={() => setAperte(v => !v)} aria-expanded={aperte}
            className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]">
            {aperte ? t('email.nascondi', 'Nascondi le email') : t('email.ultime', 'Ultime email ({{n}})', { n: dati.ricevute.length })}
          </button>
        )}
        <button type="button" onClick={() => setConferma(true)}
          className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]">
          {t('email.cambia', 'Cambia indirizzo')}
        </button>
      </div>
      {aperte && (
        <ul className="mt-1 divide-y divide-[var(--ds-border)] rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)]">
          {dati.ricevute.map(r => (
            <li key={r.id} className="px-3 py-2 text-[13px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-[var(--ds-text-primary)]">{r.mittente || t('email.sconosciuto', 'Mittente sconosciuto')}</span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-muted)]">{quando(r.ricevutaAt)}</span>
              </div>
              <div className="truncate text-[var(--ds-text-muted)]">{esito(r)}</div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDeleteModal
        isOpen={conferma}
        title={t('email.cambiaTitolo', 'Cambiare indirizzo?')}
        message={t('email.cambiaTesto', 'Il vecchio indirizzo smette subito di funzionare: quello nuovo va dato a chi inoltra le fatture.')}
        confirmLabel={t('email.cambia', 'Cambia indirizzo')}
        cancelLabel={t('lascia', 'Lascia')}
        showIrreversibleWarning={false}
        onConfirm={rigenera}
        onCancel={() => setConferma(false)}
      />
    </div>
  );
};
