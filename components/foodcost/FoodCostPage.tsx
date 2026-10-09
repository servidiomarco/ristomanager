import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChefHat, History, Plus, Wand2 } from 'lucide-react';
import {
  Callout, EmptyState, Field, FormCard, ModalShell, SearchField, SegmentedControl, StatStrip, dsButton, dsInput, useMediaQuery,
} from '../ds';
import type { Dish } from '../../types';
import { useFoodCost, type FoodCostState } from '../../hooks/useFoodCost';
import {
  foodCostApiService, type FcImpostazioni, type FcIngrediente, type FcPrezzoStorico,
} from '../../services/foodCostApiService';
import { money, moneySymbol } from '../../utils/displayMoney';
import {
  UNITA_QUANTITA, foodCostPct, margineCents, semaforo, type CostoPiatto, type UnitaCosto,
} from '../../utils/foodCost';
import { FoodCostPill } from './FoodCostPill';
import { SchedaTecnica, type SchedaTarget } from './SchedaTecnica';

/* Food cost: quanto costa ogni piatto e quanto rende. Quattro schede — i
   piatti con il loro food cost, gli ingredienti con il prezzo, i
   semilavorati, e (per chi gestisce) target e regole dei banchetti.

   Gli ingredienti sono i prodotti del magazzino: un prezzo scritto qui resta
   sul prodotto, e lo storico tiene ogni cambio. */

