import React, { useState } from 'react';
import { Info, Minus, Plus, Utensils } from 'lucide-react';
import type { Dish } from '../types';
import type { MenuCatalogue } from '../services/ordersApiService';
import { Sheet, dsButton, dsInput } from './ds';
import { euro } from './comande/orderView';
import { MODIFIER_N_MIN, MODIFIER_N_MAX, clampModifierN, signedModifierLabel, signedModifierDelta } from '../utils/modifierScale';

// ---------------------------------------------------------------------------
// Foglio varianti condiviso fra palmare (OrderPad) e Cassa — prima viveva
// dentro OrderPad e la Cassa ignorava le varianti del tutto, che con la
// validazione min/max server-side sarebbe diventato un 400 in faccia al
// cassiere.
//
// Tre blocchi: gli INGREDIENTI dei piatti composti (pre-inclusi, si toccano
// per togliere — «Senza cipolla», con l'eventuale sconto), i GRUPPI di
// varianti (scelta singola a chip, multiple coi contatori ± alla
// Passepartout), e la variante libera che viaggia come nota di riga.
//
// I sovrapprezzi percentuali si mostrano già risolti in € sul prezzo di
// anagrafica del piatto: il conto vero lo fa il server sul prezzo battuto
// (listino della comanda) — qui è un'anteprima, non un contratto.
// ---------------------------------------------------------------------------

type CatalogueGroups = MenuCatalogue['modifier_groups'];
type CatalogueComponents = MenuCatalogue['dish_components'];

