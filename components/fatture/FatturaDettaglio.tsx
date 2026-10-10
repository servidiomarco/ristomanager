import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, ArrowLeft, Ban, Check, FileText, Link2, Loader2, PackageCheck, Plus, RotateCcw, Trash2, Undo2,
} from 'lucide-react';
import { InventoryArea, type InventoryLocation, type InventoryProduct } from '../../types';
import { getInventoryLocations, getInventoryProducts } from '../../services/apiService';
import { supplierApiService, type Supplier } from '../../services/shoppingApiService';
import {
  CATEGORIE_SPESA,
  fattureFornitoriApi,
  type CategoriaSpesa,
  type FfDettaglio,
  type FfRiga,
} from '../../services/fattureFornitoriApiService';
import { formatMoneyMinor, formatMoneyUnits } from '../../utils/money';
import { toTitleCase } from '../../utils/text';
import { onSocketEvent } from '../../services/socketEvents';
import { ConfirmDeleteModal } from '../ConfirmDeleteModal';
import { Callout, Field, ModalShell, SectionHeader, StatusPill, dsButton, dsSelect } from '../ds';
import { AbbinaRiga } from './AbbinaRiga';

interface Props {
  id: number;
  onBack: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const AREE: InventoryArea[] = [InventoryArea.CUCINA, InventoryArea.BAR, InventoryArea.SALA];

const dataBreve = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const qta = (n: number): string => String(Math.round(n * 1000) / 1000).replace('.', ',');

/* Una fattura aperta. Le righe di merce si decidono una per una (o in blocco
   per le «altre»), poi un tasto le carica tutte nella cella scelta per ogni
   area. Le righe di sole note, gli sconti e le spese stanno sotto, chiuse:
   contano nel totale, non nel magazzino. */
export const FatturaDettaglio: React.FC<Props> = ({ id, onBack, showToast }) => {
  const { t } = useTranslation('fatture', { useSuspense: false });
  const [f, setF] = useState<FfDettaglio | null>(null);
  const [prodotti, setProdotti] = useState<InventoryProduct[]>([]);
  const [celle, setCelle] = useState<InventoryLocation[]>([]);
  const [fornitori, setFornitori] = useState<Supplier[]>([]);
  const [errore, setErrore] = useState<string | null>(null);
  const [aperta, setAperta] = useState<FfRiga | null>(null);
  const [celleScelte, setCelleScelte] = useState<Partial<Record<InventoryArea, number>>>({});
  const [lavoro, setLavoro] = useState<string | null>(null);
  const [fornitoreScelto, setFornitoreScelto] = useState('');
  const [ignoraAltre, setIgnoraAltre] = useState(false);
  const [categoriaAltre, setCategoriaAltre] = useState<CategoriaSpesa>('altro');
  const [conferma, setConferma] = useState<'annulla' | 'elimina' | null>(null);
  const [altreAperte, setAltreAperte] = useState(false);

  const carica = useCallback(async () => {
    try {
      const [d, p, c, s] = await Promise.all([
        fattureFornitoriApi.dettaglio(id),
        getInventoryProducts(),
        getInventoryLocations(),
        supplierApiService.getAll().catch(() => [] as Supplier[]),
      ]);
      setF(d);
      setProdotti(p);
      setCelle(c);
      setFornitori(s);
      setErrore(null);
    } catch (err: any) {
      setErrore(err?.message || t('erroreCaricamento', 'Fattura non caricata'));
    }
  }, [id, t]);

  useEffect(() => { void carica(); }, [carica]);
  useEffect(() => onSocketEvent<{ id?: number }>('fatture:changed', p => { if (!p?.id || p.id === id) void carica(); }), [carica, id]);

  // Per ogni area la prima cella, se nessuno ne ha scelta un'altra.
  useEffect(() => {
    setCelleScelte(prev => {
      const next = { ...prev };
      for (const area of AREE) {
        if (next[area] == null) {
          const prima = celle.find(c => c.area === area);
          if (prima) next[area] = prima.id;
        }
      }
      return next;
    });
  }, [celle]);

  const merce = useMemo(() => (f?.righe ?? []).filter(r => r.tipo === 'merce'), [f]);
  const altre = useMemo(() => (f?.righe ?? []).filter(r => r.tipo !== 'merce'), [f]);
  const daDecidere = merce.filter(r => r.esito == null);
  const inMagazzino = merce.filter(r => r.esito === 'CARICO');
  const areeDelCarico = AREE.filter(a => inMagazzino.some(r => r.prodotto?.area === a));
  const aperto = f?.stato === 'DA_CONTROLLARE';

  const aggiornaRiga = (r: FfRiga) => {
    setF(prev => {
      if (!prev) return prev;
      const righe = prev.righe.map(x => (x.id === r.id ? r : x));
      return { ...prev, righe, righeDaDecidere: righe.filter(x => x.tipo === 'merce' && x.esito == null).length };
    });
  };

  const esegui = async (chiave: string, fn: () => Promise<void>) => {
    if (lavoro) return;
    setLavoro(chiave);
    try {
      await fn();
    } catch (err: any) {
      showToast(err?.message || t('errore', 'Non salvato'), 'error');
    } finally {
      setLavoro(null);
    }
  };

  if (errore) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={onBack} className={dsButton.quiet}><ArrowLeft className="h-4 w-4" aria-hidden />{t('indietro', 'Fatture')}</button>
        <Callout tone="critical" icon={AlertTriangle}>{errore}</Callout>
      </div>
    );
  }
  if (!f) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[var(--ds-text-muted)]" aria-hidden /></div>;
  }

  const apriPdf = (indice: number) => esegui('pdf', async () => {
    // La scheda si apre subito, nel gesto dell'utente: dopo l'attesa del
    // download Safari la tratterebbe come un popup e la bloccherebbe.
    const finestra = window.open('', '_blank');
    const blob = await fattureFornitoriApi.allegato(f.id, indice);
    const url = URL.createObjectURL(blob);
    if (finestra) finestra.location.href = url;
    else window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  const collega = (input: { supplierId: string } | { crea: true }) => esegui('fornitore', async () => {
    setF(await fattureFornitoriApi.collegaFornitore(f.id, input));
    showToast(t('fornitoreCollegato', 'Fornitore collegato'), 'success');
  });

  const ignoraLeAltre = () => esegui('altre', async () => {
    for (const r of daDecidere) {
      aggiornaRiga(await fattureFornitoriApi.decidiRiga(f.id, r.id, { esito: 'IGNORA', categoriaSpesa: categoriaAltre }));
    }
    setIgnoraAltre(false);
  });

  const caricaInMagazzino = () => esegui('carica', async () => {
    const ubicazioni: Partial<Record<InventoryArea, number>> = {};
    for (const a of areeDelCarico) if (celleScelte[a]) ubicazioni[a] = celleScelte[a];
    const r = await fattureFornitoriApi.caricaInMagazzino(f.id, ubicazioni);
    setF(r.fattura);
    const righe = t('caricata.righe', '{{count}} righe in magazzino', { count: r.caricate });
    const prezzi = r.prezzi > 0 ? t('caricata.prezzi', '{{count}} prezzi aggiornati', { count: r.prezzi }) : '';
    showToast(prezzi ? `${righe}, ${prezzi}` : righe, 'success');
    for (const a of r.avvisi) showToast(a, 'info');
  });

  const annulla = () => esegui('annulla', async () => {
    setConferma(null);
    setF(await fattureFornitoriApi.annullaCarico(f.id));
    showToast(t('annullato', 'Carico annullato'), 'success');
  });

  const elimina = () => esegui('elimina', async () => {
    setConferma(null);
    await fattureFornitoriApi.elimina(f.id);
    showToast(t('eliminata', 'Fattura tolta'), 'success');
    onBack();
  });

  const cambiaStato = (stato: 'IGNORATA' | 'DA_CONTROLLARE') => esegui('stato', async () => {
    setF(await fattureFornitoriApi.cambiaStato(f.id, stato));
  });

  const titoloDoc = f.notaDiCredito
    ? t('doc.nota', 'Nota di credito {{n}} del {{d}}', { n: f.numero, d: dataBreve(f.data) })
    : t('doc.fattura', 'Fattura {{n}} del {{d}}', { n: f.numero, d: dataBreve(f.data) });
  const scadenza = f.pagamenti.find(p => p.data);

  const decisione = (r: FfRiga) => {
    if (r.esito === 'CARICO' && r.prodotto) {
      const aumento = r.costoCents != null && r.prodotto.costoCents != null && r.prodotto.unitaCosto === r.unitaCosto && !r.caricata
        ? r.costoCents - r.prodotto.costoCents
        : 0;
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <Check className="h-4 w-4 flex-shrink-0 text-[var(--ds-seated-text)]" aria-hidden />
          <span className="min-w-0 truncate font-medium text-[var(--ds-text-primary)]">{r.prodotto.nome}</span>
          {r.quantitaMagazzino != null && (
            <span className="text-[var(--ds-text-muted)]">+{qta(r.quantitaMagazzino)} {r.prodotto.unita || 'pz'}</span>
          )}
          {f.foodCost && r.costoCents != null && r.unitaCosto && (
            <span className="tabular-nums text-[var(--ds-text-muted)]">· {formatMoneyMinor(r.costoCents)}/{r.unitaCosto}</span>
          )}
          {aumento > 0 && (
            <StatusPill tone="pending" title={t('riga.prima', 'Prima {{p}}', { p: formatMoneyMinor(r.prodotto.costoCents!) })}>
              +{formatMoneyMinor(aumento)}
            </StatusPill>
          )}
          {r.daMemoria && <StatusPill tone="neutral">{t('riga.nota', 'già noto')}</StatusPill>}
        </div>
      );
    }
    if (r.esito === 'IGNORA') {
      const cat = CATEGORIE_SPESA.find(c => c.value === r.categoriaSpesa);
      return (
        <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
          <Ban className="h-4 w-4 flex-shrink-0" aria-hidden />
          {t('riga.ignorata', 'Ignorata')}{cat ? ` · ${t(`categoria.${cat.value}`, cat.label).toLowerCase()}` : ''}
          {r.daMemoria && <StatusPill tone="neutral">{t('riga.nota', 'già noto')}</StatusPill>}
        </div>
      );
    }
    return <span className="text-[13px] font-medium text-[var(--ds-pending-text)]">{t('riga.daDecidere', 'Da abbinare')}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className={`${dsButton.quiet} h-10 px-4`}>
          <ArrowLeft className="h-4 w-4" aria-hidden />{t('indietro', 'Fatture')}
        </button>
        <div className="flex items-center gap-2">
          {f.allegati.map(a => (
            <button key={a.indice} type="button" onClick={() => apriPdf(a.indice)} className={`${dsButton.secondary} h-10 px-4`} disabled={lavoro === 'pdf'}>
              <FileText className="h-4 w-4" aria-hidden />{/pdf/i.test(a.formato ?? a.nome) ? 'PDF' : a.nome}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{f.fornitore.nome}</h2>
            <p className="mt-0.5 text-[14px] text-[var(--ds-text-muted)]">{titoloDoc}</p>
          </div>
          {f.totaleCents != null && (
            <div className="flex-shrink-0 text-right">
              <div className="text-[20px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{formatMoneyMinor(f.totaleCents)}</div>
              <div className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                {t('iva', 'IVA {{iva}}', { iva: formatMoneyMinor(f.impostaCents) })}
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {f.stato === 'CARICATA' && <StatusPill tone="positive">{t('stato.caricata', 'Caricata')}</StatusPill>}
          {f.stato === 'IGNORATA' && <StatusPill>{t('stato.ignorata', 'Messa da parte')}</StatusPill>}
          {f.fornitore.supplierNome && <StatusPill>{f.fornitore.supplierNome}</StatusPill>}
          {scadenza?.data && <StatusPill>{t('scadenza', 'Scade il {{d}}', { d: dataBreve(scadenza.data) })}</StatusPill>}
          {f.ddt.length > 0 && <StatusPill>{t('ddt', 'DDT {{n}}', { n: f.ddt.map(d => d.numero).join(', ') })}</StatusPill>}
        </div>
      </div>

      {f.altroDestinatario && (
        <Callout tone="pending" icon={AlertTriangle}>
          {t('altroDestinatario', 'È intestata a un\'altra partita IVA: controlla che sia del locale.')}
        </Callout>
      )}

      {!f.fornitore.supplierId && (
        <Callout tone="info" icon={Link2} title={t('fornitore.titolo', 'Fornitore nuovo per l\'anagrafica')}>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {f.fornitoreSuggerito ? (
              <button type="button" className={`${dsButton.secondary} h-10 px-4`} disabled={!!lavoro}
                onClick={() => collega({ supplierId: f.fornitoreSuggerito!.id })}>
                {t('fornitore.suggerito', 'È «{{nome}}»', { nome: f.fornitoreSuggerito.nome })}
              </button>
            ) : fornitori.length > 0 && (
              <>
                <select className={`${dsSelect} h-10 w-auto min-w-[160px]`} value={fornitoreScelto} onChange={e => setFornitoreScelto(e.target.value)}
                  aria-label={t('fornitore.scegli', 'Scegli il fornitore')}>
                  <option value="">{t('fornitore.scegli', 'Scegli il fornitore')}</option>
                  {fornitori.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button type="button" className={`${dsButton.secondary} h-10 px-4`} disabled={!fornitoreScelto || !!lavoro}
                  onClick={() => collega({ supplierId: fornitoreScelto })}>
                  {t('fornitore.collega', 'Collega')}
                </button>
              </>
            )}
            <button type="button" className={`${dsButton.quiet} h-10 px-4`} disabled={!!lavoro} onClick={() => collega({ crea: true })}>
              <Plus className="h-4 w-4" aria-hidden />{t('fornitore.crea', 'Crea')}
            </button>
          </div>
        </Callout>
      )}

      {f.notaDiCredito && aperto && (
        <Callout tone="info" icon={Ban} action={
          <button type="button" className={`${dsButton.secondary} h-10 px-4`} disabled={!!lavoro} onClick={() => cambiaStato('IGNORATA')}>
            {t('mettiDaParte', 'Metti da parte')}
          </button>
        }>
          {t('notaDiCredito', 'Una nota di credito non carica merce.')}
        </Callout>
      )}

      {f.stato === 'CARICATA' && (
        <Callout tone="positive" icon={PackageCheck} action={
          <button type="button" className={`${dsButton.secondary} h-10 px-4`} disabled={!!lavoro} onClick={() => setConferma('annulla')}>
            <Undo2 className="h-4 w-4" aria-hidden />{t('annulla', 'Annulla carico')}
          </button>
        }>
          {f.caricataAt
            ? t('caricataIl', 'Caricata il {{d}}{{chi}}', { d: dataBreve(f.caricataAt), chi: f.caricataDa ? ` · ${f.caricataDa}` : '' })
            : t('stato.caricata', 'Caricata')}
        </Callout>
      )}

      {f.stato === 'IGNORATA' && (
        <Callout tone="info" action={
          <button type="button" className={`${dsButton.secondary} h-10 px-4`} disabled={!!lavoro} onClick={() => cambiaStato('DA_CONTROLLARE')}>
            <RotateCcw className="h-4 w-4" aria-hidden />{t('riprendi', 'Riprendi')}
          </button>
        }>
          {t('messaDaParte', 'Messa da parte: non entra in magazzino.')}
        </Callout>
      )}

      {merce.length > 0 && (
        <section className="space-y-2">
          <SectionHeader
            meta={merce.length}
            action={aperto && !f.notaDiCredito && daDecidere.length > 1 ? (
              <button type="button" className="text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
                onClick={() => setIgnoraAltre(true)}>
                {t('ignoraAltre', 'Ignora le {{n}} da abbinare', { n: daDecidere.length })}
              </button>
            ) : undefined}
          >
            {t('merce', 'Merce')}
          </SectionHeader>
          <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {merce.map(r => {
              const cliccabile = aperto && !f.notaDiCredito;
              const Riga = cliccabile ? 'button' : 'div';
              return (
                <li key={r.id} className="border-b border-[var(--ds-border)] last:border-b-0">
                  <Riga
                    {...(cliccabile ? { type: 'button' as const, onClick: () => setAperta(r) } : {})}
                    className={`flex w-full flex-col gap-1.5 px-4 py-3 text-left ${cliccabile ? 'transition-colors hover:bg-[var(--ds-surface-row)]' : ''}`}
                  >
                    <div className="flex w-full items-start justify-between gap-3">
                      <span className="min-w-0 text-[14px] font-medium text-[var(--ds-text-primary)]">{r.descrizione || `#${r.numeroLinea}`}</span>
                      <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-primary)]">{formatMoneyUnits(r.prezzoTotale)}</span>
                    </div>
                    <div className="text-[12px] text-[var(--ds-text-muted)]">
                      {[
                        r.quantita != null ? `${qta(r.quantita)} ${(r.unitaMisura || 'pz').toLowerCase()}` : null,
                        formatMoneyUnits(r.prezzoUnitario),
                        t('riga.iva', 'IVA {{p}}%', { p: r.aliquotaIva }),
                        r.lotto ? t('riga.lotto', 'lotto {{lotto}}', { lotto: r.lotto }) : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {decisione(r)}
                  </Riga>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {altre.length > 0 && (
        <section className="space-y-2">
          <button type="button" onClick={() => setAltreAperte(v => !v)} className="text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
            aria-expanded={altreAperte}>
            {altreAperte ? t('altre.chiudi', 'Nascondi le altre righe') : t('altre.apri', 'Altre righe ({{n}})', { n: altre.length })}
          </button>
          {altreAperte && (
            <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
              {altre.map(r => (
                <li key={r.id} className="flex items-start justify-between gap-3 border-b border-[var(--ds-border)] px-4 py-2.5 text-[13px] last:border-b-0">
                  <span className="min-w-0 text-[var(--ds-text-secondary)]">
                    {r.descrizione || t('riga.soloNote', 'Note')}
                    <span className="ml-2 text-[var(--ds-text-muted)]">{t(`tipo.${r.tipo}`, r.tipo)}</span>
                  </span>
                  {r.prezzoTotale !== 0 && <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-primary)]">{formatMoneyUnits(r.prezzoTotale)}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {aperto && f.stato !== 'CARICATA' && (
        <div className="flex justify-start">
          <button type="button" onClick={() => setConferma('elimina')} className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ds-critical-text)] hover:underline">
            <Trash2 className="h-4 w-4" aria-hidden />{t('elimina', 'Togli la fattura')}
          </button>
        </div>
      )}

      {aperto && !f.notaDiCredito && merce.length > 0 && (
        // Appiccicato in fondo alla pagina che scorre (il riquadro del
        // Magazzino), così con 49 righe il tasto resta sotto il pollice.
        <div className="sticky bottom-0 z-10 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-raised)]">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            {areeDelCarico.map(area => (
              <Field key={area} label={t('cella', 'Cella {{area}}', { area: t(`area.${area}`, area.toLowerCase()) })} className="md:w-48">
                <select className={dsSelect} value={celleScelte[area] ?? ''} onChange={e => setCelleScelte(prev => ({ ...prev, [area]: Number(e.target.value) || undefined }))}>
                  {celle.filter(c => c.area === area).length === 0 && <option value="">{t('nessunaCella', 'Nessuna cella')}</option>}
                  {celle.filter(c => c.area === area).map(c => <option key={c.id} value={c.id}>{toTitleCase(c.name)}</option>)}
                </select>
              </Field>
            ))}
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
              <span className="text-[13px] text-[var(--ds-text-muted)]">
                {daDecidere.length > 0
                  ? t('mancano', 'Mancano {{count}} righe', { count: daDecidere.length })
                  : [
                      inMagazzino.length > 0 ? t('riepilogo.carico', '{{count}} in magazzino', { count: inMagazzino.length }) : null,
                      merce.length > inMagazzino.length ? t('riepilogo.ignorate', '{{count}} ignorate', { count: merce.length - inMagazzino.length }) : null,
                    ].filter(Boolean).join(' · ')}
              </span>
              <button type="button" onClick={caricaInMagazzino} className={`${dsButton.primary} w-full whitespace-nowrap sm:w-auto`}
                disabled={daDecidere.length > 0 || lavoro != null || areeDelCarico.some(a => !celleScelte[a])}>
                {lavoro === 'carica' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PackageCheck className="h-4 w-4" aria-hidden />}
                {inMagazzino.length === 0 && daDecidere.length === 0 ? t('chiudi', 'Chiudi la fattura') : t('caricaInMagazzino', 'Carica in magazzino')}
              </button>
            </div>
          </div>
        </div>
      )}

      <AbbinaRiga
        fatturaId={f.id}
        riga={aperta}
        prodotti={prodotti}
        unitaCostoProdotti={f.unitaCostoProdotti ?? {}}
        foodCost={f.foodCost}
        onClose={() => setAperta(null)}
        onSaved={r => { aggiornaRiga(r); setAperta(null); }}
        onProdottoCreato={p => setProdotti(prev => [...prev, p])}
        showToast={showToast}
      />

      <ModalShell
        open={ignoraAltre}
        onClose={() => setIgnoraAltre(false)}
        title={t('ignoraAltreTitolo', 'Ignora {{n}} righe', { n: daDecidere.length })}
        size="sm"
        closeOnEscape
        bodyClassName="p-5"
        footer={
          <button type="button" className={dsButton.primary} disabled={lavoro != null} onClick={ignoraLeAltre}>
            {lavoro === 'altre' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Ban className="h-4 w-4" aria-hidden />}
            {t('ignora', 'Ignora')}
          </button>
        }
      >
        <Field label={t('abbina.categoria', 'Conta nella spesa come')}>
          <div className="flex flex-wrap gap-2">
            {CATEGORIE_SPESA.map(c => (
              <button key={c.value} type="button" onClick={() => setCategoriaAltre(c.value)} aria-pressed={categoriaAltre === c.value}
                className={`h-10 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors ${
                  categoriaAltre === c.value
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                }`}>
                {t(`categoria.${c.value}`, c.label)}
              </button>
            ))}
          </div>
        </Field>
      </ModalShell>

      <ConfirmDeleteModal
        isOpen={conferma === 'annulla'}
        title={t('annullaTitolo', 'Annullare il carico?')}
        message={t('annullaTesto', 'La merce esce dal magazzino con una rettifica e la fattura torna da controllare. I prezzi restano nello storico.')}
        confirmLabel={t('annulla', 'Annulla carico')}
        cancelLabel={t('lascia', 'Lascia')}
        showIrreversibleWarning={false}
        onConfirm={annulla}
        onCancel={() => setConferma(null)}
      />
      <ConfirmDeleteModal
        isOpen={conferma === 'elimina'}
        title={t('eliminaTitolo', 'Togliere la fattura?')}
        message={t('eliminaTesto', 'Sparisce dall\'elenco; la puoi ricaricare dal file.')}
        confirmLabel={t('elimina', 'Togli la fattura')}
        cancelLabel={t('lascia', 'Lascia')}
        showIrreversibleWarning={false}
        onConfirm={elimina}
        onCancel={() => setConferma(null)}
      />
    </div>
  );
};
