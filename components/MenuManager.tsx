

import React, { useState, useMemo } from 'react';
import { Dish, BanquetMenu, COMMON_ALLERGENS } from '../types';
import { Plus, Search, Tag, Leaf, Trash2, Edit2, Utensils, BookOpen, Check, Calendar, List as ListIcon, ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { printBanquet } from '../utils/printBanquet';

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

  // New Dish State
  const [newDish, setNewDish] = useState<Partial<Dish>>({
    name: '',
    description: '',
    price: 0,
    category: 'Antipasti',
    allergens: []
  });

  // New Banquet Menu State
  const [newBanquet, setNewBanquet] = useState<Partial<BanquetMenu>>({
      name: '',
      description: '',
      price_per_person: 0,
      dish_ids: [],
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
        allergens: newDish.allergens || []
      });
    } else {
      onAddDish({
        name: newDish.name!,
        description: newDish.description || '',
        price: Number(newDish.price),
        category: newDish.category || 'Antipasti',
        allergens: newDish.allergens || []
      } as Dish);
    }

    setIsDishFormOpen(false);
    setIsEditingDish(false);
    setEditingDishId(null);
    setNewDish({ name: '', description: '', price: 0, category: 'Antipasti', allergens: [] });
  };

  const handleEditDish = (dish: Dish) => {
    setNewDish({
      name: dish.name,
      description: dish.description,
      price: dish.price,
      category: dish.category,
      allergens: dish.allergens
    });
    setEditingDishId(dish.id);
    setIsEditingDish(true);
    setIsDishFormOpen(true);
  };

  const handleAddBanquetSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if(!newBanquet.name || !newBanquet.price_per_person || !newBanquet.event_date) return;

      const payload = {
          name: newBanquet.name!,
          description: newBanquet.description || '',
          price_per_person: Number(newBanquet.price_per_person),
          dish_ids: newBanquet.dish_ids || [],
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
      setNewBanquet({ name: '', description: '', price_per_person: 0, dish_ids: [], event_date: '', deposit_amount: undefined });
  };

  const handleEditBanquet = (menu: BanquetMenu) => {
    setNewBanquet({
      name: menu.name,
      description: menu.description,
      price_per_person: menu.price_per_person,
      dish_ids: menu.dish_ids,
      event_date: menu.event_date || '',
      deposit_amount: menu.deposit_amount != null ? Number(menu.deposit_amount) : undefined
    });
    setEditingBanquetId(menu.id);
    setIsEditingBanquet(true);
    setIsBanquetFormOpen(true);
  };

  const toggleDishInBanquet = (dishId: number) => {
      setNewBanquet(prev => {
          const currentIds = prev.dish_ids || [];
          if (currentIds.includes(dishId)) {
              return { ...prev, dish_ids: currentIds.filter(id => id !== dishId) };
          } else {
              return { ...prev, dish_ids: [...currentIds, dishId] };
          }
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
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Gestione Menu & Banchetti</h1>
          <p className="text-slate-500">Configura i piatti e crea proposte per eventi.</p>
        </div>
        {canEdit && (
        <div className="flex gap-2">
            {activeTab === 'DISHES' ? (
                 <button
                 onClick={() => setIsDishFormOpen(true)}
                 className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-lg shadow-indigo-200"
               >
                 <Plus className="h-5 w-5" /> Nuovo Piatto
               </button>
            ) : (
                <button
                onClick={() => setIsBanquetFormOpen(true)}
                className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-lg shadow-indigo-200"
              >
                <Plus className="h-5 w-5" /> Nuovo Banchetto
              </button>
            )}
        </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-slate-200 mb-6">
        <button 
            onClick={() => setActiveTab('DISHES')}
            className={`pb-3 px-2 font-medium text-sm flex items-center gap-2 transition-colors border-b-2 ${activeTab === 'DISHES' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
            <Utensils className="h-4 w-4" /> Piatti alla Carta
        </button>
        <button 
            onClick={() => setActiveTab('BANQUETS')}
            className={`pb-3 px-2 font-medium text-sm flex items-center gap-2 transition-colors border-b-2 ${activeTab === 'BANQUETS' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
            <BookOpen className="h-4 w-4" /> Menu Banchetti
        </button>
      </div>

      {activeTab === 'DISHES' && (
          <>
            {/* Stats/Filters */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-sm text-slate-500">Totale Piatti</div>
                    <div className="text-2xl font-bold text-slate-800">{dishes.length}</div>
                </div>
                <div className="md:col-span-3">
                    <div className="relative h-full">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-5 w-5" />
                        <input 
                            type="text" 
                            placeholder="Cerca piatto per nome o categoria..." 
                            className="w-full h-full pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none text-slate-900"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* Dish List */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Nome Piatto</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Categoria</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Prezzo</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Allergeni</th>
                    {canEdit && <th className="px-6 py-4 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Azioni</th>}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {filteredDishes.map((dish) => (
                    <tr key={dish.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{dish.name}</div>
                        <div className="text-sm text-slate-500 truncate max-w-xs">{dish.description}</div>
                        </td>
                        <td className="px-6 py-4">
                        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                            {dish.category}
                        </span>
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-700">
                        € {Number(dish.price).toFixed(2)}
                        </td>
                        <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                            {dish.allergens.length > 0 ? dish.allergens.map(a => (
                                <span key={a} className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-700 border border-rose-200">
                                    {a}
                                </span>
                            )) : <span className="text-xs text-slate-400">-</span>}
                        </div>
                        </td>
                        {canEdit && (
                        <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => handleEditDish(dish)}
                                className="text-slate-400 hover:text-indigo-600 transition-colors p-1 rounded-full hover:bg-indigo-50"
                            >
                                <Edit2 className="h-5 w-5" />
                            </button>
                            <button
                                onClick={() => onDeleteDish(dish.id)}
                                className="text-slate-400 hover:text-rose-600 transition-colors p-1 rounded-full hover:bg-rose-50"
                            >
                                <Trash2 className="h-5 w-5" />
                            </button>
                        </div>
                        </td>
                        )}
                    </tr>
                    ))}
                </tbody>
                </table>
            </div>
          </>
      )}

      {activeTab === 'BANQUETS' && (
        <div className="space-y-6">
          {/* View toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex bg-slate-100 rounded-xl p-1">
              <button
                onClick={() => setBanquetView('LIST')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${banquetView === 'LIST' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <ListIcon className="h-4 w-4" /> Lista
              </button>
              <button
                onClick={() => setBanquetView('CALENDAR')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${banquetView === 'CALENDAR' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <Calendar className="h-4 w-4" /> Calendario
              </button>
            </div>
          </div>

          {banquetView === 'LIST' && (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {banquetMenus.map(menu => (
                  <div key={menu.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 relative group">
                      <div className="absolute top-4 right-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                              onClick={() => printBanquet(menu, dishes)}
                              className="text-slate-300 hover:text-emerald-500 transition-colors"
                              title="Stampa / Salva PDF / Condividi"
                          >
                              <Printer className="h-5 w-5" />
                          </button>
                          {canEdit && (
                          <>
                          <button
                              onClick={() => handleEditBanquet(menu)}
                              className="text-slate-300 hover:text-indigo-500 transition-colors"
                          >
                              <Edit2 className="h-5 w-5" />
                          </button>
                          <button
                              onClick={() => onDeleteBanquetMenu(menu.id)}
                              className="text-slate-300 hover:text-rose-500 transition-colors"
                          >
                              <Trash2 className="h-5 w-5" />
                          </button>
                          </>
                          )}
                      </div>
                      <div className="flex justify-between items-start mb-4">
                          <div>
                              <h3 className="font-bold text-lg text-slate-800">{menu.name}</h3>
                              <p className="text-sm text-slate-500 line-clamp-2">{menu.description}</p>
                          </div>
                      </div>
                      {menu.event_date && (
                        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg mb-3">
                          <Calendar className="h-3.5 w-3.5" />
                          {new Date(menu.event_date + 'T00:00').toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      )}
                      <div className="mb-4 flex items-baseline gap-4 flex-wrap">
                          <div>
                              <span className="text-2xl font-bold text-indigo-600">€{menu.price_per_person}</span>
                              <span className="text-slate-400 text-sm"> / persona</span>
                          </div>
                          {menu.deposit_amount != null && Number(menu.deposit_amount) > 0 && (
                              <div className="text-sm">
                                  <span className="text-slate-400">Acconto: </span>
                                  <span className="font-semibold text-slate-700">€{Number(menu.deposit_amount).toFixed(2)}</span>
                              </div>
                          )}
                      </div>
                      <div className="space-y-2">
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Composizione:</p>
                          <ul className="text-sm text-slate-700 space-y-1">
                              {menu.dish_ids.map(id => {
                                  const dish = dishes.find(d => d.id === id);
                                  return dish ? <li key={id} className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-indigo-400"/> {dish.name}</li> : null;
                              })}
                          </ul>
                      </div>
                  </div>
              ))}
              {banquetMenus.length === 0 && (
                  <div className="col-span-full text-center py-12 text-slate-400">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-slate-100">
              <h2 className="text-xl font-bold text-slate-800">Aggiungi Nuovo Piatto</h2>
            </div>
            <form onSubmit={handleAddDishSubmit} className="p-6 space-y-4 overflow-y-auto bg-white">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nome</label>
                <input 
                  required
                  className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                  value={newDish.name}
                  onChange={e => setNewDish({...newDish, name: e.target.value})}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Prezzo (€)</label>
                  <input 
                    type="number"
                    step="0.5"
                    required
                    className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                    value={newDish.price}
                    onChange={e => setNewDish({...newDish, price: parseFloat(e.target.value)})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Categoria</label>
                  <select 
                    className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
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
                <label className="block text-sm font-medium text-slate-700 mb-1">Descrizione</label>
                <textarea 
                  className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none h-20"
                  value={newDish.description}
                  onChange={e => setNewDish({...newDish, description: e.target.value})}
                />
              </div>
              
              <div>
                 <label className="block text-sm font-medium text-slate-700 mb-2">Allergeni</label>
                 <div className="flex flex-wrap gap-2">
                    {COMMON_ALLERGENS.map(allergen => {
                        const isSelected = newDish.allergens?.includes(allergen);
                        return (
                            <button
                                key={allergen}
                                type="button"
                                onClick={() => toggleAllergen(allergen)}
                                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all flex items-center gap-1 ${
                                    isSelected 
                                    ? 'bg-rose-50 border-rose-200 text-rose-700 ring-1 ring-rose-200' 
                                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                }`}
                            >
                                {isSelected && <Check size={12} />}
                                {allergen}
                            </button>
                        )
                    })}
                 </div>
              </div>

              <div className="flex gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => setIsDishFormOpen(false)}
                  className="flex-1 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
                >
                  Annulla
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100">
              <h2 className="text-xl font-bold text-slate-800">Crea Menu Banchetto</h2>
            </div>
            <form onSubmit={handleAddBanquetSubmit} className="flex-1 overflow-y-auto p-6 space-y-4 bg-white">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Nome Menu</label>
                    <input
                        required
                        placeholder="es. Menu Matrimonio Gold"
                        className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={newBanquet.name}
                        onChange={e => setNewBanquet({...newBanquet, name: e.target.value})}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Data Evento</label>
                    <input
                        type="date"
                        required
                        className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={newBanquet.event_date || ''}
                        onChange={e => setNewBanquet({...newBanquet, event_date: e.target.value})}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Prezzo per Persona (€)</label>
                    <input
                        type="number"
                        required
                        className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={newBanquet.price_per_person}
                        onChange={e => setNewBanquet({...newBanquet, price_per_person: parseFloat(e.target.value)})}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Acconto (€) <span className="text-slate-400 font-normal">— opzionale</span></label>
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={newBanquet.deposit_amount ?? ''}
                        onChange={e => setNewBanquet({...newBanquet, deposit_amount: e.target.value === '' ? undefined : parseFloat(e.target.value)})}
                    />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Descrizione Commerciale</label>
                <textarea
                  className="w-full rounded-lg border-slate-300 border p-2 bg-slate-50 text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none h-20"
                  value={newBanquet.description}
                  onChange={e => setNewBanquet({...newBanquet, description: e.target.value})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Seleziona Piatti</label>
                <div className="bg-slate-50 rounded-xl border border-slate-200 p-3 max-h-72 overflow-y-auto space-y-3">
                    {BANQUET_DISH_CATEGORIES.map(category => {
                        const categoryDishes = dishes.filter(d => d.category === category);
                        if (categoryDishes.length === 0) return null;
                        return (
                            <div key={category}>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5 sticky top-0 bg-slate-50 py-0.5">
                                    {category}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {categoryDishes.map(dish => (
                                        <div
                                            key={dish.id}
                                            onClick={() => toggleDishInBanquet(dish.id)}
                                            className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-start gap-2 ${
                                                newBanquet.dish_ids?.includes(dish.id)
                                                ? 'bg-indigo-50 border-indigo-500'
                                                : 'bg-white border-slate-200 hover:border-slate-300'
                                            }`}
                                        >
                                            <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                                newBanquet.dish_ids?.includes(dish.id) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                                            }`}>
                                                {newBanquet.dish_ids?.includes(dish.id) && <div className="w-2 h-2 bg-white rounded-full" />}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium text-slate-800 truncate">{dish.name}</div>
                                                <div className="text-xs text-slate-500">€{dish.price}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                    {/* Uncategorized dishes (if any custom categories exist) */}
                    {(() => {
                        const orphan = dishes.filter(d => !BANQUET_DISH_CATEGORIES.includes(d.category as any));
                        if (orphan.length === 0) return null;
                        return (
                            <div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Altro</div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {orphan.map(dish => (
                                        <div
                                            key={dish.id}
                                            onClick={() => toggleDishInBanquet(dish.id)}
                                            className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-start gap-2 ${
                                                newBanquet.dish_ids?.includes(dish.id)
                                                ? 'bg-indigo-50 border-indigo-500'
                                                : 'bg-white border-slate-200 hover:border-slate-300'
                                            }`}
                                        >
                                            <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                                newBanquet.dish_ids?.includes(dish.id) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                                            }`}>
                                                {newBanquet.dish_ids?.includes(dish.id) && <div className="w-2 h-2 bg-white rounded-full" />}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium text-slate-800 truncate">{dish.name}</div>
                                                <div className="text-xs text-slate-500">{dish.category} · €{dish.price}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })()}
                </div>
              </div>

            </form>
            <div className="p-6 border-t border-slate-100 flex gap-3 bg-slate-50">
                <button 
                  type="button"
                  onClick={() => setIsBanquetFormOpen(false)}
                  className="flex-1 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-white"
                >
                  Annulla
                </button>
                <button 
                  onClick={handleAddBanquetSubmit}
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                >
                  Crea Menu
                </button>
              </div>
          </div>
        </div>
      )}
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
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCursor(new Date(year, monthIndex - 1, 1))}
          className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          aria-label="Mese precedente"
        >
          <ChevronLeft className="h-5 w-5 text-slate-600" />
        </button>
        <h3 className="font-semibold text-slate-800 capitalize">
          {ITALIAN_MONTHS[monthIndex]} {year}
        </h3>
        <button
          onClick={() => setCursor(new Date(year, monthIndex + 1, 1))}
          className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          aria-label="Mese successivo"
        >
          <ChevronRight className="h-5 w-5 text-slate-600" />
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
        {ITALIAN_WEEKDAYS.map(d => <div key={d} className="py-1">{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
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
              className={`aspect-square sm:aspect-auto sm:min-h-[68px] p-1.5 rounded-lg border text-left flex flex-col transition-all ${
                isSelected
                  ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200'
                  : events.length
                  ? 'border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50'
                  : 'border-slate-200 hover:bg-slate-50'
              } ${inMonth ? '' : 'opacity-40'}`}
            >
              <span className={`text-xs font-semibold ${isToday ? 'text-indigo-600' : 'text-slate-700'}`}>
                {d.getDate()}
              </span>
              {events.length > 0 && (
                <span className="mt-auto text-[10px] font-medium text-indigo-700 bg-white border border-indigo-200 rounded-full px-1.5 py-0.5 self-start">
                  {events.length} {events.length === 1 ? 'evento' : 'eventi'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <h4 className="font-semibold text-slate-800 mb-3 capitalize">
            {new Date(selectedDate + 'T00:00').toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
          </h4>
          <div className="space-y-2">
            {selectedBanquets.map(menu => (
              <div
                key={menu.id}
                onClick={() => canEdit && onSelectBanquet(menu)}
                className={`p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white hover:border-indigo-200 transition-colors flex items-center justify-between gap-3 ${canEdit ? 'cursor-pointer' : ''}`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-800 truncate">{menu.name}</p>
                  {menu.description && <p className="text-xs text-slate-500 truncate">{menu.description}</p>}
                </div>
                <span className="text-sm font-bold text-indigo-600 whitespace-nowrap">€{menu.price_per_person}/pax</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};