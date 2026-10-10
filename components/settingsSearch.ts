import { useEffect, useState, type RefObject } from 'react';

/* Ricerca nella pagina Impostazioni.

   La pagina è una sola e tutte le card sono sempre montate (anche il corpo
   delle card chiuse: è un <details>), quindi si cerca nel testo che c'è già
   a schermo invece di tenere un indice a parte — un elenco di voci da
   allineare a mano a ogni card nuova divergerebbe al primo giro, come era
   già successo ai nomi delle sezioni nel menu.

   Il DOM lo marcano i blocchi di App.tsx:
   - [data-imp-sezione] con [data-imp-etichetta]: un blocco (Profilo, …);
   - [data-imp-lista] (o, se manca, [data-imp-contenuto]): il contenitore
     le cui figlie sono le card da filtrare;
   - [data-imp-parole] su una card: sinonimi che nel testo non compaiono.

   Una card resta se contiene tutte le parole cercate (senza accenti né
   maiuscole); se le contiene il nome del blocco, resta il blocco intero. Le
   card chiuse che trovano la parola solo nel corpo si aprono, e si
   richiudono quando la ricerca si svuota. Le card si nascondono con un
   attributo (index.css), non con `hidden`: una classe `flex` lo
   scavalcherebbe, e React non tocca un attributo che non ha messo lui. */

export const normalizeSearch = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const HIDDEN_ATTR = 'data-imp-nascosto';
const HIGHLIGHT = 'imp-ricerca';
const MAX_HIGHLIGHTS = 300;

const textOf = (el: Element): string =>
  normalizeSearch(`${el.textContent || ''} ${(el as HTMLElement).dataset?.impParole || ''}`);

const itemsOf = (section: Element): Element[] => {
  const list = section.querySelector('[data-imp-lista]') || section.querySelector('[data-imp-contenuto]');
  return list ? Array.from(list.children) : [];
};

const setHidden = (el: Element, hidden: boolean) => {
  if (hidden) el.setAttribute(HIDDEN_ATTR, '');
  else el.removeAttribute(HIDDEN_ATTR);
};

/* Lo stile dell'evidenziazione sta qui e non in index.css: l'ottimizzatore
   CSS della build (lightningcss) non riconosce ::highlight e avvisa a ogni
   build. È un segno di lettura, non uno stato: la tinta del focus, tenue,
   non una famiglia di stato. */
const ensureHighlightStyle = () => {
  if (document.getElementById('imp-ricerca-stile')) return;
  const style = document.createElement('style');
  style.id = 'imp-ricerca-stile';
  style.textContent = `::highlight(${HIGHLIGHT}) { background-color: color-mix(in srgb, var(--ds-border-focus) 28%, transparent); color: var(--ds-text-primary); }`;
  document.head.appendChild(style);
};

/** Evidenzia le parole con la CSS Custom Highlight API, dove c'è: nessun
 *  nodo aggiunto al DOM, quindi niente che React debba riconciliare. */
const highlight = (root: HTMLElement, words: string[]) => {
  const registry = (window as any).CSS?.highlights;
  const HighlightCtor = (window as any).Highlight;
  if (!registry || !HighlightCtor) return;
  ensureHighlightStyle();
  registry.delete(HIGHLIGHT);
  if (words.length === 0) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const parent = node.parentElement;
      if (!parent || parent.closest(`[${HIDDEN_ATTR}]`) || parent.closest('details:not([open]) > :not(summary)')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node && ranges.length < MAX_HIGHLIGHTS; node = walker.nextNode()) {
    const raw = node.nodeValue || '';
    // La normalizzazione toglie gli accenti senza cambiare la lunghezza
    // delle lettere italiane (à → a), quindi gli indici restano validi; per
    // testi in cui non è così, si salta il nodo invece di evidenziare storto.
    const flat = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (flat.length !== raw.length) continue;
    for (const w of words) {
      let from = 0;
      for (let i = flat.indexOf(w, from); i !== -1 && ranges.length < MAX_HIGHLIGHTS; i = flat.indexOf(w, from)) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + w.length);
        ranges.push(r);
        from = i + w.length;
      }
    }
  }
  if (ranges.length > 0) registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
};

/** Filtra le card della pagina Impostazioni sotto `rootRef`. Restituisce
 *  quante card restano (null se non si sta cercando). `active` è la pagina
 *  a schermo: quando torna, il filtro si riapplica al DOM appena montato. */
export function useSettingsSearch(rootRef: RefObject<HTMLElement | null>, query: string, active: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const words = normalizeSearch(query).split(' ').filter(Boolean);
    const opened = new Set<HTMLDetailsElement>();

    const apply = () => {
      let visible = 0;
      for (const section of Array.from(root.querySelectorAll('[data-imp-sezione]'))) {
        const items = itemsOf(section);
        if (words.length === 0) {
          setHidden(section, false);
          items.forEach(i => setHidden(i, false));
          continue;
        }
        const label = normalizeSearch((section as HTMLElement).dataset.impEtichetta || '');
        const wholeSection = words.every(w => label.includes(w));
        let shown = 0;
        for (const item of items) {
          const text = textOf(item);
          const match = wholeSection || words.every(w => text.includes(w));
          setHidden(item, !match);
          if (!match) continue;
          shown++;
          if (wholeSection) continue;
          // La parola sta solo nel corpo di una card chiusa: la si apre. La
          // card stessa è spesso il <details> (SettingsDisclosure), e
          // querySelectorAll guarda solo dentro: la si aggiunge a mano.
          const details = [
            ...(item instanceof HTMLDetailsElement ? [item] : []),
            ...Array.from(item.querySelectorAll('details')),
          ];
          for (const d of details) {
            if (d.open) continue;
            const summary = d.querySelector(':scope > summary');
            const inSummary = summary ? words.every(w => textOf(summary).includes(w)) : false;
            if (!inSummary && words.every(w => textOf(d).includes(w))) {
              d.open = true;
              opened.add(d);
            }
          }
        }
        setHidden(section, shown === 0);
        visible += shown;
      }
      highlight(root, words);
      setCount(words.length === 0 ? null : visible);
    };

    apply();
    if (words.length === 0) return;
    // I risultati partono dall'alto: senza, chi cerca da metà pagina vede
    // il filtro accadere sopra di sé, fuori schermo.
    const scroller = root.closest('.overflow-y-auto');
    if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;

    // Il contenuto arriva anche dopo (liste caricate, card che si montano):
    // finché si cerca, ogni cambio di testo rifà il filtro. Si osservano
    // solo nodi e testo, non gli attributi: quelli li scrive apply stesso.
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      opened.forEach(d => { d.open = false; });
    };
  }, [rootRef, query, active]);

  // Uscendo dalla pagina non resta un'evidenziazione appesa altrove.
  useEffect(() => () => { (window as any).CSS?.highlights?.delete(HIGHLIGHT); }, []);

  return count;
}
