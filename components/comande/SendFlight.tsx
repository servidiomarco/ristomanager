import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BottleWine, CakeSlice, Soup } from 'lucide-react';

/* ── SendFlight ───────────────────────────────────────────────────────────
   Dopo l'Invia il piattino (e la bottiglia, e la fetta di torta) attraversano
   il bottone appena premuto: la ricevuta visiva di COSA è partito — cucina,
   bar, dolci — senza leggere il toast. Sta sulla comanda ancora aperta; a
   volo finito `onDone` chiude il tavolo e si torna alla griglia. Portale a
   posizione fissa sul rettangolo del bottone preso al tocco, così non
   dipende da dove il bottone sta nell'albero (colonna, foglio, pagina).
   Con riduzione del movimento non si monta: si torna ai tavoli subito. */

export type SendKind = 'food' | 'drink' | 'dessert';

export interface SendFlightData {
  /** Chiave di React: due invii di fila ripartono da capo. */
  id: number;
  from: { left: number; top: number; width: number; height: number };
  kinds: SendKind[];
}

/* Le stesse tinte delle sezioni del menu (DishBrowser): categorie, non stati. */
const KIND_CHROME: Record<SendKind, { icon: typeof Soup; chip: string }> = {
  food: { icon: Soup, chip: 'bg-[var(--ds-cat-6-tint)] text-[var(--ds-cat-6-text)]' },
  drink: { icon: BottleWine, chip: 'bg-[var(--ds-cat-2-tint)] text-[var(--ds-cat-2-text)]' },
  dessert: { icon: CakeSlice, chip: 'bg-[var(--ds-cat-4-tint)] text-[var(--ds-cat-4-text)]' },
};

const CHIP = 36;
const STAGGER_MS = 110;
const FLIGHT_MS = 900;

export const SendFlight: React.FC<{ flight: SendFlightData; onDone: () => void }> = ({ flight, onDone }) => {
  const { from, kinds } = flight;
  useEffect(() => {
    const t = window.setTimeout(onDone, FLIGHT_MS + STAGGER_MS * (kinds.length - 1) + 50);
    return () => window.clearTimeout(t);
    // onDone cambia a ogni render del genitore: il timer vale per questo volo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.id]);

  // Il bottone del palmare può essere stretto quanto un pollice: sotto i
  // 160px il volo si allarga attorno al suo centro, o non si vedrebbe.
  const width = Math.max(from.width, 160);
  const left = from.left + from.width / 2 - width / 2;
  const dist = Math.max(0, width - CHIP);

  return createPortal(
    <>
      {/* Per il secondo del volo la comanda è già partita e sta per chiudersi:
          un tocco qui (un altro piatto, «Conto») finirebbe su un tavolo che
          sparisce sotto il dito. Velo trasparente, niente da vedere. */}
      <div aria-hidden className="fixed inset-0 z-[99]" />
      <div
        aria-hidden
        className="pointer-events-none fixed z-[100]"
        style={{ left, top: from.top + from.height / 2 - CHIP / 2, width, height: CHIP }}
      >
        {kinds.map((kind, i) => {
          const { icon: Icon, chip } = KIND_CHROME[kind];
          return (
            <span
              key={kind}
              className={`ds-send-flight absolute left-0 top-0 inline-flex h-9 w-9 items-center justify-center rounded-full shadow-[var(--ds-shadow-raised)] ${chip}`}
              style={{
                '--send-flight-dist': `${dist}px`,
                animationDelay: `${i * STAGGER_MS}ms`,
                animationDuration: `${FLIGHT_MS}ms`,
              } as React.CSSProperties}
            >
              <Icon size={18} strokeWidth={2} />
            </span>
          );
        })}
      </div>
    </>,
    document.body,
  );
};
