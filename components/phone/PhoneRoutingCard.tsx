import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PhoneForwarded, Plus, X } from 'lucide-react';
import { SegmentedControl, dsButton, dsInput } from '../ds';
import { useAuth } from '../../contexts/AuthContext';
import { voiceCallsApiService, type PhoneRouting } from '../../services/voiceCallsApiService';

/* ── Chi risponde al telefono (docs/telefono-piano.md, Fase 3 ridotta) ─────
   Con Sympotia davanti al numero di Sofia, il ristoratore sceglie se
   risponde subito Sofia o se prima squilla il cellulare del locale. Il
   cellulare squilla come una telefonata normale: chi risponde sente chi
   chiama e preme 1; se nessuno lo fa entro il tempo scelto, risponde Sofia.
   Softphone nel CRM e cordless arriveranno sullo stesso giro. */

const MAX_MOBILES = 3;

interface Props {
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

const sameRouting = (a: PhoneRouting, b: PhoneRouting): boolean =>
  a.mode === b.mode && a.ring_seconds === b.ring_seconds && a.mobiles.join(',') === b.mobiles.join(',');

export const PhoneRoutingCard: React.FC<Props> = ({ showToast }) => {
  const { t } = useTranslation('canali', { useSuspense: false });
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings:full');

  const [saved, setSaved] = useState<PhoneRouting | null>(null);
  const [mode, setMode] = useState<PhoneRouting['mode']>('solo_sofia');
  const [mobiles, setMobiles] = useState<string[]>(['']);
  const [ring, setRing] = useState('15');
  const [saving, setSaving] = useState(false);

  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  const load = (r: PhoneRouting) => {
    setSaved(r);
    setMode(r.mode);
    setMobiles(r.mobiles.length > 0 ? r.mobiles : ['']);
    setRing(String(r.ring_seconds));
  };

  useEffect(() => {
    let cancelled = false;
    voiceCallsApiService.phoneRouting()
      .then(r => { if (!cancelled) load(r); })
      // Un server senza la rotta (deploy in corso) non mostra la card.
      .catch(() => { if (!cancelled) setSaved(null); });
    return () => { cancelled = true; };
  }, []);

  if (!saved) {
    return null;
  }

  const draft: PhoneRouting = {
    mode,
    mobiles: mobiles.map(m => m.trim()).filter(Boolean),
    ring_seconds: Number(ring),
  };
  const ringValid = Number.isInteger(draft.ring_seconds) && draft.ring_seconds >= 5 && draft.ring_seconds <= 60;
  const valid = ringValid && (mode === 'solo_sofia' || draft.mobiles.length > 0);
  const dirty = !sameRouting(draft, saved);

  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    try {
      load(await voiceCallsApiService.updatePhoneRouting(draft));
      showToast(t('pr.saved', 'Impostazione salvata'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('pr.err', 'Salvataggio non riuscito'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
          <PhoneForwarded className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h4 className="text-[14px] font-medium text-[var(--ds-text-primary)]">{t('pr.title', 'Chi risponde al telefono')}</h4>
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('pr.subtitle', 'Le chiamate al numero di Sofia')}</p>
        </div>
      </div>

      <div className="mt-4">
        <SegmentedControl
          value={mode}
          onChange={next => canEdit && setMode(next)}
          ariaLabel={t('pr.title', 'Chi risponde al telefono')}
          equalWidth={false}
          options={[
            { value: 'solo_sofia', label: t('pr.soloSofia', 'Solo Sofia') },
            { value: 'prima_cellulare', label: t('pr.primaCellulare', 'Prima il cellulare') },
          ]}
        />
      </div>

      {mode === 'prima_cellulare' && (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-[var(--ds-text-secondary)]">
            {t('pr.hint', 'Squilla come una chiamata normale, dal numero di Sofia. Chi risponde sente chi chiama e preme 1; se nessuno risponde in tempo, risponde Sofia.')}
          </p>
          {mobiles.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="tel"
                inputMode="tel"
                value={m}
                disabled={!canEdit}
                onChange={e => setMobiles(prev => prev.map((v, j) => (j === i ? e.target.value : v)))}
                placeholder={t('pr.mobilePh', 'Cellulare, es. 347 123 4567')}
                aria-label={t('pr.mobile', 'Cellulare')}
                className={dsInput}
              />
              {mobiles.length > 1 && canEdit && (
                <button
                  type="button"
                  onClick={() => setMobiles(prev => prev.filter((_, j) => j !== i))}
                  aria-label={t('pr.remove', 'Togli questo cellulare')}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {mobiles.length < MAX_MOBILES && canEdit && (
            <button
              type="button"
              onClick={() => setMobiles(prev => [...prev, ''])}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 text-[13px] font-medium text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Plus className="h-4 w-4" aria-hidden /> {t('pr.add', 'Un altro cellulare')}
            </button>
          )}
          <label className="flex items-center gap-2 text-[14px] text-[var(--ds-text-primary)]">
            {t('pr.ringFor', 'Squilla per')}
            <input
              type="number"
              min={5}
              max={60}
              value={ring}
              disabled={!canEdit}
              onChange={e => setRing(e.target.value)}
              className="h-11 w-20 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-3 text-center text-[15px] tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            />
            {t('pr.seconds', 'secondi, poi Sofia')}
          </label>
        </div>
      )}

      {canEdit && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={save} disabled={!valid || !dirty || saving} className={dsButton.primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('pr.save', 'Salva')}
          </button>
        </div>
      )}
    </div>
  );
};