type Tab = 'piatti' | 'ingredienti' | 'semilavorati' | 'impostazioni';
type Filtro = 'tutti' | 'senza' | 'incompleti' | 'sopra' | 'bozze';
type Toast = (message: string, type?: 'success' | 'error' | 'info') => void;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const parseDec = (s: string): number | null => {
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const centsToInput = (c: number | null): string => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export const FoodCostPage: React.FC<{ dishes: Dish[]; showToast: Toast }> = ({ dishes, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const fc = useFoodCost();
  const [tab, setTab] = useState<Tab>('piatti');
  const [scheda, setScheda] = useState<SchedaTarget | null>(null);
  const canManage = fc.dati?.canManage === true;

  const options: Array<{ value: Tab; label: string }> = [
    { value: 'piatti', label: t('tab.dishes', 'Piatti') },
    { value: 'ingredienti', label: t('tab.ingredients', 'Ingredienti') },
    { value: 'semilavorati', label: t('tab.preps', 'Semilavorati') },
    ...(canManage ? [{ value: 'impostazioni' as const, label: t('tab.settings', 'Impostazioni') }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="space-y-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
              {t('title', 'Food cost')}
            </h1>
            <p className="mt-1 text-[15px] text-[var(--ds-text-muted)]">
              {t('subtitle', 'Quanto costa ogni piatto, e quanto ti resta.')}
            </p>
          </div>

          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            ariaLabel={t('tabs', 'Sezioni del food cost')}
            overflow="scroll"
            equalWidth={false}
            options={options}
          />

          {fc.error && <Callout tone="critical">{fc.error}</Callout>}
          {!fc.dati && !fc.error && <p className="text-[15px] text-[var(--ds-text-muted)]">{t('loading', 'Caricamento…')}</p>}

          {fc.dati && tab === 'piatti' && (
            <PiattiTab fc={fc} dishes={dishes} onOpen={d => setScheda({ kind: 'piatto', dish: d })} showToast={showToast} />
          )}
          {fc.dati && tab === 'ingredienti' && <IngredientiTab fc={fc} showToast={showToast} />}
          {fc.dati && tab === 'semilavorati' && (
            <SemilavoratiTab fc={fc} showToast={showToast} onOpen={i => setScheda({ kind: 'preparazione', ingrediente: i })} />
          )}
          {fc.dati && tab === 'impostazioni' && canManage && <ImpostazioniTab fc={fc} showToast={showToast} />}
        </div>
      </div>

      <SchedaTecnica open={scheda != null} onClose={() => setScheda(null)} fc={fc} target={scheda} showToast={showToast} />
    </div>
  );
};

// ---- Piatti ----------------------------------------------------------------------

const PiattiTab: React.FC<{ fc: FoodCostState; dishes: Dish[]; onOpen: (d: Dish) => void; showToast: Toast }> = ({ fc, dishes, onOpen, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('tutti');
  const target = fc.dati?.impostazioni.targetPct ?? 30;
  // Sul telefono tre conteggi in riga si troncano: numero sopra, etichetta sotto.
  const isWide = useMediaQuery('(min-width: 640px)');

  const righe = useMemo(() => {
    return dishes
      .filter(d => d.is_active !== false)
      .map(d => {
        const c: CostoPiatto | undefined = fc.costoDi(d.id);
        const iva = d.vat_rate ?? 10;
        const pct = foodCostPct(c?.cents ?? null, Number(d.price) || 0, iva);
        return { dish: d, costo: c, pct, margine: margineCents(c?.cents ?? null, Number(d.price) || 0, iva) };
      })
      .sort((a, b) => (a.dish.category || '').localeCompare(b.dish.category || '') || a.dish.name.localeCompare(b.dish.name));
  }, [dishes, fc.costoDi]);

  const conScheda = righe.filter(r => r.costo && r.costo.stato !== 'senza_scheda').length;
  const sopra = righe.filter(r => r.pct != null && r.pct > target).length;
  const incompleti = righe.filter(r => r.costo?.stato === 'incompleto').length;
  // Una bozza conta solo finché il piatto non ha una scheda.
  const inBozza = (r: { dish: Dish; costo?: CostoPiatto }) =>
    fc.bozze.has(r.dish.id) && (!r.costo || r.costo.stato === 'senza_scheda');
  const bozze = righe.filter(inBozza).length;

  const visibili = righe.filter(r => {
    if (q.trim() && !norm(r.dish.name).includes(norm(q.trim()))) return false;
    if (filtro === 'senza') return !r.costo || r.costo.stato === 'senza_scheda';
    if (filtro === 'incompleti') return r.costo?.stato === 'incompleto';
    if (filtro === 'sopra') return r.pct != null && r.pct > target;
    if (filtro === 'bozze') return inBozza(r);
    return true;
  });

  return (
    <div className="space-y-4">
      <StatStrip
        layout={isWide ? 'inline' : 'stacked'}
        stats={[
          { label: t('dishes.withCard', 'con scheda'), value: `${conScheda}/${righe.length}` },
          { label: t('dishes.overTarget', 'sopra il {{pct}}%', { pct: target }), value: sopra, tone: sopra > 0 ? 'critical' : 'neutral', onClick: () => setFiltro('sopra') },
          { label: t('dishes.incomplete', 'prezzi mancanti'), value: incompleti, tone: incompleti > 0 ? 'pending' : 'neutral', onClick: () => setFiltro('incompleti') },
        ]}
      />
      <BozzeInBlocco fc={fc} showToast={showToast} onVedi={() => setFiltro('bozze')} bozze={bozze} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={q} onChange={setQ} placeholder={t('dishes.search', 'Cerca un piatto')} className="sm:max-w-xs" />
        <SegmentedControl<Filtro>
          size="sm"
          value={filtro}
          onChange={setFiltro}
          ariaLabel={t('dishes.filter', 'Filtro')}
          overflow="scroll"
          equalWidth={false}
          options={[
            { value: 'tutti', label: t('dishes.all', 'Tutti') },
            { value: 'senza', label: t('dishes.noCard', 'Senza scheda') },
            { value: 'incompleti', label: t('dishes.incompleteShort', 'Incompleti') },
            { value: 'sopra', label: t('dishes.overShort', 'Sopra target') },
            ...(bozze > 0 || filtro === 'bozze'
              ? [{ value: 'bozze' as const, label: t('dishes.drafts', 'Bozze AI ({{count}})', { count: bozze }) }]
              : []),
          ]}
        />
      </div>

      {visibili.length === 0 ? (
        <EmptyState icon={ChefHat}>{t('dishes.empty', 'Nessun piatto qui.')}</EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)]">
          <li aria-hidden className="hidden items-center gap-3 border-b border-[var(--ds-border)] px-4 py-2 text-[12px] text-[var(--ds-text-muted)] sm:flex">
            <span className="flex-1" />
            <span className="flex items-center gap-4">
              <span className="w-24 text-right">{t('dishes.colCost', 'Costo')}</span>
              <span className="w-20 text-right">{t('dishes.colPct', 'Food cost')}</span>
              <span className="w-24 text-right">{t('dishes.colMargin', 'Margine')}</span>
            </span>
          </li>
          {visibili.map(({ dish, costo, pct, margine }) => (
            <li key={dish.id} className="border-b border-[var(--ds-border)] last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(dish)}
                className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--ds-surface-row)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{dish.name}</span>
                  <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
                    {dish.category || t('dishes.noCategory', 'Senza categoria')} · {money(Math.round((Number(dish.price) || 0) * 100))}
                    {dish.sold_by_weight ? ` ${t('dishes.perKg', 'al kg')}` : ''}
                    {costo?.stato === 'incompleto' && (
                      <span className="text-[var(--ds-pending-text)]"> · {t('dishes.missingPrices', 'mancano prezzi')}</span>
                    )}
                    {inBozza({ dish, costo }) && (
                      <span className="text-[var(--ds-arriving-text)]"> · {t('dishes.draftTag', 'bozza da rivedere')}</span>
                    )}
                  </span>
                </span>
                {/* Sul telefono costo e percentuale in colonna a destra, il
                    margine si legge nella scheda; da sm in su tre colonne. */}
                <span className="flex flex-shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-4">
                  <span className="text-right text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:w-24">
                    {!costo || costo.stato === 'senza_scheda'
                      ? <span className="text-[13px] text-[var(--ds-text-muted)]">{t('dishes.noCardShort', 'senza scheda')}</span>
                      : money(Math.round(costo.cents ?? 0))}
                  </span>
                  {pct != null && <span className="text-right sm:w-20"><FoodCostPill pct={pct} tone={semaforo(pct, target)} /></span>}
                  {pct == null && <span className="hidden text-right text-[var(--ds-text-muted)] sm:inline sm:w-20">—</span>}
                  <span className="hidden w-24 text-right text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:inline">
                    {margine == null ? '—' : money(Math.round(margine))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-[var(--ds-text-muted)]">{t('dishes.note', 'Food cost sul prezzo di carta senza IVA. Margine = prezzo senza IVA meno costo.')}</p>
    </div>
  );
};


// ---- Bozze in blocco ---------------------------------------------------------------

/* L'AI prepara una bozza per ogni piatto senza scheda, in sottofondo: le
   bozze arrivano man mano (socket) e si rivedono una per una dalla scheda.
   Finché non si salvano non contano in nessun costo. */
const BozzeInBlocco: React.FC<{ fc: FoodCostState; showToast: Toast; onVedi: () => void; bozze: number }> = ({ fc, showToast, onVedi, bozze }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [avvio, setAvvio] = useState(false);
  const gen = fc.dati?.generazione ?? null;
  const candidati = fc.dati?.bozzeCandidati ?? 0;
  if (!fc.dati?.canManage || !fc.dati.aiDisponibile) return null;
  if (!gen && candidati === 0 && bozze === 0) return null;

  const avvia = async () => {
    if (avvio) return;
    setAvvio(true);
    try {
      const r = await foodCostApiService.generaBozze();
      showToast(r.daPreparare > 0
        ? t('ai.batchStarted', 'Preparo {{count}} bozze: arrivano qui man mano', { count: r.daPreparare })
        : t('ai.batchNone', 'Nessun piatto da preparare'), 'info');
      fc.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAvvio(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {gen ? (
        <div className="flex min-h-[44px] items-center gap-2" role="status">
          <Wand2 className="ds-ai-wand h-4 w-4 text-[var(--ds-arriving-text)]" aria-hidden />
          <span className="ds-ai-shimmer text-[14px]">
            {t('ai.batchRunning', 'Preparo le bozze… {{fatte}} di {{totali}}', { fatte: gen.fatte, totali: gen.totali })}
          </span>
        </div>
      ) : candidati > 0 && (
        /* Wand2 + famiglia arriving: è AI che propone (§ds). */
        <button
          type="button"
          onClick={avvia}
          disabled={avvio}
          className="inline-flex h-11 items-center gap-2 rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-tint)] px-4 text-[15px] font-semibold text-[var(--ds-arriving-text)] transition-opacity hover:opacity-80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <Wand2 className="h-4 w-4" aria-hidden /> {t('ai.batch', 'Bozze con l\'AI per {{count}} piatti', { count: candidati })}
        </button>
      )}
      {bozze > 0 && !gen && (
        <button type="button" onClick={onVedi} className="min-h-[44px] text-[14px] font-medium text-[var(--ds-text-secondary)] underline-offset-2 hover:underline">
          {t('ai.batchReview', '{{count}} da rivedere', { count: bozze })}
        </button>
      )}
      <span className="text-[13px] text-[var(--ds-text-muted)]">{t('ai.batchHint', 'Non contano nei costi finché non le salvi.')}</span>
    </div>
  );
};

// ---- Ingredienti ---------------------------------------------------------------------

const IngredientiTab: React.FC<{ fc: FoodCostState; showToast: Toast }> = ({ fc, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [q, setQ] = useState('');
  const [soloSenza, setSoloSenza] = useState(false);
  const [nuovo, setNuovo] = useState(false);
  const [storico, setStorico] = useState<FcIngrediente | null>(null);
  const canManage = fc.dati?.canManage === true;

  const usi = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of fc.dati?.righe ?? []) m.set(r.productId, (m.get(r.productId) ?? 0) + 1);
    return m;
  }, [fc.dati]);

  const lista = (fc.dati?.ingredienti ?? [])
    .filter(i => !i.isPreparazione)
    .filter(i => !q.trim() || norm(i.nome).includes(norm(q.trim())))
    .filter(i => !soloSenza || i.costoCents == null || !i.unitaCosto)
    // Prima quelli che stanno in una scheda: sono i prezzi che contano.
    .sort((a, b) => (usi.get(b.id) ? 1 : 0) - (usi.get(a.id) ? 1 : 0) || a.nome.localeCompare(b.nome));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={q} onChange={setQ} placeholder={t('ing.search', 'Cerca un ingrediente')} className="sm:max-w-xs" />
        <SegmentedControl<'tutti' | 'senza'>
          size="sm"
          value={soloSenza ? 'senza' : 'tutti'}
          onChange={v => setSoloSenza(v === 'senza')}
          ariaLabel={t('ing.filter', 'Filtro')}
          equalWidth={false}
          options={[
            { value: 'tutti', label: t('ing.all', 'Tutti') },
            { value: 'senza', label: t('ing.noPrice', 'Senza prezzo') },
          ]}
        />
        {canManage && (
          <button type="button" className={`${dsButton.primary} sm:ml-auto`} onClick={() => setNuovo(true)}>
            <Plus className="h-4 w-4" aria-hidden /> {t('ing.new', 'Nuovo ingrediente')}
          </button>
        )}
      </div>
      <p className="text-[13px] text-[var(--ds-text-muted)]">
        {t('ing.hint', 'Prezzo IVA esclusa. La resa è la parte che resta dopo scarto e cottura: il branzino intero rende circa il 48% di filetto.')}
      </p>
      {lista.length === 0 ? (
        <EmptyState icon={ChefHat}>{t('ing.empty', 'Nessun ingrediente. Quelli del magazzino compaiono qui.')}</EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)]">
          {lista.map(i => (
            <IngredienteRiga
              key={i.id}
              ing={i}
              usi={usi.get(i.id) ?? 0}
              canManage={canManage}
              fc={fc}
              showToast={showToast}
              onStorico={() => setStorico(i)}
            />
          ))}
        </ul>
      )}
      {nuovo && <NuovoIngrediente fc={fc} onClose={() => setNuovo(false)} showToast={showToast} />}
      <StoricoPrezzi ing={storico} onClose={() => setStorico(null)} />
    </div>
  );
};

const IngredienteRiga: React.FC<{
  ing: FcIngrediente;
  usi: number;
  canManage: boolean;
  fc: FoodCostState;
  showToast: Toast;
  onStorico: () => void;
}> = ({ ing, usi, canManage, fc, showToast, onStorico }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [prezzo, setPrezzo] = useState(centsToInput(ing.costoCents));
  const [resa, setResa] = useState(String(ing.resaPct));
  useEffect(() => { setPrezzo(centsToInput(ing.costoCents)); }, [ing.costoCents]);
  useEffect(() => { setResa(String(ing.resaPct)); }, [ing.resaPct]);

  const salva = async (patch: Parameters<typeof foodCostApiService.aggiornaIngrediente>[1]) => {
    try {
      await foodCostApiService.aggiornaIngrediente(ing.id, patch);
      fc.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
      setPrezzo(centsToInput(ing.costoCents));
      setResa(String(ing.resaPct));
    }
  };

  const commitPrezzo = () => {
    const n = prezzo.trim() === '' ? null : parseDec(prezzo);
    const cents = n == null ? null : Math.round(n * 100);
    if (prezzo.trim() !== '' && (n == null || n < 0)) { setPrezzo(centsToInput(ing.costoCents)); return; }
    if (cents === ing.costoCents) return;
    salva({ costoCents: cents, ...(ing.unitaCosto ? {} : { unitaCosto: 'kg' as UnitaCosto }) });
  };
  const commitResa = () => {
    const n = parseInt(resa, 10);
    if (!Number.isInteger(n) || n < 1 || n > 100) { setResa(String(ing.resaPct)); return; }
    if (n !== ing.resaPct) salva({ resaPct: n });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ds-border)] px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-[1_1_12rem]">
        <span className="block truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{ing.nome}</span>
        <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
          {usi > 0 ? t('ing.usedIn', 'in {{count}} schede', { count: usi }) : t('ing.unused', 'in nessuna scheda')}
          {ing.fornitore ? ` · ${ing.fornitore}` : ''}
        </span>
      </span>
      <div className="relative w-28">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
        <input
          inputMode="decimal"
          aria-label={t('ing.price', 'Prezzo')}
          className={`${dsInput} pl-8 tabular-nums`}
          value={prezzo}
          disabled={!canManage}
          onChange={e => setPrezzo(e.target.value)}
          onBlur={commitPrezzo}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          placeholder="—"
        />
      </div>
      <SegmentedControl<UnitaCosto>
        size="sm"
        value={ing.unitaCosto ?? 'kg'}
        onChange={v => canManage && v !== ing.unitaCosto && salva({ unitaCosto: v })}
        ariaLabel={t('ing.unit', 'Prezzo al')}
        equalWidth={false}
        options={[
          { value: 'kg', label: t('unit.kgShort', '/kg') },
          { value: 'l', label: t('unit.lShort', '/l') },
          { value: 'pz', label: t('unit.pzShort', '/pz') },
        ]}
      />
      <div className="relative w-20">
        <input
          inputMode="numeric"
          aria-label={t('ing.yield', 'Resa')}
          className={`${dsInput} pr-7 text-right tabular-nums`}
          value={resa}
          disabled={!canManage}
          onChange={e => setResa(e.target.value)}
          onBlur={commitResa}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">%</span>
      </div>
      <button
        type="button"
        onClick={onStorico}
        aria-label={t('ing.history', 'Storico prezzi')}
        title={t('ing.history', 'Storico prezzi')}
        className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
      >
        <History className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
};

const NuovoIngrediente: React.FC<{
  fc: FoodCostState;
  onClose: () => void;
  showToast: Toast;
  preparazione?: boolean;
  onCreated?: (i: FcIngrediente) => void;
}> = ({ fc, onClose, showToast, preparazione = false, onCreated }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [nome, setNome] = useState('');
  const [unita, setUnita] = useState<UnitaCosto>('kg');
  const [prezzo, setPrezzo] = useState('');
  const [resa, setResa] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crea = async () => {
    if (!nome.trim()) { setError(t('ing.nameRequired', 'Serve il nome')); return; }
    const n = parseDec(prezzo);
    const r = parseInt(resa, 10);
    setBusy(true);
    setError(null);
    try {
      const creato = await foodCostApiService.creaIngrediente({
        nome: nome.trim(),
        unitaCosto: unita,
        costoCents: !preparazione && n != null && n >= 0 ? Math.round(n * 100) : null,
        resaPct: Number.isInteger(r) && r >= 1 && r <= 100 ? r : 100,
        isPreparazione: preparazione,
      });
      fc.reload();
      onCreated?.(creato);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      size="sm"
      title={preparazione ? t('prep.new', 'Nuovo semilavorato') : t('ing.new', 'Nuovo ingrediente')}
      bodyClassName="p-4 sm:p-6 space-y-4"
      footerNote={error ? <span className="text-[var(--ds-critical-text)]">{error}</span> : undefined}
      footer={(
        <>
          <button type="button" className={dsButton.secondary} onClick={onClose}>{t('editor.cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} disabled={busy} onClick={crea}>{t('editor.createShort', 'Crea')}</button>
        </>
      )}
    >
      <FormCard>
        <div className="space-y-4">
          <Field label={t('ing.name', 'Nome')} htmlFor="fc-nuovo-nome" required>
            <input id="fc-nuovo-nome" className={dsInput} value={nome} onChange={e => setNome(e.target.value)} autoFocus />
          </Field>
          <Field label={preparazione ? t('editor.prepUnit', 'Si usa a') : t('ing.unit', 'Prezzo al')}>
            <SegmentedControl<UnitaCosto>
              value={unita}
              onChange={setUnita}
              ariaLabel={t('ing.unit', 'Prezzo al')}
              options={[
                { value: 'kg', label: t('unit.kg', 'kg') },
                { value: 'l', label: t('unit.l', 'litri') },
                { value: 'pz', label: t('unit.pz', 'pezzi') },
              ]}
            />
          </Field>
          {!preparazione && (
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('ing.price', 'Prezzo')} htmlFor="fc-nuovo-prezzo" hint={t('ing.priceHint', 'IVA esclusa')}>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">{moneySymbol()}</span>
                  <input id="fc-nuovo-prezzo" inputMode="decimal" className={`${dsInput} pl-9`} value={prezzo} onChange={e => setPrezzo(e.target.value)} placeholder="0,00" />
                </div>
              </Field>
              <Field label={t('ing.yield', 'Resa')} htmlFor="fc-nuovo-resa">
                <div className="relative">
                  <input id="fc-nuovo-resa" inputMode="numeric" className={`${dsInput} pr-8`} value={resa} onChange={e => setResa(e.target.value)} />
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">%</span>
                </div>
              </Field>
            </div>
          )}
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('ing.goesToStock', 'Va anche nel magazzino, area cucina.')}</p>
        </div>
      </FormCard>
    </ModalShell>
  );
};

const FONTE: Record<FcPrezzoStorico['fonte'], { key: string; it: string }> = {
  MANUALE: { key: 'history.manual', it: 'a mano' },
  BOLLA: { key: 'history.ddt', it: 'dalla bolla' },
  FATTURA_XML: { key: 'history.invoice', it: 'dalla fattura' },
  PASSEPARTOUT: { key: 'history.pos', it: 'dalla cassa' },
};

const StoricoPrezzi: React.FC<{ ing: FcIngrediente | null; onClose: () => void }> = ({ ing, onClose }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [prezzi, setPrezzi] = useState<FcPrezzoStorico[] | null>(null);
  useEffect(() => {
    if (!ing) return;
    setPrezzi(null);
    foodCostApiService.getPrezzi(ing.id).then(r => setPrezzi(r.prezzi)).catch(() => setPrezzi([]));
  }, [ing]);
  if (!ing) return null;
  return (
    <ModalShell open onClose={onClose} size="sm" closeOnEscape title={ing.nome} subtitle={t('ing.history', 'Storico prezzi')} bodyClassName="p-4 sm:p-6">
      {prezzi == null ? (
        <p className="text-[15px] text-[var(--ds-text-muted)]">{t('loading', 'Caricamento…')}</p>
      ) : prezzi.length === 0 ? (
        <p className="text-[15px] text-[var(--ds-text-muted)]">{t('history.empty', 'Nessun prezzo registrato.')}</p>
      ) : (
        <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)]">
          {prezzi.map(p => (
            <li key={p.id} className="flex items-center justify-between gap-3 border-b border-[var(--ds-border)] px-4 py-2.5 last:border-b-0">
              <span className="min-w-0">
                <span className="block text-[15px] tabular-nums text-[var(--ds-text-primary)]">{money(p.costoCents)}/{p.unitaCosto}</span>
                <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
                  {t(FONTE[p.fonte].key, FONTE[p.fonte].it)}{p.autore ? ` · ${p.autore}` : ''}{p.fornitore ? ` · ${p.fornitore}` : ''}
                </span>
              </span>
              <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                {new Date(p.data).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  );
};

// ---- Semilavorati ---------------------------------------------------------------------

const SemilavoratiTab: React.FC<{ fc: FoodCostState; showToast: Toast; onOpen: (i: FcIngrediente) => void }> = ({ fc, showToast, onOpen }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const [nuovo, setNuovo] = useState(false);
  const canManage = fc.dati?.canManage === true;
  const lista = (fc.dati?.ingredienti ?? []).filter(i => i.isPreparazione).sort((a, b) => a.nome.localeCompare(b.nome));

  const costoUnita = (i: FcIngrediente) => {
    try {
      return fc.calc?.costoUnitario(i.id) ?? null;
    } catch {
      return null;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="text-[14px] text-[var(--ds-text-muted)]">
          {t('prep.hint', 'Ragù, fondi, impasti: una ricetta che entra in altre ricette. Il costo al kg segue i prezzi dei suoi ingredienti.')}
        </p>
        {canManage && (
          <button type="button" className={`${dsButton.primary} sm:ml-auto`} onClick={() => setNuovo(true)}>
            <Plus className="h-4 w-4" aria-hidden /> {t('prep.new', 'Nuovo semilavorato')}
          </button>
        )}
      </div>
      {lista.length === 0 ? (
        <EmptyState icon={ChefHat}>{t('prep.empty', 'Nessun semilavorato.')}</EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)]">
          {lista.map(i => {
            const c = costoUnita(i);
            const righe = fc.righePreparazione.get(i.id)?.length ?? 0;
            return (
              <li key={i.id} className="border-b border-[var(--ds-border)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpen(i)}
                  className="flex min-h-[56px] w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-[var(--ds-surface-row)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{i.nome}</span>
                    <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
                      {t('prep.lines', '{{count}} ingredienti', { count: righe })}
                      {i.resaQuantita != null && i.unitaCosto
                        ? ` · ${t('prep.yields', 'rende {{qty}} {{unit}}', { qty: String(i.resaQuantita).replace('.', ','), unit: UNITA_QUANTITA[i.unitaCosto] })}`
                        : ''}
                    </span>
                  </span>
                  <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-secondary)]">
                    {c?.cents == null ? '—' : `${money(Math.round(c.cents))}/${i.unitaCosto ?? 'kg'}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {nuovo && (
        <NuovoIngrediente fc={fc} preparazione onClose={() => setNuovo(false)} showToast={showToast} onCreated={onOpen} />
      )}
    </div>
  );
};

// ---- Impostazioni ---------------------------------------------------------------------

const ImpostazioniTab: React.FC<{ fc: FoodCostState; showToast: Toast }> = ({ fc, showToast }) => {
  const { t } = useTranslation('foodcost', { useSuspense: false });
  const corrente = fc.dati!.impostazioni;
  const [valori, setValori] = useState<Record<keyof FcImpostazioni, string>>({
    targetPct: String(corrente.targetPct),
    ivaBanchettiPct: String(corrente.ivaBanchettiPct),
    quotaBambiniPct: String(corrente.quotaBambiniPct),
  });
  const [busy, setBusy] = useState(false);

  const salva = async () => {
    setBusy(true);
    try {
      await foodCostApiService.salvaImpostazioni({
        targetPct: parseInt(valori.targetPct, 10),
        ivaBanchettiPct: parseInt(valori.ivaBanchettiPct, 10),
        quotaBambiniPct: parseInt(valori.quotaBambiniPct, 10),
      });
      fc.reload();
      showToast(t('settings.saved', 'Impostazioni salvate'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const campo = (k: keyof FcImpostazioni, label: string, hint: string) => (
    <Field label={label} htmlFor={`fc-${k}`} hint={hint}>
      <div className="relative">
        <input
          id={`fc-${k}`}
          inputMode="numeric"
          className={`${dsInput} pr-9`}
          value={valori[k]}
          onChange={e => setValori(v => ({ ...v, [k]: e.target.value }))}
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">%</span>
      </div>
    </Field>
  );

  return (
    <FormCard
      title={t('settings.title', 'Regole del calcolo')}
      aside={<button type="button" className={dsButton.primary} disabled={busy} onClick={salva}>{t('editor.save', 'Salva')}</button>}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {campo('targetPct', t('settings.target', 'Food cost obiettivo'), t('settings.targetHint', 'Sopra questa soglia il piatto si colora.'))}
        {campo('ivaBanchettiPct', t('settings.vat', 'IVA dei banchetti'), t('settings.vatHint', 'Per togliere l\'IVA dal prezzo a persona.'))}
        {campo('quotaBambiniPct', t('settings.children', 'Costo menu bambini'), t('settings.childrenHint', 'Rispetto a quello di un adulto.'))}
      </div>
    </FormCard>
  );
};
