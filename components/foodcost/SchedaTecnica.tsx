import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Plus, Search, Trash2, Wand2 } from 'lucide-react';
import { Callout, Field, FormCard, ModalShell, SegmentedControl, Stepper, dsButton, dsInput } from '../ds';
import type { FoodCostState } from '../../hooks/useFoodCost';
import { foodCostApiService, type FcIngrediente, type FcRigaBozza } from '../../services/foodCostApiService';
import { money, moneySymbol } from '../../utils/displayMoney';
import {
  CicloRicettaError,
  RicettaTroppoProfondaError,
  UNITA_QUANTITA,
  foodCostPct,
  margineCents,
  prezzoConsigliatoEuro,
  semaforo,
  type EsitoCosto,
  type RigaFc,
  type UnitaCosto,
} from '../../utils/foodCost';
import { FoodCostPill } from './FoodCostPill';

/* La scheda tecnica di un piatto o di un semilavorato: ingredienti, quantità
   nette, e il costo che si muove mentre si scrive. I conti sono quelli di
   utils/foodCost.ts, sugli stessi dati del server; il salvataggio sostituisce
   tutte le righe in un colpo.

   Un ingrediente nuovo si crea da qui e va nel magazzino (area cucina); un
   prezzo che manca si scrive sulla riga, senza cambiare pagina.

   Una scheda vuota si può far scrivere all'AI: la bozza riempie le righe,
   segnate con la bacchetta, e diventa una scheda solo col Salva. Gli
   ingredienti che il magazzino non ha restano proposte finché lo chef non li
   crea o non ne sceglie uno che c'è già. */

export type SchedaTarget =
  | { kind: 'piatto'; dish: { id: number; name: string; price: number; vat_rate?: number; sold_by_weight?: boolean } }
  | { kind: 'preparazione'; ingrediente: FcIngrediente };

interface RigaEdit {
  key: string;
  productId: number | null;
  quantita: string;
  note: string;
  /** Proposta dall'AI e non ancora toccata. */
  daAi?: boolean;
  /** L'unità che la quantità dell'AI presuppone, per un ingrediente che non ne ha. */
  unitaProposta?: UnitaCosto | null;
  /** L'ingrediente nuovo che l'AI propone, finché non lo si crea o sceglie. */
  nomeProposto?: string | null;
}

