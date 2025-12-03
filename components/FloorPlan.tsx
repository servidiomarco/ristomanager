import React, { useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Table, TableShape, Room, TableStatus, Reservation, Shift } from '../types';
import { Plus, Move, Armchair, Trash2, Combine, Scissors, Save, MousePointer2, CheckSquare, Lock, Unlock, Users, X, Clock, Timer, User, Check, Layout, CaseSensitive } from 'lucide-react';

console.log('🔥🔥🔥 FLOORPLAN MODULE LOADED - NEW VERSION WITH MERGE FILTER DEBUG 🔥🔥🔥');

interface FloorPlanProps {
  rooms: Room[];
  tables: Table[];
  reservations: Reservation[];
  onUpdateTable: (updatedTable: Table) => void;
  onDeleteTable: (tableId: number) => void;
  onAddTable: (table: Omit<Table, 'id'>) => void;
  onMergeTables: (tableIds: number[]) => void;
  onSplitTable: (tableId: number) => void;
  onAddRoom: (roomName: string) => void;
  onDeleteRoom: (room_id: number) => void;
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
  onDeleteRoom
}) => {
  console.log('🎨 FLOORPLAN COMPONENT RENDERING with', tables.length, 'tables');

  const [activeRoomId, setActiveRoomId] = useState<number>(() => {
    const firstRoom = rooms[0];
    return typeof firstRoom?.id === 'number' ? firstRoom.id : 0;
  });
  const [selectedTables, setSelectedTables] = useState<number[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);

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

  const canvasRef = useRef<HTMLDivElement>(null);

  // Debug: Log all tables
  useEffect(() => {
    const roomTables = tables.filter(t => t.room_id === activeRoomId);
    const tableIds = roomTables.map(t => t.id);
    const uniqueIds = new Set(tableIds);

    if (tableIds.length !== uniqueIds.size) {
      console.error('DUPLICATE TABLE IDs DETECTED IN STATE!');
      console.error('All table IDs:', tableIds);
      console.error('Duplicate tables:', roomTables.filter((t, i, arr) =>
        arr.findIndex(t2 => t2.id === t.id) !== i
      ));
    }

    roomTables.forEach(t => {
      if (t.merged_with && t.merged_with.length > 0) {
        console.log(`Table ${t.name} (ID: ${t.id}) has merged_with:`, t.merged_with);
      }
    });
  }, [tables, activeRoomId]);

  // Filter tables for the current room and hide merged tables
  console.log('🔍 STARTING FILTER - activeRoomId:', activeRoomId, 'Total tables:', tables.length);

  const currentTables = tables
    .filter(t => t.room_id === activeRoomId)
    // Deduplicate first - keep only the first occurrence of each ID
    .filter((t, index, self) => self.findIndex(t2 => t2.id === t.id) === index)
    .filter(t => {
      // Hide tables that are merged into another table
      // A table is hidden if its ID appears in another table's merged_with array
      const isMergedIntoAnother = tables.some(other => {
        if (other.merged_with && other.merged_with.length > 0) {
          // Convert both to numbers for comparison (in case of type mismatch)
          const mergedIds = other.merged_with.map(id => Number(id));
          const tableId = Number(t.id);
          const isIncluded = mergedIds.includes(tableId);

          if (isIncluded) {
            console.log(`Table ${t.name} (ID: ${tableId}) is merged into table ${other.name} (merged_with: [${mergedIds}]) - WILL BE HIDDEN`);
          }

          return isIncluded;
        }
        return false;
      });

      if (isMergedIntoAnother) {
        console.log(`❌ HIDING Table ${t.name} (ID: ${t.id}) because it's merged into another table`);
      } else if (t.merged_with && t.merged_with.length > 0) {
        console.log(`✅ SHOWING Table ${t.name} (ID: ${t.id}) - this is the PRIMARY merged table with merged_with: [${t.merged_with}]`);
      }

      return !isMergedIntoAnother;
    });

  // Debug: Log final filtered tables
  useEffect(() => {
    console.log('📋 FINAL currentTables after filtering:', currentTables.map(t => `${t.name} (ID: ${t.id})`));
  }, [currentTables, activeRoomId]);

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

    // Handle multi-select
    if (e.ctrlKey || e.metaKey || isSelectionMode) {
        setSelectedTables(prev => prev.includes(tableId) ? prev.filter(id => id !== tableId) : [...prev, tableId]);
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

    // Calculate delta from start position
    const deltaX = e.clientX - dragState.startX;
    const deltaY = e.clientY - dragState.startY;

    // Apply CSS transform for smooth visual dragging (no React re-render)
    draggedElementRef.current.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    draggedElementRef.current.style.zIndex = '100';

    // Update current position in ref
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
    const deltaX = touch.clientX - dragState.startX;
    const deltaY = touch.clientY - dragState.startY;

    // Apply CSS transform for smooth visual dragging
    draggedElementRef.current.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    draggedElementRef.current.style.zIndex = '100';

    // Update current position in ref
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
          alert("Devi mantenere almeno una sala attiva.");
          return;
      }
      const roomTables = tables.filter(t => t.room_id === room_id);
      if (roomTables.length > 0) {
          alert("Non puoi eliminare una sala che contiene dei tavoli. Rimuovi prima i tavoli.");
          return;
      }
      if (confirm(`Sei sicuro di voler eliminare la sala "${rooms.find(r => r.id === room_id)?.name}"?`)) {
          onDeleteRoom(room_id);
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

    const baseClasses = `absolute flex flex-col items-center justify-center border-2 shadow-sm transition-shadow select-none ${statusColors[dynamicStatus]} ${isSelected ? 'ring-4 ring-indigo-400/50 ring-offset-1 border-indigo-500' : ''} ${table.is_locked || timerDisplay ? 'cursor-not-allowed opacity-90' : 'cursor-grab active:cursor-grabbing hover:shadow-md'}`;

    // Responsive table sizes - smaller on mobile (< 640px like ReservationList)
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
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

  const singleSelectedTable = selectedTables.length === 1 ? tables.find(t => t.id === selectedTables[0]) : null;

  return (
    <div
      className="flex flex-col h-[calc(100vh-64px)] p-4 gap-4"
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Toolbar */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-4 z-20">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide flex-1 min-w-0 pb-1">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => {
                  setActiveRoomId(room.id);
                  setSelectedTables([]);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap border flex items-center gap-2 flex-shrink-0 ${
                  activeRoomId === room.id
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-200'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border-slate-200'
              }`}
            >
              {room.name}
            </button>
          ))}
          
          {/* Add Room UI */}
          {isAddingRoom ? (
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
          )}
        </div>

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

        {selectedTables.length > 0 && (
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

            {selectedTables.length > 1 && !selectedTables.some(id => tables.find(t => t.id === id)?.is_locked) && (
                <button 
                    onClick={() => {
                        onMergeTables(selectedTables);
                        setSelectedTables([]);
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 font-medium text-sm"
                >
                <Combine size={16} /> Unisci
                </button>
            )}
            
            {selectedTables.length === 1 && singleSelectedTable?.merged_with && singleSelectedTable.merged_with.length > 0 && !singleSelectedTable?.is_locked && (
                <button
                    onClick={() => {
                        onSplitTable(selectedTables[0]);
                        setSelectedTables([]);
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
          {currentTables.map(renderTableShape)}
          
          {currentTables.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 pointer-events-none">
                  <p>Trascina o aggiungi tavoli in questa sala</p>
              </div>
          )}
          
          {isSelectionMode && (
              <div className="absolute top-4 left-4 bg-indigo-600 text-white px-3 py-1 rounded-full text-xs font-medium shadow-lg pointer-events-none flex items-center gap-2">
                  <CheckSquare size={12} /> MODALITÀ SELEZIONE ATTIVA
              </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur p-3 rounded-xl shadow-sm border border-slate-200 text-xs space-y-2 pointer-events-none select-none z-10">
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
      </div>
    </div>
  );
};