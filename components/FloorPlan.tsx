import React, { useState, useRef, useEffect, useMemo } from 'react';
import { flushSync, createPortal } from 'react-dom';
import { Table, TableShape, Room, TableStatus, Reservation, ReservationSource, Shift, TableMerge, TableHiddenOverride, RoomClosedOverride, ArrivalStatus, ReservationStatus, BanquetMenu } from '../types';
import { Plus, Move, Armchair, Trash2, Combine, Scissors, Save, MousePointer2, CheckSquare, Lock, Unlock, Users, X, Clock, Timer, User, Check, Layout, CaseSensitive, AlertTriangle, Sun, Sunset, Loader2, Info, RotateCw, Ruler, StickyNote, Eye, EyeOff, DoorClosed, DoorOpen, BookOpen, Mic, ChevronDown } from 'lucide-react';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';
import { deriveTableDisplayStatus, isSeated, TABLE_STATUS_LABEL } from './reservationState';
import { useNow } from '../hooks/useNow';
import { Loader } from './Loader';
import { computeAutoLayout } from '../utils/tableLayout';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { buildFloorLabels } from '../utils/labelPlacement';
import { buildBanquetColorClassMap } from '../utils/banquetColors';
import { BanquetLabel } from './ReservationCard';
import { snapToGrid, collidesWithOthers, findOverlappingPairs, getTableFootprint, FLOOR_CLEARANCE } from '../utils/tableOverlap';
import { toTitleCase, getInitials } from '../utils/text';
import { getTableMerges, getTableHidden, createTableHidden, deleteTableHidden, getRoomClosed, createRoomClosed, deleteRoomClosed } from '../services/apiService';
import { applyMerges } from '../utils/tableMerge';
import { useSocket } from '../hooks/useSocket';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { DateNavigator } from './DateNavigator';
import { SegmentedControl, Callout, ModalShell, FormCard, Field, dsInput, dsTextarea, dsButton, dsIconButton } from './ds';

console.log('🔥🔥🔥 FLOORPLAN MODULE LOADED - NEW VERSION WITH MERGE FILTER DEBUG 🔥🔥🔥');

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const detectShiftFromNow = (): Shift => {
  const hour = new Date().getHours();
  return hour >= 11 && hour < 17 ? Shift.LUNCH : Shift.DINNER;
};

// The "n nascosti" toggle appears twice — mobile header and desktop note. It
// means the same thing in both, so the states live here rather than being
// retyped per breakpoint, where they drifted apart before. Height is applied at
// the call site: 44px on mobile, 32px in the dense desktop row.
const HIDDEN_TOGGLE_BASE =
  'inline-flex items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const HIDDEN_TOGGLE_ON = 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]';
const HIDDEN_TOGGLE_OFF =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]';

// Room tabs. A closed room stays legible rather than being greyed out of
// reach — you still need to open it again from here, so "closed" is carried by
// the strike-through and the door glyph, not by disabling the control.
const ROOM_TAB_BASE =
  'inline-flex h-11 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const ROOM_TAB_ACTIVE = 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]';
const ROOM_TAB_ACTIVE_CLOSED = 'bg-[var(--ds-text-muted)] text-[var(--ds-surface)] line-through';
const ROOM_TAB_IDLE =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]';
const ROOM_TAB_IDLE_CLOSED =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-subtle)] hover:bg-[var(--ds-border)] line-through';

// A latched tool (selection mode, manual layout) has to read as "on" and not
// merely hovered, so it takes the tint rather than a darker grey.
const TOOL_BUTTON_ON = 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]';

// Selection-toolbar actions: one 44px pill shape that takes an icon and an
// optional short label, so "Unisci", "Dividi" and "Elimina" differ by tone
// only and the row keeps a single rhythm however many actions are showing.
const EDIT_ACTION_BASE =
  'inline-flex h-11 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const EDIT_ACTION_QUIET =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]';
// Inline value editors (name, seats) sit on the same 44px baseline as the
// buttons beside them — a shorter field made the row look broken.
const EDIT_FIELD_WRAP =
  'flex h-11 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3';

interface FloorPlanProps {
  rooms: Room[];
  tables: Table[];
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  onUpdateTable: (updatedTable: Table) => void;
  onDeleteTable: (tableId: number) => void;
  onAddTable: (table: Omit<Table, 'id'>) => void;
  onMergeTables: (tableIds: number[], date: string, shift: Shift) => Promise<void> | void;
  onSplitTable: (tableId: number, date: string, shift: Shift) => Promise<void> | void;
  onAddRoom: (roomName: string) => void;
  onDeleteRoom: (room_id: number) => void;
  onToggleRoomClosed: (room_id: number, is_closed: boolean) => void;
  canEdit?: boolean;
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
}

