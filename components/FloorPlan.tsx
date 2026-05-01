import React, { useState, useRef, useEffect, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { Table, TableShape, Room, TableStatus, Reservation, Shift, TableMerge, ArrivalStatus } from '../types';
import { Plus, Move, Armchair, Trash2, Combine, Scissors, Save, MousePointer2, CheckSquare, Lock, Unlock, Users, X, Clock, Timer, User, Check, Layout, CaseSensitive, AlertTriangle, Sun, Moon, Calendar, Loader2, Info, RotateCw } from 'lucide-react';
import { getTableMerges } from '../services/apiService';
import { applyMerges } from '../utils/tableMerge';
import { useSocket } from '../hooks/useSocket';

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
  onUpdateTable: (updatedTable: Table) => void;
  onDeleteTable: (tableId: number) => void;
  onAddTable: (table: Omit<Table, 'id'>) => void;
  onMergeTables: (tableIds: number[], date: string, shift: Shift) => Promise<void> | void;
  onSplitTable: (tableId: number, date: string, shift: Shift) => Promise<void> | void;
  onAddRoom: (roomName: string) => void;
  onDeleteRoom: (room_id: number) => void;
  canEdit?: boolean;
}

export const FloorPlan: React.FC<FloorPlanProps> = ({
  rooms,
  tables,
  reservations,
  onUpdateTable,
  onDeleteTable,
  onAddTable,
  onMergeTables,
  onSplitTable,
  onAddRoom,
  onDeleteRoom,
  canEdit = true
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

  // Per-shift merge context
  const [selectedDate, setSelectedDate] = useState<string>(() => formatLocalDate(new Date()));
  const [selectedShift, setSelectedShift] = useState<Shift>(() => detectShiftFromNow());
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  const [isLoadingMerges, setIsLoadingMerges] = useState(false);

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
  }>({
    isDragging: false,
    tableId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    originalPos: null
  });

  const draggedElementRef = useRef<HTMLDivElement | null>(null);
  
  // Room Management State
  const [isAddingRoom, setIsAddingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');

  // Tick state for updating timers every second
  const [tick, setTick] = useState(0);

  // Modal state for alerts
  const [alertModal, setAlertModal] = useState<{ message: string; type: 'error' | 'warning' } | null>(null);
  const [deleteRoomConfirm, setDeleteRoomConfirm] = useState<Room | null>(null);

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
    ));

  // Compute the natural bounding box of the room from current tables, then
  // a scale factor that shrinks the room to fit the available canvas size.
  const roomExtent = useMemo(() => {
    const PADDING = 40;
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const baseSize = isMobile ? 45 : 80;
    const baseWidth = isMobile ? 60 : 100;
    const seatMultiplier = isMobile ? 8 : 15;

    if (currentTables.length === 0) return { width: 800, height: 600 };

    let maxRight = 0;
    let maxBottom = 0;
    for (const t of currentTables) {
      let w: number, h: number;
      if (t.shape === TableShape.CIRCLE || t.shape === TableShape.SQUARE) {
        w = baseSize; h = baseSize;
      } else {
        w = Math.max(baseWidth, t.seats * seatMultiplier);
        h = baseSize;
      }
      maxRight = Math.max(maxRight, t.x + w);
      maxBottom = Math.max(maxBottom, t.y + h);
    }
    return { width: maxRight + PADDING, height: maxBottom + PADDING };
  }, [currentTables]);

  const scale = useMemo(() => {
    if (canvasSize.width === 0 || canvasSize.height === 0) return 1;
    const sx = canvasSize.width / roomExtent.width;
    const sy = canvasSize.height / roomExtent.height;
    return Math.min(sx, sy, 1);
  }, [canvasSize, roomExtent]);

  useEffect(() => { scaleRef.current = scale; }, [scale]);

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

          const [h, m] = r.reservation_time.split('T')[1].substring(0, 5).split(':').map(Number);
          const resTimeValue = h * 60 + m;
          
          // Broad check to display name if reservation is roughly now
          return (currentTimeValue >= (resTimeValue - 30) && currentTimeValue <= (resTimeValue + 120));
      });
  };

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

    // Initialize drag using refs
    dragStateRef.current = {
      isDragging: true,
      tableId: tableId,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      originalPos: table ? { x: table.x, y: table.y } : null
    };
    draggedElementRef.current = element;
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState.isDragging || !draggedElementRef.current) return;

    const s = scaleRef.current || 1;
    const deltaX = (e.clientX - dragState.startX) / s;
    const deltaY = (e.clientY - dragState.startY) / s;

    // Apply CSS transform for smooth visual dragging (no React re-render).
    // Translation is in unscaled coords; the scaled wrapper maps it to screen.
    // Translate must come first so the matrix's tx/ty entries match the
    // unrotated drag delta (rotation last preserves values[4]/values[5]).
    const dragTable = tables.find(t => t.id === dragState.tableId);
    const rotPart = dragTable?.rotation ? ` rotate(${dragTable.rotation}deg)` : '';
    draggedElementRef.current.style.transform = `translate(${deltaX}px, ${deltaY}px)${rotPart}`;
    draggedElementRef.current.style.zIndex = '100';

    dragState.currentX = e.clientX;
    dragState.currentY = e.clientY;
  };

  const handleMouseUp = () => {
    const dragState = dragStateRef.current;

    // Save final position to backend if we were dragging
    if (dragState.isDragging && dragState.tableId !== null && canvasRef.current) {
        const table = tables.find(t => t.id === dragState.tableId);

        if (table && dragState.originalPos && draggedElementRef.current) {
            // Validate table.id is a proper number
            if (typeof table.id !== 'number' || isNaN(table.id)) {
                console.error('Invalid table ID in handleMouseUp:', table.id, table);
                return;
            }

            // Parse the current transform to get the translation
            const transform = window.getComputedStyle(draggedElementRef.current).transform;
            let translateX = 0;
            let translateY = 0;

            if (transform && transform !== 'none') {
                const matrix = transform.match(/matrix\((.+)\)/);
                if (matrix) {
                    const values = matrix[1].split(', ');
                    translateX = parseFloat(values[4]) || 0;
                    translateY = parseFloat(values[5]) || 0;
                }
            }

            // Calculate final position: original position + transform delta
            const finalX = Math.round(dragState.originalPos.x + translateX);
            const finalY = Math.round(dragState.originalPos.y + translateY);

            // Ensure positions don't go negative
            const clampedX = Math.max(0, finalX);
            const clampedY = Math.max(0, finalY);

            const updatedTable = {
                ...table,
                x: clampedX,
                y: clampedY
            };

            // Force synchronous update to prevent snap-back
            flushSync(() => {
                onUpdateTable(updatedTable);
            });

            // Clear transform after DOM has been updated with new position
            draggedElementRef.current.style.transform = '';
            draggedElementRef.current.style.zIndex = '';
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
      originalPos: null
    };
    draggedElementRef.current = null;
    setIsDragging(false);
  };

  // Touch event handlers for mobile
  const handleTouchStart = (e: React.TouchEvent, tableId: number, element: HTMLDivElement) => {
    e.stopPropagation();

    // If not in edit mode, don't allow selection or dragging
    if (!canEdit) {
        return;
    }

    const touch = e.touches[0];
    const table = tables.find(t => t.id === tableId);

    if (table?.is_locked || (table?.temp_lock_expires_at && table.temp_lock_expires_at > Date.now())) {
        return;
    }

    if (!selectedTables.includes(tableId)) {
        setSelectedTables([tableId]);
    }

    // Initialize drag using refs
    dragStateRef.current = {
      isDragging: true,
      tableId: tableId,
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      originalPos: table ? { x: table.x, y: table.y } : null
    };
    draggedElementRef.current = element;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState.isDragging || !draggedElementRef.current) return;

    const touch = e.touches[0];
    const s = scaleRef.current || 1;
    const deltaX = (touch.clientX - dragState.startX) / s;
    const deltaY = (touch.clientY - dragState.startY) / s;

    const dragTable = tables.find(t => t.id === dragState.tableId);
    const rotPart = dragTable?.rotation ? ` rotate(${dragTable.rotation}deg)` : '';
    draggedElementRef.current.style.transform = `translate(${deltaX}px, ${deltaY}px)${rotPart}`;
    draggedElementRef.current.style.zIndex = '100';

    dragState.currentX = touch.clientX;
    dragState.currentY = touch.clientY;
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

  const handleSeatsChange = (newSeats: number) => {
      if (newSeats < 1) return;
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table && !table.is_locked) {
              onUpdateTable({ ...table, seats: newSeats });
          }
      });
  };

  const handleNameChange = (newName: string) => {
    if (singleSelectedTable) {
        onUpdateTable({ ...singleSelectedTable, name: newName });
    }
  };

  const handleRotate = (delta: number) => {
      selectedTables.forEach(id => {
          const table = tables.find(t => t.id === id);
          if (table && !table.is_locked) {
              const next = (((table.rotation || 0) + delta) % 360 + 360) % 360;
              onUpdateTable({ ...table, rotation: next });
          }
      });
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
    // Ensure table.id is a valid number
    if (!table.id || typeof table.id !== 'number') {
      console.error('Invalid table ID:', table);
      return null;
    }

    const isSelected = selectedTables.includes(table.id);
    const dynamicStatus = getDynamicTableStatus(table);
    const reservation = getActiveReservation(table);
    const isMerged = table.merged_with && table.merged_with.length > 0;

    // Calculate remaining time if temp locked
    let timerDisplay = null;
    if (table.temp_lock_expires_at && table.temp_lock_expires_at > Date.now()) {
        const remainingSeconds = Math.ceil((table.temp_lock_expires_at - Date.now()) / 1000);
        const mm = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
        const ss = (remainingSeconds % 60).toString().padStart(2, '0');
        timerDisplay = `${mm}:${ss}`;
    }

    const statusColors = {
      [TableStatus.FREE]: 'bg-white border-emerald-300 text-emerald-700',
      [TableStatus.OCCUPIED]: 'bg-red-100 border-red-300 text-red-700',
      [TableStatus.RESERVED]: 'bg-amber-100 border-amber-300 text-amber-700',
      [TableStatus.DIRTY]: 'bg-gray-200 border-gray-400 text-gray-600'
    };

    const baseClasses = `absolute flex flex-col items-center justify-center border-2 shadow-sm transition-shadow select-none ${statusColors[dynamicStatus]} ${isSelected && canEdit ? 'ring-4 ring-indigo-400/50 ring-offset-1 border-indigo-500' : ''} ${!canEdit ? 'cursor-default' : table.is_locked || timerDisplay ? 'cursor-not-allowed opacity-90' : 'cursor-grab active:cursor-grabbing hover:shadow-md'}`;

    // Responsive table sizes - smaller on mobile and tablets (< 768px)
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const baseSize = isMobile ? 45 : 80;
    const baseWidth = isMobile ? 60 : 100;
    const seatMultiplier = isMobile ? 8 : 15;

    let shapeStyles = {};

    if (table.shape === TableShape.CIRCLE) {
      shapeStyles = { borderRadius: '50%', width: `${baseSize}px`, height: `${baseSize}px` };
    } else if (table.shape === TableShape.SQUARE) {
      shapeStyles = { borderRadius: '8px', width: `${baseSize}px`, height: `${baseSize}px` };
    } else {
      const width = Math.max(baseWidth, table.seats * seatMultiplier);
      shapeStyles = { borderRadius: '8px', width: `${width}px`, height: `${baseSize}px` };
    }

    return (
      <div
        key={table.id}
        className={baseClasses}
        style={{
          left: table.x,
          top: table.y,
          ...shapeStyles,
          transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined,
          zIndex: isSelected ? 10 : 1
        }}
        onMouseDown={(e) => {
          const element = e.currentTarget as HTMLDivElement;
          handleMouseDown(e, table.id, element);
        }}
        onTouchStart={(e) => {
          const element = e.currentTarget as HTMLDivElement;
          handleTouchStart(e, table.id, element);
        }}
      >
        <span className="font-bold text-sm flex items-center gap-1">
            {table.is_locked && <Lock size={10} className="text-slate-400" />}
            {table.name}
        </span>
        
        {/* Show Reservation Name */}
        {reservation && !timerDisplay && (
            <span className="text-[10px] font-bold truncate max-w-[90%] bg-white/50 px-1 rounded">
                {reservation.customer_name}
            </span>
        )}

        <span className="text-xs flex items-center gap-1 opacity-80">
           <Armchair size={10} /> {table.seats}
        </span>
        
        {dynamicStatus === TableStatus.OCCUPIED && (
             <div className="absolute -top-2 -right-2 w-3 h-3 bg-red-500 rounded-full border border-white animate-pulse"></div>
        )}

        {/* Timer Badge */}
        {timerDisplay && (
            <div className="absolute -top-3 -right-2 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm flex items-center gap-0.5 border border-white">
                <Timer size={8} /> {timerDisplay}
            </div>
        )}

        {/* Merged Table Badge */}
        {isMerged && !timerDisplay && (
            <div className="absolute -top-2 -left-2 bg-indigo-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm flex items-center gap-0.5 border border-white">
                <Combine size={8} />
            </div>
        )}
      </div>
    );
  };

  const singleSelectedTable = selectedTables.length === 1 ? displayTables.find(t => t.id === selectedTables[0]) : null;

  return (
    <div
      className="flex flex-col h-[calc(100vh-64px)] p-4 gap-4"
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Date + Shift Picker (controls per-shift merge scope) */}
      <div className="bg-white px-3 sm:px-4 py-2 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center gap-3 z-20">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-indigo-500" />
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-2 py-1.5 text-sm rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          />
        </div>
        <div className="inline-flex bg-slate-100 rounded-lg p-1">
          <button
            onClick={() => setSelectedShift(Shift.LUNCH)}
            className={`flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
              selectedShift === Shift.LUNCH ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Sun size={14} /> Pranzo
          </button>
          <button
            onClick={() => setSelectedShift(Shift.DINNER)}
            className={`flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
              selectedShift === Shift.DINNER ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Moon size={14} /> Cena
          </button>
        </div>
        <span className="text-xs text-slate-400 hidden sm:inline">
          Le unioni tavoli sono valide solo per questa data e turno.
        </span>
      </div>

      {/* Toolbar */}
      <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-2 sm:gap-4 z-20">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide w-full sm:flex-1 sm:min-w-0 pb-1">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => {
                  setActiveRoomId(room.id);
                  setSelectedTables([]);
              }}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap border flex items-center gap-1 sm:gap-2 flex-shrink-0 ${
                  activeRoomId === room.id
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-200'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border-slate-200'
              }`}
            >
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
                      className="px-3 py-2 w-32 rounded-lg border border-indigo-300 focus:ring-2 focus:ring-indigo-500 outline-none text-sm bg-white"
                      onKeyDown={e => e.key === 'Enter' && handleConfirmAddRoom()}
                  />
                  <button
                    onClick={handleConfirmAddRoom}
                    className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 shadow-sm"
                    title="Conferma"
                  >
                      <Check size={16}/>
                  </button>
                  <button
                    onClick={() => { setIsAddingRoom(false); setNewRoomName(''); }}
                    className="p-2 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200"
                    title="Annulla"
                  >
                      <X size={16}/>
                  </button>
              </div>
          ) : (
            <button
                onClick={() => setIsAddingRoom(true)}
                className="p-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 border border-indigo-200 shrink-0 transition-colors"
                title="Aggiungi Nuova Sala"
            >
                <Plus size={16} />
            </button>
          ))}
        </div>

        {/* Tools section - Only shown in edit mode */}
        {canEdit && (
        <div className="flex items-center gap-3 border-l pl-4 border-slate-200 overflow-x-auto shrink-0">
          <span className="text-xs font-semibold text-slate-400 uppercase hidden xl:block">Strumenti</span>

          <button
            onClick={() => setIsSelectionMode(!isSelectionMode)}
            className={`p-2 rounded-lg border transition-all ${
                isSelectionMode
                ? 'bg-indigo-100 border-indigo-300 text-indigo-700'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
            title="Modalità Selezione Multipla"
          >
              <CheckSquare className="h-4 w-4" />
          </button>

          {selectedTables.length > 0 && (
              <button
                onClick={() => setSelectedTables([])}
                className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-rose-500 transition-colors"
                title="Deseleziona Tutto"
              >
                  <X className="h-4 w-4" />
              </button>
          )}

          <div className="h-8 w-px bg-slate-200 mx-1"></div>

          <button onClick={() => handleAddTable(TableShape.RECTANGLE)} className="p-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-slate-600" title="Rettangolo">
            <div className="w-6 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.SQUARE)} className="p-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-slate-600" title="Quadrato">
            <div className="w-4 h-4 border-2 border-current rounded-sm" />
          </button>
          <button onClick={() => handleAddTable(TableShape.CIRCLE)} className="p-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-slate-600" title="Tondo">
             <div className="w-4 h-4 border-2 border-current rounded-full" />
          </button>

          <div className="h-8 w-px bg-slate-200 mx-1"></div>

          {/* Delete Room Button (Safe location) */}
          <button
            onClick={() => handleDeleteRoomClick(activeRoomId)}
            className="p-2 rounded-lg border border-red-100 text-red-500 hover:bg-red-50 hover:border-red-200 transition-colors"
            title={`Elimina Sala Corrente: ${rooms.find(r => r.id === activeRoomId)?.name}`}
          >
             <Layout className="h-4 w-4 inline mr-1"/>
             <Trash2 className="h-4 w-4 inline" />
          </button>
        </div>
        )}

        {/* Edit toolbar - Only shown when tables selected AND in edit mode */}
        {canEdit && selectedTables.length > 0 && (
            <div className="flex items-center gap-2 border-l pl-4 border-slate-200 animate-in slide-in-from-right duration-200 shrink-0">
            <span className="text-xs font-semibold text-slate-400 uppercase hidden xl:block">Modifica</span>
            
            {/* Lock/Unlock */}
            <button 
                onClick={handleToggleLock}
                className={`p-2 rounded-lg border transition-colors ${
                    singleSelectedTable?.is_locked 
                    ? 'bg-amber-50 border-amber-200 text-amber-600' 
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
                title={singleSelectedTable?.is_locked ? "Sblocca Tavolo" : "Blocca Tavolo"}
            >
                {singleSelectedTable?.is_locked ? <Unlock size={16} /> : <Lock size={16} />}
            </button>
            
            {/* Temp Lock (Timer) */}
            <button 
                onClick={handleTempLock}
                className="p-2 rounded-lg border bg-white border-slate-200 text-slate-600 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200 transition-colors flex items-center gap-1"
                title="Blocca per 15 minuti"
            >
                <Clock size={16} /> <span className="text-xs font-bold hidden sm:inline">15m</span>
            </button>

            {/* Table Name Edit */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className="flex items-center gap-1 bg-indigo-50 border border-indigo-200 shadow-sm rounded-lg px-2 py-1">
                    <CaseSensitive size={14} className="text-indigo-500" />
                    <input 
                        type="text"
                        className="w-20 text-sm outline-none text-indigo-700 font-bold bg-transparent"
                        value={singleSelectedTable.name}
                        onChange={(e) => handleNameChange(e.target.value)}
                    />
                </div>
            )}

            {/* Seats Edit - Updated Styling */}
            {singleSelectedTable && !singleSelectedTable.is_locked && (
                <div className="flex items-center gap-1 bg-indigo-50 border border-indigo-200 shadow-sm rounded-lg px-2 py-1">
                    <Users size={14} className="text-indigo-500" />
                    <input
                        type="number"
                        min="1"
                        max="20"
                        className="w-12 text-sm outline-none text-indigo-700 font-bold bg-transparent"
                        value={singleSelectedTable.seats}
                        onChange={(e) => handleSeatsChange(parseInt(e.target.value) || 1)}
                    />
                </div>
            )}

            {/* Rotate Table */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                <button
                    onClick={(e) => handleRotate(e.shiftKey ? -15 : 15)}
                    onContextMenu={(e) => { e.preventDefault(); handleRotate(-15); }}
                    className="flex items-center gap-1 px-2 py-2 rounded-lg border bg-white border-slate-200 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors"
                    title={`Ruota +15° (Shift/click destro per -15°)${singleSelectedTable ? ` — attuale: ${singleSelectedTable.rotation || 0}°` : ''}`}
                >
                    <RotateCw size={16} />
                    {singleSelectedTable && (singleSelectedTable.rotation || 0) !== 0 && (
                        <span className="text-xs font-bold tabular-nums">{singleSelectedTable.rotation}°</span>
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
                    className="flex items-center gap-2 px-3 py-2 bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 font-medium text-sm"
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
                    className="flex items-center gap-2 px-3 py-2 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 font-medium text-sm"
                    title={`Dividi tavoli: ${singleSelectedTable.name}`}
                >
                <Scissors size={16} /> Dividi
                </button>
            )}

            {/* Delete only if not locked */}
            {!selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                 <button 
                 onClick={() => {
                     selectedTables.forEach(id => onDeleteTable(id));
                     setSelectedTables([]);
                 }}
                 className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium text-sm"
                >
                    <Trash2 size={16} /> Elimina
                </button>
            )}
            </div>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className={`flex-1 bg-slate-100 rounded-xl border-2 border-dashed border-slate-300 relative overflow-hidden ${isSelectionMode ? 'cursor-crosshair' : 'cursor-default'}`}
        onClick={() => !isSelectionMode && setSelectedTables([])}
        style={{
            backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
            backgroundSize: '20px 20px'
        }}
      >
          <div
            className="absolute top-0 left-0"
            style={{
                width: `${roomExtent.width}px`,
                height: `${roomExtent.height}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left'
            }}
          >
            {currentTables.map(renderTableShape)}
          </div>

          {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-slate-100/70 backdrop-blur-[1px] flex items-center justify-center">
                  <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-sm border border-slate-200">
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                      <span className="text-sm text-slate-600">Caricamento tavoli…</span>
                  </div>
              </div>
          )}

          {currentTables.length === 0 && !isLoadingMerges && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 pointer-events-none">
                  <p>Trascina o aggiungi tavoli in questa sala</p>
              </div>
          )}
          
          {isSelectionMode && (
              <div className="absolute top-4 left-4 bg-indigo-600 text-white px-3 py-1 rounded-full text-xs font-medium shadow-lg pointer-events-none flex items-center gap-2">
                  <CheckSquare size={12} /> MODALITÀ SELEZIONE ATTIVA
              </div>
          )}

          {/* Legend - collapsible */}
          <div className="absolute bottom-4 right-4 z-10 select-none">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                className="flex items-center gap-2 px-3 py-2 bg-white/90 backdrop-blur rounded-xl shadow-sm border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-white transition-colors"
                aria-expanded={isLegendOpen}
            >
                <Info size={14} className="text-indigo-500" />
                Legenda
            </button>
            {isLegendOpen && (
                <div
                    className="absolute bottom-full right-0 mb-2 w-56 bg-white/95 backdrop-blur p-3 rounded-xl shadow-lg border border-slate-200 text-xs space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="font-semibold text-slate-700 mb-1">Legenda Stato</div>
                    <div className="flex items-center gap-2 text-slate-600">
                        <div className="w-3 h-3 bg-white border border-emerald-300 rounded-sm"></div> Libero
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                        <div className="w-3 h-3 bg-red-50 border border-red-300 rounded-sm relative">
                            <div className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-red-500 rounded-full"></div>
                        </div> Occupato (In corso)
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                        <div className="w-3 h-3 bg-amber-50 border border-amber-300 rounded-sm"></div> Riservato (Prossime 2h)
                    </div>
                    <div className="flex items-center gap-2 text-slate-400 border-t pt-2 mt-1">
                        <Lock size={12} /> Tavolo Bloccato
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                        <Timer size={12} /> Blocco Temporaneo
                    </div>
                </div>
            )}
          </div>
      </div>

      {/* Alert Modal */}
      {alertModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
                alertModal.type === 'error' ? 'bg-red-100' : 'bg-amber-100'
              }`}>
                <AlertTriangle className={`h-8 w-8 ${
                  alertModal.type === 'error' ? 'text-red-600' : 'text-amber-600'
                }`} />
              </div>
              <h3 className="text-xl font-semibold text-slate-800 mb-2">Attenzione</h3>
              <p className="text-slate-600 mb-6">{alertModal.message}</p>
              <button
                onClick={() => setAlertModal(null)}
                className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Room Confirmation Modal */}
      {deleteRoomConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <AlertTriangle className="h-8 w-8 text-red-600" />
              </div>
              <h3 className="text-xl font-semibold text-slate-800 mb-2">Elimina Sala</h3>
              <p className="text-slate-600 mb-6">
                Sei sicuro di voler eliminare la sala <strong>"{deleteRoomConfirm.name}"</strong>?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteRoomConfirm(null)}
                  className="flex-1 px-4 py-3 bg-slate-200 text-slate-700 rounded-xl hover:bg-slate-300 transition-colors font-medium"
                >
                  Annulla
                </button>
                <button
                  onClick={handleDeleteRoomConfirm}
                  className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors font-medium"
                >
                  Elimina
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};