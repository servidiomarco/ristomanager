// Wizard di primo accesso (Fase D1) — quello che un tenant appena
// provisionato non ha ancora: dati legali, sale e tavoli, orari, menu minimo.
//
// Lo vede solo l'OWNER, al posto dell'app, finché non tocca "entra nel
// gestionale" (App.tsx guarda user.tenant.needs_onboarding). I passi non si
// bloccano a vicenda — StepNav è navigazione, non un cancello: si può entrare
// anche a mani vuote e completare dopo dalle Impostazioni. Sale, tavoli e
// piatti si creano subito (sono POST veri); dati legali e orari si salvano
// tutti insieme all'uscita, così un ripensamento a metà non lascia mezze
// configurazioni.
import React, { useEffect, useMemo, useState } from 'react';
import { Building2, LayoutGrid, Clock, UtensilsCrossed, Plus, ArrowLeft, ArrowRight } from 'lucide-react';
import { ModalShell, StepNav, FormCard, Field, Stepper, dsInput, dsSelect, dsButton, dsStepArrow } from './ds';
import { useAuth } from '../contexts/AuthContext';
import {
    getLegalSettings, updateLegalSettings,
    getOpeningHours, updateOpeningHours, type OpeningHoursRow,
    getRooms, createRoom, getTables, createTable,
    getDishes, createDish,
} from '../services/apiService';
import { type Room, type Table, type Dish, TableShape, TableStatus } from '../types';

const STEPS = [
    { label: 'Ristorante', icon: Building2 },
    { label: 'Sale e tavoli', icon: LayoutGrid },
    { label: 'Orari', icon: Clock },
    { label: 'Menu', icon: UtensilsCrossed },
] as const;

const DISH_CATEGORIES = ['Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Bevande'] as const;

// Lunedì per primo: weekday resta 0=domenica come a database.
const WEEKDAYS: Array<{ weekday: number; label: string }> = [
    { weekday: 1, label: 'lunedì' },
    { weekday: 2, label: 'martedì' },
    { weekday: 3, label: 'mercoledì' },
    { weekday: 4, label: 'giovedì' },
    { weekday: 5, label: 'venerdì' },
    { weekday: 6, label: 'sabato' },
    { weekday: 0, label: 'domenica' },
];

interface LegalDraft {
    company_name: string;
    company_address: string;
    vat_number: string;
    public_phone: string;
    privacy_email: string;
}

