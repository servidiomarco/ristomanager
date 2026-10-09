import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { foodCostApiService, type FcDati, type FcIngrediente, type FcRiga } from '../services/foodCostApiService';
import { onSocketEvent } from '../services/socketEvents';
import {
  CicloRicettaError,
  RicettaTroppoProfondaError,
  costoPiatto,
  creaCalcolatore,
  type CalcolatoreFc,
  type CostoPiatto,
  type IngredienteFc,
  type RigaFc,
} from '../utils/foodCost';

/* I dati del food cost e il calcolatore, per chi può vederli. Lo usano la
   pagina, l'editor della scheda, il menu (badge) e il banchetto: tutti fanno
   i conti con lo stesso utils/foodCost.ts del server, sui dati di /dati.

   Senza l'entitlement o senza foodcost:view il hook non chiama niente e
   `enabled` è false: chi lo usa non mostra nulla. */

export interface FoodCostState {
  enabled: boolean;
  dati: FcDati | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  calc: CalcolatoreFc | null;
  ingredienti: Map<number, FcIngrediente>;
  /** Righe di ogni piatto, per l'editor. */
  righePiatto: Map<number, FcRiga[]>;
  /** Righe di ogni semilavorato, per l'editor. */
  righePreparazione: Map<number, FcRiga[]>;
  /** Costo di una porzione del piatto (undefined = nessuna scheda). */
  costoDi: (dishId: number) => CostoPiatto | undefined;
}

const raggruppa = (righe: FcRiga[], chiave: 'dishId' | 'preparazioneId'): Map<number, FcRiga[]> => {
  const m = new Map<number, FcRiga[]>();
  for (const r of righe) {
    const k = r[chiave];
    if (k == null) continue;
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
};

const comeRighe = (righe: FcRiga[] | undefined): RigaFc[] =>
  (righe ?? []).map(r => ({ productId: r.productId, quantita: r.quantita }));

export const useFoodCost = (): FoodCostState => {
  const { hasFeature, hasPermission } = useAuth();
  const enabled = hasFeature('food_cost') && hasPermission('foodcost:view');
  const [dati, setDati] = useState<FcDati | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    foodCostApiService.getDati()
      .then(d => { if (alive) { setDati(d); setError(null); } })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, tick]);

  useEffect(() => (enabled ? onSocketEvent('foodcost:changed', reload) : undefined), [enabled, reload]);

  const ingredienti = useMemo(() => new Map((dati?.ingredienti ?? []).map(i => [i.id, i])), [dati]);
  const righePiatto = useMemo(() => raggruppa(dati?.righe ?? [], 'dishId'), [dati]);
  const righePreparazione = useMemo(() => raggruppa(dati?.righe ?? [], 'preparazioneId'), [dati]);

  const calc = useMemo<CalcolatoreFc | null>(() => {
    if (!dati) return null;
    const ing = new Map<number, IngredienteFc>(dati.ingredienti.map(i => [i.id, {
      id: i.id,
      costoCents: i.costoCents,
      unitaCosto: i.unitaCosto,
      resaPct: i.resaPct,
      isPreparazione: i.isPreparazione,
      resaQuantita: i.resaQuantita,
    }]));
    const prep = new Map<number, RigaFc[]>();
    for (const [k, v] of righePreparazione) prep.set(k, comeRighe(v));
    return creaCalcolatore(ing, prep);
  }, [dati, righePreparazione]);

  const costi = useMemo(() => {
    const out = new Map<number, CostoPiatto>();
    if (!dati || !calc) return out;
    const meta = new Map(dati.piatti.map(p => [p.dishId, p]));
    const ids = new Set<number>([...righePiatto.keys(), ...meta.keys()]);
    for (const id of ids) {
      const m = meta.get(id);
      try {
        out.set(id, costoPiatto(calc, comeRighe(righePiatto.get(id)), m?.porzioni ?? 1, m?.costoManualeCents ?? null));
      } catch (err) {
        if (err instanceof CicloRicettaError || err instanceof RicettaTroppoProfondaError) {
          out.set(id, { cents: null, stato: 'incompleto', mancanti: [], manuale: false });
        } else {
          throw err;
        }
      }
    }
    return out;
  }, [dati, calc, righePiatto]);

  const costoDi = useCallback((dishId: number) => costi.get(dishId), [costi]);

  return { enabled, dati, loading, error, reload, calc, ingredienti, righePiatto, righePreparazione, costoDi };
};
