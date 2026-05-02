

import React, { useState, useMemo } from 'react';
import { Dish, BanquetMenu, BanquetCourse, COMMON_ALLERGENS } from '../types';
import { Plus, Search, Tag, Leaf, Trash2, Edit2, Utensils, BookOpen, Check, Calendar, List as ListIcon, ChevronLeft, ChevronRight, Printer, ImageIcon, X } from 'lucide-react';
import { printBanquet } from '../utils/printBanquet';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';

const BANQUET_DISH_CATEGORIES = ['Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Bevande'] as const;

const ITALIAN_MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const ITALIAN_WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

const formatLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

interface MenuManagerProps {
  dishes: Dish[];
  banquetMenus: BanquetMenu[];
  onAddDish: (dish: Omit<Dish, 'id'>) => void;
  onUpdateDish: (id: number, dish: Partial<Dish>) => void;
  onDeleteDish: (id: number) => void;
  onAddBanquetMenu: (menu: Omit<BanquetMenu, 'id'>) => void;
  onUpdateBanquetMenu: (id: number, menu: Partial<BanquetMenu>) => void;
  onDeleteBanquetMenu: (id: number) => void;
  canEdit?: boolean;
  initialTab?: 'DISHES' | 'BANQUETS';
}

export const MenuManager: React.FC<MenuManagerProps> = ({
    dishes,
    banquetMenus,
    onAddDish,
    onUpdateDish,
    onDeleteDish,
    onAddBanquetMenu,
    onUpdateBanquetMenu,
    onDeleteBanquetMenu,
    canEdit = true,
    initialTab = 'DISHES'
}) => {
  const [activeTab, setActiveTab] = useState<'DISHES' | 'BANQUETS'>(initialTab);
  const [banquetView, setBanquetView] = useState<'LIST' | 'CALENDAR'>('LIST');
  const [searchTerm, setSearchTerm] = useState('');
  const [isDishFormOpen, setIsDishFormOpen] = useState(false);
  const [isBanquetFormOpen, setIsBanquetFormOpen] = useState(false);
  const [isEditingDish, setIsEditingDish] = useState(false);
  const [isEditingBanquet, setIsEditingBanquet] = useState(false);
  const [editingDishId, setEditingDishId] = useState<number | null>(null);
  const [editingBanquetId, setEditingBanquetId] = useState<number | null>(null);
  const [deleteDishConfirm, setDeleteDishConfirm] = useState<Dish | null>(null);
  const [deleteBanquetConfirm, setDeleteBanquetConfirm] = useState<BanquetMenu | null>(null);

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
      deposit_amount: undefined
  });

  const handleAddDishSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDish.name || !newDish.price) return;

    if (isEditingDish && editingDishId !== null) {
      onUpdateDish(editingDishId, {
        name: newDish.name!,
        description: newDish.description || '',
        price: Number(newDish.price),
        category: newDish.category || 'Antipasti',
        allergens: newDish.allergens || [],
        photo_url: newDish.photo_url?.trim() || undefined
      });
    } else {
      onAddDish({
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

  const handleAddBanquetSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if(!newBanquet.name || !newBanquet.price_per_person || !newBanquet.event_date) return;

      const courses = (newBanquet.courses || []).filter(c => c.name.trim() !== '');
      const flatDishIds = courses.flatMap(c => c.dish_ids);

      const payload = {
          name: newBanquet.name!,
          description: newBanquet.description || '',
          price_per_person: Number(newBanquet.price_per_person),
          dish_ids: flatDishIds,
          courses,
          event_date: newBanquet.event_date!,
          deposit_amount: newBanquet.deposit_amount != null && newBanquet.deposit_amount !== ('' as any)
              ? Number(newBanquet.deposit_amount)
              : undefined
      };

      if (isEditingBanquet && editingBanquetId !== null) {
        onUpdateBanquetMenu(editingBanquetId, payload);
      } else {
        onAddBanquetMenu(payload as BanquetMenu);
      }

      setIsBanquetFormOpen(false);
      setIsEditingBanquet(false);
      setEditingBanquetId(null);
      setNewBanquet({ name: '', description: '', price_per_person: 0, dish_ids: [], courses: [], event_date: '', deposit_amount: undefined });
  };

  const handleEditBanquet = (menu: BanquetMenu) => {
    // Derive courses: use stored courses if present, otherwise wrap legacy flat list into a single course
    const courses: BanquetCourse[] = menu.courses && menu.courses.length > 0
      ? menu.courses.map(c => ({ name: c.name, dish_ids: [...(c.dish_ids || [])] }))
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
      deposit_amount: menu.deposit_amount != null ? Number(menu.deposit_amount) : undefined
    });
    setEditingBanquetId(menu.id);
    setIsEditingBanquet(true);
    setIsBanquetFormOpen(true);
  };

  const handleOpenNewBanquet = () => {
    setIsEditingBanquet(false);
    setEditingBanquetId(null);
    setNewBanquet({
      name: '', description: '', price_per_person: 0,
      dish_ids: [],
      courses: [{ name: '1ª Uscita', dish_ids: [] }],
      event_date: '', deposit_amount: undefined
    });
    setIsBanquetFormOpen(true);
  };

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

  const filteredDishes = dishes.filter(d => 
    d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-fg)]">Gestione Menu & Banchetti</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">Configura i piatti e crea proposte per eventi.</p>
        </div>
        {canEdit && (
        <div className="flex gap-2">
            {activeTab === 'DISHES' ? (
                 <button
                 onClick={() => setIsDishFormOpen(true)}
                 className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2"
               >
                 <Plus className="h-4 w-4" /> Nuovo Piatto
               </button>
            ) : (
                <button
                onClick={handleOpenNewBanquet}
                className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2"
              >
                <Plus className="h-4 w-4" /> Nuovo Banchetto
              </button>
            )}
        </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-[var(--color-line)] mb-6">
        <button
            onClick={() => setActiveTab('DISHES')}
            className={`pb-3 px-2 font-medium text-sm flex items-center gap-2 transition border-b-2 ${activeTab === 'DISHES' ? 'border-[var(--color-fg)] text-[var(--color-fg)]' : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
        >
            <Utensils className="h-4 w-4" /> Piatti alla Carta
        </button>
        <button
            onClick={() => setActiveTab('BANQUETS')}
            className={`pb-3 px-2 font-medium text-sm flex items-center gap-2 transition border-b-2 ${activeTab === 'BANQUETS' ? 'border-[var(--color-fg)] text-[var(--color-fg)]' : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
        >
            <BookOpen className="h-4 w-4" /> Menu Banchetti
        </button>
      </div>

      {activeTab === 'DISHES' && (
          <>
            {/* Stats/Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-[var(--color-surface)] p-4 rounded-lg border border-[var(--color-line)]">
                    <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Totale Piatti</div>
                    <div className="text-2xl font-semibold text-[var(--color-fg)] mt-1">{dishes.length}</div>
                </div>
                <div className="md:col-span-3">
                    <div className="relative h-full">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--color-fg-subtle)] h-4 w-4" />
                        <input
                            type="text"
                            placeholder="Cerca piatto per nome o categoria..."
                            className="w-full h-full pl-10 pr-4 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md text-sm focus:outline-none focus:border-[var(--color-fg)] text-[var(--color-fg)]"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* Dish List */}
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[640px]">
                <thead className="bg-[var(--color-surface-3)] border-b border-[var(--color-line)]">
                    <tr>
                    <th className="px-4 py-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)] w-16">Foto</th>
                    <th className="px-6 py-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)]">Nome Piatto</th>
                    <th className="px-6 py-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)]">Categoria</th>
                    <th className="px-6 py-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)]">Prezzo</th>
                    <th className="px-6 py-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)]">Allergeni</th>
                    {canEdit && <th className="px-6 py-3 text-right text-[11px] uppercase tracking-[0.06em] font-semibold text-[var(--color-fg-subtle)]">Azioni</th>}
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
                        {canEdit && (
                        <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                            <button
                                onClick={() => handleEditDish(dish)}
                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                            >
                                <Edit2 className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => setDeleteDishConfirm(dish)}
                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                        </td>
                        )}
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
          {/* View toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full">
              <button
                onClick={() => setBanquetView('LIST')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition ${banquetView === 'LIST' ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)]'}`}
              >
                <ListIcon className="h-4 w-4" /> Lista
              </button>
              <button
                onClick={() => setBanquetView('CALENDAR')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition ${banquetView === 'CALENDAR' ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)]'}`}
              >
                <Calendar className="h-4 w-4" /> Calendario
              </button>
            </div>
          </div>

          {banquetView === 'LIST' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {banquetMenus.map(menu => (
                  <div key={menu.id} className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-5 relative group">
                      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                              onClick={() => printBanquet(menu, dishes)}
                              className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                              title="Stampa / Salva PDF / Condividi"
                          >
                              <Printer className="h-4 w-4" />
                          </button>
                          {canEdit && (
                          <>
                          <button
                              onClick={() => handleEditBanquet(menu)}
                              className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                          >
                              <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                              onClick={() => setDeleteBanquetConfirm(menu)}
                              className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600"
                          >
                              <Trash2 className="h-4 w-4" />
                          </button>
                          </>
                          )}
                      </div>
                      <div className="flex justify-between items-start mb-3">
                          <div>
                              <h3 className="font-semibold text-[15px] text-[var(--color-fg)]">{menu.name}</h3>
                              <p className="text-sm text-[var(--color-fg-muted)] line-clamp-2">{menu.description}</p>
                          </div>
                      </div>
                      {menu.event_date && (
                        <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] bg-[var(--color-surface-3)] border border-[var(--color-line)] px-2 py-0.5 rounded-full mb-3">
                          <Calendar className="h-3 w-3" />
                          {new Date(menu.event_date + 'T00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      )}
                      <div className="mb-4 flex items-baseline gap-4 flex-wrap">
                          <div>
                              <span className="text-2xl font-semibold text-[var(--color-fg)]">€{menu.price_per_person}</span>
                              <span className="text-[var(--color-fg-subtle)] text-sm"> / persona</span>
                          </div>
                          {menu.deposit_amount != null && Number(menu.deposit_amount) > 0 && (
                              <div className="text-sm">
                                  <span className="text-[var(--color-fg-subtle)]">Acconto: </span>
                                  <span className="font-medium text-[var(--color-fg)]">€{Number(menu.deposit_amount).toFixed(2)}</span>
                              </div>
                          )}
                      </div>
                      <div className="space-y-3">
                          <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Composizione</p>
                          {menu.courses && menu.courses.length > 0 ? (
                            <div className="space-y-2.5">
                              {menu.courses.map((course, idx) => (
                                <div key={idx}>
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-subtle)] mb-1">{course.name}</div>
                                  <ul className="text-sm text-[var(--color-fg)] space-y-1">
                                    {course.dish_ids.map(id => {
                                      const dish = dishes.find(d => d.id === id);
                                      return dish ? <li key={id} className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-[var(--color-fg-muted)]"/> {dish.name}</li> : null;
                                    })}
                                    {course.dish_ids.length === 0 && <li className="text-xs text-[var(--color-fg-subtle)] italic">Nessun piatto</li>}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <ul className="text-sm text-[var(--color-fg)] space-y-1">
                                {menu.dish_ids.map(id => {
                                    const dish = dishes.find(d => d.id === id);
                                    return dish ? <li key={id} className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-[var(--color-fg-muted)]"/> {dish.name}</li> : null;
                                })}
                            </ul>
                          )}
                      </div>
                  </div>
              ))}
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
              canEdit={canEdit}
            />
          )}
        </div>
      )}

      {/* Add Dish Modal */}
      {isDishFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-3.5 border-b border-[var(--color-line)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{isEditingDish ? 'Modifica Piatto' : 'Aggiungi Nuovo Piatto'}</h2>
            </div>
            <form onSubmit={handleAddDishSubmit} className="px-5 py-4 space-y-4 overflow-y-auto">
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome</label>
                <input 
                  required
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  value={newDish.name}
                  onChange={e => setNewDish({...newDish, name: e.target.value})}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Prezzo (€)</label>
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
                  <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Categoria</label>
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
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Descrizione</label>
                <textarea
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20"
                  value={newDish.description}
                  onChange={e => setNewDish({...newDish, description: e.target.value})}
                />
              </div>

              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">URL Foto <span className="text-slate-400 font-normal">— opzionale</span></label>
                <div className="flex gap-3 items-start">
                  <input
                    type="url"
                    placeholder="https://..."
                    className="flex-1 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    value={newDish.photo_url || ''}
                    onChange={e => setNewDish({...newDish, photo_url: e.target.value})}
                  />
                  {newDish.photo_url ? (
                    <img
                      src={newDish.photo_url}
                      alt="Anteprima"
                      className="w-12 h-12 rounded-lg object-cover border border-slate-200 flex-shrink-0"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center flex-shrink-0">
                      <ImageIcon className="h-5 w-5 text-slate-300" />
                    </div>
                  )}
                </div>
              </div>

              <div>
                 <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-2">Allergeni</label>
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
                  className="w-full sm:w-auto rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition"
                >
                  Salva Piatto
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Banquet Modal */}
      {isBanquetFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3.5 border-b border-[var(--color-line)]">
              <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{isEditingBanquet ? 'Modifica Menu Banchetto' : 'Crea Menu Banchetto'}</h2>
            </div>
            <form onSubmit={handleAddBanquetSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome Menu</label>
                    <input
                        required
                        placeholder="es. Menu Matrimonio Gold"
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                        value={newBanquet.name}
                        onChange={e => setNewBanquet({...newBanquet, name: e.target.value})}
                    />
                </div>
                <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Data Evento</label>
                    <input
                        type="date"
                        required
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                        value={newBanquet.event_date || ''}
                        onChange={e => setNewBanquet({...newBanquet, event_date: e.target.value})}
                    />
                </div>
                <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Prezzo per Persona (€)</label>
                    <input
                        type="number"
                        required
                        className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                        value={newBanquet.price_per_person}
                        onChange={e => setNewBanquet({...newBanquet, price_per_person: parseFloat(e.target.value)})}
                    />
                </div>
                <div>
                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Acconto (€) <span className="text-slate-400 font-normal">— opzionale</span></label>
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
              </div>
              <div>
                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Descrizione Commerciale</label>
                <textarea
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20"
                  value={newBanquet.description}
                  onChange={e => setNewBanquet({...newBanquet, description: e.target.value})}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-700">Composizione del Menu — Uscite</label>
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
                              className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Sposta su"
                            >
                              <ChevronLeft className="h-3.5 w-3.5 rotate-90" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveCourse(courseIndex, 1)}
                              disabled={courseIndex === totalCourses - 1}
                              className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
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
                                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-subtle)] mb-1.5">
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
                                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-subtle)] mb-1.5">Altro</div>
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
            <div className="px-5 py-3 border-t border-[var(--color-line)] flex flex-col sm:flex-row gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={() => setIsBanquetFormOpen(false)}
                  className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
                >
                  Annulla
                </button>
                <button
                  onClick={handleAddBanquetSubmit}
                  type="submit"
                  className="w-full sm:w-auto rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition"
                >
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
    </div>
  );
};

interface BanquetCalendarProps {
  banquetMenus: BanquetMenu[];
  onSelectBanquet: (menu: BanquetMenu) => void;
  canEdit: boolean;
}

const BanquetCalendar: React.FC<BanquetCalendarProps> = ({ banquetMenus, onSelectBanquet, canEdit }) => {
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
    <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4 sm:p-5">
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

      <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-[var(--color-fg-subtle)] uppercase tracking-[0.06em] mb-2">
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
              className={`aspect-square sm:aspect-auto sm:min-h-[68px] p-1.5 rounded-md border text-left flex flex-col transition ${
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
                <span className="mt-auto text-[10px] font-medium text-[var(--color-fg-muted)] bg-[var(--color-surface)] border border-[var(--color-line)] rounded-full px-1.5 py-0.5 self-start">
                  {events.length} {events.length === 1 ? 'evento' : 'eventi'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <div className="mt-6 border-t border-[var(--color-line)] pt-4">
          <h4 className="text-sm font-semibold text-[var(--color-fg)] mb-3 capitalize">
            {new Date(selectedDate + 'T00:00').toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
          </h4>
          <div className="space-y-1.5">
            {selectedBanquets.map(menu => (
              <div
                key={menu.id}
                onClick={() => canEdit && onSelectBanquet(menu)}
                className={`p-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] transition flex items-center justify-between gap-3 ${canEdit ? 'cursor-pointer' : ''}`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-fg)] truncate">{menu.name}</p>
                  {menu.description && <p className="text-xs text-[var(--color-fg-muted)] truncate">{menu.description}</p>}
                </div>
                <span className="text-sm font-semibold text-[var(--color-fg)] whitespace-nowrap">€{menu.price_per_person}/pax</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};