import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, DoorClosed, EyeOff, Calendar } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import {
    getRoomClosed,
    getTableHidden,
    createRoomClosed,
    createTableHidden,
    deleteRoomClosed,
    deleteTableHidden,
    getRooms,
    getTables,
} from '../services/apiService';
import { Shift, Room, Table, RoomClosedOverride, TableHiddenOverride } from '../types';
import { useAuth } from '../contexts/AuthContext';

interface Props {
    showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

// Aggregate row shown in the list: either a room-level closure or a
// table-level hide, unified so they can be sorted together by (date, shift).
type ClosureRow =
    | { kind: 'room'; id: number; date: string; shift: Shift; room_id: number }
    | { kind: 'table'; id: number; date: string; shift: Shift; table_id: number };

const shiftLabel = (s: Shift): string => (s === Shift.LUNCH ? 'Pranzo' : 'Cena');

const formatDate = (isoDate: string): string => {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

const todayISO = (): string => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

export const ScheduledClosuresManager: React.FC<Props> = ({ showToast }) => {
    const { hasPermission } = useAuth();
    const canEdit = hasPermission('floorplan:full');

    const [showPast, setShowPast] = useState(false);
    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<ClosureRow[]>([]);
    const [rooms, setRooms] = useState<Room[]>([]);
    const [tables, setTables] = useState<Table[]>([]);

    // Add-form state
    const [showForm, setShowForm] = useState(false);
    const [formKind, setFormKind] = useState<'room' | 'table'>('room');
    const [formDate, setFormDate] = useState(todayISO());
    const [formShift, setFormShift] = useState<Shift>(Shift.DINNER);
    const [formRoomId, setFormRoomId] = useState<number | ''>('');
    const [formTableId, setFormTableId] = useState<number | ''>('');
    const [saving, setSaving] = useState(false);

    const load = async (scope: 'future' | 'all') => {
        setLoading(true);
        try {
            const [roomsList, tablesList, roomClosed, tableHidden] = await Promise.all([
                getRooms(),
                getTables(),
                getRoomClosed(undefined, undefined, scope),
                getTableHidden(undefined, undefined, scope),
            ]);
            setRooms(roomsList);
            setTables(tablesList);
            const combined: ClosureRow[] = [
                ...roomClosed.map((r: RoomClosedOverride): ClosureRow => ({
                    kind: 'room', id: r.id, date: r.date, shift: r.shift, room_id: r.room_id,
                })),
                ...tableHidden.map((t: TableHiddenOverride): ClosureRow => ({
                    kind: 'table', id: t.id, date: t.date, shift: t.shift, table_id: t.table_id,
                })),
            ];
            combined.sort((a, b) => {
                if (a.date !== b.date) return a.date < b.date ? -1 : 1;
                if (a.shift !== b.shift) return a.shift === Shift.LUNCH ? -1 : 1;
                return a.kind === b.kind ? 0 : a.kind === 'room' ? -1 : 1;
            });
            setRows(combined);
        } catch (err: any) {
            showToast(err?.message || 'Errore nel caricamento delle chiusure', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load(showPast ? 'all' : 'future');
    }, [showPast]);

    const roomsById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);
    const tablesById = useMemo(() => new Map(tables.map(t => [t.id, t])), [tables]);

    const handleDelete = async (row: ClosureRow) => {
        try {
            if (row.kind === 'room') {
                await deleteRoomClosed(row.date, row.shift, row.room_id);
            } else {
                await deleteTableHidden(row.date, row.shift, row.table_id);
            }
            setRows(prev => prev.filter(r => !(r.kind === row.kind && r.id === row.id)));
            showToast('Chiusura rimossa', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Impossibile rimuovere la chiusura', 'error');
        }
    };

    const resetForm = () => {
        setFormKind('room');
        setFormDate(todayISO());
        setFormShift(Shift.DINNER);
        setFormRoomId('');
        setFormTableId('');
    };

    const handleAdd = async () => {
        if (formKind === 'room' && !formRoomId) {
            showToast('Seleziona una sala', 'error');
            return;
        }
        if (formKind === 'table' && !formTableId) {
            showToast('Seleziona un tavolo', 'error');
            return;
        }
        setSaving(true);
        try {
            if (formKind === 'room') {
                await createRoomClosed(formDate, formShift, Number(formRoomId));
            } else {
                await createTableHidden(formDate, formShift, Number(formTableId));
            }
            showToast('Chiusura aggiunta', 'success');
            setShowForm(false);
            resetForm();
            await load(showPast ? 'all' : 'future');
        } catch (err: any) {
            showToast(err?.message || 'Impossibile aggiungere la chiusura', 'error');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
                        <input
                            type="checkbox"
                            checked={showPast}
                            onChange={e => setShowPast(e.target.checked)}
                            className="rounded"
                        />
                        Mostra passate
                    </label>
                </div>
                {canEdit && (
                    <button
                        onClick={() => setShowForm(v => !v)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
                    >
                        <Plus className="h-4 w-4" />
                        Nuova chiusura
                    </button>
                )}
            </div>

            {showForm && canEdit && (
                <div className="mb-4 p-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] space-y-3">
                    <div className="flex gap-2">
                        <button
                            onClick={() => setFormKind('room')}
                            className={`flex-1 px-3 py-2 rounded-md text-sm font-medium border ${formKind === 'room'
                                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                : 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                        >
                            <DoorClosed className="h-4 w-4 inline mr-1" /> Sala
                        </button>
                        <button
                            onClick={() => setFormKind('table')}
                            className={`flex-1 px-3 py-2 rounded-md text-sm font-medium border ${formKind === 'table'
                                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                : 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                        >
                            <EyeOff className="h-4 w-4 inline mr-1" /> Tavolo
                        </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className="block text-xs text-[var(--color-fg-muted)] mb-1">Data</label>
                            <input
                                type="date"
                                value={formDate}
                                min={todayISO()}
                                onChange={e => setFormDate(e.target.value)}
                                className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-[var(--color-fg-muted)] mb-1">Turno</label>
                            <select
                                value={formShift}
                                onChange={e => setFormShift(e.target.value as Shift)}
                                className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                            >
                                <option value={Shift.LUNCH}>Pranzo</option>
                                <option value={Shift.DINNER}>Cena</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-[var(--color-fg-muted)] mb-1">
                                {formKind === 'room' ? 'Sala' : 'Tavolo'}
                            </label>
                            {formKind === 'room' ? (
                                <select
                                    value={formRoomId}
                                    onChange={e => setFormRoomId(e.target.value ? Number(e.target.value) : '')}
                                    className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                                >
                                    <option value="">Seleziona...</option>
                                    {rooms.map(r => (
                                        <option key={r.id} value={r.id}>{r.name}</option>
                                    ))}
                                </select>
                            ) : (
                                <select
                                    value={formTableId}
                                    onChange={e => setFormTableId(e.target.value ? Number(e.target.value) : '')}
                                    className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                                >
                                    <option value="">Seleziona...</option>
                                    {tables.map(t => {
                                        const room = roomsById.get(t.room_id);
                                        return (
                                            <option key={t.id} value={t.id}>
                                                {t.name}{room ? ` — ${room.name}` : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                            )}
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            onClick={() => { setShowForm(false); resetForm(); }}
                            className="px-3 py-1.5 rounded-md text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
                            disabled={saving}
                        >
                            Annulla
                        </button>
                        <button
                            onClick={handleAdd}
                            disabled={saving}
                            className="px-3 py-1.5 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                        >
                            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                            Conferma
                        </button>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-8 text-[var(--color-fg-muted)]">
                    <CookingPotLoader label="Caricamento..." />
                </div>
            ) : rows.length === 0 ? (
                <div className="text-center py-8 text-sm text-[var(--color-fg-muted)]">
                    <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    Nessuna chiusura {showPast ? '' : 'futura'} programmata.
                </div>
            ) : (
                <ul className="divide-y divide-[var(--color-line)] border border-[var(--color-line)] rounded-lg overflow-hidden">
                    {rows.map(row => {
                        const label = row.kind === 'room'
                            ? `Sala: ${roomsById.get(row.room_id)?.name ?? `#${row.room_id}`}`
                            : (() => {
                                const t = tablesById.get(row.table_id);
                                const room = t ? roomsById.get(t.room_id) : null;
                                return `Tavolo: ${t?.name ?? `#${row.table_id}`}${room ? ` — ${room.name}` : ''}`;
                            })();
                        const Icon = row.kind === 'room' ? DoorClosed : EyeOff;
                        return (
                            <li key={`${row.kind}-${row.id}`} className="flex items-center justify-between gap-3 px-4 py-3 bg-[var(--color-surface)]">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-8 h-8 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center flex-shrink-0">
                                        <Icon className="h-4 w-4 text-[var(--color-fg)]" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium text-[var(--color-fg)] truncate">{label}</div>
                                        <div className="text-xs text-[var(--color-fg-muted)]">
                                            {formatDate(row.date)} · {shiftLabel(row.shift)}
                                        </div>
                                    </div>
                                </div>
                                {canEdit && (
                                    <button
                                        onClick={() => handleDelete(row)}
                                        className="p-1.5 rounded-md text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/15 transition"
                                        title="Rimuovi chiusura"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};