export const OnboardingWizard: React.FC = () => {
    const { user, completeOnboarding } = useAuth();
    const [step, setStep] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [finishing, setFinishing] = useState(false);

    const [legal, setLegal] = useState<LegalDraft>({
        company_name: '', company_address: '', vat_number: '', public_phone: '', privacy_email: '',
    });
    const [hours, setHours] = useState<OpeningHoursRow[]>([]);
    const [rooms, setRooms] = useState<Room[]>([]);
    const [tables, setTables] = useState<Table[]>([]);
    const [dishes, setDishes] = useState<Dish[]>([]);

    const [newRoomName, setNewRoomName] = useState('');
    const [tableRoomId, setTableRoomId] = useState<number | null>(null);
    const [tableCount, setTableCount] = useState(4);
    const [tableSeats, setTableSeats] = useState(4);
    const [newDish, setNewDish] = useState({ name: '', price: '', category: 'Antipasti' as string });

    // Un login a metà onboarding riparte da quel che c'è già, non da zero.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [ls, oh, rs, ts, ds] = await Promise.all([
                    getLegalSettings(), getOpeningHours(), getRooms(), getTables(), getDishes(),
                ]);
                if (cancelled) return;
                setLegal({
                    company_name: ls.company_name || '',
                    company_address: ls.company_address || '',
                    vat_number: ls.vat_number || '',
                    public_phone: ls.public_phone || '',
                    privacy_email: ls.privacy_email || '',
                });
                setHours(oh);
                setRooms(rs);
                setTables(ts);
                setDishes(ds);
                if (rs.length > 0) setTableRoomId(rs[0].id);
            } catch {
                if (!cancelled) setError('Caricamento non riuscito. Ricarica la pagina.');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const tablesInRoom = useMemo(() => {
        const byRoom = new Map<number, number>();
        for (const t of tables) byRoom.set(t.room_id, (byRoom.get(t.room_id) || 0) + 1);
        return byRoom;
    }, [tables]);

    const handleAddRoom = async () => {
        const name = newRoomName.trim();
        if (!name) return;
        setError(null);
        try {
            const room = await createRoom({ name, width: 800, height: 600 });
            setRooms(prev => [...prev, room]);
            if (tableRoomId == null) setTableRoomId(room.id);
            setNewRoomName('');
        } catch {
            setError('Sala non creata. Riprova.');
        }
    };

    const handleAddTables = async () => {
        if (tableRoomId == null || tableCount < 1) return;
        setError(null);
        try {
            const existing = tablesInRoom.get(tableRoomId) || 0;
            const created: Table[] = [];
            for (let i = 0; i < tableCount; i++) {
                const n = existing + i;
                // Griglia 5 per riga dentro la sala 800×600: i tavoli nascono
                // ordinati, poi si spostano dalla pianta.
                created.push(await createTable({
                    name: `T${n + 1}`,
                    shape: TableShape.SQUARE,
                    seats: tableSeats,
                    x: 60 + (n % 5) * 140,
                    y: 60 + Math.floor(n / 5) * 140,
                    room_id: tableRoomId,
                    status: TableStatus.FREE,
                }));
            }
            setTables(prev => [...prev, ...created]);
        } catch {
            setError('Tavoli non creati del tutto. Riprova.');
            // I tavoli già creati restano: si rilegge la lista così la
            // numerazione del prossimo giro riparte da lì.
            const ts = await getTables().catch(() => null);
            if (ts) setTables(ts);
        }
    };

    const handleAddDish = async () => {
        const name = newDish.name.trim();
        const price = Number(String(newDish.price).replace(',', '.'));
        if (!name || !Number.isFinite(price) || price < 0) return;
        setError(null);
        try {
            const dish = await createDish({ name, price, category: newDish.category, allergens: [] });
            setDishes(prev => [...prev, dish]);
            setNewDish(d => ({ ...d, name: '', price: '' }));
        } catch {
            setError('Piatto non creato. Riprova.');
        }
    };

    const setHour = (weekday: number, field: 'lunch_open' | 'lunch_close' | 'dinner_open' | 'dinner_close', value: string) => {
        setHours(prev => prev.map(r => r.weekday === weekday ? { ...r, [field]: value || null } : r));
    };

    const handleFinish = async () => {
        setFinishing(true);
        setError(null);
        try {
            await updateLegalSettings({
                company_name: legal.company_name.trim(),
                company_address: legal.company_address.trim(),
                vat_number: legal.vat_number.trim(),
                public_phone: legal.public_phone.trim(),
                privacy_email: legal.privacy_email.trim(),
                // Il nome pubblico parte dal nome del tenant; si raffina poi.
                business_name: user?.tenant?.name || '',
            });
            for (const row of hours) {
                // Un turno a metà (solo apertura o solo chiusura) è chiuso:
                // il server rifiuterebbe la coppia spaiata.
                const lunchOk = !!(row.lunch_open && row.lunch_close);
                const dinnerOk = !!(row.dinner_open && row.dinner_close);
                await updateOpeningHours(row.weekday, {
                    lunch_open: lunchOk ? row.lunch_open : null,
                    lunch_close: lunchOk ? row.lunch_close : null,
                    dinner_open: dinnerOk ? row.dinner_open : null,
                    dinner_close: dinnerOk ? row.dinner_close : null,
                    slot_minutes: row.slot_minutes,
                    disabled_lunch_slots: row.disabled_lunch_slots,
                    disabled_dinner_slots: row.disabled_dinner_slots,
                });
            }
            await completeOnboarding();
            // Da qui App.tsx smette di montare il wizard: niente altro da fare.
        } catch {
            setError('Salvataggio non riuscito. Riprova.');
            setFinishing(false);
        }
    };

    const last = step === STEPS.length - 1;

    return (
        <div className="min-h-screen bg-[var(--ds-canvas)]">
            <ModalShell
                open
                onClose={() => {}}
                title={user?.tenant?.name || 'Il tuo ristorante'}
                subtitle="Prepara il gestionale: dati, sale e tavoli, orari, menu."
                size="lg"
                fixedHeight
                footerLayout="row"
                bodyClassName="p-4 sm:p-6 space-y-4"
                subheader={<StepNav steps={STEPS} current={step} onSelect={setStep} ariaLabel="Passi dell'onboarding" />}
                footerStart={error && <span className="text-[13px] text-[var(--ds-critical-text)]">{error}</span>}
                footer={
                    <>
                        <button type="button" className={dsStepArrow} onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0 || finishing} aria-label="Passo precedente">
                            <ArrowLeft className="h-5 w-5" aria-hidden />
                        </button>
                        {last ? (
                            <button type="button" className={dsButton.primary} onClick={handleFinish} disabled={finishing}>
                                {finishing ? 'Salvataggio…' : 'Entra nel gestionale'}
                            </button>
                        ) : (
                            <button type="button" className={dsStepArrow} onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))} aria-label="Passo successivo">
                                <ArrowRight className="h-5 w-5" aria-hidden />
                            </button>
                        )}
                    </>
                }
            >
                {step === 0 && (
                    <FormCard title="Dati del ristorante">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label="Ragione sociale" className="sm:col-span-2">
                                <input className={dsInput} value={legal.company_name} onChange={e => setLegal(l => ({ ...l, company_name: e.target.value }))} placeholder="Trattoria Da Mario S.r.l." />
                            </Field>
                            <Field label="Indirizzo" className="sm:col-span-2">
                                <input className={dsInput} value={legal.company_address} onChange={e => setLegal(l => ({ ...l, company_address: e.target.value }))} placeholder="Via Roma 1, Milano" />
                            </Field>
                            <Field label="Partita IVA">
                                <input className={dsInput} value={legal.vat_number} onChange={e => setLegal(l => ({ ...l, vat_number: e.target.value }))} inputMode="numeric" />
                            </Field>
                            <Field label="Telefono">
                                <input className={dsInput} value={legal.public_phone} onChange={e => setLegal(l => ({ ...l, public_phone: e.target.value }))} inputMode="tel" />
                            </Field>
                            <Field label="Email per la privacy" hint="Compare nell'informativa ai clienti." className="sm:col-span-2">
                                <input className={dsInput} value={legal.privacy_email} onChange={e => setLegal(l => ({ ...l, privacy_email: e.target.value }))} inputMode="email" />
                            </Field>
                        </div>
                    </FormCard>
                )}

                {step === 1 && (
                    <>
                        <FormCard title="Sale" aside={rooms.length > 0 ? `${rooms.length}` : undefined}>
                            {rooms.length > 0 && (
                                <ul className="mb-4 space-y-2">
                                    {rooms.map(r => (
                                        <li key={r.id} className="flex items-center justify-between rounded-[14px] bg-[var(--ds-surface-row)] px-4 py-2.5 text-[15px] text-[var(--ds-text-primary)]">
                                            <span>{r.name}</span>
                                            <span className="text-[13px] text-[var(--ds-text-muted)]">{tablesInRoom.get(r.id) || 0} tavoli</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="flex gap-2">
                                <input
                                    className={dsInput}
                                    value={newRoomName}
                                    onChange={e => setNewRoomName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleAddRoom(); }}
                                    placeholder="Sala interna"
                                />
                                <button type="button" className={dsButton.secondary} onClick={handleAddRoom} disabled={!newRoomName.trim()}>
                                    <Plus className="h-4 w-4" aria-hidden /> Sala
                                </button>
                            </div>
                        </FormCard>
                        <FormCard title="Tavoli" aside={tables.length > 0 ? `${tables.length}` : undefined}>
                            {rooms.length === 0 ? (
                                <p className="text-[14px] text-[var(--ds-text-muted)]">Prima crea una sala.</p>
                            ) : (
                                <div className="grid gap-4 sm:grid-cols-3">
                                    <Field label="Sala">
                                        <select className={dsSelect} value={tableRoomId ?? ''} onChange={e => setTableRoomId(Number(e.target.value))}>
                                            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                        </select>
                                    </Field>
                                    <Field label="Quanti tavoli">
                                        <Stepper value={tableCount} onChange={v => setTableCount(v ?? 1)} min={1} max={30} ariaLabel="Quanti tavoli" />
                                    </Field>
                                    <Field label="Coperti a tavolo">
                                        <Stepper value={tableSeats} onChange={v => setTableSeats(v ?? 2)} min={1} max={20} ariaLabel="Coperti a tavolo" />
                                    </Field>
                                    <div className="sm:col-span-3">
                                        <button type="button" className={dsButton.secondary} onClick={handleAddTables}>
                                            <Plus className="h-4 w-4" aria-hidden /> Aggiungi tavoli
                                        </button>
                                    </div>
                                </div>
                            )}
                        </FormCard>
                    </>
                )}

                {step === 2 && (
                    <FormCard title="Orari di apertura" aside="vuoto = chiuso">
                        <div className="space-y-3">
                            {WEEKDAYS.map(({ weekday, label }) => {
                                const row = hours.find(r => r.weekday === weekday);
                                if (!row) return null;
                                return (
                                    <div key={weekday} className="grid items-center gap-2 sm:grid-cols-[90px_1fr_1fr]">
                                        <span className="text-[14px] font-medium text-[var(--ds-text-secondary)]">{label}</span>
                                        <div className="flex items-center gap-2">
                                            <span className="w-14 text-[13px] text-[var(--ds-text-muted)]">pranzo</span>
                                            <input type="time" className={dsInput} value={row.lunch_open || ''} onChange={e => setHour(weekday, 'lunch_open', e.target.value)} />
                                            <input type="time" className={dsInput} value={row.lunch_close || ''} onChange={e => setHour(weekday, 'lunch_close', e.target.value)} />
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="w-14 text-[13px] text-[var(--ds-text-muted)]">cena</span>
                                            <input type="time" className={dsInput} value={row.dinner_open || ''} onChange={e => setHour(weekday, 'dinner_open', e.target.value)} />
                                            <input type="time" className={dsInput} value={row.dinner_close || ''} onChange={e => setHour(weekday, 'dinner_close', e.target.value)} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </FormCard>
                )}

                {step === 3 && (
                    <FormCard title="Menu" aside={dishes.length > 0 ? `${dishes.length}` : undefined}>
                        {dishes.length > 0 && (
                            <ul className="mb-4 space-y-2">
                                {dishes.map(d => (
                                    <li key={d.id} className="flex items-center justify-between rounded-[14px] bg-[var(--ds-surface-row)] px-4 py-2.5 text-[15px] text-[var(--ds-text-primary)]">
                                        <span>{d.name}</span>
                                        <span className="text-[13px] text-[var(--ds-text-muted)]">{d.category} · {Number(d.price).toFixed(2)} €</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="grid gap-4 sm:grid-cols-[1fr_120px_160px_auto]">
                            <Field label="Piatto">
                                <input
                                    className={dsInput}
                                    value={newDish.name}
                                    onChange={e => setNewDish(d => ({ ...d, name: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') handleAddDish(); }}
                                    placeholder="Spaghetti alle vongole"
                                />
                            </Field>
                            <Field label="Prezzo">
                                <input className={dsInput} value={newDish.price} onChange={e => setNewDish(d => ({ ...d, price: e.target.value }))} inputMode="decimal" placeholder="12" />
                            </Field>
                            <Field label="Categoria">
                                <select className={dsSelect} value={newDish.category} onChange={e => setNewDish(d => ({ ...d, category: e.target.value }))}>
                                    {DISH_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                            </Field>
                            <div className="flex items-end">
                                <button type="button" className={dsButton.secondary} onClick={handleAddDish} disabled={!newDish.name.trim() || newDish.price === ''}>
                                    <Plus className="h-4 w-4" aria-hidden /> Piatto
                                </button>
                            </div>
                        </div>
                    </FormCard>
                )}
            </ModalShell>
        </div>
    );
};
