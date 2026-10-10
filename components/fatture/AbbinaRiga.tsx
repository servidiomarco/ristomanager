import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Plus } from 'lucide-react';
import { InventoryArea, type InventoryProduct } from '../../types';
import { createInventoryProduct } from '../../services/apiService';
import {
  CATEGORIE_SPESA,
  fattureFornitoriApi,
  type CategoriaSpesa,
  type FfRiga,
} from '../../services/fattureFornitoriApiService';
import { indovinaConfezione, unitaDellaFattura } from '../../utils/confezione';
import type { UnitaCosto } from '../../utils/foodCost';
import { formatMoneyMinor, formatMoneyUnits } from '../../utils/money';
import { Field, SearchField, SegmentedControl, Sheet, dsButton, dsInput } from '../ds';

/* Una riga della fattura, decisa: va in magazzino su un prodotto (con quante
   unità del prodotto vale una della fattura, e quanti kg/l/pz per il prezzo
   del food cost), oppure si ignora con una categoria di spesa. La prima
   volta lo decide qualcuno; dalla fattura dopo lo ricorda il server. */

interface Props {
  fatturaId: number;
  riga: FfRiga | null;
  prodotti: InventoryProduct[];
  /** L'unità con cui il food cost paga ogni prodotto, per chi ce l'ha. */
  unitaCostoProdotti: Record<number, UnitaCosto>;
  foodCost: boolean;
  onClose: () => void;
  onSaved: (riga: FfRiga) => void;
  onProdottoCreato: (p: InventoryProduct) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type Modo = 'carico' | 'ignora';
type UnitaScelta = UnitaCosto | 'no';

const NUOVO = -1;

const numero = (s: string): number | null => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const testoNumero = (n: number): string => String(Math.round(n * 10000) / 10000).replace('.', ',');

/** Il nome del prodotto nuovo dalla descrizione, senza la confezione in coda
 *  e con la sola iniziale maiuscola, come i nomi del Magazzino. */
const nomeDaDescrizione = (d: string): string => {
  const n = (d.replace(/\b(KG|GR|G|LT|L|ML|CL|PZ)\s*\d+([.,]\d+)?(\s*X\s*\d+)?\b.*$/i, '').trim() || d).toLowerCase();
  return n.charAt(0).toUpperCase() + n.slice(1);
};

export const AbbinaRiga: React.FC<Props> = ({ fatturaId, riga, prodotti, unitaCostoProdotti, foodCost, onClose, onSaved, onProdottoCreato, showToast }) => {
  const { t } = useTranslation('fatture', { useSuspense: false });
  const [modo, setModo] = useState<Modo>('carico');
  const [cerca, setCerca] = useState('');
  const [productId, setProductId] = useState<number | null>(null);
  const [nuovoNome, setNuovoNome] = useState('');
  const [nuovaArea, setNuovaArea] = useState<InventoryArea>(InventoryArea.CUCINA);
  const [nuovaUnita, setNuovaUnita] = useState('');
  const [fattoreMagazzino, setFattoreMagazzino] = useState('1');
  const [unitaCosto, setUnitaCosto] = useState<UnitaScelta>('kg');
  const [fattoreCosto, setFattoreCosto] = useState('1');
  const [categoria, setCategoria] = useState<CategoriaSpesa>('altro');
  const [salvo, setSalvo] = useState(false);

  const guess = useMemo(() => (riga ? indovinaConfezione(riga.descrizione) : null), [riga]);
  const prodottoScelto = productId != null && productId !== NUOVO ? prodotti.find(p => p.id === productId) ?? null : null;
  const unitaFattura = (riga?.unitaMisura || 'pz').toLowerCase();

  // All'apertura: quello che la riga ha già (dalla memoria o da prima),
  // altrimenti una proposta letta dalla descrizione.
  useEffect(() => {
    if (!riga) return;
    setModo(riga.esito === 'IGNORA' ? 'ignora' : 'carico');
    setCerca('');
    setProductId(riga.productId);
    setNuovoNome(nomeDaDescrizione(riga.descrizione));
    setNuovaArea(InventoryArea.CUCINA);
    setNuovaUnita(unitaFattura === 'colli' ? 'colli' : unitaFattura);
    setFattoreMagazzino(testoNumero(riga.fattoreMagazzino ?? 1));
    const unitaRiga = unitaDellaFattura(riga.unitaMisura);
    if (riga.esito === 'CARICO') {
      setUnitaCosto(riga.unitaCosto ?? 'no');
      setFattoreCosto(testoNumero(riga.fattoreCosto ?? 1));
    } else {
      const u: UnitaCosto = riga.prodotto?.unitaCosto ?? guess?.unita ?? unitaRiga ?? 'pz';
      setUnitaCosto(u);
      setFattoreCosto(testoNumero(guess && guess.unita === u ? guess.quantita : 1));
    }
    setCategoria(riga.categoriaSpesa ?? (riga.aliquotaIva > 0 && riga.aliquotaIva <= 10 ? 'cibo' : 'altro'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riga?.id]);

  // Scelto un prodotto che nel food cost ha già la sua unità, il prezzo va a quella.
  const scegli = (id: number) => {
    setProductId(id);
    const u = unitaCostoProdotti[id] ?? null;
    if (u && unitaCosto !== 'no' && u !== unitaCosto) {
      setUnitaCosto(u);
      setFattoreCosto(testoNumero(guess && guess.unita === u ? guess.quantita : 1));
    }
  };

  // In cima i prodotti che hanno parole della descrizione: «OLIVE FRESCHE
  // BELLE DI CERIGNOLA» porta su «Olive all'ascolana».
  const elenco = useMemo(() => {
    const q = cerca.trim().toLowerCase();
    const parole = (riga?.descrizione ?? '').toLowerCase().split(/[^a-zà-ù0-9]+/).filter(w => w.length >= 4);
    const punti = (nome: string) => {
      const n = nome.toLowerCase();
      return parole.filter(w => n.includes(w)).length;
    };
    const base = q ? prodotti.filter(p => p.name.toLowerCase().includes(q)) : prodotti;
    return base
      .map(p => ({ p, punti: punti(p.name) }))
      .sort((a, b) => b.punti - a.punti || a.p.name.localeCompare(b.p.name, 'it'))
      .slice(0, q ? 40 : 60)
      .map(x => x.p);
  }, [prodotti, cerca, riga?.descrizione]);

  if (!riga) return null;

  const fm = numero(fattoreMagazzino);
  const fc = numero(fattoreCosto);
  const unitaProdotto = productId === NUOVO ? nuovaUnita.trim() || 'pz' : prodottoScelto?.unit || 'pz';
  const quantitaMagazzino = fm && riga.quantita ? Math.round(riga.quantita * fm * 1000) / 1000 : null;
  const costoAnteprima = unitaCosto !== 'no' && fc && riga.quantita && riga.prezzoTotale > 0
    ? Math.round((riga.prezzoTotale * 100) / (riga.quantita * fc))
    : null;
  // Il food cost paga questo prodotto in un'altra unità: il server non
  // aggiornerebbe il prezzo, meglio dirlo prima.
  const unitaDelProdotto = productId != null && productId !== NUOVO ? unitaCostoProdotti[productId] ?? null : null;
  const unitaDiversa = unitaCosto !== 'no' && unitaDelProdotto != null && unitaDelProdotto !== unitaCosto;
  const valido = modo === 'ignora'
    || (productId != null && (productId !== NUOVO || nuovoNome.trim().length > 0) && fm != null && (unitaCosto === 'no' || fc != null));

  const salva = async () => {
    if (!valido || salvo) return;
    setSalvo(true);
    try {
      if (modo === 'ignora') {
        onSaved(await fattureFornitoriApi.decidiRiga(fatturaId, riga.id, { esito: 'IGNORA', categoriaSpesa: categoria }));
        return;
      }
      let id = productId!;
      if (id === NUOVO) {
        const creato = await createInventoryProduct({ area: nuovaArea, name: nuovoNome.trim(), unit: nuovaUnita.trim() || null });
        onProdottoCreato(creato);
        id = creato.id;
      }
      onSaved(await fattureFornitoriApi.decidiRiga(fatturaId, riga.id, {
        esito: 'CARICO',
        productId: id,
        fattoreMagazzino: fm!,
        unitaCosto: unitaCosto === 'no' ? null : unitaCosto,
        fattoreCosto: unitaCosto === 'no' ? null : fc,
      }));
    } catch (err: any) {
      showToast(err?.message || t('errore', 'Non salvato'), 'error');
    } finally {
      setSalvo(false);
    }
  };

  const meta = [
    riga.quantita != null ? `${testoNumero(riga.quantita)} ${unitaFattura}` : null,
    formatMoneyUnits(riga.prezzoUnitario),
    riga.lotto ? t('riga.lotto', 'lotto {{lotto}}', { lotto: riga.lotto }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Sheet
      open={riga != null}
      onClose={onClose}
      title={riga.descrizione || t('riga.senzaDescrizione', 'Riga {{n}}', { n: riga.numeroLinea })}
      subtitle={`${meta} · ${formatMoneyUnits(riga.prezzoTotale)}`}
      subheader={
        <div className="px-5 pb-3">
          <SegmentedControl<Modo>
            value={modo}
            onChange={setModo}
            ariaLabel={t('abbina.modo', 'Cosa fare della riga')}
            options={[
              { value: 'carico', label: t('abbina.carico', 'In magazzino') },
              { value: 'ignora', label: t('abbina.ignora', 'Ignora') },
            ]}
          />
        </div>
      }
      bodyClassName="space-y-5 px-5 py-4"
      footer={
        <button type="button" onClick={salva} disabled={!valido || salvo} className={`${dsButton.primary} w-full`}>
          {salvo ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          {t('abbina.salva', 'Salva')}
        </button>
      }
    >
      {modo === 'ignora' ? (
        <Field label={t('abbina.categoria', 'Conta nella spesa come')} hint={t('abbina.categoriaHint', 'Non entra in magazzino. Le prossime fatture la ignorano da sole.')}>
          <div className="flex flex-wrap gap-2">
            {CATEGORIE_SPESA.map(c => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategoria(c.value)}
                aria-pressed={categoria === c.value}
                className={`h-10 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors ${
                  categoria === c.value
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                }`}
              >
                {t(`categoria.${c.value}`, c.label)}
              </button>
            ))}
          </div>
        </Field>
      ) : (
        <>
          <Field label={t('abbina.prodotto', 'Prodotto di magazzino')}>
            <SearchField value={cerca} onChange={setCerca} placeholder={t('abbina.cerca', 'Cerca')} ariaLabel={t('abbina.cerca', 'Cerca')} recessed />
            <div className="mt-2 max-h-[260px] overflow-y-auto rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-1">
              {elenco.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => scegli(p.id)}
                  aria-pressed={productId === p.id}
                  className={`flex min-h-[44px] w-full items-center gap-3 rounded-[var(--ds-radius-sm)] px-3 text-left text-[14px] transition-colors ${
                    productId === p.id ? 'bg-[var(--ds-surface)] font-semibold shadow-[var(--ds-shadow-card)]' : 'hover:bg-[var(--ds-surface)]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--ds-text-primary)]">{p.name}</span>
                  <span className="flex-shrink-0 text-[12px] text-[var(--ds-text-muted)]">
                    {t(`area.${p.area}`, p.area.toLowerCase())}{p.unit ? ` · ${p.unit}` : ''}
                  </span>
                  {productId === p.id && <Check className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-primary)]" aria-hidden />}
                </button>
              ))}
              {elenco.length === 0 && (
                <p className="px-3 py-3 text-[13px] text-[var(--ds-text-muted)]">{t('abbina.nessuno', 'Nessun prodotto con questo nome')}</p>
              )}
              <button
                type="button"
                onClick={() => setProductId(NUOVO)}
                aria-pressed={productId === NUOVO}
                className={`flex min-h-[44px] w-full items-center gap-3 rounded-[var(--ds-radius-sm)] px-3 text-left text-[14px] font-medium transition-colors ${
                  productId === NUOVO ? 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]' : 'hover:bg-[var(--ds-surface)]'
                }`}
              >
                <Plus className="h-4 w-4 flex-shrink-0" aria-hidden />
                {t('abbina.nuovo', 'Nuovo prodotto')}
              </button>
            </div>
          </Field>

          {productId === NUOVO && (
            <div className="space-y-3 rounded-[var(--ds-radius-sm)] p-3 ring-1 ring-inset ring-[var(--ds-border)]">
              <Field label={t('abbina.nome', 'Nome')} htmlFor="ff-nuovo-nome">
                <input id="ff-nuovo-nome" className={dsInput} value={nuovoNome} onChange={e => setNuovoNome(e.target.value)} />
              </Field>
              <div className="grid grid-cols-1 gap-3">
                <Field label={t('abbina.area', 'Area')}>
                  <SegmentedControl<InventoryArea>
                    value={nuovaArea}
                    onChange={setNuovaArea}
                    ariaLabel={t('abbina.area', 'Area')}
                    equalWidth={false}
                    size="sm"
                    options={[
                      { value: InventoryArea.CUCINA, label: t('area.CUCINA', 'cucina') },
                      { value: InventoryArea.BAR, label: t('area.BAR', 'bar') },
                      { value: InventoryArea.SALA, label: t('area.SALA', 'sala') },
                    ]}
                  />
                </Field>
                <Field label={t('abbina.unita', 'Si conta in')} htmlFor="ff-nuovo-unita">
                  <input id="ff-nuovo-unita" className={dsInput} value={nuovaUnita} placeholder="pz, buste, kg…" onChange={e => setNuovaUnita(e.target.value)} />
                </Field>
              </div>
            </div>
          )}

          <Field
            label={t('abbina.confezione', 'In magazzino')}
            htmlFor="ff-fattore-magazzino"
            hint={quantitaMagazzino != null ? t('abbina.entrano', 'Entrano {{q}} {{u}}', { q: testoNumero(quantitaMagazzino), u: unitaProdotto }) : undefined}
          >
            <div className="flex items-center gap-2 text-[14px] text-[var(--ds-text-secondary)]">
              <span className="flex-shrink-0">1 {unitaFattura} =</span>
              <div className="w-28 flex-shrink-0">
                <input
                  id="ff-fattore-magazzino"
                  inputMode="decimal"
                  className={`${dsInput} text-right tabular-nums`}
                  value={fattoreMagazzino}
                  onChange={e => setFattoreMagazzino(e.target.value)}
                />
              </div>
              <span className="min-w-0 truncate">{unitaProdotto}</span>
            </div>
          </Field>

          {foodCost && (
            <Field
              label={t('abbina.prezzo', 'Prezzo nel food cost')}
              error={unitaDiversa ? t('abbina.unitaDiversa', 'Nel food cost questo prodotto si paga al {{u}}', { u: unitaDelProdotto }) : undefined}
              hint={
                unitaCosto === 'no'
                  ? t('abbina.prezzoNo', 'Il prezzo del prodotto non cambia.')
                  : costoAnteprima != null
                    ? t('abbina.prezzoAnteprima', '{{prezzo}} al {{u}}', { prezzo: formatMoneyMinor(costoAnteprima), u: unitaCosto })
                    : undefined
              }
            >
              <SegmentedControl<UnitaScelta>
                value={unitaCosto}
                onChange={u => {
                  setUnitaCosto(u);
                  if (u !== 'no') setFattoreCosto(testoNumero(guess && guess.unita === u ? guess.quantita : 1));
                }}
                ariaLabel={t('abbina.prezzo', 'Prezzo nel food cost')}
                size="sm"
                equalWidth={false}
                options={[
                  { value: 'kg', label: t('abbina.alKg', 'al kg') },
                  { value: 'l', label: t('abbina.alLitro', 'al litro') },
                  { value: 'pz', label: t('abbina.alPezzo', 'al pezzo') },
                  { value: 'no', label: t('abbina.nonAggiornare', 'non aggiornare') },
                ]}
              />
              {unitaCosto !== 'no' && (
                <div className="mt-2 flex items-center gap-2 text-[14px] text-[var(--ds-text-secondary)]">
                  <span className="flex-shrink-0">1 {unitaFattura} =</span>
                  <div className="w-28 flex-shrink-0">
                    <input
                      inputMode="decimal"
                      aria-label={t('abbina.contenuto', 'Contenuto della confezione')}
                      className={`${dsInput} text-right tabular-nums`}
                      value={fattoreCosto}
                      onChange={e => setFattoreCosto(e.target.value)}
                    />
                  </div>
                  <span>{unitaCosto}</span>
                </div>
              )}
            </Field>
          )}
        </>
      )}
    </Sheet>
  );
};
