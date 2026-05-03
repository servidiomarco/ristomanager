import React from 'react';
import { BanquetMenu, Dish, Shift } from '../types';
import { X, Sun, Moon, Users, Calendar, Utensils, Printer, StickyNote } from 'lucide-react';
import { printBanquet } from '../utils/printBanquet';

interface Props {
  banquet: BanquetMenu;
  dishes: Dish[];
  onClose: () => void;
}

const formatItalianDate = (iso?: string): string => {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
};

export const BanquetCompositionModal: React.FC<Props> = ({ banquet, dishes, onClose }) => {
  const courses = Array.isArray(banquet.courses) && banquet.courses.length > 0
    ? banquet.courses
    : null;

  const fallbackDishes = !courses
    ? banquet.dish_ids.map(id => dishes.find(d => d.id === id)).filter((d): d is Dish => !!d)
    : [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-slate-100">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold text-slate-800 truncate">{banquet.name}</h2>
            <div className="flex items-center gap-2 flex-wrap mt-1.5">
              {banquet.event_date && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                  <Calendar className="h-3.5 w-3.5 text-indigo-500" />
                  {formatItalianDate(banquet.event_date)}
                </span>
              )}
              {banquet.shift === Shift.LUNCH && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                  <Sun className="h-3 w-3" /> Pranzo
                </span>
              )}
              {banquet.shift === Shift.DINNER && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                  <Moon className="h-3 w-3" /> Cena
                </span>
              )}
              {banquet.guests != null && banquet.guests > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                  <Users className="h-3.5 w-3.5 text-indigo-500" />
                  <span className="font-semibold">{banquet.guests}</span> coperti
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600">
                €{banquet.price_per_person}/pax
              </span>
            </div>
            {banquet.description && (
              <p className="text-sm text-slate-500 mt-2 line-clamp-2">{banquet.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
            <button
              type="button"
              onClick={() => printBanquet(banquet, dishes)}
              className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
              title="Stampa"
            >
              <Printer className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
              title="Chiudi"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
              <Utensils className="h-3.5 w-3.5" />
              Composizione del menù
            </h3>
            {courses ? (
              <div className="space-y-3">
                {courses.map((course, idx) => {
                  const items = course.dish_ids
                    .map(id => dishes.find(d => d.id === id))
                    .filter((d): d is Dish => !!d);
                  if (items.length === 0) return null;
                  return (
                    <div key={`${course.name}-${idx}`} className="border border-slate-100 rounded-lg p-3 bg-slate-50/50">
                      <h4 className="text-sm font-semibold text-indigo-600 mb-1.5">{course.name}</h4>
                      <ul className="space-y-1">
                        {items.map(d => (
                          <li key={d.id} className="text-sm text-slate-700 flex items-baseline gap-2">
                            <span className="text-indigo-300">•</span>
                            <span>{d.name}</span>
                            {d.allergens && d.allergens.length > 0 && (
                              <span className="text-[10px] text-rose-600 font-medium">
                                {d.allergens.join(', ')}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : fallbackDishes.length > 0 ? (
              <ul className="space-y-1">
                {fallbackDishes.map(d => (
                  <li key={d.id} className="text-sm text-slate-700 flex items-baseline gap-2">
                    <span className="text-indigo-300">•</span>
                    <span>{d.name}</span>
                    {d.category && <span className="text-[10px] text-slate-400">({d.category})</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400 italic">Nessun piatto selezionato.</p>
            )}
          </div>

          {/* Notes */}
          {(banquet.notes_courses || banquet.notes_service || banquet.notes_mise_en_place) && (
            <div className="space-y-2 pt-2 border-t border-slate-100">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                <StickyNote className="h-3.5 w-3.5" />
                Note operative
              </h3>
              {banquet.notes_courses && (
                <div className="border-l-3 border-l-amber-400 bg-amber-50/50 rounded-r-lg p-2.5 border border-amber-100">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Portate (Cucina)</h4>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{banquet.notes_courses}</p>
                </div>
              )}
              {banquet.notes_service && (
                <div className="border-l-3 border-l-amber-400 bg-amber-50/50 rounded-r-lg p-2.5 border border-amber-100">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Servizio (Sala)</h4>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{banquet.notes_service}</p>
                </div>
              )}
              {banquet.notes_mise_en_place && (
                <div className="border-l-3 border-l-amber-400 bg-amber-50/50 rounded-r-lg p-2.5 border border-amber-100">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Mise en Place</h4>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{banquet.notes_mise_en_place}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
