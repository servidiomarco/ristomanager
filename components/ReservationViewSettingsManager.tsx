import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getFeatureFlags, updateFeatureFlags, FeatureFlags } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { SegmentedControl } from './ds';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

type ReservationView = 'merged' | 'step';

/* Come si sceglie il tavolo quando si apre una prenotazione. Le due viste
   fanno le stesse identiche cose — cambia solo dove sta la sala:

   - unita: il tavolo vive dentro Dettagli, riassunto in una riga che si apre
     dove sta. Chi prenota al telefono resta su una schermata sola.
   - a parte: il tavolo diventa un passo suo e prende tutta la larghezza. Chi
     lavora molto sulla piantina vede piu' tavoli senza scorrere.

   Non e' un interruttore: nessuna delle due e' "spenta". Per questo un
   SegmentedControl e non uno Switch — §7.2 lo da' per due o tre opzioni che
   si escludono, che e' esattamente questo caso. */
const VIEW_COPY: Record<ReservationView, { label: string; detail: string }> = {
    merged: {
        label: 'Tutto in una vista',
        detail: 'Il tavolo sta dentro Dettagli, in una riga che si apre dove sta.',
    },
    step: {
        label: 'Tavolo a parte',
        detail: 'Il tavolo è un passo suo e prende tutta la larghezza.',
    },
};

export const ReservationViewSettingsManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('settings:full');

    const [flags, setFlags] = useState<FeatureFlags | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getFeatureFlags();
                if (!cancelled) setFlags(data);
            } catch (err: any) {
                if (!cancelled) showToastRef.current(err?.message || 'Errore nel caricamento delle impostazioni', 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const select = async (next: ReservationView) => {
        if (!flags || !canEdit || saving) return;
        const nextValue = next === 'step';
        if (nextValue === flags.reservation_table_step_enabled) return;
        // Ottimista, con rollback sull'errore: la scelta e' una preferenza di
        // layout, non un dato — l'attesa di rete non deve rendere il controllo
        // insensibile sotto il dito.
        const previous = flags;
        setFlags({ ...flags, reservation_table_step_enabled: nextValue });
        setSaving(true);
        try {
            const updated = await updateFeatureFlags({ reservation_table_step_enabled: nextValue });
            setFlags(updated);
            showToast(`Vista prenotazione: ${VIEW_COPY[next].label.toLowerCase()}`, 'success');
        } catch (err: any) {
            setFlags(previous);
            showToast(err?.message || 'Errore aggiornamento impostazione', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading || !flags) {
        return (
            <div className="flex items-center gap-2 px-1 py-2 text-[13px] text-[var(--ds-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Caricamento…
            </div>
        );
    }

    const current: ReservationView = flags.reservation_table_step_enabled ? 'step' : 'merged';

    /* Senza permesso il controllo sparisce invece di restare li' spento:
       SegmentedControl non ha uno stato disabilitato, quindi resterebbe
       cliccabile e non farebbe niente — un comando che non risponde e' peggio
       di un comando che non c'e'. La vista in uso si legge lo stesso. */
    if (!canEdit) {
        return (
            <div className="space-y-1.5">
                <p className="text-[15px] font-medium text-[var(--ds-text-primary)]">{VIEW_COPY[current].label}</p>
                <p className="text-[13px] leading-[18px] text-[var(--ds-text-muted)]">
                    {VIEW_COPY[current].detail} La cambia chi gestisce le impostazioni.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {/* `equalWidth={false}`: "Tutto in una vista" e' quasi il doppio di
                "Tavolo a parte", e a larghezze uguali la prima si troncava. */}
            <SegmentedControl<ReservationView>
                value={current}
                onChange={select}
                equalWidth={false}
                ariaLabel="Vista del modal prenotazione"
                options={[
                    { value: 'merged', label: VIEW_COPY.merged.label },
                    { value: 'step', label: VIEW_COPY.step.label },
                ]}
            />
            <p className="text-[13px] leading-[18px] text-[var(--ds-text-muted)]">
                {VIEW_COPY[current].detail}
            </p>
        </div>
    );
};
