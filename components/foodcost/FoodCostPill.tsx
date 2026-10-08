import React from 'react';
import { StatusPill, type PillTone } from '../ds';
import { formatPct, semaforo, type Semaforo } from '../../utils/foodCost';

/* La percentuale di food cost con il suo colore: verde entro il target,
   ambra fino a cinque punti sopra, rosso oltre. Sono stati veri (§3: «da
   guardare», «fuori»), non categorie, quindi le famiglie di stato. */

const TONE: Record<Semaforo, PillTone> = { ok: 'positive', attenzione: 'pending', alto: 'critical' };

export const FoodCostPill: React.FC<{
  pct: number | null;
  /** Già calcolato dal chiamante; se assente si ricava da targetPct. */
  tone?: Semaforo | null;
  targetPct?: number;
  className?: string;
}> = ({ pct, tone, targetPct = 30, className }) => {
  if (pct == null) return <span className="text-[var(--ds-text-muted)]">—</span>;
  const s = tone === undefined ? semaforo(pct, targetPct) : tone;
  return (
    <StatusPill tone={s ? TONE[s] : 'neutral'} className={`tabular-nums ${className ?? ''}`}>
      {formatPct(pct)}
    </StatusPill>
  );
};
