

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Dish, BanquetMenu, BanquetCourse, Shift, COMMON_ALLERGENS, Customer, Table, Reservation, ArrivalStatus, Room } from '../types';
import { Plus, Search, Tag, Leaf, Trash2, Edit2, Utensils, BookOpen, Check, Calendar, List as ListIcon, ChevronLeft, ChevronRight, Printer, ImageIcon, X, Sun, Sunset, Users, StickyNote, Eye, BookUser, Phone, Mail, Upload, Loader2, Wallet, MoreHorizontal } from 'lucide-react';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { printBanquet } from '../utils/printBanquet';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { BanquetCompositionModal } from './BanquetCompositionModal';
import { BanquetPaymentsModal } from './BanquetPaymentsModal';
import { DishDetailModal } from './DishDetailModal';
import { CustomerPickerModal } from './CustomerPickerModal';
import { getCustomers } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';

const BANQUET_DISH_CATEGORIES = ['Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Bevande'] as const;

const ITALIAN_MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const ITALIAN_WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

const formatLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

type BanquetTimeStatus = 'PAST' | 'UPCOMING';

const computeBanquetTimeStatus = (menu: BanquetMenu): BanquetTimeStatus => {
    if (!menu.event_date) return 'UPCOMING';
    const today = formatLocalDate(new Date());
    return menu.event_date < today ? 'PAST' : 'UPCOMING';
};

type BanquetPaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

const computeBanquetPaymentStatus = (menu: BanquetMenu): BanquetPaymentStatus => {
    const paid = Number(menu.total_paid || 0);
    const guests = Number(menu.guests || 0);
    const price = Number(menu.price_per_person || 0);
    const due = guests > 0 && price > 0 ? guests * price : 0;
    if (paid <= 0) return 'UNPAID';
    if (due > 0 && paid + 0.005 >= due) return 'PAID';
    return 'PARTIAL';
};