export const VariantSheet: React.FC<{
  dish: Dish;
  groups: CatalogueGroups;
  /** Ingredienti del piatto (solo COMPOSED): tutti inclusi in partenza. */
  components?: CatalogueComponents;
  /** Riapertura di una riga in bozza: il foglio parte dallo stato della
   *  riga — è anche il posto dove le varianti troncate si leggono intere. */
  initial?: { entries: { id: number; n: number }[]; removed?: number[]; note?: string; weight_grams?: number };
  /** Quantità della riga, quando il foglio È il posto dove si cambia (riga
   *  in bozza dell'orderpad: sulla riga restano solo matita e maniglia).
   *  Assente = nessun blocco quantità, il foglio resta quello di sempre
   *  (Cassa, battuta nuova). Minimo 1: l'eliminazione è un gesto a parte. */
  initialQty?: number;
  /** «Elimina riga» nel footer, quiet critica. Assente = non compare. */
  onDelete?: () => void;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (entries: { id: number; n: number }[], removedComponentIds: number[], note?: string, weightGrams?: number, qty?: number) => void;
}> = ({ dish, groups, components = [], initial, initialQty, onDelete, confirmLabel, onCancel, onConfirm }) => {
  // Verso per variante, scala d'intensità a 4 gradini (utils/modifierScale):
  // +1 aggiunge a pagamento, +2 «Molta» allo stesso addebito, −1 «Senza» in
  // sconto, −2 «Poca» gratis, 0 = non applicata. Le scelte singole (cotture)
  // restano chip a +1: un «Poca media» non significa niente. Il clamp
  // all'init ripara le bozze localStorage di prima della scala (n fino a ±5).
  const [selected, setSelected] = useState<Map<number, number>>(
    () => new Map((initial?.entries ?? []).map(e => [e.id, clampModifierN(e.n)])),
  );
  const [removed, setRemoved] = useState<Set<number>>(
    () => new Set(initial?.removed ?? []),
  );
  // Variante libera: quello che in cassa il cameriere scrive a mano («senza
  // sale», «metà porzione»). Viaggia come nota di riga — KDS e comanda in
  // cucina la stampano già sotto il piatto.
  const [custom, setCustom] = useState(initial?.note ?? '');
  // Vendita al peso: i grammi del pezzo, chiesti qui alla battuta (stima del
  // cameriere; il peso vero lo corregge la cucina dopo il taglio). Il prezzo
  // del piatto è AL KG e l'anteprima sotto si aggiorna col peso. Range e
  // punto di partenza vengono dalla SCHEDA del piatto (un filetto non parte
  // da 500 g come una bistecca); i default coprono i piatti senza scheda.
  const wMin = dish.weight_min_grams ?? 300;
  const wMax = Math.max(dish.weight_max_grams ?? 1000, wMin);
  const wDef = Math.min(Math.max(dish.weight_default_grams ?? 500, wMin), wMax);
  const [grams, setGrams] = useState<number>(() => initial?.weight_grams ?? wDef);
  // Chip equispaziati sul range, arrotondati ai 50 g: pochi bersagli larghi,
  // il fine lo fa lo stepper.
  const weightChips = React.useMemo(() => {
    const span = wMax - wMin;
    const step = span <= 0 ? 50 : Math.max(50, Math.round(span / 5 / 50) * 50);
    const out: number[] = [];
    for (let g = wMin; g < wMax && out.length < 6; g += step) out.push(g);
    out.push(wMax);
    return [...new Set(out)];
  }, [wMin, wMax]);
  // Guida del gruppo (es. i gradi di cottura spiegati): chiusa di default,
  // il foglio serve a battere — la si apre quando serve ripassarla.
  const [openNotes, setOpenNotes] = useState<Set<number>>(new Set());
  // Quantità della riga (solo in modifica dall'orderpad). Al peso resta 1:
  // due pezzi sono due pesate, quindi due righe.
  const [qty, setQty] = useState<number>(initialQty ?? 1);
  const showQty = initialQty != null && !dish.sold_by_weight;

  const dishCents = Math.round(Number(dish.price) * 100);
  // Percentuale risolta in € sul prezzo di anagrafica: anteprima leggibile;
  // il server ricalcola sul prezzo del listino battuto.
  const deltaOf = (m: CatalogueGroups[number]['modifiers'][number]): number =>
    m.price_delta_pct != null
      ? Math.round(dishCents * Number(m.price_delta_pct) / 100)
      : m.price_delta_cents;

  const chosenInGroup = (g: CatalogueGroups[number]): number =>
    g.modifiers.filter(m => (selected.get(m.id) ?? 0) > 0).length;

  const setN = (g: CatalogueGroups[number], modId: number, n: number) => {
    // Il tetto del gruppo vale sulle varianti DISTINTE in aggiunta, come la
    // validazione del server: alzare l'n di una già scelta è lecito
    // («++ prosciutto»), aggiungerne una nuova oltre il max no.
    const wasChosen = (selected.get(modId) ?? 0) > 0;
    if (n > 0 && !wasChosen && chosenInGroup(g) >= g.max_select) return;
    setSelected(prev => {
      const next = new Map(prev);
      if (n === 0) next.delete(modId);
      else next.set(modId, clampModifierN(n));
      return next;
    });
  };

  const toggleSingle = (groupId: number, modId: number) => {
    setSelected(prev => {
      const next = new Map(prev);
      const group = groups.find(g => g.id === groupId);
      const siblings = group ? group.modifiers.map(m => m.id) : [];
      const wasOn = next.get(modId) != null;
      for (const s of siblings) next.delete(s);
      if (!wasOn) next.set(modId, 1);
      return next;
    });
  };

  const toggleRemoved = (componentId: number) => {
    setRemoved(prev => {
      const next = new Set(prev);
      if (next.has(componentId)) next.delete(componentId); else next.add(componentId);
      return next;
    });
  };

  const entries = [...selected.entries()].map(([id, n]) => ({ id, n }));
  const missing = groups.filter(g => g.min_select > 0
    && g.modifiers.filter(m => (selected.get(m.id) ?? 0) > 0).length < g.min_select);

  return (
    <Sheet
      open
      onClose={onCancel}
      title={dish.name}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <Utensils size={14} aria-hidden /> Varianti
        </span>
      }
      ariaLabel={`Varianti per ${dish.name}`}
      bodyClassName="space-y-5 px-5 py-5 sm:px-6"
      footer={
        <div className="flex flex-col gap-3">
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="self-center text-[13px] font-medium text-[var(--ds-critical-text)] underline decoration-dotted transition-opacity hover:opacity-70"
            >
              elimina riga
            </button>
          )}
          <button
            type="button"
            onClick={() => onConfirm(entries, [...removed], custom.trim() || undefined,
              dish.sold_by_weight ? grams : undefined,
              initialQty != null ? qty : undefined)}
            disabled={missing.length > 0}
            className={`w-full ${dsButton.primary}`}
          >
            {missing.length > 0 ? `Scegli: ${missing.map(g => g.name).join(', ')}` : (confirmLabel ?? 'Aggiungi')}
          </button>
        </div>
      }
    >
      {showQty && (
        <div className="flex items-center gap-3">
          <div className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Quantità</div>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQty(v => Math.max(1, v - 1))}
              disabled={qty <= 1}
              aria-label="Uno in meno"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40"
            >
              <Minus size={16} aria-hidden />
            </button>
            <span className="min-w-[32px] text-center text-[18px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {qty}
            </span>
            <button
              type="button"
              onClick={() => setQty(v => Math.min(99, v + 1))}
              aria-label="Uno in più"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
            >
              <Plus size={16} aria-hidden />
            </button>
          </div>
        </div>
      )}
      {dish.sold_by_weight && (
        <div>
          <div className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">
            Peso · {euro(Math.round(dishCents))} al kg
          </div>
          <div className="flex flex-wrap gap-2">
            {weightChips.map(g => (
              <button
                key={g}
                type="button"
                onClick={() => setGrams(g)}
                aria-pressed={grams === g}
                className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-semibold tabular-nums transition-colors ${
                  grams === g
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                }`}
              >
                {g >= 1000 ? `${g / 1000} kg` : `${g} g`}
              </button>
            ))}
          </div>
          {/* Il fine: i tagli veri non sono tondi. ±10 g, prezzo vivo. */}
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setGrams(v => Math.max(wMin, v - 10))}
              aria-label="Riduci di 10 grammi"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
            >
              <Minus size={16} aria-hidden />
            </button>
            <span className="min-w-[88px] text-center text-[18px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {grams} g
            </span>
            <button
              type="button"
              onClick={() => setGrams(v => Math.min(wMax, v + 10))}
              aria-label="Aumenta di 10 grammi"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
            >
              <Plus size={16} aria-hidden />
            </button>
            <span className="ml-auto text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
              {euro(Math.round(dishCents * grams / 1000))}
            </span>
          </div>
        </div>
      )}

      {components.length > 0 && (
        <div>
          <div className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">
            Ingredienti · tocca per togliere
          </div>
          <div className="flex flex-wrap gap-2">
            {components.map(c => {
              const out = removed.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleRemoved(c.id)}
                  aria-pressed={out}
                  className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors ${
                    out
                      ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] line-through'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                  }`}
                >
                  {c.name}
                  {out && c.removal_delta_cents < 0 && (
                    <span className="ml-1.5 tabular-nums no-underline opacity-75">
                      −{euro(Math.abs(c.removal_delta_cents))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {groups.map(g => {
        const single = g.max_select <= 1;
        const chosen = chosenInGroup(g);
        return (
          <div key={g.id}>
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ds-text-muted)]">
              <span>
                {g.name}
                {g.min_select > 0 && (
                  <span className="text-[var(--ds-critical-text)]"> · obbligatorio</span>
                )}
                {/* Il tetto si dice solo quando può mordere: un gruppo con max
                    pari alle opzioni non ha niente da contare. */}
                {!single && g.max_select < g.modifiers.length && (
                  <span className="tabular-nums"> · {chosen}/{g.max_select}</span>
                )}
              </span>
              {g.note && (
                <button
                  type="button"
                  onClick={() => setOpenNotes(prev => {
                    const next = new Set(prev);
                    if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                    return next;
                  })}
                  aria-expanded={openNotes.has(g.id)}
                  aria-label={`Note su ${g.name}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
                >
                  <Info size={14} aria-hidden />
                </button>
              )}
            </div>
            {g.note && openNotes.has(g.id) && (
              <p className="mb-2 whitespace-pre-line rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ds-text-secondary)]">
                {g.note}
              </p>
            )}
            {single ? (
              <div className="flex flex-wrap gap-2">
                {g.modifiers.map(m => {
                  const active = (selected.get(m.id) ?? 0) > 0;
                  const delta = deltaOf(m);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleSingle(g.id, m.id)}
                      aria-pressed={active}
                      className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors ${
                        active
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                      }`}
                    >
                      {m.name}
                      {delta !== 0 && (
                        <span className="ml-1.5 tabular-nums opacity-75">
                          {delta > 0 ? '+' : '−'}{euro(Math.abs(delta))}
                        </span>
                      )}
                      {(m.name_en || m.note) && (
                        <span className="ml-1.5 text-[12px] opacity-60">
                          {[m.name_en, m.note].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              /* Le aggiunte: − e + muovono la variante su quattro gradini —
                 «+ Nduja» (addebito), «Molta Nduja» (stesso addebito),
                 «Senza Nduja» (sconto), «Poca Nduja» (gratis). Scala ±2
                 concordata con Marco il 5/09 al posto delle ripetizioni
                 n×prezzo; la regola vive in utils/modifierScale. */
              <div className="space-y-1.5">
                {g.modifiers.map(m => {
                  const n = selected.get(m.id) ?? 0;
                  const delta = deltaOf(m);
                  const deltaTot = signedModifierDelta(delta, n);
                  const capped = n === 0 && chosen >= g.max_select;
                  return (
                    <div
                      key={m.id}
                      className={`flex min-h-[48px] items-center gap-2 rounded-[14px] px-3 py-1.5 ${
                        n !== 0 ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                        {signedModifierLabel(m.name, n)}
                        {n !== 0 && deltaTot !== 0 && (
                          <span className="ml-1.5 tabular-nums opacity-75">
                            {deltaTot > 0 ? '+' : '−'}{euro(Math.abs(deltaTot))}
                          </span>
                        )}
                        {n === 0 && delta !== 0 && (
                          <span className="ml-1.5 tabular-nums opacity-60">
                            {delta > 0 ? '+' : '−'}{euro(Math.abs(delta))}
                          </span>
                        )}
                        {(m.name_en || m.note) && (
                          <span className="ml-1.5 text-[12px] opacity-60">
                            {[m.name_en, m.note].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => setN(g, m.id, n - 1)}
                        aria-label={`Togli ${m.name}`}
                        disabled={n <= MODIFIER_N_MIN}
                        className={`inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 ${
                          n !== 0 ? 'bg-white/15 hover:bg-white/25' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-border)]'
                        }`}
                      >
                        <Minus size={16} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => setN(g, m.id, n + 1)}
                        aria-label={`Aggiungi ${m.name}`}
                        disabled={capped || n >= MODIFIER_N_MAX}
                        className={`inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 ${
                          n !== 0 ? 'bg-white/15 hover:bg-white/25' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-border)]'
                        }`}
                      >
                        <Plus size={16} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <label className="block">
        <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-muted)]">Variante libera</span>
        <input
          type="text"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          maxLength={300}
          placeholder="Es. senza sale, metà porzione…"
          className={dsInput}
          // Aperta dal tocco lungo su un piatto senza varianti, la sheet ha
          // solo questo campo: il cameriere è qui per scrivere.
          autoFocus={groups.length === 0 && components.length === 0}
        />
      </label>
    </Sheet>
  );
};