const parseDec = (s: string): number | null => {
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const fmtNum = (n: number | null | undefined): string =>
  n == null ? '' : String(Math.round(n * 1000) / 1000).replace('.', ',');

/** Confronto senza maiuscole né accenti: «pomodoro» trova «Pomodóro». */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* I campi dentro una riga (che è già grigia): bianchi, o sparirebbero nella
   riga. Si sostituisce lo sfondo invece di aggiungerne un secondo, perché fra
   due utility bg-* vince l'ordine del foglio di stile, non quello della
   stringa. */
const inputSuRiga = dsInput.replace('bg-[var(--ds-surface-row)]', 'bg-[var(--ds-surface)]');

let keySeq = 0;
const nuovaChiave = () => `r${++keySeq}`;

/** Le righe di una bozza dell'AI nell'editor. Una bozza preparata in blocco
 *  può essere di qualche ora fa: un ingrediente nuovo creato nel frattempo
 *  si aggancia per nome, uno cancellato sparisce, e una quantità in un'unità
 *  che l'ingrediente non usa più va riscritta. */
const righeDaBozza = (righe: FcRigaBozza[], fc: FoodCostState): RigaEdit[] => {
  const perNome = new Map((fc.dati?.ingredienti ?? []).map(i => [norm(i.nome).trim(), i]));
  return righe.flatMap(r => {
    const ing = r.productId != null
      ? fc.ingredienti.get(r.productId)
      : (r.nomeNuovo ? perNome.get(norm(r.nomeNuovo).trim()) : undefined);
    if (r.productId != null && !ing) return [];
    const conflitto = ing?.unitaCosto != null && ing.unitaCosto !== r.unita;
    return [{
      key: nuovaChiave(),
      productId: ing?.id ?? null,
      quantita: conflitto ? '' : fmtNum(r.quantita),
      note: r.nota ?? '',
      daAi: !conflitto,
      unitaProposta: conflitto ? null : r.unita,
      nomeProposto: ing ? null : r.nomeNuovo,
    }];
  });
};

export const SchedaTecnica: React.FC<{
  open: boolean;
  onClose: () => void;
  fc: FoodCostState;
  target: SchedaTarget | null;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ open, onClose, fc, target, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const canManage = fc.dati?.canManage === true;
  const targetPct = fc.dati?.impostazioni.targetPct ?? 30;

  const [righe, setRighe] = useState<RigaEdit[]>([]);
  const [porzioni, setPorzioni] = useState<number>(1);
  const [costoManuale, setCostoManuale] = useState('');
  const [resaQuantita, setResaQuantita] = useState('');
  const [unitaPrep, setUnitaPrep] = useState<UnitaCosto>('kg');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);
  /** Gli avvisi della bozza dell'AI; null finché non se ne chiede una. */
  const [avvisiAi, setAvvisiAi] = useState<string[] | null>(null);
  /** La bozza viene da quelle preparate in blocco: si può scartare. */
  const [bozzaSalvata, setBozzaSalvata] = useState(false);
  const [scartando, setScartando] = useState(false);

  // Si inizializza all'apertura, non a ogni ricarica dei dati: un prezzo
  // salvato da una riga non deve cancellare quello che si sta scrivendo.
  const targetKey = target ? (target.kind === 'piatto' ? `d${target.dish.id}` : `p${target.ingrediente.id}`) : '';
  useEffect(() => {
    if (!open || !target) return;
    setError(null);
    setAvvisiAi(null);
    setGenerando(false);
    setBozzaSalvata(false);
    const salvate = target.kind === 'piatto'
      ? fc.righePiatto.get(target.dish.id) ?? []
      : fc.righePreparazione.get(target.ingrediente.id) ?? [];
    setRighe(salvate.map(r => ({ key: nuovaChiave(), productId: r.productId, quantita: fmtNum(r.quantita), note: r.note ?? '' })));
    if (target.kind === 'piatto') {
      const meta = fc.dati?.piatti.find(p => p.dishId === target.dish.id);
      setPorzioni(meta?.porzioni ?? 1);
      setCostoManuale(meta?.costoManualeCents != null ? fmtNum(meta.costoManualeCents / 100) : '');
      // Una scheda vuota con la sua bozza preparata in blocco si apre già
      // riempita: è lo stesso stato di una bozza appena chiesta.
      const bozza = fc.bozze.get(target.dish.id);
      if (bozza && salvate.length === 0 && meta?.costoManualeCents == null) {
        setRighe(righeDaBozza(bozza.righe, fc));
        setPorzioni(bozza.porzioni);
        setAvvisiAi(bozza.avvisi);
        setBozzaSalvata(true);
      }
    } else {
      setResaQuantita(fmtNum(target.ingrediente.resaQuantita));
      setUnitaPrep(target.ingrediente.unitaCosto ?? 'kg');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  const righeFc: RigaFc[] = useMemo(
    () => righe
      .map(r => ({ productId: r.productId, quantita: parseDec(r.quantita) }))
      .filter((r): r is RigaFc => r.productId != null && r.quantita != null && r.quantita > 0),
    [righe],
  );

  const esito: { totale: EsitoCosto | null; ciclo: boolean } = useMemo(() => {
    if (!fc.calc) return { totale: null, ciclo: false };
    try {
      return { totale: fc.calc.costoRighe(righeFc), ciclo: false };
    } catch (err) {
      if (err instanceof CicloRicettaError || err instanceof RicettaTroppoProfondaError) return { totale: null, ciclo: true };
      throw err;
    }
  }, [fc.calc, righeFc]);

  const costoRiga = (r: RigaEdit): number | null => {
    const q = parseDec(r.quantita);
    if (!fc.calc || r.productId == null || q == null || q <= 0) return null;
    try {
      return fc.calc.costoRiga({ productId: r.productId, quantita: q });
    } catch {
      return null;
    }
  };

  if (!target) return null;

  const isPiatto = target.kind === 'piatto';
  const nome = isPiatto ? target.dish.name : target.ingrediente.nome;
  const escluso = isPiatto ? null : target.ingrediente.id;

  // ---- Numeri in testa --------------------------------------------------------
  const manualeCents = (() => {
    const n = parseDec(costoManuale);
    return n != null && n >= 0 ? Math.round(n * 100) : null;
  })();
  let costoPorzione: number | null = null;
  if (isPiatto) {
    if (righeFc.length > 0) costoPorzione = esito.totale?.cents != null ? esito.totale.cents / Math.max(1, porzioni) : null;
    else costoPorzione = manualeCents;
  }
  const prezzo = isPiatto ? Number(target.dish.price) || 0 : 0;
  const iva = isPiatto ? (target.dish.vat_rate ?? 10) : 0;
  const pct = isPiatto ? foodCostPct(costoPorzione, prezzo, iva) : null;
  const margine = isPiatto ? margineCents(costoPorzione, prezzo, iva) : null;
  const consigliato = isPiatto ? prezzoConsigliatoEuro(costoPorzione, targetPct, iva) : null;
  const resaPrep = parseDec(resaQuantita);
  const costoUnitaPrep = !isPiatto && esito.totale?.cents != null && resaPrep && resaPrep > 0
    ? esito.totale.cents / (unitaPrep === 'pz' ? resaPrep : resaPrep / 1000)
    : null;
  const mancanti = (esito.totale?.mancanti ?? []).map(id => fc.ingredienti.get(id)?.nome).filter(Boolean) as string[];

  // ---- Azioni -----------------------------------------------------------------
  // La bacchetta resta finché la quantità è quella dell'AI.
  const aggiorna = (key: string, patch: Partial<RigaEdit>) =>
    setRighe(prev => prev.map(r => (r.key === key
      ? { ...r, ...patch, ...('quantita' in patch && !('daAi' in patch) ? { daAi: false } : {}) }
      : r)));
  const togli = (key: string) => setRighe(prev => prev.filter(r => r.key !== key));
  const aggiungi = () => setRighe(prev => [...prev, { key: nuovaChiave(), productId: null, quantita: '', note: '' }]);

  // Una bozza per apertura: rifarla darebbe la stessa risposta, pagata due volte.
  const puoBozza = canManage && fc.dati?.aiDisponibile === true && righe.length === 0 && avvisiAi === null
    && (isPiatto ? !costoManuale.trim() : true);

  const generaBozza = async () => {
    if (!puoBozza || generando) return;
    setGenerando(true);
    setError(null);
    try {
      const bozza = await foodCostApiService.bozzaScheda(isPiatto
        ? { piattoId: target.dish.id, porzioni }
        : { preparazioneId: target.ingrediente.id });
      setRighe(righeDaBozza(bozza.righe, fc));
      // La resa del semilavorato solo se parla la stessa unità di come si usa.
      if (!isPiatto && bozza.resaQuantita != null && bozza.resaUnita
        && (!target.ingrediente.unitaCosto || target.ingrediente.unitaCosto === bozza.resaUnita)) {
        setUnitaPrep(bozza.resaUnita);
        setResaQuantita(fmtNum(bozza.resaQuantita));
      }
      setAvvisiAi(bozza.avvisi ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerando(false);
    }
  };

  const scartaBozza = async () => {
    if (!isPiatto || scartando) return;
    setScartando(true);
    try {
      await foodCostApiService.scartaBozza(target.dish.id);
      fc.reload();
      setRighe([]);
      setAvvisiAi(null);
      setBozzaSalvata(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScartando(false);
    }
  };

  const salva = async () => {
    if (!canManage || saving) return;
    const incomplete = righe.some(r => r.productId == null || !(parseDec(r.quantita)! > 0));
    if (incomplete) {
      setError(t('editor.rowIncomplete', 'Ogni riga vuole un ingrediente e una quantità'));
      return;
    }
    if (esito.ciclo) {
      setError(t('editor.cycle', 'Questa ricetta finirebbe per contenere sé stessa'));
      return;
    }
    // L'unità proposta va col salvataggio solo per chi non ne ha una: è la
    // prima scheda a fissarla, così la quantità non resta ambigua.
    const payload = righe.map(r => ({
      productId: r.productId!,
      quantita: parseDec(r.quantita)!,
      note: r.note.trim() || null,
      unita: fc.ingredienti.get(r.productId!)?.unitaCosto ? null : r.unitaProposta ?? null,
    }));
    setSaving(true);
    setError(null);
    try {
      if (isPiatto) {
        await foodCostApiService.salvaSchedaPiatto(target.dish.id, {
          righe: payload,
          porzioni,
          costoManualeCents: payload.length === 0 ? manualeCents : null,
        });
      } else {
        if (!resaPrep || resaPrep <= 0) {
          setError(t('editor.yieldRequired', 'Scrivi quanto rende la ricetta'));
          setSaving(false);
          return;
        }
        await foodCostApiService.salvaSchedaPreparazione(target.ingrediente.id, {
          righe: payload,
          resaQuantita: resaPrep,
          unitaCosto: unitaPrep,
        });
      }
      fc.reload();
      showToast?.(t('editor.saved', 'Scheda salvata'), 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const tono = semaforo(pct, targetPct);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="md"
      fixedHeight
      title={nome}
      subtitle={isPiatto ? t('editor.subtitleDish', 'Scheda tecnica') : t('editor.subtitlePrep', 'Semilavorato')}
      bodyClassName="p-4 sm:p-6 space-y-4"
      footerNote={error ? <span className="text-[var(--ds-critical-text)]">{error}</span> : undefined}
      footer={canManage ? (
        <>
          <button type="button" className={dsButton.secondary} onClick={onClose}>{t('editor.cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={salva} disabled={saving}>
            {saving ? t('editor.saving', 'Salvataggio…') : t('editor.save', 'Salva')}
          </button>
        </>
      ) : (
        <button type="button" className={dsButton.secondary} onClick={onClose}>{t('editor.close', 'Chiudi')}</button>
      )}
    >
      {/* Il conto, sempre in vista: è quello per cui si apre la scheda. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {isPiatto ? (
          <>
            <Numero
              label={target.dish.sold_by_weight ? t('editor.costPerKg', 'Costo al kg venduto') : t('editor.costPortion', 'Costo porzione')}
              value={costoPorzione == null ? '—' : money(Math.round(costoPorzione))}
            />
            <Numero label={t('editor.foodCost', 'Food cost')} value={<FoodCostPill pct={pct} tone={tono} />} />
            <Numero label={t('editor.margin', 'Margine')} value={margine == null ? '—' : money(Math.round(margine))} />
            <Numero
              label={t('editor.suggested', 'Prezzo per stare al {{pct}}%', { pct: targetPct })}
              value={consigliato == null ? '—' : money(Math.round(consigliato * 100))}
            />
          </>
        ) : (
          <>
            <Numero label={t('editor.recipeCost', 'Costo ricetta')} value={esito.totale?.cents == null ? '—' : money(Math.round(esito.totale.cents))} />
            <Numero
              label={t('editor.costPerUnit', 'Costo al {{unit}}', { unit: unitaPrep === 'pz' ? t('unit.piece', 'pezzo') : unitaPrep === 'l' ? t('unit.liter', 'litro') : 'kg' })}
              value={costoUnitaPrep == null ? '—' : money(Math.round(costoUnitaPrep))}
            />
          </>
        )}
      </div>

      {esito.ciclo && (
        <Callout tone="critical" icon={AlertCircle}>{t('editor.cycle', 'Questa ricetta finirebbe per contenere sé stessa')}</Callout>
      )}
      {mancanti.length > 0 && (
        <Callout tone="pending" icon={AlertCircle}>
          {t('editor.missing', 'Senza prezzo: {{names}}. Il costo è per difetto.', { names: mancanti.join(', ') })}
        </Callout>
      )}

      {avvisiAi !== null && (
        <div className="ds-ai-frame">
          <div className="ds-ai-card flex items-start gap-2.5 px-3.5 py-3">
            <Wand2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-arriving-text)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-[var(--ds-text-primary)]">
                {righe.length > 0
                  ? t('ai.draftTitle', 'Bozza dell\'AI: controlla ingredienti e grammature, poi salva')
                  : t('ai.draftEmpty', 'L\'AI non ha proposto ingredienti')}
              </p>
              {avvisiAi.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--ds-text-secondary)]">
                  {avvisiAi.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
            </div>
            {bozzaSalvata && canManage && (
              <button
                type="button"
                onClick={scartaBozza}
                disabled={scartando}
                className="-my-1 inline-flex h-11 flex-shrink-0 items-center rounded-[var(--ds-radius-control)] px-3 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface)] hover:text-[var(--ds-critical-text)] disabled:opacity-40"
              >
                {t('ai.discard', 'Scarta')}
              </button>
            )}
          </div>
        </div>
      )}

      <FormCard
        title={t('editor.ingredients', 'Ingredienti')}
        aside={<span className="text-[13px] text-[var(--ds-text-muted)]">{t('editor.netQty', 'Quantità nette')}</span>}
      >
        {righe.length === 0 && (
          <p className="mb-3 text-[14px] text-[var(--ds-text-muted)]">
            {isPiatto
              ? t('editor.emptyDish', 'Nessun ingrediente. Per un piatto comprato fatto (acqua, vino, dolci) basta il costo a mano qui sotto.')
              : t('editor.emptyPrep', 'Nessun ingrediente.')}
          </p>
        )}
        {puoBozza && (generando ? (
          <div className="mb-3 flex min-h-[44px] items-center gap-2" role="status">
            <Wand2 className="ds-ai-wand h-4 w-4 text-[var(--ds-arriving-text)]" aria-hidden />
            <span className="ds-ai-shimmer text-[14px]">{t('ai.writing', 'Scrivo la bozza…')}</span>
          </div>
        ) : (
          /* Wand2 + famiglia arriving: è AI che propone (§ds). */
          <button
            type="button"
            onClick={generaBozza}
            className="mb-3 inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-tint)] px-4 text-[15px] font-semibold text-[var(--ds-arriving-text)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Wand2 className="h-4 w-4" aria-hidden /> {t('ai.draft', 'Bozza con l\'AI')}
          </button>
        ))}
        <ul className="space-y-3">
          {righe.map(r => (
            <RigaEditor
              key={r.key}
              riga={r}
              fc={fc}
              escluso={escluso}
              readOnly={!canManage}
              costo={costoRiga(r)}
              onChange={patch => aggiorna(r.key, patch)}
              onRemove={() => togli(r.key)}
              showToast={showToast}
            />
          ))}
        </ul>
        {canManage && (
          <button type="button" onClick={aggiungi} className={`${dsButton.quiet} mt-3 w-full sm:w-auto`}>
            <Plus className="h-4 w-4" aria-hidden /> {t('editor.addIngredient', 'Aggiungi ingrediente')}
          </button>
        )}
      </FormCard>

      {isPiatto ? (
        <FormCard title={t('editor.portionsTitle', 'Resa')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('editor.portions', 'Porzioni della ricetta')} hint={t('editor.portionsHint', 'La teglia di lasagne da 8: scrivi 8.')}>
              {canManage
                ? <Stepper value={porzioni} onChange={v => setPorzioni(Math.max(1, v ?? 1))} min={1} max={500} ariaLabel={t('editor.portions', 'Porzioni della ricetta')} />
                : <p className="text-[15px] text-[var(--ds-text-primary)]">{porzioni}</p>}
            </Field>
            {righe.length === 0 && (
              <Field label={t('editor.manualCost', 'Costo a mano')} htmlFor="fc-manuale" hint={t('editor.manualCostHint', 'Per porzione, IVA esclusa')}>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
                  <input
                    id="fc-manuale"
                    inputMode="decimal"
                    className={`${dsInput} pl-9`}
                    value={costoManuale}
                    disabled={!canManage}
                    onChange={e => setCostoManuale(e.target.value)}
                    placeholder="0,00"
                  />
                </div>
              </Field>
            )}
          </div>
        </FormCard>
      ) : (
        <FormCard title={t('editor.portionsTitle', 'Resa')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('editor.prepUnit', 'Si usa a')}>
              <SegmentedControl<UnitaCosto>
                value={unitaPrep}
                onChange={v => canManage && setUnitaPrep(v)}
                ariaLabel={t('editor.prepUnit', 'Si usa a')}
                options={[
                  { value: 'kg', label: t('unit.kg', 'kg') },
                  { value: 'l', label: t('unit.l', 'litri') },
                  { value: 'pz', label: t('unit.pz', 'pezzi') },
                ]}
              />
            </Field>
            <Field label={t('editor.yield', 'La ricetta rende')} htmlFor="fc-resa">
              <div className="relative">
                <input
                  id="fc-resa"
                  inputMode="decimal"
                  className={`${dsInput} pr-12`}
                  value={resaQuantita}
                  disabled={!canManage}
                  onChange={e => setResaQuantita(e.target.value)}
                  placeholder="0"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">{UNITA_QUANTITA[unitaPrep]}</span>
              </div>
            </Field>
          </div>
        </FormCard>
      )}
    </ModalShell>
  );
};

const Numero: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="min-w-0 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface)] px-3 py-2.5">
    <p className="truncate text-[12px] text-[var(--ds-text-muted)]">{label}</p>
    <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{value}</div>
  </div>
);

// ---- Una riga ------------------------------------------------------------------

const RigaEditor: React.FC<{
  riga: RigaEdit;
  fc: FoodCostState;
  escluso: number | null;
  readOnly: boolean;
  costo: number | null;
  onChange: (patch: Partial<RigaEdit>) => void;
  onRemove: () => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ riga, fc, escluso, readOnly, costo, onChange, onRemove, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [cercando, setCercando] = useState(false);
  const ing = riga.productId != null ? fc.ingredienti.get(riga.productId) : undefined;
  const unitaRiga = ing?.unitaCosto ?? riga.unitaProposta ?? null;
  const unita = unitaRiga ? UNITA_QUANTITA[unitaRiga] : null;
  const senzaPrezzo = ing != null && (!ing.unitaCosto || (!ing.isPreparazione && ing.costoCents == null));

  // Scelto un ingrediente che si conta in un'altra unità, la quantità
  // dell'AI non vale più: va riscritta.
  const scegli = (id: number) => {
    const scelto = fc.ingredienti.get(id);
    const conflitto = riga.unitaProposta != null && scelto?.unitaCosto != null && scelto.unitaCosto !== riga.unitaProposta;
    onChange({ productId: id, ...(conflitto ? { quantita: '', daAi: false, unitaProposta: null } : {}) });
  };

  return (
    <li className="rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          {riga.productId == null && !readOnly
            ? (riga.nomeProposto && !cercando
              ? <PropostaNuovo nome={riga.nomeProposto} unita={riga.unitaProposta ?? null} fc={fc} escluso={escluso} onPick={scegli} onCerca={() => setCercando(true)} showToast={showToast} />
              : <ScegliIngrediente fc={fc} escluso={escluso} onPick={scegli} showToast={showToast} iniziale={riga.nomeProposto} unitaIniziale={riga.unitaProposta} />)
            : (
              <p className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                {riga.daAi && <Wand2 className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-[var(--ds-arriving-text)]" aria-hidden />}
                {ing?.nome ?? t('editor.unknown', 'Ingrediente rimosso')}
                {ing?.isPreparazione && <span className="ml-2 text-[13px] font-normal text-[var(--ds-text-muted)]">{t('editor.prepTag', 'semilavorato')}</span>}
              </p>
            )}
        </div>
        <div className="relative w-28 flex-shrink-0">
          <input
            inputMode="decimal"
            aria-label={t('editor.qty', 'Quantità')}
            className={`${inputSuRiga} pr-10 text-right tabular-nums`}
            value={riga.quantita}
            disabled={readOnly}
            onChange={e => onChange({ quantita: e.target.value })}
            placeholder="0"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">{unita ?? ''}</span>
        </div>
        <span className="w-20 flex-shrink-0 text-right text-[15px] tabular-nums text-[var(--ds-text-secondary)]">
          {costo == null ? '—' : money(Math.round(costo))}
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('editor.removeRow', 'Togli ingrediente')}
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface)] hover:text-[var(--ds-critical-text)]"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {senzaPrezzo && !readOnly && ing && !ing.isPreparazione && (
        <PrezzoVeloce ingrediente={ing} fc={fc} showToast={showToast} unitaIniziale={riga.unitaProposta} />
      )}
    </li>
  );
};

/** Il prezzo che manca, scritto sulla riga. */
export const PrezzoVeloce: React.FC<{
  ingrediente: FcIngrediente;
  fc: FoodCostState;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** L'unità da proporre quando l'ingrediente non ne ha (quella della bozza). */
  unitaIniziale?: UnitaCosto | null;
}> = ({ ingrediente, fc, showToast, unitaIniziale }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [unita, setUnita] = useState<UnitaCosto>(ingrediente.unitaCosto ?? unitaIniziale ?? 'kg');
  const [prezzo, setPrezzo] = useState('');
  const [saving, setSaving] = useState(false);
  const salva = async () => {
    const n = parseDec(prezzo);
    if (n == null || n < 0) return;
    setSaving(true);
    try {
      await foodCostApiService.aggiornaIngrediente(ingrediente.id, { costoCents: Math.round(n * 100), unitaCosto: unita });
      fc.reload();
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-[var(--ds-pending-text)]">{t('editor.noPrice', 'Manca il prezzo')}</span>
      <div className="relative w-28">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
        <input
          inputMode="decimal"
          aria-label={t('editor.price', 'Prezzo')}
          className={`${inputSuRiga} pl-8 tabular-nums`}
          value={prezzo}
          onChange={e => setPrezzo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') salva(); }}
          placeholder="0,00"
        />
      </div>
      <SegmentedControl<UnitaCosto>
        size="sm"
        value={unita}
        onChange={setUnita}
        ariaLabel={t('editor.priceUnit', 'Prezzo al')}
        equalWidth={false}
        options={[
          { value: 'kg', label: t('unit.perKg', 'al kg') },
          { value: 'l', label: t('unit.perL', 'al litro') },
          { value: 'pz', label: t('unit.perPz', 'al pezzo') },
        ]}
      />
      <button type="button" className={dsButton.secondary} disabled={saving || parseDec(prezzo) == null} onClick={salva}>
        {t('editor.savePrice', 'Salva prezzo')}
      </button>
    </div>
  );
};

// ---- Ingrediente nuovo proposto dall'AI ---------------------------------------------

/** Un ingrediente che l'AI propone e il magazzino non ha: si crea con un
 *  tocco, si sceglie fra quelli che gli somigliano, o si cerca. Mai creato
 *  da solo. */
const PropostaNuovo: React.FC<{
  nome: string;
  unita: UnitaCosto | null;
  fc: FoodCostState;
  escluso: number | null;
  onPick: (id: number) => void;
  onCerca: () => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ nome, unita, fc, escluso, onPick, onCerca, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [busy, setBusy] = useState(false);
  const simili = useMemo(() => {
    const parole = norm(nome).split(/\s+/).filter(w => w.length >= 4);
    if (parole.length === 0) return [];
    return (fc.dati?.ingredienti ?? [])
      .filter(i => i.id !== escluso && parole.some(w => norm(i.nome).includes(w)))
      .slice(0, 3);
  }, [nome, fc.dati, escluso]);

  const crea = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nuovo = await foodCostApiService.creaIngrediente({ nome, unitaCosto: unita ?? 'kg' });
      fc.reload();
      onPick(nuovo.id);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
        <Wand2 className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-[var(--ds-arriving-text)]" aria-hidden />
        {nome}
        <span className="ml-2 text-[13px] font-normal text-[var(--ds-text-muted)]">{t('ai.newTag', 'nuovo')}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={dsButton.secondary} disabled={busy} onClick={crea}>
          <Plus className="h-4 w-4" aria-hidden /> {t('ai.create', 'Crea')}
        </button>
        {simili.map(i => (
          <button key={i.id} type="button" className={`${dsButton.secondary} max-w-full`} onClick={() => onPick(i.id)}>
            <span className="truncate">{i.nome}</span>
          </button>
        ))}
        <button type="button" className={dsButton.secondary} onClick={onCerca} aria-label={t('ai.search', 'Cerca un ingrediente')}>
          <Search className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
};

// ---- Scelta dell'ingrediente ------------------------------------------------------

const ScegliIngrediente: React.FC<{
  fc: FoodCostState;
  escluso: number | null;
  onPick: (id: number) => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** La ricerca già scritta (il nome proposto dall'AI). */
  iniziale?: string | null;
  unitaIniziale?: UnitaCosto | null;
}> = ({ fc, escluso, onPick, showToast, iniziale, unitaIniziale }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [q, setQ] = useState(iniziale ?? '');
  const [creando, setCreando] = useState(false);
  const [unita, setUnita] = useState<UnitaCosto>(unitaIniziale ?? 'kg');
  const [prezzo, setPrezzo] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const trovati = useMemo(() => {
    const n = norm(q.trim());
    const tutti = (fc.dati?.ingredienti ?? []).filter(i => i.id !== escluso);
    if (!n) return tutti.slice(0, 8);
    return tutti.filter(i => norm(i.nome).includes(n)).slice(0, 8);
  }, [q, fc.dati, escluso]);
  const esatto = trovati.some(i => norm(i.nome) === norm(q.trim()));

  const crea = async () => {
    const nome = q.trim();
    if (!nome || busy) return;
    const n = parseDec(prezzo);
    setBusy(true);
    try {
      const nuovo = await foodCostApiService.creaIngrediente({
        nome,
        unitaCosto: unita,
        costoCents: n != null && n >= 0 ? Math.round(n * 100) : null,
      });
      fc.reload();
      onPick(nuovo.id);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        className={inputSuRiga}
        value={q}
        onChange={e => { setQ(e.target.value); setCreando(false); }}
        placeholder={t('editor.searchIngredient', 'Cerca o crea un ingrediente')}
        aria-label={t('editor.searchIngredient', 'Cerca o crea un ingrediente')}
      />
      {!creando && (
        <ul className="max-h-56 overflow-y-auto rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface)]">
          {trovati.map(i => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => onPick(i.id)}
                className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 text-left text-[15px] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]"
              >
                <span className="truncate">{i.nome}{i.isPreparazione && <span className="ml-2 text-[13px] text-[var(--ds-text-muted)]">{t('editor.prepTag', 'semilavorato')}</span>}</span>
                <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                  {i.costoCents != null && i.unitaCosto ? `${money(i.costoCents)}/${i.unitaCosto}` : ''}
                </span>
              </button>
            </li>
          ))}
          {q.trim() && !esatto && (
            <li>
              <button
                type="button"
                onClick={() => setCreando(true)}
                className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-[15px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]"
              >
                <Plus className="h-4 w-4" aria-hidden /> {t('editor.create', 'Crea «{{name}}»', { name: q.trim() })}
              </button>
            </li>
          )}
        </ul>
      )}
      {creando && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface)] p-2">
          <SegmentedControl<UnitaCosto>
            size="sm"
            value={unita}
            onChange={setUnita}
            ariaLabel={t('editor.priceUnit', 'Prezzo al')}
            equalWidth={false}
            options={[
              { value: 'kg', label: t('unit.perKg', 'al kg') },
              { value: 'l', label: t('unit.perL', 'al litro') },
              { value: 'pz', label: t('unit.perPz', 'al pezzo') },
            ]}
          />
          <div className="relative w-28">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
            <input
              inputMode="decimal"
              aria-label={t('editor.price', 'Prezzo')}
              className={`${dsInput} pl-8 tabular-nums`}
              value={prezzo}
              onChange={e => setPrezzo(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <button type="button" className={dsButton.primary} disabled={busy} onClick={crea}>
            {t('editor.createShort', 'Crea')}
          </button>
        </div>
      )}
    </div>
  );
};
