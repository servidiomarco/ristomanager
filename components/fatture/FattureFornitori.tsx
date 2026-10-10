import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileUp, Loader2, Mail, Receipt } from 'lucide-react';
import {
  fattureFornitoriApi,
  type FfEsitoFile,
  type FfTestata,
  type StatoFattura,
} from '../../services/fattureFornitoriApiService';
import { onSocketEvent } from '../../services/socketEvents';
import { formatMoneyMinor } from '../../utils/money';
import { Callout, EmptyState, SegmentedControl, StatusPill, dsButton, type PillTone } from '../ds';
import { FatturaDettaglio } from './FatturaDettaglio';

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  onBack: () => void;
  /** Il conteggio «da controllare» è cambiato: la voce del Magazzino lo mostra. */
  onConteggio?: (n: number) => void;
}

type Filtro = StatoFattura | 'TUTTE';

const ACCETTA = '.xml,.p7m,.zip,application/xml,text/xml,application/zip,application/pkcs7-mime';

const dataBreve = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/* Le fatture dei fornitori, dentro il Magazzino. Si caricano i file com'erano
   (l'XML, il p7m firmato, lo zip scaricato dal portale): ogni fattura entra
   «da controllare» e si apre per abbinare le righe ai prodotti. */
export const FattureFornitori: React.FC<Props> = ({ showToast, onBack, onConteggio }) => {
  const { t } = useTranslation('fatture', { useSuspense: false });
  const [filtro, setFiltro] = useState<Filtro>('DA_CONTROLLARE');
  const [fatture, setFatture] = useState<FfTestata[]>([]);
  const [daControllare, setDaControllare] = useState(0);
  const [caricamento, setCaricamento] = useState(true);
  const [invio, setInvio] = useState<{ fatti: number; totali: number } | null>(null);
  const [esiti, setEsiti] = useState<FfEsitoFile[] | null>(null);
  const [aperta, setAperta] = useState<number | null>(null);
  const [sopra, setSopra] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const leggi = useCallback(async () => {
    try {
      const r = await fattureFornitoriApi.elenco(filtro === 'TUTTE' ? undefined : filtro);
      setFatture(r.fatture);
      setDaControllare(r.daControllare);
      onConteggio?.(r.daControllare);
    } catch (err: any) {
      showToast(err?.message || t('erroreElenco', 'Fatture non caricate'), 'error');
    } finally {
      setCaricamento(false);
    }
  }, [filtro, onConteggio, showToast, t]);

  useEffect(() => { void leggi(); }, [leggi]);
  useEffect(() => onSocketEvent('fatture:changed', () => { void leggi(); }), [leggi]);

  const caricaFile = async (files: File[]) => {
    if (files.length === 0 || invio) return;
    setEsiti(null);
    setInvio({ fatti: 0, totali: files.length });
    const tutti: FfEsitoFile[] = [];
    for (const file of files) {
      try {
        const r = await fattureFornitoriApi.carica(file);
        tutti.push(...r.esiti);
      } catch (err: any) {
        tutti.push({ file: file.name, esito: 'scartato', motivo: err?.message || t('erroreFile', 'File non letto') });
      }
      setInvio(prev => (prev ? { ...prev, fatti: prev.fatti + 1 } : prev));
    }
    setInvio(null);
    const nuove = tutti.filter(e => e.esito === 'nuova');
    // Una fattura sola: si apre subito, è quella che si voleva guardare.
    if (nuove.length === 1 && tutti.length === 1 && nuove[0].id) {
      setAperta(nuove[0].id);
    } else {
      setEsiti(tutti);
    }
    if (filtro !== 'DA_CONTROLLARE' && nuove.length > 0) setFiltro('DA_CONTROLLARE');
    else void leggi();
  };

  if (aperta != null) {
    return <FatturaDettaglio id={aperta} showToast={showToast} onBack={() => { setAperta(null); void leggi(); }} />;
  }

  const pillola = (f: FfTestata): { tone: PillTone; testo: string } => {
    if (f.stato === 'CARICATA') return { tone: 'positive', testo: t('stato.caricata', 'Caricata') };
    if (f.stato === 'IGNORATA') return { tone: 'neutral', testo: t('stato.ignorata', 'Messa da parte') };
    if (f.notaDiCredito) return { tone: 'info', testo: t('stato.notaDiCredito', 'Nota di credito') };
    if (f.righeDaDecidere > 0) return { tone: 'pending', testo: t('stato.daAbbinare', '{{n}} da abbinare', { n: f.righeDaDecidere }) };
    return { tone: 'info', testo: t('stato.pronta', 'Pronta da caricare') };
  };

  const nuove = esiti?.filter(e => e.esito === 'nuova') ?? [];
  const doppioni = esiti?.filter(e => e.esito === 'doppione') ?? [];
  const scartati = esiti?.filter(e => e.esito === 'scartato') ?? [];

  return (
    <div
      className="space-y-4"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setSopra(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setSopra(false); }}
      onDrop={e => { e.preventDefault(); setSopra(false); void caricaFile(Array.from(e.dataTransfer.files)); }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={onBack} aria-label={t('magazzino', 'Magazzino')}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] sm:text-[26px]">
            {t('titolo', 'Fatture fornitori')}
          </h1>
        </div>
        <button type="button" onClick={() => input.current?.click()} disabled={invio != null} className={dsButton.primary}>
          {invio ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileUp className="h-4 w-4" aria-hidden />}
          {invio && invio.totali > 1
            ? t('invio', '{{fatti}} di {{totali}}', invio)
            : t('carica', 'Carica fatture')}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCETTA}
          className="hidden"
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void caricaFile(files); }}
        />
      </div>

      {sopra && (
        <div className="rounded-[var(--ds-radius)] border-2 border-dashed border-[var(--ds-border-focus)] bg-[var(--ds-surface)] px-6 py-10 text-center text-[15px] font-medium text-[var(--ds-text-primary)]">
          {t('rilascia', 'Rilascia qui le fatture')}
        </div>
      )}

      {esiti && (
        <Callout
          tone={scartati.length > 0 && nuove.length === 0 ? 'pending' : 'positive'}
          title={[
            nuove.length ? t('esito.nuove', '{{count}} nuove', { count: nuove.length }) : null,
            doppioni.length ? t('esito.doppioni', '{{count}} già presenti', { count: doppioni.length }) : null,
            scartati.length ? t('esito.scartati', '{{count}} file scartati', { count: scartati.length }) : null,
          ].filter(Boolean).join(' · ') || t('esito.niente', 'Nessuna fattura nel file')}
          action={<button type="button" className="text-[14px] font-medium underline" onClick={() => setEsiti(null)}>{t('ok', 'Ok')}</button>}
        >
          {nuove.length > 0 && (
            <div>
              {t('esito.riconosciute', 'Già riconosciute: {{r}} di {{count}} righe', {
                r: nuove.reduce((s, e) => s + (e.riconosciute ?? 0), 0),
                count: nuove.reduce((s, e) => s + (e.righeMerce ?? 0), 0),
              })}
            </div>
          )}
          {scartati.map((s, i) => (
            <div key={`${s.file}-${i}`} className="truncate">{s.file}: {s.motivo}</div>
          ))}
        </Callout>
      )}

      <SegmentedControl<Filtro>
        value={filtro}
        onChange={setFiltro}
        ariaLabel={t('filtro', 'Quali fatture')}
        equalWidth={false}
        overflow="scroll"
        options={[
          { value: 'DA_CONTROLLARE', label: t('filtri.daControllare', 'Da controllare'), badge: daControllare, badgeTone: daControllare > 0 ? 'alert' : 'neutral' },
          { value: 'CARICATA', label: t('filtri.caricate', 'Caricate') },
          { value: 'IGNORATA', label: t('filtri.messeDaParte', 'Messe da parte') },
          { value: 'TUTTE', label: t('filtri.tutte', 'Tutte') },
        ]}
      />

      {caricamento ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[var(--ds-text-muted)]" aria-hidden /></div>
      ) : fatture.length === 0 ? (
        <EmptyState
          icon={Receipt}
          action={filtro === 'DA_CONTROLLARE' ? (
            <button type="button" onClick={() => input.current?.click()} className={dsButton.secondary}>
              <FileUp className="h-4 w-4" aria-hidden />{t('carica', 'Carica fatture')}
            </button>
          ) : undefined}
        >
          {filtro === 'DA_CONTROLLARE'
            ? t('vuoto.daControllare', 'Nessuna fattura da controllare. Carica gli XML, i p7m o lo zip del commercialista.')
            : t('vuoto.altre', 'Nessuna fattura qui.')}
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          {fatture.map(f => {
            const p = pillola(f);
            return (
              <li key={f.id} className="border-b border-[var(--ds-border)] last:border-b-0">
                <button type="button" onClick={() => setAperta(f.id)}
                  className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                        {f.fornitore.supplierNome || f.fornitore.nome}
                      </span>
                      {f.origine === 'EMAIL' && <Mail className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-text-muted)]" aria-label={t('daEmail', 'Arrivata per email')} />}
                    </div>
                    <div className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                      {t('riga.numero', 'n. {{n}} · {{d}}', { n: f.numero, d: dataBreve(f.data) })}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1">
                    {f.totaleCents != null && (
                      <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{formatMoneyMinor(f.totaleCents)}</span>
                    )}
                    <StatusPill tone={p.tone}>{p.testo}</StatusPill>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
