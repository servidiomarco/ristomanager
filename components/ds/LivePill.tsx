import React from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, CloudOff, Server, ServerOff } from 'lucide-react';
import { displayLocale } from '../../utils/formatLocale';

// ---------------------------------------------------------------------------
// Lo stato della connessione e l'ora, in una pastiglia sola.
//
// Estratta dalla testata globale quando Comande ha smesso di averla: a schermo
// pieno la chrome è della pagina, ma «Live 19:12» deve restare — è l'unico
// posto in cui il palmare dice di essere ancora attaccato al server, e un
// cameriere che batte offline non se ne accorge da nient'altro.
//
// Il pallino pulsa, ma sotto prefers-reduced-motion diventa colore fermo: il
// segnale non si toglie mai, si toglie solo il movimento.
//
// Con la modalità ibrida accesa porta anche due icone, nodo di sala e online,
// accese o spente: la sala vede se sta lavorando solo col nodo (linea caduta),
// solo online (nodo giù) o con tutti e due. Spenta = glifo barrato, non solo
// più chiaro: il colore da solo non basta a dirlo.
// ---------------------------------------------------------------------------

interface LivePillProps {
  connected: boolean;
  /* NOTA per chi la monta: la pastiglia porta `inline-flex` (e il pallino
     `flex`) nella propria classe base. Per nasconderla serve una utility CON
     VARIANTE — `max-md:hidden`, non `hidden` — perche' fra due utility di
     display semplici vince quella che Tailwind emette dopo, non quella scritta
     dopo nella stringa. Con `hidden` la pastiglia resta visibile. */
  /** L'ora da mostrare. Chi possiede la pastiglia possiede anche il suo tick. */
  time: Date;
  /** 'pill' è la testata (fondo tinto); 'dot' è il solo pallino del telefono. */
  variant?: 'pill' | 'dot';
  /** Da dove lavora il dispositivo (useLinkRoutes). Null o assente = modalità
   *  ibrida spenta: niente icone. Le mostra solo la variante 'pill'. */
  routes?: { node: boolean; cloud: boolean } | null;
  /** Classi del gruppo icone, per nasconderlo dove la chrome non ha posto.
   *  Il gruppo porta `flex`: serve una utility CON variante (`max-xl:hidden`),
   *  come per la pastiglia intera. */
  routesClassName?: string;
  className?: string;
}

export const LivePill: React.FC<LivePillProps> = ({ connected, time, variant = 'pill', routes = null, routesClassName = '', className = '' }) => {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const label = connected ? t('live.connected', 'Connesso') : t('live.disconnected', 'Non connesso');
  // Tutti e due spenti vuol dire socket giù: lo dice già «Offline».
  const routesLabel = !routes ? null
    : routes.node && routes.cloud ? t('live.routes.both', 'Nodo e online')
    : routes.node ? t('live.routes.nodeOnly', 'Solo nodo')
    : routes.cloud ? t('live.routes.cloudOnly', 'Solo online')
    : null;
  const pillLabel = routesLabel ? `${label} · ${routesLabel}` : label;

  if (variant === 'dot') {
    return (
      <span
        className={`relative flex h-2.5 w-2.5 ${className}`}
        role="status"
        aria-live={connected ? 'polite' : 'assertive'}
        aria-label={label}
        title={label}
      >
        {connected && (
          <span className="absolute inline-flex h-full w-full rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden" aria-hidden></span>
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}
          aria-hidden
        ></span>
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 pl-2.5 pr-3 h-10 rounded-[var(--ds-radius-control)] text-[15px] font-medium ${
        connected
          ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
          : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
      } ${className}`}
      role="status"
      aria-live={connected ? 'polite' : 'assertive'}
      aria-label={pillLabel}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {connected && (
          <span className="absolute inline-flex h-full w-full rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden"></span>
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}></span>
      </span>
      <span className="whitespace-nowrap tabular-nums">
        {connected
          ? t('live.at', 'Live {{ora}}', { ora: time.toLocaleTimeString(displayLocale(), { hour: '2-digit', minute: '2-digit' }) })
          : t('live.offline', 'Offline')}
      </span>
      {routes && (
        <span className={`flex items-center gap-2 ${routesClassName}`} aria-hidden>
          <span className="h-4 w-px bg-current opacity-25"></span>
          <span className="flex" title={routes.node ? t('live.node.on', 'Lavora col nodo di sala') : t('live.node.off', 'Nodo di sala non raggiungibile')}>
            {routes.node ? <Server size={16} /> : <ServerOff size={16} className="opacity-60" />}
          </span>
          <span className="flex" title={routes.cloud ? t('live.cloud.on', 'Lavora online') : t('live.cloud.off', 'Online non raggiungibile')}>
            {routes.cloud ? <Cloud size={16} /> : <CloudOff size={16} className="opacity-60" />}
          </span>
        </span>
      )}
    </div>
  );
};
