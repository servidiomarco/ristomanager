import React, { useState, useRef, useEffect, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { Table, TableShape, Room, TableStatus, Reservation, ReservationSource, Shift, TableMerge, TableHiddenOverride, ArrivalStatus, ReservationStatus, BanquetMenu } from '../types';
import { Plus, Move, Armchair, Trash2, Combine, Scissors, Save, MousePointer2, CheckSquare, Lock, Unlock, Users, X, Clock, Timer, User, Check, Layout, CaseSensitive, AlertTriangle, Sun, Sunset, Loader2, Info, RotateCw, Ruler, StickyNote, Eye, EyeOff, DoorClosed, DoorOpen, BookOpen, Mic } from 'lucide-react';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';
import { computeAutoLayout } from '../utils/tableLayout';
import { buildFloorLabels } from '../utils/labelPlacement';
import { banquetColorClass } from '../utils/banquetColors';
import { ReservationCard, BanquetLabel } from './ReservationCard';
import { snapToGrid, collidesWithOthers, findOverlappingPairs, getTableFootprint, FLOOR_CLEARANCE } from '../utils/tableOverlap';
import { toTitleCase, getInitials } from '../utils/text';
import { getTableMerges, getTableHidden, createTableHidden, deleteTableHidden } from '../services/apiService';
import { applyMerges } from '../utils/tableMerge';
import { useSocket } from '../hooks/useSocket';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { DateNavigator } from './DateNavigator';

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
  const getActiveReservation = (table: Table): Reservation | undefined => {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      const currentTimeValue = currentHour * 60 + currentMin;

      let currentActiveShift: Shift | null = null;
      if (currentHour >= 11 && currentHour < 17) currentActiveShift = Shift.LUNCH;
      else if (currentHour >= 18 || currentHour < 4) currentActiveShift = Shift.DINNER;

      return reservations.find(r => {
          if (r.table_id !== table.id) return false;
          if (r.reservation_time.split('T')[0] !== todayStr) return false;
          if (currentActiveShift && r.shift !== currentActiveShift) return false;
          if (r.arrival_status === ArrivalStatus.DEPARTED) return false;
          if (r.reservation_status === ReservationStatus.CANCELLED) return false;

          const [h, m] = r.reservation_time.split('T')[1].substring(0, 5).split(':').map(Number);
          const resTimeValue = h * 60 + m;
          
          // Broad check to display name if reservation is roughly now
          return (currentTimeValue >= (resTimeValue - 30) && currentTimeValue <= (resTimeValue + 120));
      });
  };

  // Collision-aware reservation cards + banquet hulls/labels for the floor.
  const floorLabels = useMemo(() => {
    const labelTables = currentTables.map(t => {
      const pos = layoutMode === 'manual'
        ? { x: t.x, y: t.y }
        : (autoLayout.positions.get(t.id) || { x: t.x, y: t.y });
      return { id: t.id, shape: t.shape, seats: t.seats, rotation: t.rotation ?? 0, x: pos.x, y: pos.y };
    });
    const reservationByTableId = new Map<number, Reservation>();
    const banquetDataById = new Map<number, BanquetMenu>();
    const banquetTableIds = new Map<number, number[]>();
    for (const t of currentTables) {
      const b = banquetByTableId.get(t.id);
      if (b) {
        banquetDataById.set(b.id, b);
        const arr = banquetTableIds.get(b.id) || [];
        arr.push(t.id);
        banquetTableIds.set(b.id, arr);
      } else {
        const r = getActiveReservation(t);
        if (r && r.reservation_status !== ReservationStatus.NO_SHOW) {
          reservationByTableId.set(t.id, r);
        }
      }
    }
    const banquetGroups = [...banquetTableIds.entries()].map(([id, tableIds]) => ({ id, tableIds }));
    const selectedTableId = selectedTables.length === 1 ? selectedTables[0] : null;
    // Reservation info is now drawn as a card wrapping each table (renderTableShape);
    // buildFloorLabels only handles banquet hulls + their labels here.
    const result = buildFloorLabels({
      tables: labelTables,
      reservationTableIds: [],
      banquets: banquetGroups,
      selectedTableId,
    });
    return { ...result, banquetDataById, banquetGroups };
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
        const [h, m] = reservation.reservation_time.split('T')[1].substring(0, 5).split(':').map(Number);
        const resTimeValue = h * 60 + m;
        const nowDate = new Date();
        const currentTimeValue = nowDate.getHours() * 60 + nowDate.getMinutes();

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

    // Map reservation state → display status
    let displayStatus: TableDisplayStatus = 'libera';
    let captionTime = '';
    let captionIcon: 'clock' | null = null;

    if (banquet) {
      displayStatus = 'attesa';
    } else if (isTempLocked) {
      displayStatus = 'attesa';
    } else if (reservation && reservation.reservation_status !== ReservationStatus.NO_SHOW) {
      if (reservation.arrival_status === ArrivalStatus.ARRIVED) {
        // Arrived tables show capacity only — no clock/timer.
        displayStatus = 'arrivato';
      } else {
        displayStatus = 'attesa';
        captionIcon = 'clock';
        const timePart = reservation.reservation_time.split('T')[1];
        if (timePart) captionTime = timePart.substring(0, 5);
      }
    }

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
    const pillTopPx = captionTopPx + 32;

    const accentVar = displayStatus !== 'libera' ? `var(--tg-${displayStatus}-accent)` : undefined;

    const pos = layoutMode === 'manual'
      ? { x: table.x, y: table.y }
      : (autoLayout.positions.get(table.id) || { x: table.x, y: table.y });

    const isDraggable = canEdit && layoutMode === 'manual' && !table.is_locked && !isTempLocked;
    const isReservedCard = !!(reservation && reservation.reservation_status !== ReservationStatus.NO_SHOW);

    return (
      <div
        key={table.id}
        className={`absolute select-none ${isInvalidDrag ? 'floor-table-invalid ' : ''}${!canEdit ? 'cursor-default' : table.is_locked || isTempLocked ? 'cursor-not-allowed opacity-90' : isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${isHidden ? 'opacity-40 grayscale' : ''}`}
        style={{
          left: pos.x,
          top: pos.y,
          width: svgW,
          height: svgH,
          zIndex: isSelected ? 30 : (isReservedCard ? 5 : 1)
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
        {isReservedCard && reservation ? (
          /* Reserved tables: the glyph is wrapped in a card (glyph + capacity +
             name + covers·time), centred on the table. It overflows the
             interactive box but events still bubble so dragging keeps working. */
          <div className="absolute left-1/2 top-0 -translate-x-1/2">
            <ReservationCard
              width={Math.max(svgW + 24, 170)}
              selected={isSelected && canEdit}
              status={reservation.arrival_status === ArrivalStatus.ARRIVED ? 'arrivato' : 'attesa'}
              tableLabel={table.name}
              shape={table.shape}
              seats={table.seats}
              rotation={table.rotation}
              name={reservation.customer_name}
              capacity={table.seats}
              covers={reservation.guests}
              childrenCount={reservation.children}
              time={reservation.reservation_time.split('T')[1]?.slice(0, 5) || null}
            />
          </div>
        ) : (
          <>
            <div style={{ transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined }}>
              <TableGlyph
                name={table.name}
                seats={table.seats}
                shape={table.shape}
                status={displayStatus}
                party={reservation ? reservation.guests : banquet ? (banquet.guests ?? 0) : 0}
                isSelected={isSelected && canEdit}
              />
            </div>

            {/* Capacity chip (seat + N) under free / banquet tables. */}
            <div
              className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none flex items-center gap-1.5"
              style={{ top: captionTopPx, fontSize: 18 }}
            >
              <Armchair size={22} style={{ color: 'var(--tg-covers)' }} className="flex-shrink-0" />
              <span style={{ color: 'var(--tg-covers)' }}>{table.seats}</span>
            </div>
          </>
        )}

        {/* Timer Badge */}
        {timerDisplay && (
          <div className="absolute bg-amber-500 text-[#ffffff] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--color-surface)] pointer-events-none" style={{ top: -4, right: -4 }}>
            <Timer size={8} /> {timerDisplay}
          </div>
        )}

        {/* Merged Table Badge */}
        {isMerged && !timerDisplay && (
          <div className="absolute bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--color-surface)] pointer-events-none" style={{ top: -4, left: -4 }}>
            <Combine size={8} />
          </div>
        )}

        {/* Hidden-for-shift Badge */}
        {isHidden && (
          <div className="absolute bg-[var(--color-fg-muted)] text-[var(--color-fg-on-brand)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 border border-[var(--color-surface)] pointer-events-none" style={{ top: -4, left: -4 }}>
            <EyeOff size={8} />
          </div>
        )}

      </div>
    );
  };

  const singleSelectedTable = selectedTables.length === 1 ? displayTables.find(t => t.id === selectedTables[0]) : null;

  // Portrait orientation gate — block floor plan on mobile portrait
  if (isPortrait) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-64px)] p-8 text-center bg-[var(--color-surface-2)]">
        <RotateCw className="h-16 w-16 text-[var(--color-fg-subtle)] mb-6" />
        <h2 className="text-lg font-semibold text-[var(--color-fg)] mb-2">Ruota il dispositivo</h2>
        <p className="text-sm text-[var(--color-fg-muted)] max-w-[280px]">
          Ruota il dispositivo in orizzontale per vedere sala e tavoli
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-[calc(100vh-64px)] p-2 gap-2 sm:p-4 sm:gap-4"
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Mobile: Date + Shift Picker (controls per-shift merge scope) */}
      <div className="md:hidden bg-[var(--color-surface)] px-3 sm:px-4 py-2 rounded-lg border border-[var(--color-line)] flex flex-wrap items-center gap-3 z-20">
        <DateNavigator
          value={selectedDate}
          onChange={setSelectedDate}
          className="flex-1 min-w-[220px]"
        />
        <div className="flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5">
          <button
            onClick={() => setSelectedShift(Shift.LUNCH)}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              selectedShift === Shift.LUNCH ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
            }`}
          >
            <Sun className="h-4 w-4" /> Pranzo
          </button>
          <button
            onClick={() => setSelectedShift(Shift.DINNER)}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              selectedShift === Shift.DINNER ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
            }`}
          >
            <Sunset className="h-4 w-4" /> Cena
          </button>
        </div>
        {hiddenTableIds.size > 0 && (
            <button
                onClick={() => setShowHidden(s => !s)}
                className={`ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                    showHidden
                        ? 'bg-indigo-50 dark:bg-[#4f46e5]/15 text-indigo-700 dark:text-[#a5b4fc] border-indigo-200 dark:border-[#4f46e5]/30'
                        : 'bg-white dark:bg-[var(--color-surface)] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/30 hover:bg-slate-50 dark:hover:bg-slate-500/15'
                }`}
                title={showHidden ? 'Nascondi i tavoli nascosti' : 'Mostra i tavoli nascosti per riattivarli'}
            >
                {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                {hiddenTableIds.size} {hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}
            </button>
        )}
      </div>

      {/* Desktop: Merge scope note + hidden toggle */}
      <div className="hidden md:flex items-center gap-3 px-1 z-20">
        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-fg-subtle)]">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
          Le unioni tavoli sono valide solo per questa data e turno.
        </span>
        {hiddenTableIds.size > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
                <button
                    onClick={() => setShowHidden(s => !s)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                        showHidden
                            ? 'bg-indigo-50 dark:bg-[#4f46e5]/15 text-indigo-700 dark:text-[#a5b4fc] border-indigo-200 dark:border-[#4f46e5]/30'
                            : 'bg-white dark:bg-[var(--color-surface)] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-500/30 hover:bg-slate-50 dark:hover:bg-slate-500/15'
                    }`}
                    title={showHidden ? 'Nascondi i tavoli nascosti' : 'Mostra i tavoli nascosti per riattivarli'}
                >
                    {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                    {hiddenTableIds.size} {hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}
                </button>
                <button
                    onClick={() => setUnhideAllConfirm(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border bg-white dark:bg-[var(--color-surface)] text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/15 transition-colors"
                    title={`Riattiva tutti i ${hiddenTableIds.size} tavoli nascosti per questo turno`}
                >
                    <Eye size={14} />
                    Riattiva tutti
                </button>
            </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="bg-[var(--color-surface)] p-3 sm:p-4 rounded-lg border border-[var(--color-line)] flex flex-wrap items-center justify-between gap-2 sm:gap-4 z-20">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide w-full sm:flex-1 sm:min-w-0 pb-1">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => {
                  setActiveRoomId(room.id);
                  setSelectedTables([]);
              }}
              className={`rounded-full px-4 py-2.5 text-sm font-medium transition whitespace-nowrap border flex items-center gap-2 flex-shrink-0 ${
                  activeRoomId === room.id
                  ? room.is_closed
                    ? 'bg-[var(--color-fg-muted)] text-[var(--color-fg-on-brand)] border-[var(--color-fg-muted)]'
                    : 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                  : room.is_closed
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-hover)] border-[var(--color-line)] line-through'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] border-[var(--color-line)]'
              }`}
              title={room.is_closed ? `${room.name} (Chiusa)` : room.name}
            >
              {room.is_closed && <DoorClosed size={14} />}
              {room.name}
            </button>
          ))}

          {/* Add Room UI - Only shown in edit mode */}
          {canEdit && (isAddingRoom ? (
              <div className="flex items-center gap-1 animate-in fade-in slide-in-from-left-2">
                  <input
                      autoFocus
                      value={newRoomName}
                      onChange={e => setNewRoomName(e.target.value)}
                      placeholder="Nome sala..."
                      className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-1.5 text-sm w-32 focus:outline-none focus:border-[var(--color-fg)]"
                      onKeyDown={e => e.key === 'Enter' && handleConfirmAddRoom()}
                  />
                  <button
                    onClick={handleConfirmAddRoom}
                    className="p-1.5 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90"
                    title="Conferma"
                  >
                      <Check size={16}/>
                  </button>
                  <button
                    onClick={() => { setIsAddingRoom(false); setNewRoomName(''); }}
                    className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                    title="Annulla"
                  >
                      <X size={16}/>
                  </button>
              </div>
          ) : (
            <button
                onClick={() => setIsAddingRoom(true)}
                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] border border-[var(--color-line)]"
                title="Aggiungi Nuova Sala"
            >
                <Plus size={16} />
            </button>
          ))}
        </div>

        {/* Tools section - Only shown in edit mode */}
        {canEdit && (
        <div className="flex items-center gap-2 sm:border-l sm:pl-4 border-[var(--color-line)] overflow-x-auto shrink-0 w-full sm:w-auto">
          <span className="text-[11px] font-semibold text-[var(--color-fg-subtle)] tracking-[0.02em] hidden xl:block">Strumenti</span>

          <button
            onClick={() => setIsSelectionMode(!isSelectionMode)}
            className={`p-1.5 rounded-md border transition ${
                isSelectionMode
                ? 'bg-[var(--color-surface-3)] border-[var(--color-line-strong)] text-[var(--color-fg)]'
                : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
            }`}
            title="Modalità Selezione Multipla"
          >
              <CheckSquare className="h-4 w-4" />
          </button>

          <button
            onClick={() => setLayoutMode(m => m === 'auto' ? 'manual' : 'auto')}
            className={`p-1.5 rounded-md border transition ${
                layoutMode === 'manual'
                ? 'bg-indigo-50 dark:bg-[#4f46e5]/15 border-indigo-200 dark:border-[#4f46e5]/30 text-indigo-700 dark:text-[#a5b4fc]'
                : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
            }`}
            title={layoutMode === 'manual' ? 'Layout manuale: trascina per posizionare. Clicca per tornare ad auto-tidy.' : 'Layout auto-tidy: posizioni ordinate per numero. Clicca per attivare drag manuale.'}
          >
              {layoutMode === 'manual' ? <Move className="h-4 w-4" /> : <Layout className="h-4 w-4" />}
          </button>

          {selectedTables.length > 0 && (
              <button
                onClick={() => setSelectedTables([])}
                className="p-1.5 rounded-md border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-600 dark:hover:text-rose-400 transition"
                title="Deseleziona Tutto"
              >
                  <X className="h-4 w-4" />
              </button>
          )}

          <div className="h-6 w-px bg-[var(--color-line)] mx-1"></div>

          <button onClick={() => handleAddTable(TableShape.RECTANGLE)} className="p-1.5 bg-[var(--color-surface)] border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] rounded-md text-[var(--color-fg-muted)]" title="Rettangolo">
            <div className="w-6 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.SQUARE)} className="p-1.5 bg-[var(--color-surface)] border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] rounded-md text-[var(--color-fg-muted)]" title="Quadrato">
            <div className="w-4 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.CIRCLE)} className="p-1.5 bg-[var(--color-surface)] border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] rounded-md text-[var(--color-fg-muted)]" title="Tondo">
             <div className="w-4 h-4 border-2 border-current rounded-full" />
          </button>

          <div className="h-6 w-px bg-[var(--color-line)] mx-1"></div>

          {/* Toggle Room Closed Button */}
          {(() => {
            const activeRoom = rooms.find(r => r.id === activeRoomId);
            if (!activeRoom) return null;
            const isClosed = activeRoom.is_closed === true;
            return (
              <button
                onClick={() => onToggleRoomClosed(activeRoom.id, !isClosed)}
                className={`p-2 rounded-lg border transition-colors flex items-center gap-1 text-xs font-medium ${
                  isClosed
                    ? 'border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15 hover:bg-emerald-100 dark:hover:bg-emerald-500/25'
                    : 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 hover:bg-amber-100 dark:hover:bg-amber-500/25'
                }`}
                title={isClosed ? `Riapri Sala: ${activeRoom.name}` : `Chiudi Sala: ${activeRoom.name}`}
              >
                {isClosed ? <DoorOpen className="h-4 w-4" /> : <DoorClosed className="h-4 w-4" />}
                <span className="hidden lg:inline">{isClosed ? 'Riapri' : 'Chiudi'}</span>
              </button>
            );
          })()}

          {/* Delete Room Button (Safe location) */}
          <button
            onClick={() => handleDeleteRoomClick(activeRoomId)}
            className="p-1.5 rounded-md border border-rose-100 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/15 transition"
            title={`Elimina Sala Corrente: ${rooms.find(r => r.id === activeRoomId)?.name}`}
          >
             <Layout className="h-4 w-4 inline mr-1"/>
             <Trash2 className="h-4 w-4 inline" />
          </button>
        </div>
        )}

        {/* Edit toolbar - Only shown when tables selected AND in edit mode */}
        {canEdit && selectedTables.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 sm:border-l sm:pl-4 border-[var(--color-line)] animate-in slide-in-from-right duration-200 shrink-0 w-full sm:w-auto">
            <span className="text-[11px] font-semibold text-[var(--color-fg-subtle)] tracking-[0.02em] hidden xl:block">Modifica</span>

            {/* Lock/Unlock */}
            <button
                onClick={handleToggleLock}
                className={`p-1.5 rounded-md border transition ${
                    singleSelectedTable?.is_locked
                    ? 'bg-amber-50 dark:bg-amber-500/15 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300'
                    : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                }`}
                title={singleSelectedTable?.is_locked ? "Sblocca Tavolo" : "Blocca Tavolo"}
            >
                {singleSelectedTable?.is_locked ? <Unlock size={16} /> : <Lock size={16} />}
            </button>

            {/* Temp Lock (Timer) */}
            <button
                onClick={handleTempLock}
                className="p-1.5 rounded-md border bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 hover:border-amber-200 dark:hover:border-amber-500/30 transition flex items-center gap-1"
                title="Blocca per 15 minuti"
            >
                <Clock size={16} /> <span className="text-xs font-semibold hidden sm:inline">15m</span>
            </button>

            {/* Table Name Edit */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className="flex items-center gap-1 bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md px-2 py-1">
                    <CaseSensitive size={14} className="text-[var(--color-fg-muted)]" />
                    <input
                        type="text"
                        className="w-20 text-sm outline-none text-[var(--color-fg)] font-semibold bg-transparent"
                        value={singleSelectedTable.name}
                        onChange={(e) => handleNameChange(e.target.value)}
                    />
                </div>
            )}

            {/* Seats Edit */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className="flex items-center gap-1 bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md px-2 py-1">
                    <Users size={14} className="text-[var(--color-fg-muted)]" />
                    <input
                        type="number"
                        min="1"
                        max="20"
                        className="w-12 text-sm outline-none text-[var(--color-fg)] font-semibold bg-transparent"
                        value={singleSelectedTable.seats}
                        onChange={(e) => handleSeatsChange(parseInt(e.target.value) || 1)}
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
                    className={`flex items-center gap-1 px-2 py-2 rounded-lg border transition-colors ${
                        (singleSelectedTable.notes || singleSelectedTable.width_cm || singleSelectedTable.length_cm)
                            ? 'bg-indigo-50 dark:bg-[#4f46e5]/15 border-indigo-200 dark:border-[#4f46e5]/30 text-indigo-700 dark:text-[#a5b4fc] hover:bg-indigo-100 dark:hover:bg-[#4f46e5]/25'
                            : 'bg-white dark:bg-[var(--color-surface)] border-slate-200 dark:border-slate-500/30 text-slate-600 dark:text-slate-400 hover:bg-indigo-50 dark:hover:bg-[#4f46e5]/15 hover:text-indigo-600 dark:hover:text-[#818cf8] hover:border-indigo-200 dark:hover:border-[#4f46e5]/30'
                    }`}
                    title="Dettagli tavolo (dimensioni, note)"
                >
                    <Info size={16} />
                    <span className="text-xs font-semibold hidden sm:inline">Dettagli</span>
                </button>
            )}

            {/* Rotate Table */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                <button
                    onClick={(e) => handleRotate(e.shiftKey ? -15 : 15)}
                    onContextMenu={(e) => { e.preventDefault(); handleRotate(-15); }}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-md border bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition"
                    title={`Ruota +15° (Shift/click destro per -15°)${singleSelectedTable ? ` — attuale: ${singleSelectedTable.rotation || 0}°` : ''}`}
                >
                    <RotateCw size={16} />
                    {singleSelectedTable && (singleSelectedTable.rotation || 0) !== 0 && (
                        <span className="text-xs font-semibold tabular-nums">{singleSelectedTable.rotation}°</span>
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
                    className="flex items-center gap-2 rounded-full px-3 py-1.5 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 font-medium text-sm transition"
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
                    className="flex items-center gap-2 rounded-full px-3 py-1.5 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/25 font-medium text-sm transition"
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
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium text-sm ${
                            allHidden
                                ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/25'
                                : 'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-500/30'
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
                 className="flex items-center gap-2 rounded-full px-3 py-1.5 bg-rose-600 text-[#ffffff] hover:bg-rose-700 font-medium text-sm transition"
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
        <div className="bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2.5 flex items-start gap-2.5 z-20 animate-in fade-in slide-in-from-top-1">
          <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-xs text-rose-800 dark:text-rose-200">
            <span className="font-semibold">
              {overlapPairs.length === 1 ? 'Un tavolo si sovrappone' : `${overlapPairs.length} sovrapposizioni di tavoli`} in questa sala.
            </span>{' '}
            <span className="text-rose-700 dark:text-rose-300">
              Trascina per separarli: {overlapPairs.map(([a, b]) => `${a.name} ↔ ${b.name}`).join(', ')}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setDismissedOverlapSig(overlapSig)}
            className="p-1 rounded-md text-rose-500 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/25 transition-colors flex-shrink-0"
            aria-label="Ignora avviso"
            title="Ignora avviso"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={`flex-1 bg-[var(--color-surface-2)] rounded-lg border border-dashed border-[var(--color-line-strong)] relative overflow-hidden ${isSelectionMode ? 'cursor-crosshair' : 'cursor-default'}`}
        onClick={() => !isSelectionMode && setSelectedTables([])}
        style={{
            backgroundImage: 'radial-gradient(rgba(148,163,184,0.4) 1px, transparent 1px)',
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
                className={`${banquetColorClass(h.banquetId)} absolute rounded-2xl border border-[var(--color-banquet-border)] bg-[var(--color-banquet-bg)] pointer-events-none`}
                style={{ left: h.box.x, top: h.box.y, width: h.box.w, height: h.box.h, zIndex: 0 }} />
            ))}
            {currentTables.map(renderTableShape)}
            {/* Banquet event labels (one per banquet) */}
            {floorLabels.banquetLabels.map((bl, i) => {
              const data = floorLabels.banquetDataById.get(bl.banquetId);
              if (!data) return null;
              return (
                <div key={`blabel-${bl.banquetId}-${i}`} className="absolute pointer-events-none" style={{ left: bl.x, top: bl.y, zIndex: 15 }}>
                  <BanquetLabel width={bl.w} name={data.name} guests={data.guests} banquetId={bl.banquetId} />
                </div>
              );
            })}
          </div>

          {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-[var(--color-surface-2)]/70 backdrop-blur-[1px] flex items-center justify-center">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface)] rounded-md border border-[var(--color-line)]">
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
                      <span className="text-sm text-[var(--color-fg-muted)]">Caricamento tavoli…</span>
                  </div>
              </div>
          )}

          {currentTables.length === 0 && !isLoadingMerges && (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--color-fg-muted)] pointer-events-none">
                  <p className="text-sm">Trascina o aggiungi tavoli in questa sala</p>
              </div>
          )}

          {isSelectionMode && (
              <div className="absolute top-4 left-4 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] px-3 py-1 rounded-full text-xs font-medium pointer-events-none flex items-center gap-2">
                  <CheckSquare size={12} /> MODALITÀ SELEZIONE ATTIVA
              </div>
          )}

          {rooms.find(r => r.id === activeRoomId)?.is_closed && (
              <div className="absolute top-4 right-4 bg-amber-500 text-[#ffffff] px-3 py-1.5 rounded-full text-xs font-bold shadow-lg pointer-events-none flex items-center gap-1.5 tracking-wide">
                  <DoorClosed size={12} /> Sala Chiusa
              </div>
          )}

          {/* Legend - collapsible */}
          <div className="absolute bottom-4 right-4 z-10 select-none">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface)] rounded-md border border-[var(--color-line)] text-xs font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition"
                aria-expanded={isLegendOpen}
            >
                <Info size={14} />
                Legenda
            </button>
            {isLegendOpen && (
                <div
                    className="absolute bottom-full right-0 mb-2 w-56 bg-[var(--color-surface)] p-3 rounded-md border border-[var(--color-line)] shadow-[var(--shadow-overlay)] text-xs space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-1">Legenda Stato</div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                        <div className="w-3 h-3 rounded-sm border" style={{ background: 'var(--tg-libera-bg)', borderColor: 'var(--tg-libera-stroke)' }}></div> Libera
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                        <div className="w-3 h-3 rounded-sm border" style={{ background: 'var(--tg-attesa-bg)', borderColor: 'var(--tg-attesa-stroke)' }}></div> In attesa
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--tg-attesa-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                        <div className="w-3 h-3 rounded-sm border" style={{ background: 'var(--tg-arrivato-bg)', borderColor: 'var(--tg-arrivato-stroke)' }}></div> Arrivato
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-subtle)] border-t border-[var(--color-line)] pt-2 mt-1">
                        <Lock size={12} /> Tavolo Bloccato
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-subtle)]">
                        <Timer size={12} /> Blocco Temporaneo
                    </div>
                </div>
            )}
          </div>
      </div>

      {/* Alert Modal */}
      {alertModal && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setAlertModal(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-6 text-center">
              <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 border ${
                alertModal.type === 'error' ? 'bg-rose-50 dark:bg-rose-500/15 border-rose-100 dark:border-rose-500/30' : 'bg-amber-50 dark:bg-amber-500/15 border-amber-100 dark:border-amber-500/30'
              }`}>
                <AlertTriangle className={`h-5 w-5 ${
                  alertModal.type === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'
                }`} />
              </div>
              <h3 className="text-[15px] font-semibold text-[var(--color-fg)] mb-2">Attenzione</h3>
              <p className="text-sm text-[var(--color-fg-muted)] mb-6">{alertModal.message}</p>
              <button
                onClick={() => setAlertModal(null)}
                className="w-full rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition"
              >
                OK
              </button>
            </div>
          </div>
        </div>
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
        icon={<Eye className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />}
        iconWrapperClassName="mx-auto w-12 h-12 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-100 dark:border-emerald-500/30 rounded-full flex items-center justify-center mb-4"
        confirmClassName="rounded-full px-4 py-2 bg-emerald-600 text-[#ffffff] text-sm font-medium hover:bg-emerald-700 transition"
        showIrreversibleWarning={false}
        onCancel={() => setUnhideAllConfirm(false)}
        onConfirm={async () => {
          setUnhideAllConfirm(false);
          await handleUnhideAll();
        }}
      />

      {/* Table Details Modal (dimensions + notes) */}
      {detailsModal && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setDetailsModal(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Dettagli Tavolo {detailsModal.table.name}</h3>
              <button
                onClick={() => setDetailsModal(null)}
                className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                  <Ruler className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" /> Dimensioni (cm)
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1">Larghezza</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="es. 80"
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-500/30 p-2 bg-slate-50 dark:bg-slate-500/10 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 outline-none"
                      value={detailsModal.widthCm}
                      onChange={e => setDetailsModal({ ...detailsModal, widthCm: e.target.value })}
                    />
                  </div>
                  <span className="text-slate-400 dark:text-slate-500 mt-5">×</span>
                  <div className="flex-1">
                    <label className="text-[11px] text-slate-500 dark:text-slate-400 block mb-1">Lunghezza</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="es. 120"
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-500/30 p-2 bg-slate-50 dark:bg-slate-500/10 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 outline-none"
                      value={detailsModal.lengthCm}
                      onChange={e => setDetailsModal({ ...detailsModal, lengthCm: e.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                  <StickyNote className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" /> Note
                </label>
                <textarea
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-500/30 p-2 bg-slate-50 dark:bg-slate-500/10 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 outline-none h-24 resize-none"
                  placeholder="es. Tavolo accanto alla finestra, ottimo per cene romantiche"
                  value={detailsModal.notes}
                  onChange={e => setDetailsModal({ ...detailsModal, notes: e.target.value })}
                />
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex gap-2 justify-end">
              <button
                onClick={() => setDetailsModal(null)}
                className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
              >
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
                className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
              >
                Salva
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};