export const FloorPlan: React.FC<FloorPlanProps> = ({
  rooms,
  tables,
  reservations,
  banquetMenus,
  onUpdateTable,
  onDeleteTable,
  onAddTable,
  onMergeTables,
  onSplitTable,
  onAddRoom,
  onDeleteRoom,
  onToggleRoomClosed,
  canEdit = true,
  globalDate,
  globalShiftFilter: globalShiftFilterProp,
}) => {
  console.log('🎨 FLOORPLAN COMPONENT RENDERING with', tables.length, 'tables');

  const [activeRoomId, setActiveRoomId] = useState<number>(() => {
    const firstRoom = rooms[0];
    return typeof firstRoom?.id === 'number' ? firstRoom.id : 0;
  });
  const [selectedTables, setSelectedTables] = useState<number[]>([]);
  // Bozza locale del campo coperti: si digita liberamente e si applica su
  // blur/Invio. Senza, l'input controllato combatte la digitazione — e sul
  // tavolo unito (che mostra la SOMMA dei coperti) ogni tasto faceva saltare
  // il numero della capienza dei tavoli agganciati.
  const [seatsDraft, setSeatsDraft] = useState<{ id: number; value: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isLegendOpen, setIsLegendOpen] = useState(false);

  // Per-shift merge context — synced from global header on desktop
  const [selectedDate, setSelectedDate] = useState<string>(() =>
    globalDate ? formatLocalDate(globalDate) : formatLocalDate(new Date())
  );
  const [selectedShift, setSelectedShift] = useState<Shift>(() => {
    if (globalShiftFilterProp === 'LUNCH') return Shift.LUNCH;
    if (globalShiftFilterProp === 'DINNER') return Shift.DINNER;
    return detectShiftFromNow();
  });

  useEffect(() => {
    if (globalDate) setSelectedDate(formatLocalDate(globalDate));
  }, [globalDate]);
  useEffect(() => {
    if (globalShiftFilterProp === 'LUNCH') setSelectedShift(Shift.LUNCH);
    else if (globalShiftFilterProp === 'DINNER') setSelectedShift(Shift.DINNER);
  }, [globalShiftFilterProp]);
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  const [isLoadingMerges, setIsLoadingMerges] = useState(false);
  const [hiddenTableIds, setHiddenTableIds] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [closedRoomIdsForShift, setClosedRoomIdsForShift] = useState<Set<number>>(new Set());
  const [roomClosureMenuOpen, setRoomClosureMenuOpen] = useState(false);
  // Anchor rect for the room-closure dropdown (portal target). We render the
  // menu at body level so the toolbar's overflow-x doesn't clip it vertically.
  const [roomClosureAnchor, setRoomClosureAnchor] = useState<DOMRect | null>(null);
  const roomClosureButtonRef = useRef<HTMLButtonElement | null>(null);

  // Layout mode: 'auto' uses computed tidy rows; 'manual' uses saved x/y and
  // re-enables drag-to-position so the floor plan can mirror the real room.
  const [layoutMode, setLayoutMode] = useState<'auto' | 'manual'>(() => {
    if (typeof window === 'undefined') return 'auto';
    try {
      const saved = window.localStorage.getItem('floorPlan.layoutMode');
      return saved === 'manual' ? 'manual' : 'auto';
    } catch { return 'auto'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('floorPlan.layoutMode', layoutMode); } catch {}
  }, [layoutMode]);

  // Portrait orientation gate (floor-plan only, mobile/touch devices)
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === 'undefined') return false;
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    return isMobile && window.matchMedia('(orientation: portrait)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isMobile) return;
    const mql = window.matchMedia('(orientation: portrait)');
    const handler = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Refresh merges from the server for the current date+shift. Used after
  // local merge/split actions so the originating client updates immediately
  // even when the socket is offline.
  const refreshMerges = async () => {
    try {
      const merges = await getTableMerges(selectedDate, selectedShift);
      setTableMerges(merges);
    } catch (err) {
      console.error('Error fetching table merges:', err);
    }
  };

  const handleToggleHide = async (ids: number[]) => {
    const allHidden = ids.every(id => hiddenTableIds.has(id));
    try {
      if (allHidden) {
        await Promise.all(ids.map(id => deleteTableHidden(selectedDate, selectedShift, id)));
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          ids.forEach(id => next.delete(id));
          return next;
        });
      } else {
        const targets = ids.filter(id => !hiddenTableIds.has(id));
        for (const id of targets) {
          await createTableHidden(selectedDate, selectedShift, id);
        }
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          targets.forEach(id => next.add(id));
          return next;
        });
      }
    } catch (err: any) {
      setAlertModal({ message: err?.message || 'Operazione non riuscita', type: 'error' });
    }
  };

  const handleUnhideAll = async () => {
    if (hiddenTableIds.size === 0) return;
    const ids = [...hiddenTableIds];
    try {
      await Promise.all(ids.map(id => deleteTableHidden(selectedDate, selectedShift, id)));
      setHiddenTableIds(new Set());
      setShowHidden(false);
    } catch (err: any) {
      setAlertModal({ message: err?.message || 'Operazione non riuscita', type: 'error' });
    }
  };

  // Close/reopen a room for the currently selected (date, shift) only.
  // Parallel to handleToggleHide but at the room level. The extended
  // rooms.is_closed flag is handled separately by onToggleRoomClosed.
  const handleToggleRoomShiftClosed = async (room_id: number) => {
    const isClosedForShift = closedRoomIdsForShift.has(room_id);
    try {
      if (isClosedForShift) {
        await deleteRoomClosed(selectedDate, selectedShift, room_id);
        setClosedRoomIdsForShift(prev => {
          const next = new Set(prev);
          next.delete(room_id);
          return next;
        });
      } else {
        await createRoomClosed(selectedDate, selectedShift, room_id);
        setClosedRoomIdsForShift(prev => {
          const next = new Set(prev);
          next.add(room_id);
          return next;
        });
      }
    } catch (err: any) {
      setAlertModal({ message: err?.message || 'Operazione non riuscita', type: 'error' });
    }
  };

  // Fetch merges whenever date/shift changes
  useEffect(() => {
    let cancelled = false;
    setIsLoadingMerges(true);
    getTableMerges(selectedDate, selectedShift)
      .then(merges => {
        if (!cancelled) setTableMerges(merges);
      })
      .catch(err => {
        console.error('Error fetching table merges:', err);
        if (!cancelled) setTableMerges([]);
      })
      .finally(() => { if (!cancelled) setIsLoadingMerges(false); });
    return () => { cancelled = true; };
  }, [selectedDate, selectedShift]);

  // Fetch hidden tables for the current date/shift
  useEffect(() => {
    let cancelled = false;
    getTableHidden(selectedDate, selectedShift)
      .then(rows => {
        if (!cancelled) setHiddenTableIds(new Set(rows.map(r => r.table_id)));
      })
      .catch(err => {
        console.error('Error fetching hidden tables:', err);
        if (!cancelled) setHiddenTableIds(new Set());
      });
    return () => { cancelled = true; };
  }, [selectedDate, selectedShift]);

  // Fetch per-shift closed rooms for the current date/shift
  useEffect(() => {
    let cancelled = false;
    getRoomClosed(selectedDate, selectedShift)
      .then(rows => {
        if (!cancelled) setClosedRoomIdsForShift(new Set(rows.map(r => r.room_id)));
      })
      .catch(err => {
        console.error('Error fetching closed rooms:', err);
        if (!cancelled) setClosedRoomIdsForShift(new Set());
      });
    return () => { cancelled = true; };
  }, [selectedDate, selectedShift]);

  const { socket } = useSocket();

  // Listen for merge socket events filtered by current date+shift
  useEffect(() => {
    if (!socket) return;

    const matches = (m: TableMerge) => m.date === selectedDate && m.shift === selectedShift;

    const handleCreated = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => {
        const existing = prev.findIndex(p => p.primary_id === m.primary_id);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = m;
          return next;
        }
        return [...prev, m];
      });
    };

    const handleDeleted = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => prev.filter(p => p.primary_id !== m.primary_id));
    };

    socket.on('tableMerge:created', handleCreated);
    socket.on('tableMerge:deleted', handleDeleted);
    return () => {
      socket.off('tableMerge:created', handleCreated);
      socket.off('tableMerge:deleted', handleDeleted);
    };
  }, [socket, selectedDate, selectedShift]);

  // Listen for hidden-table socket events filtered by current date+shift
  useEffect(() => {
    if (!socket) return;

    const matches = (h: TableHiddenOverride) => h.date === selectedDate && h.shift === selectedShift;

    const handleHiddenCreated = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.add(h.table_id);
        return next;
      });
    };

    const handleHiddenDeleted = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.delete(h.table_id);
        return next;
      });
    };

    socket.on('tableHidden:created', handleHiddenCreated);
    socket.on('tableHidden:deleted', handleHiddenDeleted);
    return () => {
      socket.off('tableHidden:created', handleHiddenCreated);
      socket.off('tableHidden:deleted', handleHiddenDeleted);
    };
  }, [socket, selectedDate, selectedShift]);

  // Listen for room-closed socket events filtered by current date+shift
  useEffect(() => {
    if (!socket) return;

    const matches = (c: RoomClosedOverride) => c.date === selectedDate && c.shift === selectedShift;

    const handleRoomClosedCreated = (c: RoomClosedOverride) => {
      if (!matches(c)) return;
      setClosedRoomIdsForShift(prev => {
        const next = new Set(prev);
        next.add(c.room_id);
        return next;
      });
    };

    const handleRoomClosedDeleted = (c: RoomClosedOverride) => {
      if (!matches(c)) return;
      setClosedRoomIdsForShift(prev => {
        const next = new Set(prev);
        next.delete(c.room_id);
        return next;
      });
    };

    socket.on('roomClosed:created', handleRoomClosedCreated);
    socket.on('roomClosed:deleted', handleRoomClosedDeleted);
    return () => {
      socket.off('roomClosed:created', handleRoomClosedCreated);
      socket.off('roomClosed:deleted', handleRoomClosedDeleted);
    };
  }, [socket, selectedDate, selectedShift]);

  // Compose display tables: raw tables + per-shift merges
  const displayTables = useMemo(
    () => applyMerges(tables, tableMerges),
    [tables, tableMerges]
  );

  // Use refs for drag state to avoid re-renders during drag
  const dragStateRef = useRef<{
    isDragging: boolean;
    tableId: number | null;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    originalPos: { x: number; y: number } | null;
    // Snapped, clamped candidate drop position and whether it conflicts.
    candidateX: number;
    candidateY: number;
    conflict: boolean;
  }>({
    isDragging: false,
    tableId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    originalPos: null,
    candidateX: 0,
    candidateY: 0,
    conflict: false
  });

  // Id of the table currently showing the red "invalid" (overlapping) state
  // during a drag. Toggled only when the conflict status flips, so dragging
  // stays cheap.
  const [dragConflictId, setDragConflictId] = useState<number | null>(null);
  // Signature of the overlap set the user has dismissed, so the load-time
  // banner reappears whenever the set of colliding tables actually changes.
  const [dismissedOverlapSig, setDismissedOverlapSig] = useState<string | null>(null);

  const draggedElementRef = useRef<HTMLDivElement | null>(null);
  
  // Room Management State
  const [isAddingRoom, setIsAddingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');

  // Tick state for updating timers every second
  const [tick, setTick] = useState(0);

  // Modal state for alerts
  const [alertModal, setAlertModal] = useState<{ message: string; type: 'error' | 'warning' } | null>(null);
  const [deleteRoomConfirm, setDeleteRoomConfirm] = useState<Room | null>(null);
  const [detailsModal, setDetailsModal] = useState<{ table: Table; widthCm: string; lengthCm: string; notes: string } | null>(null);
  const [deleteTablesConfirm, setDeleteTablesConfirm] = useState<number[] | null>(null);
  const [unhideAllConfirm, setUnhideAllConfirm] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const scaleRef = useRef(1);

  // Track canvas size so we can fit the room into the available space
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Filter tables for the current room and hide secondaries of any active merge
  const currentTables = displayTables
    .filter(t => t.room_id === activeRoomId)
    .filter((t, index, self) => self.findIndex(t2 => t2.id === t.id) === index)
    .filter(t => !displayTables.some(other =>
      other.merged_with && other.merged_with.map(id => Number(id)).includes(Number(t.id))
    ))
    // Apply per-shift hide override unless the user toggled "show hidden".
    .filter(t => showHidden || !hiddenTableIds.has(t.id));

  // Lay tables out into tidy flowing rows at render time, shaped to the canvas.
  // Positions are computed fresh from the tables actually shown (after merges /
  // hidden overrides), so every date stays neat regardless of merge state.
  const layoutAspect = canvasSize.width > 0 && canvasSize.height > 0
    ? Math.min(2.6, Math.max(0.6, canvasSize.width / canvasSize.height))
    : 1.6;
  const autoLayout = useMemo(
    () => computeAutoLayout(currentTables, layoutAspect),
    [currentTables, layoutAspect]
  );
  // Bounding box used to size the inner canvas. In auto mode it comes from
  // the tidy layout; in manual mode it's the extent of the saved x/y plus the
  // glyph footprint so dragged tables never escape the scaled wrapper.
  const roomExtent = useMemo(() => {
    if (layoutMode === 'auto') {
      return { width: autoLayout.width, height: autoLayout.height };
    }
    // Manual mode: natural bounding box of the saved positions. Combined with
    // contentOffset=(0,0) and scale≤1 below this matches the pre-PR floor
    // plan: tables render at their real size and only shrink if they overflow
    // the canvas.
    const PADDING = 60;
    if (currentTables.length === 0) return { width: 800, height: 600 };
    let maxRight = 0;
    let maxBottom = 0;
    for (const t of currentTables) {
      const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
      maxRight = Math.max(maxRight, t.x + w);
      maxBottom = Math.max(maxBottom, t.y + h);
    }
    return { width: maxRight + PADDING, height: maxBottom + PADDING };
  }, [layoutMode, autoLayout, currentTables]);

  const scale = useMemo(() => {
    if (canvasSize.width === 0 || canvasSize.height === 0) return 1;
    // Fit into the canvas minus a safe margin so tables never touch the edges
    // or collide with the floating Legenda button in the corner.
    const M = 28;
    const availW = Math.max(1, canvasSize.width - M * 2);
    const availH = Math.max(1, canvasSize.height - M * 2);
    const sx = availW / roomExtent.width;
    const sy = availH / roomExtent.height;
    // Allow zoom-in so a sparse room actually fills the canvas. Manual mode
    // still caps lower than auto so the drag math (which mixes scaleRef with
    // pointer deltas) stays predictable on dense rooms.
    return Math.min(sx, sy, layoutMode === 'manual' ? 1.5 : 2);
  }, [canvasSize, roomExtent, layoutMode]);

  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // Center the scaled room within the canvas so leftover space is even.
  // In manual mode we pin the offset to (0,0): re-centering when the
  // bounding box grows would visually drag every table back toward its
  // original spot, which feels like the drop didn't take.
  const contentOffset = useMemo(() => {
    if (layoutMode === 'manual') return { x: 0, y: 0 };
    return {
      x: Math.max(0, (canvasSize.width - roomExtent.width * scale) / 2),
      y: Math.max(0, (canvasSize.height - roomExtent.height * scale) / 2),
    };
  }, [canvasSize, roomExtent, scale, layoutMode]);

  // Detect pre-existing overlaps among the visible tables of the active room.
  // Only meaningful in manual mode (auto-tidy never overlaps). Older layouts
  // were spaced before chairs were added, so some saved positions now collide —
  // we flag them rather than moving anything.
  const overlapPairs = useMemo(() => {
    if (layoutMode !== 'manual') return [];
    return findOverlappingPairs(currentTables);
  }, [layoutMode, currentTables]);

  // Stable signature of the colliding set so a dismissed banner reappears only
  // when the actual set of overlaps changes.
  const overlapSig = useMemo(
    () => overlapPairs
      .map(([a, b]) => [a.id, b.id].sort((x, y) => x - y).join('-'))
      .sort()
      .join('|'),
    [overlapPairs]
  );
  const showOverlapBanner = overlapPairs.length > 0 && overlapSig !== dismissedOverlapSig;

  // Auto-select first room if active room is deleted
  useEffect(() => {
      if (rooms.length > 0 && !rooms.find(r => r.id === activeRoomId)) {
          setActiveRoomId(rooms[0].id);
      }
  }, [rooms, activeRoomId]);

  // Auto-select NEW room when added
  const prevRoomsLength = useRef(rooms.length);
  useEffect(() => {
      if (rooms.length > prevRoomsLength.current) {
          // A room was added, switch to the last one (assumed new)
          setActiveRoomId(rooms[rooms.length - 1].id);
      }
      prevRoomsLength.current = rooms.length;
  }, [rooms]);

  // Timer Interval
  useEffect(() => {
      const interval = setInterval(() => setTick(t => t + 1), 1000);
      return () => clearInterval(interval);
  }, []);

  // Map of tableId -> banquet occupying it for the currently selected date+shift.
  // A table can only be in one banquet for a given date+shift (server enforces).
  const banquetByTableId = useMemo(() => {
    const map = new Map<number, BanquetMenu>();
    for (const b of banquetMenus) {
      if (b.event_date !== selectedDate) continue;
      if (b.shift !== selectedShift) continue;
      const ids = Array.isArray(b.table_ids) ? b.table_ids : [];
      for (const tid of ids) {
        if (!map.has(tid)) map.set(tid, b);
      }
    }
    return map;
  }, [banquetMenus, selectedDate, selectedShift]);

  // Helper to get Active Reservation details
  // Ticking clock (1/min) — re-derives the time-based table states
  // (In arrivo / In uscita) so the map moves by itself as the service runs.
  const nowTick = useNow(60_000);

  // Rome-clock invariants, computed once per tick instead of once per table:
  // toLocaleTimeString builds an Intl.DateTimeFormat each call, which is far
  // too expensive to repeat ~50× per render.
  const romeClock = useMemo(() => {
      const now = new Date(nowTick);
      const todayStr = getRomeDatePart(now);
      const romeNow = now.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
      const [nowH, nowM] = romeNow.split(':').map(Number);
      const currentTimeValue = nowH * 60 + nowM;

      let currentActiveShift: Shift | null = null;
      if (nowH >= 11 && nowH < 17) currentActiveShift = Shift.LUNCH;
      else if (nowH >= 18 || nowH < 4) currentActiveShift = Shift.DINNER;

      return { todayStr, currentTimeValue, currentActiveShift };
  }, [nowTick]);

  const getActiveReservation = (table: Table): Reservation | undefined => {
      const { todayStr, currentTimeValue, currentActiveShift } = romeClock;

      const candidates = reservations.filter(r => {
          if (r.table_id !== table.id) return false;
          if (getRomeDatePart(r.reservation_time) !== todayStr) return false;
          if (r.arrival_status === ArrivalStatus.DEPARTED) return false;
          if (r.reservation_status === ReservationStatus.CANCELLED) return false;
          if (r.reservation_status === ReservationStatus.DECLINED) return false;

          // A seated party (ARRIVED/DEPARTING) holds its table until DEPARTED —
          // checked BEFORE the shift filter, so a lunch table lingering into
          // the dinner window still reads as occupied, not libera.
          if (isSeated(r)) return true;

          if (currentActiveShift && r.shift !== currentActiveShift) return false;

          const [h, m] = getRomeTimePart(r.reservation_time).split(':').map(Number);
          const resTimeValue = h * 60 + m;

          // Broad check to display name if reservation is roughly now
          return (currentTimeValue >= (resTimeValue - 30) && currentTimeValue <= (resTimeValue + 120));
      });

      // Double-seating: whoever is physically at the table wins over the
      // upcoming booking, regardless of array order.
      return candidates.find(isSeated) ?? candidates[0];
  };

  // Collision-aware reservation cards + banquet hulls/labels for the floor.
  const floorLabels = useMemo(() => {
    const labelTables = currentTables.map(t => {
      const pos = layoutMode === 'manual'
        ? { x: t.x, y: t.y }
        : (autoLayout.positions.get(t.id) || { x: t.x, y: t.y });
      return { id: t.id, shape: t.shape, seats: t.seats, rotation: t.rotation ?? 0, x: pos.x, y: pos.y };
    });
    const banquetDataById = new Map<number, BanquetMenu>();
    const banquetTableIds = new Map<number, number[]>();
    for (const t of currentTables) {
      const b = banquetByTableId.get(t.id);
      if (b) {
        banquetDataById.set(b.id, b);
        const arr = banquetTableIds.get(b.id) || [];
        arr.push(t.id);
        banquetTableIds.set(b.id, arr);
      }
    }
    const banquetGroups = [...banquetTableIds.entries()].map(([id, tableIds]) => ({ id, tableIds }));
    const selectedTableId = selectedTables.length === 1 ? selectedTables[0] : null;
    // Floor plan = status canvas. Reservation details (name/covers/time) are
    // no longer drawn over the canvas — only the status tint on the glyph plus
    // a small time chip. Names are reachable via tooltip / detail drawer.
    const result = buildFloorLabels({
      tables: labelTables,
      reservationTableIds: [],
      banquets: banquetGroups,
      selectedTableId,
    });
    // Assign a stable color class to each banquet present in this room — scoped
    // sequential so two distinct banquets never collide (unlike id % palette).
    const banquetColorByBanquetId = buildBanquetColorClassMap(banquetGroups.map(b => b.id));
    return { ...result, banquetDataById, banquetGroups, banquetColorByBanquetId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTables, autoLayout, layoutMode, banquetByTableId, selectedTables, reservations]);

  const getDynamicTableStatus = (table: Table): TableStatus => {
    const now = Date.now();

    // Check Temporary Lock first
    if (table.temp_lock_expires_at && table.temp_lock_expires_at > now) {
        return TableStatus.RESERVED;
    }

    // Check Reservations
    const reservation = getActiveReservation(table);
    if (reservation) {
        const [h, m] = getRomeTimePart(reservation.reservation_time).split(':').map(Number);
        const resTimeValue = h * 60 + m;
        const nowDate = new Date();
        const [nowH, nowM] = nowDate.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
        const currentTimeValue = nowH * 60 + nowM;

        if (currentTimeValue >= (resTimeValue - 15) && currentTimeValue <= (resTimeValue + 90)) {
            return TableStatus.OCCUPIED;
        }
        if (resTimeValue > currentTimeValue && resTimeValue <= (currentTimeValue + 120)) {
            return TableStatus.RESERVED;
        }
    }

    return TableStatus.FREE;
  };

  const handleMouseDown = (e: React.MouseEvent, tableId: number, element: HTMLDivElement) => {
    e.stopPropagation();

    const table = tables.find(t => t.id === tableId);

    // Handle multi-select (only in edit mode)
    if ((e.ctrlKey || e.metaKey || isSelectionMode) && canEdit) {
        setSelectedTables(prev => prev.includes(tableId) ? prev.filter(id => id !== tableId) : [...prev, tableId]);
        return;
    }

    // If not in edit mode, don't allow selection or dragging
    if (!canEdit) {
        return;
    }

    // If locked or temporarily locked, select but DO NOT drag
    const isTempLocked = table?.temp_lock_expires_at && table.temp_lock_expires_at > Date.now();

    if (table?.is_locked || isTempLocked) {
        if (!selectedTables.includes(tableId)) {
             setSelectedTables([tableId]);
        }
        return;
    }

    if (!selectedTables.includes(tableId)) {
        setSelectedTables([tableId]);
    }

    // In auto mode positions are computed at render time, so press only
    // selects. In manual mode arm a real drag against the saved x/y.
    if (layoutMode !== 'manual') return;

    dragStateRef.current = {
      isDragging: true,
      tableId: tableId,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      originalPos: table ? { x: table.x, y: table.y } : null,
      candidateX: table ? table.x : 0,
      candidateY: table ? table.y : 0,
      conflict: false
    };
    draggedElementRef.current = element;
    setIsDragging(true);
  };

  // Shared drag-move logic for mouse + touch. Snaps the candidate position to
  // the grid, tests its footprint against every other table, shows the invalid
  // state on conflict, and renders the (snapped) move.
  const applyDragMove = (clientX: number, clientY: number) => {
    const dragState = dragStateRef.current;
    if (!dragState.isDragging || !draggedElementRef.current || !dragState.originalPos) return;
    const id = dragState.tableId;
    if (id == null) return;

    const s = scaleRef.current || 1;
    const deltaX = (clientX - dragState.startX) / s;
    const deltaY = (clientY - dragState.startY) / s;

    // Snap the candidate drop to the grid, then clamp to the canvas.
    const candX = Math.max(0, snapToGrid(dragState.originalPos.x + deltaX));
    const candY = Math.max(0, snapToGrid(dragState.originalPos.y + deltaY));

    // Test the dragged table's footprint against the others (at their saved
    // positions). Use the displayed table for shape/seats/rotation.
    const dragTable = currentTables.find(t => t.id === id) || tables.find(t => t.id === id);
    const conflict = dragTable
      ? collidesWithOthers(dragTable, candX, candY, currentTables).length > 0
      : false;

    dragState.candidateX = candX;
    dragState.candidateY = candY;
    if (conflict !== dragState.conflict) {
      dragState.conflict = conflict;
      setDragConflictId(conflict ? id : null);
    }

    // Move visually to the snapped candidate. Transform is in unscaled coords;
    // the scaled wrapper maps it to screen.
    const visDX = candX - dragState.originalPos.x;
    const visDY = candY - dragState.originalPos.y;
    draggedElementRef.current.style.transform = `translate(${visDX}px, ${visDY}px)`;
    draggedElementRef.current.style.zIndex = '100';

    dragState.currentX = clientX;
    dragState.currentY = clientY;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStateRef.current.isDragging) return;
    applyDragMove(e.clientX, e.clientY);
  };

  const handleMouseUp = () => {
    const dragState = dragStateRef.current;

    if (dragState.isDragging && dragState.tableId !== null && canvasRef.current) {
        const table = tables.find(t => t.id === dragState.tableId);
        const el = draggedElementRef.current;

        if (table && dragState.originalPos && el) {
            // Validate table.id is a proper number
            if (typeof table.id !== 'number' || isNaN(table.id)) {
                console.error('Invalid table ID in handleMouseUp:', table.id, table);
                return;
            }

            if (dragState.conflict) {
                // Invalid drop — spring back to the last valid position. Do not
                // persist, and never move the other tables. Drive the transition
                // via inline style: React re-renders on release and rewrites
                // className, so a CSS class would be stripped mid-animation.
                el.style.transition = 'transform 0.22s ease';
                el.style.transform = 'translate(0px, 0px)';
                const settleEl = el;
                window.setTimeout(() => {
                    settleEl.style.transition = '';
                    settleEl.style.transform = '';
                    settleEl.style.zIndex = '';
                }, 240);
            } else {
                // Valid drop — persist the snapped, clamped candidate position.
                const updatedTable = { ...table, x: dragState.candidateX, y: dragState.candidateY };
                // Force synchronous update to prevent snap-back
                flushSync(() => {
                    onUpdateTable(updatedTable);
                });
                el.style.transform = '';
                el.style.zIndex = '';
            }
        }
    }

    // Reset drag state
    dragStateRef.current = {
      isDragging: false,
      tableId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      originalPos: null,
      candidateX: 0,
      candidateY: 0,
      conflict: false
    };
    draggedElementRef.current = null;
    setIsDragging(false);
    setDragConflictId(null);
  };

  // Touch event handlers for mobile
  const handleTouchStart = (e: React.TouchEvent, tableId: number, element: HTMLDivElement) => {
    e.stopPropagation();

    // If not in edit mode, don't allow selection or dragging
    if (!canEdit) {
        return;
    }

    const table = tables.find(t => t.id === tableId);

    if (table?.is_locked || (table?.temp_lock_expires_at && table.temp_lock_expires_at > Date.now())) {
        return;
    }

    if (!selectedTables.includes(tableId)) {
        setSelectedTables([tableId]);
    }

    // In auto mode positions are computed at render time; in manual mode
    // arm a real drag.
    if (layoutMode !== 'manual') return;

    const touch = e.touches[0];
    dragStateRef.current = {
      isDragging: true,
      tableId: tableId,
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      originalPos: table ? { x: table.x, y: table.y } : null,
      candidateX: table ? table.x : 0,
      candidateY: table ? table.y : 0,
      conflict: false
    };
    draggedElementRef.current = element;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!dragStateRef.current.isDragging) return;
    const touch = e.touches[0];
    applyDragMove(touch.clientX, touch.clientY);
  };

  const handleTouchEnd = () => {
    handleMouseUp(); // Reuse mouse up logic
  };

  const handleAddTable = (shape: TableShape) => {
    if (!activeRoomId) return;
    const newTable: Omit<Table, 'id'> = {
      name: `T${currentTables.length + 1}`,
      shape,
      seats: shape === TableShape.RECTANGLE ? 4 : 2,
      x: 50,
      y: 50,
      room_id: activeRoomId,
      status: TableStatus.FREE,
      is_locked: false
    };
    onAddTable(newTable);
  };

  const handleToggleLock = () => {
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table) {
              onUpdateTable({ ...table, is_locked: !table.is_locked });
          }
      });
  };

  const handleTempLock = () => {
      const now = Date.now();
      const duration = 15 * 60 * 1000; // 15 mins
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table) {
              onUpdateTable({ ...table, temp_lock_expires_at: now + duration });
          }
      });
      setSelectedTables([]);
  };

  // Returns true if applying `proposed` (same id, changed seats/rotation) would
  // make its footprint overlap another table in the active room. Only meaningful
  // in manual mode, where positions are the saved x/y. Auto mode reflows and can
  // never overlap, so it's always allowed there.
  const editWouldOverlap = (proposed: Table): boolean => {
      if (layoutMode !== 'manual') return false;
      return collidesWithOthers(proposed, proposed.x, proposed.y, currentTables).length > 0;
  };

  const handleSeatsChange = (newSeats: number) => {
      if (newSeats < 1) return;
      const blocked: string[] = [];
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table && !table.is_locked) {
              const proposed = { ...table, seats: newSeats };
              if (editWouldOverlap(proposed)) {
                  blocked.push(table.name);
                  return;
              }
              onUpdateTable(proposed);
          }
      });
      if (blocked.length > 0) {
          setAlertModal({
              message: `Impossibile ingrandire ${blocked.length > 1 ? 'i tavoli' : 'il tavolo'} ${blocked.join(', ')}: si sovrapporrebbe a un tavolo vicino. Spostalo prima di aggiungere coperti.`,
              type: 'warning'
          });
      }
  };

  const handleNameChange = (newName: string) => {
    if (singleSelectedTable) {
        onUpdateTable({ ...singleSelectedTable, name: newName });
    }
  };

  const handleRotate = (delta: number) => {
      const blocked: string[] = [];
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table && !table.is_locked) {
              const next = (((table.rotation || 0) + delta) % 360 + 360) % 360;
              const proposed = { ...table, rotation: next };
              if (editWouldOverlap(proposed)) {
                  blocked.push(table.name);
                  return;
              }
              onUpdateTable(proposed);
          }
      });
      if (blocked.length > 0) {
          setAlertModal({
              message: `Impossibile ruotare ${blocked.length > 1 ? 'i tavoli' : 'il tavolo'} ${blocked.join(', ')}: si sovrapporrebbe a un tavolo vicino. Spostalo prima di ruotarlo.`,
              type: 'warning'
          });
      }
  };

  // New Room Handler (Inline)
  const handleConfirmAddRoom = () => {
      if (newRoomName.trim()) {
          onAddRoom(newRoomName.trim());
          setNewRoomName('');
          setIsAddingRoom(false);
      }
  };

  const handleDeleteRoomClick = (room_id: number) => {
      if (rooms.length <= 1) {
          setAlertModal({ message: "Devi mantenere almeno una sala attiva.", type: 'warning' });
          return;
      }
      const roomTables = tables.filter(t => t.room_id === room_id);
      if (roomTables.length > 0) {
          setAlertModal({ message: "Non puoi eliminare una sala che contiene dei tavoli. Rimuovi prima i tavoli.", type: 'warning' });
          return;
      }
      const room = rooms.find(r => r.id === room_id);
      if (room) {
          setDeleteRoomConfirm(room);
      }
  };

  const handleDeleteRoomConfirm = () => {
      if (deleteRoomConfirm) {
          onDeleteRoom(deleteRoomConfirm.id);
          setDeleteRoomConfirm(null);
      }
  };

  const renderTableShape = (table: Table) => {
    if (!table.id || typeof table.id !== 'number') {
      console.error('Invalid table ID:', table);
      return null;
    }

    const isSelected = selectedTables.includes(table.id);
    const banquet = banquetByTableId.get(table.id);
    const reservation = getActiveReservation(table);
    const isMerged = table.merged_with && table.merged_with.length > 0;
    const isHidden = hiddenTableIds.has(table.id);
    const now = Date.now();
    const isTempLocked = !!(table.temp_lock_expires_at && table.temp_lock_expires_at > now);

    let timerDisplay: string | null = null;
    if (isTempLocked) {
      const remainingSeconds = Math.ceil((table.temp_lock_expires_at! - now) / 1000);
      const mm = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
      const ss = (remainingSeconds % 60).toString().padStart(2, '0');
      timerDisplay = `${mm}:${ss}`;
    }

    // Map reservation state → display status (shared, time-aware derivation:
    // WAITING near its slot pulses as 'inarrivo', a party seated past its
    // expected duration reads as 'uscita').
    const displayStatus: TableDisplayStatus = deriveTableDisplayStatus(reservation, {
      banquet: !!banquet,
      tempLocked: isTempLocked,
      now: nowTick,
    });

    const dims = getGlyphDimensions(table.shape, table.seats);
    const { width: svgW, height: svgH } = dims;

    // Overlap state: this table is being dragged into a colliding position.
    const isInvalidDrag = dragConflictId === table.id;
    // Footprint box (body + chair overhang + clearance), rotation-aware,
    // expressed relative to the glyph box's top-left for the overlay below.
    const fp = getTableFootprint(table, 0, 0, FLOOR_CLEARANCE);

    const rotationRad = ((table.rotation || 0) * Math.PI) / 180;
    const rotatedHalfH = (Math.abs(svgW * Math.sin(rotationRad)) + Math.abs(svgH * Math.cos(rotationRad))) / 2;
    const captionTopPx = svgH / 2 + rotatedHalfH + 6;

    const accentVar = displayStatus !== 'libera' ? `var(--tg-${displayStatus}-accent)` : undefined;

    const pos = layoutMode === 'manual'
      ? { x: table.x, y: table.y }
      : (autoLayout.positions.get(table.id) || { x: table.x, y: table.y });

    const isDraggable = canEdit && layoutMode === 'manual' && !table.is_locked && !isTempLocked;

    return (
      <div
        key={table.id}
        className={`absolute select-none ${isInvalidDrag ? 'floor-table-invalid ' : ''}${!canEdit ? 'cursor-default' : table.is_locked || isTempLocked ? 'cursor-not-allowed opacity-90' : isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${isHidden ? 'opacity-40 grayscale' : ''}`}
        style={{
          left: pos.x,
          top: pos.y,
          width: svgW,
          height: svgH,
          zIndex: isSelected ? 30 : 1
        }}
        onMouseDown={(e) => handleMouseDown(e, table.id, e.currentTarget as HTMLDivElement)}
        onTouchStart={(e) => handleTouchStart(e, table.id, e.currentTarget as HTMLDivElement)}
      >
        {/* Footprint (clearance) box — only visible while this table is invalid */}
        {isDraggable && (
          <div
            className="floor-table-footprint"
            style={{ left: fp.x, top: fp.y, width: fp.w, height: fp.h }}
          />
        )}
        <div style={{ transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined }}>
          <TableGlyph
            name={table.name}
            seats={table.seats}
            shape={table.shape}
            status={displayStatus}
            party={reservation
              ? (reservation.reservation_status === ReservationStatus.NO_SHOW ? 0 : reservation.guests)
              : banquet ? (banquet.guests ?? 0) : 0}
            isSelected={isSelected && canEdit}
          />
        </div>

        {/* Capacity chip — always shown below the table. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none flex items-center gap-1.5"
          style={{ top: captionTopPx, fontSize: 18 }}
        >
          <Armchair size={22} style={{ color: 'var(--tg-covers)' }} className="flex-shrink-0" />
          <span style={{ color: 'var(--tg-covers)' }}>{table.seats}</span>
        </div>

        {/* Timer Badge */}
        {timerDisplay && (
          <div className="absolute bg-[var(--ds-pending-solid)] text-[#ffffff] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--ds-canvas)] pointer-events-none" style={{ top: -4, right: -4 }}>
            <Timer size={8} /> {timerDisplay}
          </div>
        )}

        {/* Merged Table Badge */}
        {isMerged && !timerDisplay && (
          <div className="absolute bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--ds-canvas)] pointer-events-none" style={{ top: -4, left: -4 }}>
            <Combine size={8} />
          </div>
        )}

        {/* Hidden-for-shift Badge */}
        {isHidden && (
          <div className="absolute bg-[var(--ds-text-muted)] text-[var(--ds-surface)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--ds-canvas)] pointer-events-none" style={{ top: -4, left: -4 }}>
            <EyeOff size={8} />
          </div>
        )}

      </div>
    );
  };

  const singleSelectedTable = selectedTables.length === 1 ? displayTables.find(t => t.id === selectedTables[0]) : null;

  // Applica la bozza coperti. Il campo mostra i coperti COMBINATI (tavolo +
  // agganciati): il numero digitato va riportato al valore grezzo del tavolo
  // principale sottraendo il contributo dei partner, altrimenti si scrive la
  // somma come se fosse il valore del singolo tavolo.
  const commitSeatsDraft = () => {
    if (!seatsDraft || !singleSelectedTable || seatsDraft.id !== singleSelectedTable.id) { setSeatsDraft(null); return; }
    const parsed = parseInt(seatsDraft.value, 10);
    setSeatsDraft(null);
    if (!Number.isFinite(parsed) || parsed < 1) return;
    const raw = tables.find(t => t.id === singleSelectedTable.id);
    if (!raw) return;
    const partnersSeats = singleSelectedTable.seats - raw.seats;
    handleSeatsChange(Math.max(1, Math.min(99, parsed - partnersSeats)));
  };

  // Portrait orientation gate — block floor plan on mobile portrait
  if (isPortrait) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <RotateCw className="h-16 w-16 text-[var(--ds-text-subtle)] mb-6" />
        <h2 className="text-[20px] font-semibold text-[var(--ds-text-primary)] mb-2">Ruota il dispositivo</h2>
        <p className="text-[15px] text-[var(--ds-text-muted)] max-w-[280px]">
          Ruota il dispositivo in orizzontale per vedere sala e tavoli
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full p-2 gap-2 sm:p-4 sm:gap-4"
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Mobile: Date + Shift Picker (controls per-shift merge scope) */}
      <div className="md:hidden flex flex-wrap items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] px-3 py-2.5 shadow-[var(--ds-shadow-card)] sm:px-4 z-20">
        <DateNavigator
          value={selectedDate}
          onChange={setSelectedDate}
          className="flex-1 min-w-[220px]"
        />
        <SegmentedControl<Shift>
          value={selectedShift}
          onChange={setSelectedShift}
          ariaLabel="Turno"
          size="sm"
          options={[
            { value: Shift.LUNCH, label: 'Pranzo', icon: <Sun className="h-4 w-4" /> },
            { value: Shift.DINNER, label: 'Cena', icon: <Sunset className="h-4 w-4" /> },
          ]}
        />
        {hiddenTableIds.size > 0 && (
            <button
                onClick={() => setShowHidden(s => !s)}
                className={`ml-auto h-11 ${HIDDEN_TOGGLE_BASE} ${showHidden ? HIDDEN_TOGGLE_ON : HIDDEN_TOGGLE_OFF}`}
                title={showHidden ? 'Nascondi i tavoli nascosti' : 'Mostra i tavoli nascosti per riattivarli'}
            >
                {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                {hiddenTableIds.size} {hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}
            </button>
        )}
      </div>

      {/* Desktop: Merge scope note + hidden toggle */}
      <div className="hidden md:flex items-center gap-3 px-1 z-20">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-pending-fg)]" />
          Le unioni tavoli sono valide solo per questa data e turno.
        </span>
        {hiddenTableIds.size > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
                <button
                    onClick={() => setShowHidden(s => !s)}
                    className={`h-8 ${HIDDEN_TOGGLE_BASE} ${showHidden ? HIDDEN_TOGGLE_ON : HIDDEN_TOGGLE_OFF}`}
                    title={showHidden ? 'Nascondi i tavoli nascosti' : 'Mostra i tavoli nascosti per riattivarli'}
                >
                    {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                    {hiddenTableIds.size} {hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}
                </button>
                <button
                    onClick={() => setUnhideAllConfirm(true)}
                    className={`h-8 ${HIDDEN_TOGGLE_BASE} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]`}
                    title={`Riattiva tutti i ${hiddenTableIds.size} tavoli nascosti per questo turno`}
                >
                    <Eye size={14} />
                    Riattiva tutti
                </button>
            </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="rounded-[20px] bg-[var(--ds-surface)] p-3 sm:p-4 shadow-[var(--ds-shadow-card)] flex flex-wrap items-center justify-between gap-2 sm:gap-4 z-20">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide w-full sm:flex-1 sm:min-w-0 pb-1">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => {
                  setActiveRoomId(room.id);
                  setSelectedTables([]);
              }}
              className={`${ROOM_TAB_BASE} ${
                  activeRoomId === room.id
                  ? (room.is_closed || closedRoomIdsForShift.has(room.id))
                    ? ROOM_TAB_ACTIVE_CLOSED
                    : ROOM_TAB_ACTIVE
                  : (room.is_closed || closedRoomIdsForShift.has(room.id))
                    ? ROOM_TAB_IDLE_CLOSED
                    : ROOM_TAB_IDLE
              }`}
              title={room.is_closed
                ? `${room.name} (Chiusa)`
                : closedRoomIdsForShift.has(room.id)
                  ? `${room.name} (Chiusa per questo turno)`
                  : room.name}
            >
              {(room.is_closed || closedRoomIdsForShift.has(room.id)) && <DoorClosed size={14} />}
              {room.name}
            </button>
          ))}

          {/* Add Room UI - Only shown in edit mode */}
          {canEdit && (isAddingRoom ? (
              <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-left-2">
                  <input
                      autoFocus
                      value={newRoomName}
                      onChange={e => setNewRoomName(e.target.value)}
                      placeholder="Nome sala..."
                      className={`${dsInput} w-36`}
                      onKeyDown={e => e.key === 'Enter' && handleConfirmAddRoom()}
                  />
                  <button
                    onClick={handleConfirmAddRoom}
                    className={`${dsIconButton} bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-none hover:bg-[var(--ds-action-bg-hover)] hover:text-[var(--ds-action-fg)]`}
                    title="Conferma"
                  >
                      <Check size={16}/>
                  </button>
                  <button
                    onClick={() => { setIsAddingRoom(false); setNewRoomName(''); }}
                    className={`${dsIconButton} shadow-none`}
                    title="Annulla"
                  >
                      <X size={16}/>
                  </button>
              </div>
          ) : (
            <button
                onClick={() => setIsAddingRoom(true)}
                className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`}
                title="Aggiungi Nuova Sala"
            >
                <Plus size={16} />
            </button>
          ))}
        </div>

        {/* Tools section - Only shown in edit mode */}
        {canEdit && (
        <div className="flex items-center gap-2 sm:border-l sm:pl-4 border-[var(--ds-border)] overflow-x-auto shrink-0 w-full sm:w-auto">
          <span className="text-[13px] font-semibold text-[var(--ds-text-muted)] hidden xl:block">Strumenti</span>

          <button
            onClick={() => setIsSelectionMode(!isSelectionMode)}
            className={`${dsIconButton} shadow-none ${isSelectionMode ? TOOL_BUTTON_ON : 'bg-[var(--ds-surface-row)]'}`}
            title="Modalità Selezione Multipla"
          >
              <CheckSquare className="h-4 w-4" />
          </button>

          <button
            onClick={() => setLayoutMode(m => m === 'auto' ? 'manual' : 'auto')}
            className={`${dsIconButton} shadow-none ${layoutMode === 'manual' ? TOOL_BUTTON_ON : 'bg-[var(--ds-surface-row)]'}`}
            title={layoutMode === 'manual' ? 'Layout manuale: trascina per posizionare. Clicca per tornare ad auto-tidy.' : 'Layout auto-tidy: posizioni ordinate per numero. Clicca per attivare drag manuale.'}
          >
              {layoutMode === 'manual' ? <Move className="h-4 w-4" /> : <Layout className="h-4 w-4" />}
          </button>

          {selectedTables.length > 0 && (
              <button
                onClick={() => setSelectedTables([])}
                className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                title="Deseleziona Tutto"
              >
                  <X className="h-4 w-4" />
              </button>
          )}

          <div className="h-6 w-px bg-[var(--ds-border)] mx-1"></div>

          <button onClick={() => handleAddTable(TableShape.RECTANGLE)} className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`} title="Rettangolo">
            <div className="w-6 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.SQUARE)} className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`} title="Quadrato">
            <div className="w-4 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.CIRCLE)} className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`} title="Tondo">
             <div className="w-4 h-4 border-2 border-current rounded-full" />
          </button>

          <div className="h-6 w-px bg-[var(--ds-border)] mx-1"></div>

          {/* Room Closure Menu: per-shift override + extended (global) closure */}
          {(() => {
            const activeRoom = rooms.find(r => r.id === activeRoomId);
            if (!activeRoom) return null;
            const isExtendedClosed = activeRoom.is_closed === true;
            const isShiftClosed = closedRoomIdsForShift.has(activeRoom.id);
            const isAnyClosed = isExtendedClosed || isShiftClosed;
            const shiftLabel = selectedShift === Shift.LUNCH ? 'pranzo' : 'cena';
            return (
              <>
                <button
                  ref={roomClosureButtonRef}
                  onClick={() => {
                    if (roomClosureMenuOpen) {
                      setRoomClosureMenuOpen(false);
                    } else {
                      const rect = roomClosureButtonRef.current?.getBoundingClientRect() ?? null;
                      setRoomClosureAnchor(rect);
                      setRoomClosureMenuOpen(true);
                    }
                  }}
                  className={`inline-flex h-11 flex-shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    isAnyClosed
                      ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                      : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                  }`}
                  title={`Gestisci chiusura: ${activeRoom.name}`}
                >
                  {isAnyClosed ? <DoorOpen className="h-4 w-4" /> : <DoorClosed className="h-4 w-4" />}
                  <span className="hidden lg:inline">Chiusura</span>
                  <ChevronDown className="h-3 w-3" />
                </button>
                {roomClosureMenuOpen && roomClosureAnchor && createPortal(
                  <>
                    <div
                      className="fixed inset-0 z-[60]"
                      onClick={() => setRoomClosureMenuOpen(false)}
                    />
                    <div
                      className="fixed z-[61] w-72 overflow-hidden rounded-[16px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)]"
                      style={{
                        top: roomClosureAnchor.bottom + 4,
                        left: Math.max(8, Math.min(roomClosureAnchor.right - 288, window.innerWidth - 296)),
                      }}
                    >
                      <button
                        onClick={() => {
                          setRoomClosureMenuOpen(false);
                          handleToggleRoomShiftClosed(activeRoom.id);
                        }}
                        className="w-full text-left px-4 py-3 text-[15px] hover:bg-[var(--ds-surface-row)] flex items-start gap-2.5 border-b border-[var(--ds-border)]"
                      >
                        {isShiftClosed
                          ? <DoorOpen className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--ds-seated-fg)]" />
                          : <DoorClosed className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--ds-pending-fg)]" />}
                        <div>
                          <div className="font-medium text-[var(--ds-text-primary)]">
                            {isShiftClosed ? 'Riapri per questo turno' : 'Chiudi solo per questo turno'}
                          </div>
                          <div className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">
                            {selectedDate} · {shiftLabel}
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={() => {
                          setRoomClosureMenuOpen(false);
                          onToggleRoomClosed(activeRoom.id, !isExtendedClosed);
                        }}
                        className="w-full text-left px-4 py-3 text-[15px] hover:bg-[var(--ds-surface-row)] flex items-start gap-2.5"
                      >
                        {isExtendedClosed
                          ? <DoorOpen className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--ds-seated-fg)]" />
                          : <DoorClosed className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--ds-pending-fg)]" />}
                        <div>
                          <div className="font-medium text-[var(--ds-text-primary)]">
                            {isExtendedClosed ? 'Riapri (chiusura estesa)' : 'Chiusura estesa'}
                          </div>
                          <div className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">
                            Chiusa finché non riapri
                          </div>
                        </div>
                      </button>
                    </div>
                  </>,
                  document.body
                )}
              </>
            );
          })()}

          {/* Delete Room Button (Safe location) */}
          <button
            onClick={() => handleDeleteRoomClick(activeRoomId)}
            className="inline-flex h-11 flex-shrink-0 items-center gap-1 rounded-full px-3 text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            title={`Elimina Sala Corrente: ${rooms.find(r => r.id === activeRoomId)?.name}`}
          >
             <Layout className="h-4 w-4"/>
             <Trash2 className="h-4 w-4" />
          </button>
        </div>
        )}

        {/* Edit toolbar - Only shown when tables selected AND in edit mode */}
        {canEdit && selectedTables.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 sm:border-l sm:pl-4 border-[var(--ds-border)] animate-in slide-in-from-right duration-200 shrink-0 w-full sm:w-auto">
            <span className="text-[13px] font-semibold text-[var(--ds-text-muted)] hidden xl:block">Modifica</span>

            {/* Lock/Unlock */}
            <button
                onClick={handleToggleLock}
                className={`${EDIT_ACTION_BASE} ${
                    singleSelectedTable?.is_locked
                    ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                    : EDIT_ACTION_QUIET
                }`}
                title={singleSelectedTable?.is_locked ? "Sblocca Tavolo" : "Blocca Tavolo"}
            >
                {singleSelectedTable?.is_locked ? <Unlock size={16} /> : <Lock size={16} />}
            </button>

            {/* Temp Lock (Timer) */}
            <button
                onClick={handleTempLock}
                className={`${EDIT_ACTION_BASE} bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-pending-tint)] hover:text-[var(--ds-pending-text)]`}
                title="Blocca per 15 minuti"
            >
                <Clock size={16} /> <span className="hidden sm:inline">15m</span>
            </button>

            {/* Table Name Edit */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className={EDIT_FIELD_WRAP}>
                    <CaseSensitive size={14} className="text-[var(--ds-text-muted)]" />
                    <input
                        type="text"
                        className="w-20 bg-transparent text-[15px] font-semibold text-[var(--ds-text-primary)] outline-none"
                        value={singleSelectedTable.name}
                        onChange={(e) => handleNameChange(e.target.value)}
                    />
                </div>
            )}

            {/* Seats Edit */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className={EDIT_FIELD_WRAP}>
                    <Users size={14} className="text-[var(--ds-text-muted)]" />
                    <input
                        type="number"
                        min="1"
                        max="99"
                        className="w-12 bg-transparent text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)] outline-none"
                        value={seatsDraft?.id === singleSelectedTable.id ? seatsDraft.value : String(singleSelectedTable.seats)}
                        onChange={(e) => setSeatsDraft({ id: singleSelectedTable.id, value: e.target.value })}
                        onBlur={commitSeatsDraft}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                </div>
            )}

            {/* Table Details (dimensions + notes) */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <button
                    onClick={() => setDetailsModal({
                        table: singleSelectedTable,
                        widthCm: singleSelectedTable.width_cm != null ? String(singleSelectedTable.width_cm) : '',
                        lengthCm: singleSelectedTable.length_cm != null ? String(singleSelectedTable.length_cm) : '',
                        notes: singleSelectedTable.notes || ''
                    })}
                    className={`${EDIT_ACTION_BASE} ${
                        (singleSelectedTable.notes || singleSelectedTable.width_cm || singleSelectedTable.length_cm)
                            ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
                            : EDIT_ACTION_QUIET
                    }`}
                    title="Dettagli tavolo (dimensioni, note)"
                >
                    <Info size={16} />
                    <span className="hidden sm:inline">Dettagli</span>
                </button>
            )}

            {/* Rotate Table */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                <button
                    onClick={(e) => handleRotate(e.shiftKey ? -15 : 15)}
                    onContextMenu={(e) => { e.preventDefault(); handleRotate(-15); }}
                    className={`${EDIT_ACTION_BASE} ${EDIT_ACTION_QUIET}`}
                    title={`Ruota +15° (Shift/click destro per -15°)${singleSelectedTable ? ` — attuale: ${singleSelectedTable.rotation || 0}°` : ''}`}
                >
                    <RotateCw size={16} />
                    {singleSelectedTable && (singleSelectedTable.rotation || 0) !== 0 && (
                        <span className="tabular-nums">{singleSelectedTable.rotation}°</span>
                    )}
                </button>
            )}

            {selectedTables.length > 1 && !selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                <button
                    onClick={async () => {
                        await onMergeTables(selectedTables, selectedDate, selectedShift);
                        setSelectedTables([]);
                        refreshMerges();
                    }}
                    className={`${EDIT_ACTION_BASE} bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]`}
                >
                <Combine size={16} /> Unisci
                </button>
            )}

            {selectedTables.length === 1 && singleSelectedTable?.merged_with && singleSelectedTable.merged_with.length > 0 && !singleSelectedTable?.is_locked && (
                <button
                    onClick={async () => {
                        await onSplitTable(selectedTables[0], selectedDate, selectedShift);
                        setSelectedTables([]);
                        refreshMerges();
                    }}
                    className={`${EDIT_ACTION_BASE} bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]`}
                    title={`Dividi tavoli: ${singleSelectedTable.name}`}
                >
                <Scissors size={16} /> Dividi
                </button>
            )}

            {/* Hide / Unhide for the current shift */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (() => {
                const allHidden = selectedTables.every(id => hiddenTableIds.has(id));
                return (
                    <button
                        onClick={async () => {
                            await handleToggleHide([...selectedTables]);
                            setSelectedTables([]);
                        }}
                        className={`${EDIT_ACTION_BASE} ${
                            allHidden
                                ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                                : EDIT_ACTION_QUIET
                        }`}
                        title={allHidden ? 'Mostra di nuovo nel turno' : 'Nascondi per questo turno'}
                    >
                        {allHidden
                            ? <><Eye size={16} /> Mostra</>
                            : <><EyeOff size={16} /> Nascondi</>}
                    </button>
                );
            })()}

            {/* Delete only if not locked */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                 <button
                 onClick={() => setDeleteTablesConfirm([...selectedTables])}
                 className={`${EDIT_ACTION_BASE} bg-[var(--ds-critical-solid)] text-[#ffffff] hover:opacity-90`}
                >
                    <Trash2 size={16} /> Elimina
                </button>
            )}
            </div>
        )}
      </div>

      {/* Overlap warning banner — flags pre-existing collisions in this room.
          Nothing is moved automatically; the user resolves them by dragging. */}
      {showOverlapBanner && (
        <Callout
          tone="critical"
          icon={AlertTriangle}
          className="z-20 animate-in fade-in slide-in-from-top-1"
          action={
            <button
              type="button"
              onClick={() => setDismissedOverlapSig(overlapSig)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--ds-critical-solid)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              aria-label="Ignora avviso"
              title="Ignora avviso"
            >
              <X className="h-4 w-4" />
            </button>
          }
        >
          <span className="font-semibold">
            {overlapPairs.length === 1 ? 'Un tavolo si sovrappone' : `${overlapPairs.length} sovrapposizioni di tavoli`} in questa sala.
          </span>{' '}
          Trascina per separarli: {overlapPairs.map(([a, b]) => `${a.name} ↔ ${b.name}`).join(', ')}
        </Callout>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={`flex-1 bg-[var(--ds-canvas)] rounded-[20px] border border-dashed border-[var(--ds-border-strong)] relative overflow-hidden ${isSelectionMode ? 'cursor-crosshair' : 'cursor-default'}`}
        onClick={() => !isSelectionMode && setSelectedTables([])}
        style={{
            backgroundImage: 'radial-gradient(var(--floor-dot) 1px, transparent 1px)',
            backgroundSize: '20px 20px'
        }}
      >
          <div
            className="absolute top-0 left-0"
            style={{
                width: `${roomExtent.width}px`,
                height: `${roomExtent.height}px`,
                transform: `translate(${contentOffset.x}px, ${contentOffset.y}px) scale(${scale})`,
                transformOrigin: 'top left'
            }}
          >
            {/* Banquet hulls (behind tables) — tinted per banquet so two events
                in the same room are visually distinct. */}
            {floorLabels.hulls.map((h, i) => (
              <div key={`hull-${h.banquetId}-${i}`}
                className={`${floorLabels.banquetColorByBanquetId.get(h.banquetId) || 'banquet-color-0'} absolute rounded-2xl border border-[var(--color-banquet-border)] bg-[var(--color-banquet-bg)] pointer-events-none`}
                style={{ left: h.box.x, top: h.box.y, width: h.box.w, height: h.box.h, zIndex: 0 }} />
            ))}
            {currentTables.map(renderTableShape)}
            {/* Banquet event labels (one per banquet) */}
            {floorLabels.banquetLabels.map((bl, i) => {
              const data = floorLabels.banquetDataById.get(bl.banquetId);
              if (!data) return null;
              const colorClass = floorLabels.banquetColorByBanquetId.get(bl.banquetId) || 'banquet-color-0';
              return (
                <div key={`blabel-${bl.banquetId}-${i}`} className="absolute pointer-events-none" style={{ left: bl.x, top: bl.y, zIndex: 15 }}>
                  <BanquetLabel width={bl.w} name={data.name} guests={data.guests} colorClass={colorClass} />
                </div>
              );
            })}
          </div>

          {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-[var(--ds-canvas)]/70 backdrop-blur-[1px] flex items-center justify-center">
                  <div className="flex items-center gap-2 px-4 py-2 bg-[var(--ds-surface)] rounded-[16px] shadow-[var(--ds-shadow-card)]">
                      <Loader label="Caricamento tavoli…" size={40} />
                  </div>
              </div>
          )}

          {currentTables.length === 0 && !isLoadingMerges && (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--ds-text-muted)] pointer-events-none">
                  <p className="text-[15px]">Trascina o aggiungi tavoli in questa sala</p>
              </div>
          )}

          {isSelectionMode && (
              <div className="absolute top-4 left-4 bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] px-3 py-1.5 rounded-full text-[13px] font-medium pointer-events-none flex items-center gap-2">
                  <CheckSquare size={12} /> Modalità selezione attiva
              </div>
          )}

          {(() => {
            const activeRoom = rooms.find(r => r.id === activeRoomId);
            if (!activeRoom) return null;
            const extended = activeRoom.is_closed === true;
            const shiftOnly = closedRoomIdsForShift.has(activeRoom.id);
            if (!extended && !shiftOnly) return null;
            const label = extended ? 'Sala Chiusa' : 'Sala Chiusa per il turno';
            return (
              <div className="absolute top-4 right-4 bg-[var(--ds-pending-solid)] text-[#ffffff] px-3 py-1.5 rounded-full text-[13px] font-semibold shadow-[var(--ds-shadow-raised)] pointer-events-none flex items-center gap-1.5">
                <DoorClosed size={12} /> {label}
              </div>
            );
          })()}

          {/* Legend - collapsible */}
          <div className="absolute bottom-4 right-4 z-10 select-none">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                className="flex h-11 items-center gap-2 px-4 bg-[var(--ds-surface)] rounded-full shadow-[var(--ds-shadow-card)] text-[13px] font-semibold text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                aria-expanded={isLegendOpen}
            >
                <Info size={14} />
                Legenda
            </button>
            {isLegendOpen && (
                <div
                    className="absolute bottom-full right-0 mb-2 w-56 bg-[var(--ds-surface)] p-4 rounded-[16px] shadow-[var(--ds-shadow-raised)] text-[13px] space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-1">Legenda stato</div>
                    {(['libera', 'attesa', 'inarrivo', 'arrivato', 'uscita', 'noshow'] as TableDisplayStatus[]).map(s => (
                        <div key={s} className="flex items-center gap-2 text-[var(--ds-text-secondary)]">
                            <div
                                className={`w-3 h-3 rounded-sm border ${s === 'inarrivo' ? 'motion-safe:animate-pulse' : ''}`}
                                style={{ background: `var(--tg-${s}-bg)`, borderColor: `var(--tg-${s}-stroke)` }}
                            ></div>
                            {TABLE_STATUS_LABEL[s]}
                        </div>
                    ))}
                    <div className="flex items-center gap-2 text-[var(--ds-text-muted)] border-t border-[var(--ds-border)] pt-2 mt-1">
                        <Lock size={12} /> Tavolo bloccato
                    </div>
                    <div className="flex items-center gap-2 text-[var(--ds-text-muted)]">
                        <Timer size={12} /> Blocco temporaneo
                    </div>
                </div>
            )}
          </div>
      </div>

      {/* Alert Modal */}
      {alertModal && (
        <ModalShell
          open={!!alertModal}
          onClose={() => setAlertModal(null)}
          title="Attenzione"
          size="sm"
          bodyClassName="p-5 sm:p-6"
          closeOnEscape
          footer={
            <button onClick={() => setAlertModal(null)} className={`${dsButton.primary} w-full`}>
              OK
            </button>
          }
        >
          <div className="flex items-start gap-3">
            <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
              alertModal.type === 'error' ? 'bg-[var(--ds-critical-tint)]' : 'bg-[var(--ds-pending-tint)]'
            }`}>
              <AlertTriangle className={`h-5 w-5 ${
                alertModal.type === 'error' ? 'text-[var(--ds-critical-fg)]' : 'text-[var(--ds-pending-fg)]'
              }`} />
            </div>
            <p className="text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">{alertModal.message}</p>
          </div>
        </ModalShell>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteRoomConfirm}
        title="Elimina Sala"
        message="Stai per eliminare la sala:"
        itemName={deleteRoomConfirm?.name}
        onCancel={() => setDeleteRoomConfirm(null)}
        onConfirm={handleDeleteRoomConfirm}
      />

      <ConfirmDeleteModal
        isOpen={!!deleteTablesConfirm && deleteTablesConfirm.length > 0}
        title={deleteTablesConfirm && deleteTablesConfirm.length > 1 ? 'Elimina Tavoli' : 'Elimina Tavolo'}
        message={
          deleteTablesConfirm && deleteTablesConfirm.length > 1
            ? `Stai per eliminare ${deleteTablesConfirm.length} tavoli:`
            : 'Stai per eliminare il tavolo:'
        }
        itemName={
          deleteTablesConfirm
            ? deleteTablesConfirm
                .map(id => tables.find(t => t.id === id)?.name)
                .filter(Boolean)
                .join(', ')
            : undefined
        }
        onCancel={() => setDeleteTablesConfirm(null)}
        onConfirm={() => {
          if (deleteTablesConfirm) {
            deleteTablesConfirm.forEach(id => onDeleteTable(id));
            setSelectedTables([]);
          }
          setDeleteTablesConfirm(null);
        }}
      />

      <ConfirmDeleteModal
        isOpen={unhideAllConfirm}
        title="Riattiva tutti i tavoli"
        message={`Stai per riattivare ${hiddenTableIds.size} ${hiddenTableIds.size === 1 ? 'tavolo nascosto' : 'tavoli nascosti'} per questo turno.`}
        confirmLabel="Riattiva tutti"
        icon={<Eye className="h-5 w-5 text-[var(--ds-seated-fg)]" />}
        iconWrapperClassName="mx-auto w-12 h-12 bg-[var(--ds-seated-tint)] rounded-full flex items-center justify-center mb-4"
        confirmClassName="rounded-full px-5 h-11 inline-flex items-center bg-[var(--ds-seated-solid)] text-[#ffffff] text-[15px] font-semibold hover:opacity-90 transition-opacity"
        showIrreversibleWarning={false}
        onCancel={() => setUnhideAllConfirm(false)}
        onConfirm={async () => {
          setUnhideAllConfirm(false);
          await handleUnhideAll();
        }}
      />

      {/* Table Details Modal (dimensions + notes) */}
      {detailsModal && (
        <ModalShell
          open={!!detailsModal}
          onClose={() => setDetailsModal(null)}
          title={`Dettagli tavolo ${detailsModal.table.name}`}
          size="sm"
          bodyClassName="p-5 sm:p-6"
          footer={
            <>
              <button onClick={() => setDetailsModal(null)} className={dsButton.secondary}>
                Annulla
              </button>
              <button
                onClick={() => {
                  const widthRaw = detailsModal.widthCm.trim();
                  const lengthRaw = detailsModal.lengthCm.trim();
                  const widthNum = widthRaw === '' ? null : Number(widthRaw);
                  const lengthNum = lengthRaw === '' ? null : Number(lengthRaw);
                  onUpdateTable({
                    ...detailsModal.table,
                    width_cm: widthNum != null && Number.isFinite(widthNum) ? widthNum : null,
                    length_cm: lengthNum != null && Number.isFinite(lengthNum) ? lengthNum : null,
                    notes: detailsModal.notes.trim() === '' ? null : detailsModal.notes.trim(),
                  });
                  setDetailsModal(null);
                }}
                className={dsButton.primary}
              >
                Salva
              </button>
            </>
          }
        >
          <FormCard>
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Ruler className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" /> Dimensioni (cm)
                </span>
              }
            >
              <div className="flex items-end gap-2">
                <Field label="Larghezza" className="flex-1">
                  <input
                    type="number"
                    min="0"
                    placeholder="es. 80"
                    className={dsInput}
                    value={detailsModal.widthCm}
                    onChange={e => setDetailsModal({ ...detailsModal, widthCm: e.target.value })}
                  />
                </Field>
                <span className="pb-3 text-[var(--ds-text-muted)]">×</span>
                <Field label="Lunghezza" className="flex-1">
                  <input
                    type="number"
                    min="0"
                    placeholder="es. 120"
                    className={dsInput}
                    value={detailsModal.lengthCm}
                    onChange={e => setDetailsModal({ ...detailsModal, lengthCm: e.target.value })}
                  />
                </Field>
              </div>
            </Field>
            <Field
              className="mt-4"
              label={
                <span className="inline-flex items-center gap-1.5">
                  <StickyNote className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" /> Note
                </span>
              }
            >
              <textarea
                rows={3}
                className={`${dsTextarea} resize-none`}
                placeholder="es. Tavolo accanto alla finestra, ottimo per cene romantiche"
                value={detailsModal.notes}
                onChange={e => setDetailsModal({ ...detailsModal, notes: e.target.value })}
              />
            </Field>
          </FormCard>
        </ModalShell>
      )}
    </div>
  );
};