interface MenuManagerProps {
  dishes: Dish[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  reservations: Reservation[];
  onAddDish: (dish: Omit<Dish, 'id'>) => void;
  onUpdateDish: (id: number, dish: Partial<Dish>) => void;
  onDeleteDish: (id: number) => void;
  onAddBanquetMenu: (menu: Omit<BanquetMenu, 'id'>) => void;
  onUpdateBanquetMenu: (id: number, menu: Partial<BanquetMenu>) => void;
  onDeleteBanquetMenu: (id: number) => void;
  canEdit?: boolean;
  initialTab?: 'DISHES' | 'BANQUETS';
  autoOpenNewBanquet?: boolean;
  onAutoOpenNewBanquetHandled?: () => void;
  autoOpenNewDish?: boolean;
  onAutoOpenNewDishHandled?: () => void;
  onActiveTabChange?: (tab: 'DISHES' | 'BANQUETS') => void;
}

export const MenuManager: React.FC<MenuManagerProps> = ({
    dishes,
    banquetMenus,
    tables,
    rooms,
    reservations,
    onAddDish,
    onUpdateDish,
    onDeleteDish,
    onAddBanquetMenu,
    onUpdateBanquetMenu,
    onDeleteBanquetMenu,
    canEdit = true,
    initialTab = 'BANQUETS',
    autoOpenNewBanquet,
    onAutoOpenNewBanquetHandled,
    autoOpenNewDish,
    onAutoOpenNewDishHandled,
    onActiveTabChange
}) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const canManageBanquetPayments = hasPermission('banquet:manage_payments');
  const [activeTab, setActiveTab] = useState<'DISHES' | 'BANQUETS'>(initialTab);
  const [banquetView, setBanquetView] = useState<'LIST' | 'CALENDAR'>('LIST');
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isDishFormOpen, setIsDishFormOpen] = useState(false);
  const [isBanquetFormOpen, setIsBanquetFormOpen] = useState(false);
  const [isEditingDish, setIsEditingDish] = useState(false);
  const [isEditingBanquet, setIsEditingBanquet] = useState(false);
  const [editingDishId, setEditingDishId] = useState<number | null>(null);
  const [editingBanquetId, setEditingBanquetId] = useState<number | null>(null);
  const [deleteDishConfirm, setDeleteDishConfirm] = useState<Dish | null>(null);
  const [deleteBanquetConfirm, setDeleteBanquetConfirm] = useState<BanquetMenu | null>(null);
  const [viewBanquet, setViewBanquet] = useState<BanquetMenu | null>(null);
  const [paymentsBanquet, setPaymentsBanquet] = useState<BanquetMenu | null>(null);
  const [viewDish, setViewDish] = useState<Dish | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  const photoFileInputRef = useRef<HTMLInputElement>(null);

  // New Dish State
  const [newDish, setNewDish] = useState<Partial<Dish>>({
    name: '',
    description: '',
    price: 0,
    category: 'Antipasti',
    allergens: [],
    photo_url: ''
  });

  // New Banquet Menu State
  const [newBanquet, setNewBanquet] = useState<Partial<BanquetMenu>>({
      name: '',
      description: '',
      price_per_person: 0,
      dish_ids: [],
      courses: [],
      event_date: '',
      shift: undefined,
      deposit_amount: undefined,
      guests: undefined,
      customer_id: null,
      notes_courses: '',
      notes_service: '',
      notes_mise_en_place: '',
      table_ids: []
  });

  // Customer picker (rubrica) state for banquet form
  const [isBanquetCustomerPickerOpen, setIsBanquetCustomerPickerOpen] = useState(false);
  const [selectedBanquetCustomer, setSelectedBanquetCustomer] = useState<Customer | null>(null);

  // Banquet form validation errors
  const [banquetFormErrors, setBanquetFormErrors] = useState<string[]>([]);
  const [isSavingBanquet, setIsSavingBanquet] = useState(false);
  const [isSavingDish, setIsSavingDish] = useState(false);
  const [tablePickerRoomFilter, setTablePickerRoomFilter] = useState<number | 'ALL'>('ALL');
  const [cardMenuOpenId, setCardMenuOpenId] = useState<number | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onActiveTabChange?.(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (autoOpenNewBanquet) {
      handleOpenNewBanquet();
      onAutoOpenNewBanquetHandled?.();
    }
  }, [autoOpenNewBanquet]);

  useEffect(() => {
    if (autoOpenNewDish) {
      setIsDishFormOpen(true);
      onAutoOpenNewDishHandled?.();
    }
  }, [autoOpenNewDish]);

  useEffect(() => {
    if (cardMenuOpenId === null) return;
    const handler = (e: MouseEvent) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
        setCardMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [cardMenuOpenId]);

  // Load the selected customer when editing a banquet that has customer_id
  useEffect(() => {
    if (!isBanquetFormOpen) return;
    const id = newBanquet.customer_id;
    if (!id) {
      setSelectedBanquetCustomer(null);
      return;
    }
    if (selectedBanquetCustomer?.id === id) return;
    let cancelled = false;
    getCustomers()
      .then(list => {
        if (cancelled) return;
        const found = list.find(c => c.id === id) || null;
        setSelectedBanquetCustomer(found);
      })
      .catch(() => { if (!cancelled) setSelectedBanquetCustomer(null); });
    return () => { cancelled = true; };
  }, [isBanquetFormOpen, newBanquet.customer_id, selectedBanquetCustomer?.id]);

  const handleAddDishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDish.name || !newDish.price) return;
    if (isSavingDish) return;

    try {
      setIsSavingDish(true);
      if (isEditingDish && editingDishId !== null) {
        await onUpdateDish(editingDishId, {
          name: newDish.name!,
          description: newDish.description || '',
          price: Number(newDish.price),
          category: newDish.category || 'Antipasti',
          allergens: newDish.allergens || [],
          photo_url: newDish.photo_url?.trim() || undefined
        });
      } else {
        await onAddDish({
          name: newDish.name!,
          description: newDish.description || '',
          price: Number(newDish.price),
          category: newDish.category || 'Antipasti',
          allergens: newDish.allergens || [],
          photo_url: newDish.photo_url?.trim() || undefined
        } as Dish);
      }

      setIsDishFormOpen(false);
      setIsEditingDish(false);
      setEditingDishId(null);
      setNewDish({ name: '', description: '', price: 0, category: 'Antipasti', allergens: [], photo_url: '' });
    } finally {
      setIsSavingDish(false);
    }
  };

  const handleEditDish = (dish: Dish) => {
    setNewDish({
      name: dish.name,
      description: dish.description,
      price: dish.price,
      category: dish.category,
      allergens: dish.allergens,
      photo_url: dish.photo_url || ''
    });
    setEditingDishId(dish.id);
    setIsEditingDish(true);
    setIsDishFormOpen(true);
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploadError(null);
    setPhotoUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 800, 0.8);
      setNewDish(prev => ({ ...prev, photo_url: dataUrl }));
    } catch (err: any) {
      setPhotoUploadError(err?.message || 'Caricamento fallito');
    } finally {
      setPhotoUploading(false);
      if (photoFileInputRef.current) photoFileInputRef.current.value = '';
    }
  };

  const handleAddBanquetSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (isSavingBanquet) return;

      const missing: string[] = [];
      if (!newBanquet.name || !newBanquet.name.trim()) missing.push('Nome Menu');
      if (!newBanquet.event_date) missing.push('Data Evento');
      if (canViewBanquetPrice && (newBanquet.price_per_person == null || isNaN(Number(newBanquet.price_per_person)) || Number(newBanquet.price_per_person) <= 0)) {
        missing.push('Prezzo per Persona');
      }

      if (missing.length > 0) {
        setBanquetFormErrors(missing);
        return;
      }
      setBanquetFormErrors([]);

      const courses = (newBanquet.courses || []).filter(c => c.name.trim() !== '');
      const flatDishIds = courses.flatMap(c => c.dish_ids);

      const payload = {
          name: newBanquet.name!,
          description: newBanquet.description || '',
          price_per_person: Number(newBanquet.price_per_person),
          dish_ids: flatDishIds,
          courses,
          event_date: newBanquet.event_date!,
          shift: newBanquet.shift,
          deposit_amount: newBanquet.deposit_amount != null && newBanquet.deposit_amount !== ('' as any)
              ? Number(newBanquet.deposit_amount)
              : undefined,
          guests: newBanquet.guests != null && newBanquet.guests !== ('' as any)
              ? Number(newBanquet.guests)
              : undefined,
          customer_id: newBanquet.customer_id ?? null,
          notes_courses: newBanquet.notes_courses?.trim() || undefined,
          notes_service: newBanquet.notes_service?.trim() || undefined,
          notes_mise_en_place: newBanquet.notes_mise_en_place?.trim() || undefined,
          table_ids: Array.isArray(newBanquet.table_ids) ? newBanquet.table_ids : []
      };

      try {
        setIsSavingBanquet(true);
        if (isEditingBanquet && editingBanquetId !== null) {
          await onUpdateBanquetMenu(editingBanquetId, payload);
        } else {
          await onAddBanquetMenu(payload as BanquetMenu);
        }

        setIsBanquetFormOpen(false);
        setIsEditingBanquet(false);
        setEditingBanquetId(null);
        setSelectedBanquetCustomer(null);
        setNewBanquet({ name: '', description: '', price_per_person: 0, dish_ids: [], courses: [], event_date: '', shift: undefined, deposit_amount: undefined, guests: undefined, customer_id: null, notes_courses: '', notes_service: '', notes_mise_en_place: '', table_ids: [] });
      } catch (err: any) {
        const msg = err?.message || 'Errore durante il salvataggio';
        const isConflict = err?.status === 409 || /tavolo/i.test(msg);
        setBanquetFormErrors([isConflict ? `Conflitto tavoli: ${msg}` : msg]);
      } finally {
        setIsSavingBanquet(false);
      }
  };

  const handleEditBanquet = (menu: BanquetMenu) => {
    // Derive courses: use stored courses if present, otherwise wrap legacy flat list into a single course
    const courses: BanquetCourse[] = menu.courses && menu.courses.length > 0
      ? menu.courses.map(c => ({ name: c.name, dish_ids: [...(c.dish_ids || [])], notes: c.notes || '' }))
      : (menu.dish_ids && menu.dish_ids.length > 0
          ? [{ name: 'Composizione', dish_ids: [...menu.dish_ids] }]
          : []);
    setNewBanquet({
      name: menu.name,
      description: menu.description,
      price_per_person: menu.price_per_person,
      dish_ids: menu.dish_ids,
      courses,
      event_date: menu.event_date || '',
      shift: menu.shift,
      deposit_amount: menu.deposit_amount != null ? Number(menu.deposit_amount) : undefined,
      guests: menu.guests != null ? Number(menu.guests) : undefined,
      customer_id: menu.customer_id ?? null,
      notes_courses: menu.notes_courses || '',
      notes_service: menu.notes_service || '',
      notes_mise_en_place: menu.notes_mise_en_place || '',
      table_ids: Array.isArray(menu.table_ids) ? [...menu.table_ids] : []
    });
    setSelectedBanquetCustomer(null);
    setBanquetFormErrors([]);
    setEditingBanquetId(menu.id);
    setIsEditingBanquet(true);
    setIsBanquetFormOpen(true);
  };

  const handleOpenNewBanquet = () => {
    setIsEditingBanquet(false);
    setEditingBanquetId(null);
    setSelectedBanquetCustomer(null);
    setBanquetFormErrors([]);
    setNewBanquet({
      name: '', description: '', price_per_person: 0,
      dish_ids: [],
      courses: [{ name: '1ª Uscita', dish_ids: [] }],
      event_date: '', shift: undefined, deposit_amount: undefined,
      guests: undefined,
      customer_id: null,
      notes_courses: '', notes_service: '', notes_mise_en_place: '',
      table_ids: []
    });
    setIsBanquetFormOpen(true);
  };

  const closeBanquetForm = () => {
    setIsBanquetFormOpen(false);
    setBanquetFormErrors([]);
  };

  const banquetFieldHasError = (field: string) => banquetFormErrors.includes(field);

  const addCourse = () => {
    setNewBanquet(prev => {
      const courses = prev.courses ? [...prev.courses] : [];
      const ordinals = ['1ª', '2ª', '3ª', '4ª', '5ª', '6ª', '7ª', '8ª', '9ª', '10ª'];
      const next = ordinals[courses.length] || `${courses.length + 1}ª`;
      courses.push({ name: `${next} Uscita`, dish_ids: [] });
      return { ...prev, courses };
    });
  };

  const removeCourse = (index: number) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).filter((_, i) => i !== index);
      return { ...prev, courses };
    });
  };

  const renameCourse = (index: number, name: string) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => i === index ? { ...c, name } : c);
      return { ...prev, courses };
    });
  };

  const setCourseNotes = (index: number, notes: string) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => i === index ? { ...c, notes } : c);
      return { ...prev, courses };
    });
  };

  const toggleDishInCourse = (courseIndex: number, dishId: number) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => {
        if (i !== courseIndex) return c;
        const has = c.dish_ids.includes(dishId);
        return { ...c, dish_ids: has ? c.dish_ids.filter(id => id !== dishId) : [...c.dish_ids, dishId] };
      });
      return { ...prev, courses };
    });
  };

  const moveCourse = (index: number, direction: -1 | 1) => {
    setNewBanquet(prev => {
      const courses = [...(prev.courses || [])];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= courses.length) return prev;
      [courses[index], courses[newIndex]] = [courses[newIndex], courses[index]];
      return { ...prev, courses };
    });
  };

  const toggleAllergen = (allergen: string) => {
    setNewDish(prev => {
        const current = prev.allergens || [];
        if (current.includes(allergen)) {
            return { ...prev, allergens: current.filter(a => a !== allergen) };
        } else {
            return { ...prev, allergens: [...current, allergen] };
        }
    });
  };

  const dishCategories = useMemo(() => {
    const order = ['antipasti', 'primi', 'secondi', 'contorni', 'dolci'];
    const set = new Set<string>();
    for (const d of dishes) {
      if (d.category && d.category.trim()) set.add(d.category.trim());
    }
    return Array.from(set).sort((a, b) => {
      const ai = order.indexOf(a.toLowerCase());
      const bi = order.indexOf(b.toLowerCase());
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b, 'it');
    });
  }, [dishes]);

  // Map of tableId -> occupancy info for the currently selected event_date+shift
  // (excluding the banquet being edited). Used by the table picker in the form.
  const tableOccupancyMap = useMemo(() => {
    const map = new Map<number, { source: 'reservation' | 'banquet'; label: string }>();
    const date = newBanquet.event_date;
    const shift = newBanquet.shift;
    if (!date || !shift) return map;

    for (const r of reservations) {
      if (!r.table_id) continue;
      if (r.shift !== shift) continue;
      if ((r.arrival_status || ArrivalStatus.WAITING) === ArrivalStatus.DEPARTED) continue;
      const resDate = (r.reservation_time || '').slice(0, 10);
      if (resDate !== date) continue;
      if (!map.has(r.table_id)) {
        map.set(r.table_id, { source: 'reservation', label: r.customer_name });
      }
    }

    for (const b of banquetMenus) {
      if (editingBanquetId !== null && b.id === editingBanquetId) continue;
      if (b.event_date !== date) continue;
      if (b.shift !== shift) continue;
      const ids = Array.isArray(b.table_ids) ? b.table_ids : [];
      for (const tid of ids) {
        if (!map.has(tid)) {
          map.set(tid, { source: 'banquet', label: b.name });
        }
      }
    }

    return map;
  }, [newBanquet.event_date, newBanquet.shift, reservations, banquetMenus, editingBanquetId]);

  const filteredDishes = dishes.filter(d => {
    const matchesSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || d.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      {/* Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-6">
        <div className="flex gap-2 overflow-x-auto scrollbar-hide">
          <button
              onClick={() => setActiveTab('BANQUETS')}
              className={`px-4 py-2.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${activeTab === 'BANQUETS' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
          >
              Menu Banchetti
          </button>
          <button
              onClick={() => setActiveTab('DISHES')}
              className={`px-4 py-2.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${activeTab === 'DISHES' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
          >
              Piatti alla Carta
          </button>
        </div>
        {activeTab === 'BANQUETS' && (
          <div className="inline-flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5 self-start sm:self-auto flex-shrink-0">
            <button
              onClick={() => setBanquetView('LIST')}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${banquetView === 'LIST' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
            >
              <ListIcon className="h-4 w-4" /> Lista
            </button>
            <button
              onClick={() => setBanquetView('CALENDAR')}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${banquetView === 'CALENDAR' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
            >
              <Calendar className="h-4 w-4" /> Calendario
            </button>
          </div>
        )}
      </div>

      {activeTab === 'DISHES' && (
          <>
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-6">
              {dishCategories.length > 0 && (
                <div className="flex flex-wrap gap-2 flex-1">
                  <button
                    type="button"
                    onClick={() => setCategoryFilter(null)}
                    className={`px-4 py-2.5 rounded-full text-sm font-medium border transition ${
                      categoryFilter === null
                        ? 'bg-[var(--color-fg)] text-white border-[var(--color-fg)]'
                        : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    Tutte ({dishes.length})
                  </button>
                  {dishCategories.map(cat => {
                    const count = dishes.filter(d => d.category === cat).length;
                    const isActive = categoryFilter === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(isActive ? null : cat)}
                        className={`px-4 py-2.5 rounded-full text-sm font-medium border transition ${
                          isActive
                            ? 'bg-[var(--color-fg)] text-white border-[var(--color-fg)]'
                            : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {cat} ({count})
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="relative h-10 md:w-72 md:flex-shrink-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)]" />
                <input
                  type="search"
                  placeholder="Cerca piatto per nome o categoria..."
                  className="w-full h-full pl-9 pr-9 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:border-[var(--color-fg)] transition-colors"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                    aria-label="Cancella ricerca"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Dish List */}
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[640px]">
                <thead className="bg-[var(--color-surface-3)] border-b border-[var(--color-line)]">
                    <tr>
                    <th className="px-4 py-3 text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] w-16">Foto</th>
                    <th className="px-6 py-3 text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Nome Piatto</th>
                    <th className="px-6 py-3 text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Categoria</th>
                    <th className="px-6 py-3 text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Prezzo</th>
                    <th className="px-6 py-3 text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Allergeni</th>
                    <th className="px-6 py-3 text-right text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Azioni</th>
                    </tr>
                </thead>
                <tbody>
                    {filteredDishes.map((dish) => (
                    <tr key={dish.id} className="border-b border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] transition">
                        <td className="px-4 py-3">
                        {dish.photo_url ? (
                            <img
                                src={dish.photo_url}
                                alt={dish.name}
                                className="w-10 h-10 rounded-md object-cover border border-[var(--color-line)]"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                            />
                        ) : (
                            <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] border border-[var(--color-line)] flex items-center justify-center">
                                <ImageIcon className="h-4 w-4 text-[var(--color-fg-subtle)]" />
                            </div>
                        )}
                        </td>
                        <td className="px-6 py-3">
                        <div className="font-medium text-[var(--color-fg)]">{dish.name}</div>
                        <div className="text-xs text-[var(--color-fg-muted)] truncate max-w-xs">{dish.description}</div>
                        </td>
                        <td className="px-6 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]">
                            {dish.category}
                        </span>
                        </td>
                        <td className="px-6 py-3 text-sm font-medium text-[var(--color-fg)]">
                        € {Number(dish.price).toFixed(2)}
                        </td>
                        <td className="px-6 py-3">
                        <div className="flex flex-wrap gap-1">
                            {dish.allergens.length > 0 ? dish.allergens.map(a => (
                                <span key={a} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-50 text-rose-700 border border-rose-100">
                                    {a}
                                </span>
                            )) : <span className="text-xs text-[var(--color-fg-subtle)]">-</span>}
                        </div>
                        </td>
                        <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                            <button
                                onClick={() => setViewDish(dish)}
                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                                title="Visualizza piatto"
                            >
                                <Eye className="h-4 w-4" />
                            </button>
                            {canEdit && (
                            <>
                            <button
                                onClick={() => handleEditDish(dish)}
                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                                title="Modifica"
                            >
                                <Edit2 className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => setDeleteDishConfirm(dish)}
                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600"
                                title="Elimina"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                            </>
                            )}
                        </div>
                        </td>
                    </tr>
                    ))}
                </tbody>
                </table>
              </div>
            </div>
          </>
      )}

      {activeTab === 'BANQUETS' && (
        <div className="space-y-6">
          {banquetView === 'LIST' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {banquetMenus.map(menu => {
                const timeStatus = computeBanquetTimeStatus(menu);
                const cardAccent = timeStatus === 'PAST'
                  ? 'border-l-4 border-l-slate-300 bg-slate-50/40'
                  : 'border-l-4 border-l-emerald-400 bg-emerald-50/30';
                return (
                  <div key={menu.id} className={`rounded-lg border border-[var(--color-line)] flex flex-col hover:shadow-[var(--shadow-sm)] transition-shadow ${cardAccent}`}>
                      <div className="p-4 flex-1">
                          <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="min-w-0">
                                  <h3 className="font-semibold text-[15px] text-[var(--color-fg)] leading-tight truncate">{menu.name}</h3>
                                  {menu.description && (
                                    <p className="text-xs text-[var(--color-fg-muted)] line-clamp-1 mt-0.5">{menu.description}</p>
                                  )}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                  <button
                                      onClick={() => setViewBanquet(menu)}
                                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                                      title="Visualizza piatti"
                                  >
                                      <Eye className="h-4 w-4" />
                                  </button>
                                  {canManageBanquetPayments && (
                                  <button
                                      onClick={() => setPaymentsBanquet(menu)}
                                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-emerald-50 hover:text-emerald-600"
                                      title="Pagamenti"
                                  >
                                      <Wallet className="h-4 w-4" />
                                  </button>
                                  )}
                                  {canEdit && (
                                  <div className="relative">
                                      <button
                                          type="button"
                                          onClick={() => setCardMenuOpenId(cardMenuOpenId === menu.id ? null : menu.id)}
                                          className="p-1.5 rounded-md text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                          aria-label="Altre azioni"
                                      >
                                          <MoreHorizontal className="h-4 w-4" />
                                      </button>
                                      {cardMenuOpenId === menu.id && (
                                          <div
                                              ref={cardMenuRef}
                                              className="absolute right-0 top-full mt-1 w-40 bg-[var(--color-surface)] rounded-lg shadow-[var(--shadow-overlay)] border border-[var(--color-line)] py-1 z-30 animate-in fade-in slide-in-from-top-1 duration-100"
                                          >
                                              <button
                                                  type="button"
                                                  onClick={() => { setCardMenuOpenId(null); printBanquet(menu, dishes, { showPrice: canViewBanquetPrice }); }}
                                                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                              >
                                                  <Printer className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                                                  Stampa / PDF
                                              </button>
                                              <button
                                                  type="button"
                                                  onClick={() => { setCardMenuOpenId(null); handleEditBanquet(menu); }}
                                                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                              >
                                                  <Edit2 className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                                                  Modifica
                                              </button>
                                              <button
                                                  type="button"
                                                  onClick={() => { setCardMenuOpenId(null); setDeleteBanquetConfirm(menu); }}
                                                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors"
                                              >
                                                  <Trash2 className="h-3.5 w-3.5" />
                                                  Elimina
                                              </button>
                                          </div>
                                      )}
                                  </div>
                                  )}
                              </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mb-2">
                              {menu.event_date && (
                                <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] bg-[var(--color-surface-3)] border border-[var(--color-line)] px-2 py-0.5 rounded-full">
                                  <Calendar className="h-3 w-3" />
                                  {new Date(menu.event_date + 'T00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                                </div>
                              )}
                              {menu.shift === Shift.LUNCH && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">
                                  <Sun className="h-3 w-3" /> Pranzo
                                </span>
                              )}
                              {menu.shift === Shift.DINNER && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 px-2 py-0.5 rounded-full">
                                  <Sunset className="h-3 w-3" /> Cena
                                </span>
                              )}
                              {canManageBanquetPayments && (() => {
                                const status = computeBanquetPaymentStatus(menu);
                                if (status === 'PAID') return (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-0.5 rounded-full">
                                    <Check className="h-3 w-3" /> Pagato
                                  </span>
                                );
                                if (status === 'PARTIAL') return (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">
                                    <Wallet className="h-3 w-3" /> Acconto
                                  </span>
                                );
                                return (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-100 px-2 py-0.5 rounded-full">
                                    <Wallet className="h-3 w-3" /> Da pagare
                                  </span>
                                );
                              })()}
                              {canViewBanquetPrice && (
                                <span className="inline-flex items-center text-[11px] font-semibold text-[var(--color-fg)] bg-[var(--color-surface-3)] border border-[var(--color-line)] px-2 py-0.5 rounded-full">
                                  €{menu.price_per_person}/pax
                                </span>
                              )}
                          </div>
                          <div className="text-xs text-[var(--color-fg-muted)]">
                              {menu.courses && menu.courses.length > 0 ? (
                                <span>{menu.courses.length} portate · {menu.courses.reduce((sum, c) => sum + c.dish_ids.length, 0)} piatti</span>
                              ) : (
                                <span>{menu.dish_ids.length} piatti</span>
                              )}
                              {canViewBanquetPrice && menu.deposit_amount != null && Number(menu.deposit_amount) > 0 && (
                                <span> · Acconto €{Number(menu.deposit_amount).toFixed(2)}</span>
                              )}
                          </div>
                      </div>
                  </div>
                );
              })}
              {banquetMenus.length === 0 && (
                  <div className="col-span-full text-center py-12 text-[var(--color-fg-muted)]">
                      Non hai ancora creato menu per banchetti.
                  </div>
              )}
          </div>
          )}

          {banquetView === 'CALENDAR' && (
            <BanquetCalendar
              banquetMenus={banquetMenus}
              onSelectBanquet={handleEditBanquet}
              onViewBanquet={setViewBanquet}
              canEdit={canEdit}
            />
          )}
        </div>
      )}

      {/* Add Dish Modal */}
      {isDishFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) setIsDishFormOpen(false); }}>
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-3.5 border-b border-[var(--color-line)] flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{isEditingDish ? 'Modifica Piatto' : 'Aggiungi Nuovo Piatto'}</h2>
              <button type="button" onClick={() => setIsDishFormOpen(false)} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]" aria-label="Chiudi">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleAddDishSubmit} className="px-5 py-4 space-y-4 overflow-y-auto">
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome</label>
                <input 
                  required
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  value={newDish.name}
                  onChange={e => setNewDish({...newDish, name: e.target.value})}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Prezzo (€)</label>
                  <input 
                    type="number"
                    step="0.5"
                    required
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    value={newDish.price}
                    onChange={e => setNewDish({...newDish, price: parseFloat(e.target.value)})}
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Categoria</label>
                  <select 
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    value={newDish.category}
                    onChange={e => setNewDish({...newDish, category: e.target.value})}
                  >
                    <option>Antipasti</option>
                    <option>Primi</option>
                    <option>Secondi</option>
                    <option>Contorni</option>
                    <option>Dolci</option>
                    <option>Bevande</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Descrizione</label>
                <textarea
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20"
                  value={newDish.description}
                  onChange={e => setNewDish({...newDish, description: e.target.value})}
                />
              </div>

              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Foto <span className="text-[var(--color-fg-subtle)] font-normal normal-case tracking-normal">— opzionale</span></label>
                <div className="flex gap-3 items-start">
                  <div className="flex-1 flex flex-col gap-2">
                    <input
                      type="url"
                      placeholder="https://... oppure carica un file"
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                      value={newDish.photo_url?.startsWith('data:') ? '' : (newDish.photo_url || '')}
                      onChange={e => setNewDish({...newDish, photo_url: e.target.value})}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={photoFileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={handlePhotoFileChange}
                      />
                      <button
                        type="button"
                        onClick={() => photoFileInputRef.current?.click()}
                        disabled={photoUploading}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] disabled:opacity-60 disabled:cursor-wait"
                      >
                        {photoUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {photoUploading ? 'Elaborazione…' : 'Carica foto'}
                      </button>
                      {newDish.photo_url && (
                        <button
                          type="button"
                          onClick={() => setNewDish({...newDish, photo_url: ''})}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                        >
                          <X className="h-3.5 w-3.5" />
                          Rimuovi
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--color-fg-subtle)] leading-snug">
                      JPG, PNG o WebP — viene ridimensionata automaticamente a max 800×800px (~150–200 KB), ottimizzata per il web.
                    </p>
                    {photoUploadError && (
                      <p className="text-[11px] text-rose-600">{photoUploadError}</p>
                    )}
                  </div>
                  {newDish.photo_url ? (
                    <img
                      src={newDish.photo_url}
                      alt="Anteprima"
                      className="w-16 h-16 rounded-lg object-cover border border-[var(--color-line)] flex-shrink-0"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-[var(--color-surface-3)] border border-[var(--color-line)] flex items-center justify-center flex-shrink-0">
                      <ImageIcon className="h-6 w-6 text-[var(--color-fg-subtle)]" />
                    </div>
                  )}
                </div>
              </div>

              <div>
                 <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-2">Allergeni</label>
                 <div className="flex flex-wrap gap-2">
                    {COMMON_ALLERGENS.map(allergen => {
                        const isSelected = newDish.allergens?.includes(allergen);
                        return (
                            <button
                                key={allergen}
                                type="button"
                                onClick={() => toggleAllergen(allergen)}
                                className={`px-3 py-1 rounded-full text-xs font-medium border transition flex items-center gap-1 ${
                                    isSelected
                                    ? 'bg-rose-50 border-rose-100 text-rose-700'
                                    : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                                }`}
                            >
                                {isSelected && <Check size={12} />}
                                {allergen}
                            </button>
                        )
                    })}
                 </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end pt-4 border-t border-[var(--color-line)]">
                <button
                  type="button"
                  onClick={() => setIsDishFormOpen(false)}
                  className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={isSavingDish}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSavingDish && <Loader2 className="h-4 w-4 animate-spin" />}
                  Salva Piatto
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Banquet Modal */}
      {isBanquetFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-stretch justify-center z-50 p-2 sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) closeBanquetForm(); }}>
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-none overflow-hidden flex flex-col h-full">
            <div className="px-5 py-3.5 border-b border-[var(--color-line)] flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{isEditingBanquet ? 'Modifica Menu Banchetto' : 'Crea Menu Banchetto'}</h2>
              <button onClick={closeBanquetForm} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleAddBanquetSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome Menu <span className="text-rose-500">*</span></label>
                    <input
                        required
                        placeholder="es. Menu Matrimonio Gold"
                        className={`w-full bg-[var(--color-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                          banquetFieldHasError('Nome Menu')
                            ? 'border-rose-400 focus:border-rose-500'
                            : 'border-[var(--color-line)] focus:border-[var(--color-fg)]'
                        }`}
                        value={newBanquet.name}
                        onChange={e => {
                          setNewBanquet({...newBanquet, name: e.target.value});
                          if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Nome Menu'));
                        }}
                    />
                </div>
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Data Evento <span className="text-rose-500">*</span></label>
                    <input
                        type="date"
                        required
                        className={`w-full bg-[var(--color-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                          banquetFieldHasError('Data Evento')
                            ? 'border-rose-400 focus:border-rose-500'
                            : 'border-[var(--color-line)] focus:border-[var(--color-fg)]'
                        }`}
                        value={newBanquet.event_date || ''}
                        onChange={e => {
                          setNewBanquet({...newBanquet, event_date: e.target.value});
                          if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Data Evento'));
                        }}
                    />
                </div>
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Turno</label>
                    <div className="inline-flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5">
                        <button
                            type="button"
                            onClick={() => setNewBanquet({...newBanquet, shift: Shift.LUNCH})}
                            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                newBanquet.shift === Shift.LUNCH
                                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                            }`}
                        >
                            <Sun className="h-4 w-4" /> Pranzo
                        </button>
                        <button
                            type="button"
                            onClick={() => setNewBanquet({...newBanquet, shift: Shift.DINNER})}
                            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                newBanquet.shift === Shift.DINNER
                                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                            }`}
                        >
                            <Sunset className="h-4 w-4" /> Cena
                        </button>
                    </div>
                </div>
                {canViewBanquetPrice && (
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Prezzo per Persona (€) <span className="text-rose-500">*</span></label>
                    <input
                        type="number"
                        required
                        min="0"
                        step="0.01"
                        className={`w-full bg-[var(--color-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                          banquetFieldHasError('Prezzo per Persona')
                            ? 'border-rose-400 focus:border-rose-500'
                            : 'border-[var(--color-line)] focus:border-[var(--color-fg)]'
                        }`}
                        value={newBanquet.price_per_person}
                        onChange={e => {
                          setNewBanquet({...newBanquet, price_per_person: parseFloat(e.target.value)});
                          if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Prezzo per Persona'));
                        }}
                    />
                </div>
                )}
                {canViewBanquetPrice && (
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Acconto (€) <span className="text-[var(--color-fg-subtle)] font-normal normal-case tracking-normal">— opzionale</span></label>
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                        value={newBanquet.deposit_amount ?? ''}
                        onChange={e => setNewBanquet({...newBanquet, deposit_amount: e.target.value === '' ? undefined : parseFloat(e.target.value)})}
                    />
                </div>
                )}
                <div>
                    <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Numero Ospiti <span className="text-[var(--color-fg-subtle)] font-normal normal-case tracking-normal">— opzionale</span></label>
                    <input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="es. 80"
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                        value={newBanquet.guests ?? ''}
                        onChange={e => setNewBanquet({...newBanquet, guests: e.target.value === '' ? undefined : parseInt(e.target.value, 10)})}
                    />
                </div>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Cliente <span className="text-[var(--color-fg-subtle)] font-normal normal-case tracking-normal">— opzionale</span></label>
                {selectedBanquetCustomer ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-[var(--color-fg)] text-sm truncate">{selectedBanquetCustomer.name}</div>
                      <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--color-fg-muted)]">
                        {selectedBanquetCustomer.phone && (
                          <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> {selectedBanquetCustomer.phone}</span>
                        )}
                        {selectedBanquetCustomer.email && (
                          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> {selectedBanquetCustomer.email}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsBanquetCustomerPickerOpen(true)}
                        className="px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] rounded-md"
                      >
                        Cambia
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedBanquetCustomer(null);
                          setNewBanquet(prev => ({ ...prev, customer_id: null }));
                        }}
                        className="p-1.5 text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-rose-50 rounded-md"
                        title="Rimuovi cliente"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsBanquetCustomerPickerOpen(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
                  >
                    <BookUser className="h-4 w-4" />
                    Seleziona dalla rubrica
                  </button>
                )}
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">
                  Tavoli Assegnati <span className="text-slate-400 font-normal normal-case tracking-normal">— opzionale</span>
                </label>
                {!newBanquet.event_date || !newBanquet.shift ? (
                  <p className="text-xs text-[var(--color-fg-muted)] italic">Seleziona Data Evento e Turno per assegnare i tavoli.</p>
                ) : tables.length === 0 ? (
                  <p className="text-xs text-[var(--color-fg-muted)] italic">Nessun tavolo configurato.</p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-[var(--color-fg-muted)]">Seleziona uno o più tavoli per il banchetto. I tavoli occupati da altre prenotazioni o banchetti nello stesso turno sono disabilitati.</p>

                    {/* Room tabs */}
                    {(() => {
                      const openRooms = rooms.filter(r => !r.is_closed);
                      if (openRooms.length === 0) return null;
                      return (
                        <div>
                          <p className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-2">Sale</p>
                          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                            <button
                              type="button"
                              onClick={() => setTablePickerRoomFilter('ALL')}
                              className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${tablePickerRoomFilter === 'ALL' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                            >
                              Tutte le sale
                            </button>
                            {openRooms.map(room => (
                              <button
                                key={room.id}
                                type="button"
                                onClick={() => setTablePickerRoomFilter(room.id)}
                                className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${tablePickerRoomFilter === room.id ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                              >
                                {room.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Tables grouped by room — same UX as Reservations table picker */}
                    <div className="bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-line)] p-2 sm:p-4 max-h-[400px] overflow-y-auto">
                      {(() => {
                        const openRooms = rooms.filter(r => !r.is_closed);
                        const displayedRooms = tablePickerRoomFilter === 'ALL'
                          ? openRooms
                          : openRooms.filter(r => r.id === tablePickerRoomFilter);
                        if (displayedRooms.length === 0) {
                          return <div className="text-center py-10 text-[var(--color-fg-subtle)] text-sm">Nessuna sala disponibile.</div>;
                        }
                        return displayedRooms.map(room => {
                          const roomTables = [...tables]
                            .filter(t => t.room_id === room.id)
                            .sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
                          if (roomTables.length === 0) return null;
                          return (
                            <div key={room.id} className="mb-4 sm:mb-6 last:mb-0">
                              <h4 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-2 sticky top-0 bg-[var(--color-surface-2)] py-1 z-10">{room.name}</h4>
                              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 sm:gap-3">
                                {roomTables.map(t => {
                                  const isSelected = (newBanquet.table_ids || []).includes(t.id);
                                  const occ = tableOccupancyMap.get(t.id);
                                  const isOccupied = !!occ && !isSelected;
                                  return (
                                    <button
                                      key={t.id}
                                      type="button"
                                      disabled={isOccupied}
                                      onClick={() => {
                                        setNewBanquet(prev => {
                                          const current = Array.isArray(prev.table_ids) ? prev.table_ids : [];
                                          const next = current.includes(t.id)
                                            ? current.filter(id => id !== t.id)
                                            : [...current, t.id];
                                          return { ...prev, table_ids: next };
                                        });
                                      }}
                                      className={`relative p-2 sm:p-3 rounded-md border text-center transition-colors ${
                                        isSelected
                                          ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)] ring-1 ring-[var(--color-fg)] z-10'
                                          : isOccupied
                                            ? 'border-rose-200 bg-rose-50 opacity-90 cursor-not-allowed'
                                            : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                                      }`}
                                    >
                                      <div className={`text-xs sm:text-sm font-semibold truncate ${isOccupied ? 'text-rose-700' : 'text-[var(--color-fg)]'}`}>
                                        {t.name}
                                      </div>
                                      <div className={`text-[9px] sm:text-[10px] flex justify-center items-center gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 ${isOccupied ? 'text-rose-700' : 'text-[var(--color-fg-muted)]'}`}>
                                        <Users size={8} className="sm:hidden" />
                                        <Users size={10} className="hidden sm:block" />
                                        {t.seats}
                                      </div>
                                      {isOccupied && occ && (
                                        <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-rose-600 text-white text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-xs)] max-w-[140px] truncate z-10" title={occ.label}>
                                          {occ.label}
                                        </div>
                                      )}
                                      {isSelected && (
                                        <div className="absolute -top-2 -right-2 bg-[var(--color-fg)] rounded-full p-0.5 shadow-[var(--shadow-xs)] z-20">
                                          <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full m-1" />
                                        </div>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-fg-muted)] px-1">
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface)] border border-[var(--color-line)] rounded"></div> Libero</div>
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-fg)] rounded"></div> Selezionato</div>
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-rose-50 border border-rose-200 rounded"></div> Occupato</div>
                    </div>

                    {(newBanquet.table_ids || []).length > 0 && (
                      <p className="text-xs text-[var(--color-fg-muted)] px-1">
                        Selezionati: <span className="font-semibold text-[var(--color-fg)]">{(newBanquet.table_ids || []).length}</span> tavolo/i ·{' '}
                        <span className="font-semibold text-[var(--color-fg)]">
                          {(newBanquet.table_ids || []).reduce((sum, tid) => {
                            const t = tables.find(tt => tt.id === tid);
                            return sum + (t ? t.seats : 0);
                          }, 0)}
                        </span>{' '}
                        posti totali
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Descrizione Commerciale</label>
                <textarea
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20"
                  value={newBanquet.description}
                  onChange={e => setNewBanquet({...newBanquet, description: e.target.value})}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note Portate <span className="font-normal normal-case tracking-normal">— cucina</span></label>
                  <textarea
                    placeholder="es. Senza glutine al tavolo 3, allergia ai crostacei per il tavolo sposi…"
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-24"
                    value={newBanquet.notes_courses || ''}
                    onChange={e => setNewBanquet({...newBanquet, notes_courses: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note Servizio <span className="font-normal normal-case tracking-normal">— sala</span></label>
                  <textarea
                    placeholder="es. Tempi: aperitivo 19:30, taglio torta 22:30. Vino bianco freddo per gli antipasti…"
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-24"
                    value={newBanquet.notes_service || ''}
                    onChange={e => setNewBanquet({...newBanquet, notes_service: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note Mise en Place</label>
                  <textarea
                    placeholder="es. Tovagliato avorio, segnaposti personalizzati, fiori bianchi al centro…"
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-24"
                    value={newBanquet.notes_mise_en_place || ''}
                    onChange={e => setNewBanquet({...newBanquet, notes_mise_en_place: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)]">Composizione del Menu — Uscite</label>
                  <button
                    type="button"
                    onClick={addCourse}
                    className="text-xs font-medium text-[var(--color-fg)] hover:underline flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--color-surface-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" /> Aggiungi Uscita
                  </button>
                </div>
                <p className="text-xs text-[var(--color-fg-muted)] mb-3">Crea le uscite del menu (es. Antipasti, Primi, Secondi) e assegna i piatti a ciascuna.</p>

                <div className="space-y-3">
                  {(newBanquet.courses || []).map((course, courseIndex) => {
                    const totalCourses = (newBanquet.courses || []).length;
                    return (
                      <div key={courseIndex} className="bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface)] border-b border-[var(--color-line)]">
                          <div className="flex flex-col">
                            <button
                              type="button"
                              onClick={() => moveCourse(courseIndex, -1)}
                              disabled={courseIndex === 0}
                              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Sposta su"
                            >
                              <ChevronLeft className="h-3.5 w-3.5 rotate-90" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveCourse(courseIndex, 1)}
                              disabled={courseIndex === totalCourses - 1}
                              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Sposta giù"
                            >
                              <ChevronRight className="h-3.5 w-3.5 rotate-90" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={course.name}
                            onChange={e => renameCourse(courseIndex, e.target.value)}
                            placeholder={`Nome uscita (es. ${courseIndex + 1}ª Uscita)`}
                            className="flex-1 bg-transparent border-0 focus:ring-0 outline-none text-sm font-semibold text-[var(--color-fg)] px-1 py-0.5"
                          />
                          <span className="text-xs text-[var(--color-fg-muted)] whitespace-nowrap">
                            {course.dish_ids.length} {course.dish_ids.length === 1 ? 'piatto' : 'piatti'}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeCourse(courseIndex)}
                            className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600"
                            title="Elimina uscita"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="p-3 max-h-60 overflow-y-auto space-y-3">
                          {BANQUET_DISH_CATEGORIES.map(category => {
                            const categoryDishes = dishes.filter(d => d.category === category);
                            if (categoryDishes.length === 0) return null;
                            return (
                              <div key={category}>
                                <div className="text-[11px] font-semibold tracking-[0.02em] text-[var(--color-fg-subtle)] mb-1.5">
                                  {category}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  {categoryDishes.map(dish => {
                                    const checked = course.dish_ids.includes(dish.id);
                                    return (
                                      <div
                                        key={dish.id}
                                        onClick={() => toggleDishInCourse(courseIndex, dish.id)}
                                        className={`p-2 rounded-md border cursor-pointer transition flex items-start gap-2 ${
                                          checked
                                            ? 'bg-[var(--color-surface-3)] border-[var(--color-fg)]'
                                            : 'bg-[var(--color-surface)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                        }`}
                                      >
                                        <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                          checked ? 'bg-[var(--color-fg)] border-[var(--color-fg)]' : 'border-[var(--color-line-strong)]'
                                        }`}>
                                          {checked && <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full" />}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-sm font-medium text-[var(--color-fg)] truncate">{dish.name}</div>
                                          <div className="text-xs text-[var(--color-fg-muted)]">€{dish.price}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                          {(() => {
                            const orphan = dishes.filter(d => !BANQUET_DISH_CATEGORIES.includes(d.category as any));
                            if (orphan.length === 0) return null;
                            return (
                              <div>
                                <div className="text-[11px] font-semibold tracking-[0.02em] text-[var(--color-fg-subtle)] mb-1.5">Altro</div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  {orphan.map(dish => {
                                    const checked = course.dish_ids.includes(dish.id);
                                    return (
                                      <div
                                        key={dish.id}
                                        onClick={() => toggleDishInCourse(courseIndex, dish.id)}
                                        className={`p-2 rounded-md border cursor-pointer transition flex items-start gap-2 ${
                                          checked ? 'bg-[var(--color-surface-3)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                        }`}
                                      >
                                        <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                          checked ? 'bg-[var(--color-fg)] border-[var(--color-fg)]' : 'border-[var(--color-line-strong)]'
                                        }`}>
                                          {checked && <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full" />}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-sm font-medium text-[var(--color-fg)] truncate">{dish.name}</div>
                                          <div className="text-xs text-[var(--color-fg-muted)]">{dish.category} · €{dish.price}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                          {dishes.length === 0 && (
                            <div className="text-xs text-[var(--color-fg-subtle)] text-center py-4">Aggiungi prima dei piatti alla carta.</div>
                          )}
                        </div>

                        <div className="px-3 pb-3 pt-2 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
                          <label className="block text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">
                            Note uscita (opzionale)
                          </label>
                          <textarea
                            value={course.notes || ''}
                            onChange={e => setCourseNotes(courseIndex, e.target.value)}
                            placeholder="Es. servire con pane caldo, abbinare a vino bianco fresco…"
                            rows={2}
                            className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-md p-2 text-sm focus:outline-none focus:border-[var(--color-fg)] resize-y"
                          />
                        </div>
                      </div>
                    );
                  })}
                  {(newBanquet.courses || []).length === 0 && (
                    <div className="text-center py-6 bg-[var(--color-surface-2)] rounded-lg border border-dashed border-[var(--color-line)]">
                      <p className="text-sm text-[var(--color-fg-muted)] mb-2">Nessuna uscita</p>
                      <button
                        type="button"
                        onClick={addCourse}
                        className="text-sm font-medium text-[var(--color-fg)] hover:underline"
                      >
                        + Aggiungi la prima uscita
                      </button>
                    </div>
                  )}
                </div>
              </div>

            </form>
            {banquetFormErrors.length > 0 && (
              <div className="px-5 py-3 border-t border-rose-200 bg-rose-50 text-rose-800">
                <div className="text-sm font-semibold mb-1">Compila i campi obbligatori:</div>
                <ul className="text-sm list-disc list-inside space-y-0.5">
                  {banquetFormErrors.map(field => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="px-5 py-3 border-t border-[var(--color-line)] flex flex-col sm:flex-row gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={closeBanquetForm}
                  className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
                >
                  Annulla
                </button>
                <button
                  onClick={handleAddBanquetSubmit}
                  type="submit"
                  disabled={isSavingBanquet}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSavingBanquet && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isEditingBanquet ? 'Salva Modifiche' : 'Crea Menu'}
                </button>
              </div>
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteDishConfirm}
        title="Elimina Piatto"
        message="Stai per eliminare il piatto:"
        itemName={deleteDishConfirm?.name}
        onCancel={() => setDeleteDishConfirm(null)}
        onConfirm={() => {
          if (deleteDishConfirm) onDeleteDish(deleteDishConfirm.id);
          setDeleteDishConfirm(null);
        }}
      />

      <ConfirmDeleteModal
        isOpen={!!deleteBanquetConfirm}
        title="Elimina Menu Banchetto"
        message="Stai per eliminare il menu banchetto:"
        itemName={deleteBanquetConfirm?.name}
        onCancel={() => setDeleteBanquetConfirm(null)}
        onConfirm={() => {
          if (deleteBanquetConfirm) onDeleteBanquetMenu(deleteBanquetConfirm.id);
          setDeleteBanquetConfirm(null);
        }}
      />

      {viewBanquet && (
        <BanquetCompositionModal
          banquet={viewBanquet}
          dishes={dishes}
          onClose={() => setViewBanquet(null)}
        />
      )}

      {paymentsBanquet && (
        <BanquetPaymentsModal
          banquet={paymentsBanquet}
          onClose={() => setPaymentsBanquet(null)}
        />
      )}

      {viewDish && (
        <DishDetailModal
          dish={viewDish}
          onClose={() => setViewDish(null)}
        />
      )}

      <CustomerPickerModal
        isOpen={isBanquetCustomerPickerOpen}
        initialQuery={selectedBanquetCustomer?.name || newBanquet.name || ''}
        onClose={() => setIsBanquetCustomerPickerOpen(false)}
        onSelect={(c: Customer) => {
          setSelectedBanquetCustomer(c);
          setNewBanquet(prev => ({ ...prev, customer_id: c.id }));
        }}
      />
    </div>
  );
};

interface BanquetCalendarProps {
  banquetMenus: BanquetMenu[];
  onSelectBanquet: (menu: BanquetMenu) => void;
  onViewBanquet: (menu: BanquetMenu) => void;
  canEdit: boolean;
}

const BanquetCalendar: React.FC<BanquetCalendarProps> = ({ banquetMenus, onSelectBanquet, onViewBanquet, canEdit }) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const canManageBanquetPayments = hasPermission('banquet:manage_payments');
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const monthIndex = cursor.getMonth();
  const year = cursor.getFullYear();

  // Group banquets by date
  const banquetsByDate = useMemo(() => {
    const map = new Map<string, BanquetMenu[]>();
    for (const m of banquetMenus) {
      if (!m.event_date) continue;
      const arr = map.get(m.event_date) || [];
      arr.push(m);
      map.set(m.event_date, arr);
    }
    return map;
  }, [banquetMenus]);

  // Build the 6×7 grid for the month, week starting on Monday
  const cells = useMemo(() => {
    const firstOfMonth = new Date(year, monthIndex, 1);
    const dayOfWeek = (firstOfMonth.getDay() + 6) % 7; // Mon=0..Sun=6
    const start = new Date(year, monthIndex, 1 - dayOfWeek);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [year, monthIndex]);

  const todayKey = formatLocalDate(new Date());
  const selectedBanquets = selectedDate ? (banquetsByDate.get(selectedDate) || []) : [];

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="lg:w-3/4 bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4 sm:p-5">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCursor(new Date(year, monthIndex - 1, 1))}
          className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          aria-label="Mese precedente"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h3 className="text-sm font-semibold text-[var(--color-fg)] capitalize">
          {ITALIAN_MONTHS[monthIndex]} {year}
        </h3>
        <button
          onClick={() => setCursor(new Date(year, monthIndex + 1, 1))}
          className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
          aria-label="Mese successivo"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-[var(--color-fg-subtle)] tracking-[0.02em] mb-2">
        {ITALIAN_WEEKDAYS.map(d => <div key={d} className="py-1">{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const key = formatLocalDate(d);
          const inMonth = d.getMonth() === monthIndex;
          const events = banquetsByDate.get(key) || [];
          const isToday = key === todayKey;
          const isSelected = key === selectedDate;
          return (
            <button
              key={i}
              onClick={() => setSelectedDate(events.length ? key : null)}
              className={`aspect-square sm:aspect-auto sm:min-h-[68px] p-1.5 rounded-md border text-left flex flex-col transition overflow-hidden ${
                isSelected
                  ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)]'
                  : events.length
                  ? 'border-[var(--color-line-strong)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)]'
                  : 'border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
              } ${inMonth ? '' : 'opacity-40'}`}
            >
              <span className={`text-xs font-semibold ${isToday ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}`}>
                {d.getDate()}
              </span>
              {events.length > 0 && (
                <div className="mt-1 w-full flex flex-col gap-0.5 overflow-hidden">
                  {events.slice(0, 2).map(ev => (
                    <span
                      key={ev.id}
                      className="text-[10px] font-medium text-[var(--color-fg)] bg-[var(--color-surface)] border border-[var(--color-line)] rounded px-1 py-0.5 truncate block"
                      title={ev.name}
                    >
                      {ev.name}
                    </span>
                  ))}
                  {events.length > 2 && (
                    <span className="text-[10px] font-medium text-[var(--color-fg-muted)] px-1">
                      +{events.length - 2}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      </div>

      <div className="lg:w-1/4 bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
        {selectedDate ? (
          <>
          <h4 className="text-sm font-semibold text-[var(--color-fg)] mb-3 capitalize">
            {new Date(selectedDate + 'T00:00').toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
          </h4>
          <div className="space-y-2">
            {selectedBanquets.map(menu => {
              const hasNotes = !!(menu.notes_courses?.trim() || menu.notes_service?.trim() || menu.notes_mise_en_place?.trim());
              const timeStatus = computeBanquetTimeStatus(menu);
              const accent = timeStatus === 'PAST'
                ? 'border-l-4 border-l-slate-300 bg-slate-50/40'
                : 'border-l-4 border-l-emerald-400 bg-emerald-50/30';
              return (
                <div
                  key={menu.id}
                  onClick={() => canEdit && onSelectBanquet(menu)}
                  className={`p-3 rounded-md border border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] transition ${accent} ${canEdit ? 'cursor-pointer' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-[var(--color-fg)] truncate">{menu.name}</p>
                        {menu.shift === Shift.LUNCH && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-100 px-1.5 py-0.5 rounded-full">
                            <Sun className="h-3 w-3" /> Pranzo
                          </span>
                        )}
                        {menu.shift === Shift.DINNER && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded-full">
                            <Sunset className="h-3 w-3" /> Cena
                          </span>
                        )}
                        {canManageBanquetPayments && (() => {
                          const status = computeBanquetPaymentStatus(menu);
                          if (status === 'PAID') return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100 px-1.5 py-0.5 rounded-full">
                              <Check className="h-3 w-3" /> Pagato
                            </span>
                          );
                          if (status === 'PARTIAL') return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-100 px-1.5 py-0.5 rounded-full">
                              <Wallet className="h-3 w-3" /> Acconto
                            </span>
                          );
                          return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-100 px-1.5 py-0.5 rounded-full">
                              <Wallet className="h-3 w-3" /> Da pagare
                            </span>
                          );
                        })()}
                      </div>
                      {menu.description && <p className="text-xs text-[var(--color-fg-muted)] truncate mt-0.5">{menu.description}</p>}
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-[var(--color-fg-muted)] flex-wrap">
                        {menu.guests != null && menu.guests > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <Users className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                            <span className="font-medium text-[var(--color-fg)]">{menu.guests}</span>
                            <span>coperti</span>
                          </span>
                        )}
                        {hasNotes && (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <StickyNote className="h-3.5 w-3.5" />
                            <span>Con note</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {canViewBanquetPrice && (
                        <span className="text-sm font-semibold text-[var(--color-fg)] whitespace-nowrap">€{menu.price_per_person}/pax</span>
                      )}
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onViewBanquet(menu); }}
                        className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                        title="Visualizza piatti"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center text-center py-10 text-[var(--color-fg-subtle)]">
            <Calendar className="h-8 w-8 mb-2 opacity-60" />
            <p className="text-sm">Seleziona un giorno con eventi per vedere i dettagli.</p>
          </div>
        )}
      </div>
    </div>
  );
};