import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ModalShell, SegmentedControl, dsButton, dsInput } from '../ds';

// Estratto da OrderPad quando Cassa ha avuto bisogno dello stesso dialogo
// (docs/cassa-plan.md §8). Lo sconto è di CONTO, non di riga — quello di riga
// è fuori dall'MVP (§12) — quindi è lo stesso identico gesto nei due moduli.
//
// La motivazione spiega a fine servizio la differenza fra quello che il menu
// diceva e quello che è entrato. Sul palmare resta obbligatoria; in cassa è
// facoltativa (scelta di Marco, 10/09): chi sta al banco sconta anche al
// volo, e il campo resta lì per chi vuole lasciare traccia.

export const DiscountDialog: React.FC<{
  currentReason: string | null;
  hasDiscount: boolean;
  busy: boolean;
  /** «Sconto sulla comanda» (default) o «Sconto sul conto» in cassa, dove la
   *  comanda è già chiusa e lo sconto vive sul conto. */
  title?: string;
  /** false in cassa: si applica anche senza motivazione. */
  reasonRequired?: boolean;
  onCancel: () => void;
  onClear: () => void;
  onConfirm: (p: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string }) => void;
}> = ({ currentReason, hasDiscount, busy, title, reasonRequired = true, onCancel, onClear, onConfirm }) => {
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState(currentReason ?? '');
  const num = Number(value.replace(',', '.'));
  const valid = Number.isFinite(num) && num > 0 && (type !== 'PERCENT' || num <= 100)
    && (!reasonRequired || reason.trim().length >= 3);

  return (
    <ModalShell
      open
      onClose={onCancel}
      title={title ?? 'Sconto sulla comanda'}
      subtitle="Resta a registro con il tuo nome: serve a spiegare la differenza a fine servizio."
      size="sm"
      closeOnEscape
      bodyClassName="space-y-3 p-5 sm:p-6"
      footerStart={
        hasDiscount ? (
          <button type="button" onClick={onClear} disabled={busy} className={dsButton.quiet}>
            Rimuovi
          </button>
        ) : undefined
      }
      footer={
        <button
          type="button"
          onClick={() => onConfirm({ discount_type: type, discount_value: num, reason: reason.trim() })}
          disabled={busy || !valid}
          className={dsButton.primary}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Applica
        </button>
      }
    >
      <SegmentedControl<'PERCENT' | 'AMOUNT'>
        value={type}
        onChange={setType}
        ariaLabel="Tipo di sconto"
        options={[
          { value: 'PERCENT', label: 'Percentuale' },
          { value: 'AMOUNT', label: 'Importo €' },
        ]}
      />
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        inputMode="decimal"
        autoFocus
        placeholder={type === 'PERCENT' ? '10' : '5,00'}
        aria-label={type === 'PERCENT' ? 'Percentuale di sconto' : 'Importo dello sconto'}
        className={dsInput}
      />
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder={reasonRequired ? 'Motivazione (obbligatoria)' : 'Motivazione (facoltativa)'}
        aria-label="Motivazione dello sconto"
        className={dsInput}
      />
    </ModalShell>
  );
};
