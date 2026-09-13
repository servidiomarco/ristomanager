import React, { useMemo } from 'react';
import type { Room, Table } from '../../types';
import type { ServiceBill } from '../../services/ordersApiService';
import { type TableDisplayStatus } from '../TableGlyph';
import { RoomCanvas } from '../floor/RoomCanvas';
import { StatusPill } from '../ds';
import type { TableRow, TableState } from '../comande/tablesView';
import { euro } from './cassaView';

/* ── Passo 2b · piantina ──────────────────────────────────────────────────
   Griglia e piantina sono la stessa selezione letta in due modi: la griglia
   mette davanti quello che chiede un'azione, la piantina dice DOVE sta il
   tavolo.

   Il glifo è quello di sempre (`TableGlyph`), con i suoi token `--tg-*`: il
   design system dice che quella famiglia ha «i propri valori, con semantiche
   che concordano con le altre», e inventarne una sesta per la cassa avrebbe
   creato una seconda verità sullo stesso tavolo.

   La mappatura sta qui sotto, ed è deliberata. `uscita` («draining, turnover
   ahead») è letteralmente il tavolo che sta per pagare, quindi è lui a
   rappresentare «da incassare». La tinta NON è l'ambra che usa la griglia: la
   famiglia dei glifi ha una scala sua, e allinearle vorrebbe dire aggiungere
   token nuovi per una schermata sola. Quanto deve il tavolo lo dice il numero
   sotto al glifo, che è l'informazione che il cassiere cerca davvero.

   Il render è il RoomCanvas condiviso: nelle sale con pianta disegnata i
   tavoli stanno in scala reale dentro i muri veri, nelle altre tutto resta
   com'era. */

const GLYPH_STATUS: Record<TableState, TableDisplayStatus> = {
  bill: 'uscita',     // sta per liberarsi: manca solo il pagamento
  order: 'arrivato',  // seduti e in servizio
  booked: 'inarrivo', // tenuto per qualcuno che sta arrivando
  free: 'libera',
};

interface PiantinaProps {
  rows: TableRow[];
  room: Room | null;
  billByTable: Map<number, ServiceBill>;
  busy: boolean;
  onPick: (tableId: number) => void;
}

export const Piantina: React.FC<PiantinaProps> = ({ rows, room, billByTable, busy, onPick }) => {
  const inRoom = useMemo(
    () => (room ? rows.filter(r => r.table.room_id === room.id) : []),
    [rows, room]
  );
  const rowByTable = useMemo(
    () => new Map(inRoom.map(r => [r.table.id, r])),
    [inRoom]
  );
  const tables = useMemo(() => inRoom.map(r => r.table), [inRoom]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <RoomCanvas
          room={room}
          tables={tables}
          statusFor={(t: Table) => GLYPH_STATUS[rowByTable.get(t.id)?.state ?? 'free']}
          partyFor={(t: Table) => rowByTable.get(t.id)?.reservation?.guests}
          disabled={busy}
          onSelectTable={t => onPick(t.id)}
          renderTableExtras={(t: Table) => {
            const bill = billByTable.get(t.id);
            if (!bill || bill.residual_cents <= 0) return null;
            const partial = bill.paid_cents > 0 && bill.residual_cents > 0;
            return (
              /* Quanto deve il tavolo: è il numero che il cassiere cerca,
                 e il colore del glifo da solo non lo direbbe mai. */
              <span className="mt-0.5 flex flex-col items-center gap-0.5">
                <span className="text-[13px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                  {euro(bill.residual_cents)}
                </span>
                {/* Il pagamento parziale è una pill, non un quinto colore:
                    cinque tinte adiacenti non si distinguono di sbieco, con
                    poca luce, a metà servizio. */}
                {partial && <StatusPill tone="pending">parziale</StatusPill>}
              </span>
            );
          }}
        />
      </div>

      {/* Legenda. «In arrivo», non «Prenotato»: è il nome che lo stato ha in
          tutta l'app (tablesView.ts), e due nomi per la stessa cosa su due
          schermate adiacenti si pagano subito. */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-3 text-[12px] text-[var(--ds-text-muted)]">
        {([
          ['Libero', 'libera'],
          ['Comanda aperta', 'arrivato'],
          ['Da incassare', 'uscita'],
          ['In arrivo', 'inarrivo'],
        ] as [string, TableDisplayStatus][]).map(([label, status]) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full ring-1 ring-inset ring-[var(--ds-border-strong)]"
              style={{ background: `var(--tg-${status}-bg)` }}
              aria-hidden
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
};
