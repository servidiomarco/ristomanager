import React from 'react';
import { BanquetMenu, Dish, Shift } from '../types';
import { X, Sun, Moon, Users, Calendar, Utensils, Printer, StickyNote, ImageIcon, ChefHat } from 'lucide-react';
import { printBanquet } from '../utils/printBanquet';
import { useAuth } from '../contexts/AuthContext';

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
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const courses = Array.isArray(banquet.courses) && banquet.courses.length > 0
    ? banquet.courses
    : null;

  const fallbackDishes = !courses
    ? banquet.dish_ids.map(id => dishes.find(d => d.id === id)).filter((d): d is Dish => !!d)
    : [];

  return (
    <div className="fixed inset-0 bg-[var(--ds-backdrop)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-[var(--ds-border)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold text-[var(--ds-text-primary)] truncate">{banquet.name}</h2>
            <div className="flex items-center gap-2 flex-wrap mt-1.5">
              {banquet.event_date && (
                <span className="inline-flex items-center gap-1 text-[13px] text-[var(--ds-text-secondary)]">
                  <Calendar className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                  {formatItalianDate(banquet.event_date)}
                </span>
              )}
              {banquet.shift === Shift.LUNCH && (
                <span className="inline-flex items-center gap-1 text-[13px] font-semibold bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] px-1.5 py-0.5 rounded">
                  <Sun className="h-3 w-3" /> Pranzo
                </span>
              )}
              {banquet.shift === Shift.DINNER && (
                <span className="inline-flex items-center gap-1 text-[13px] font-semibold bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] px-1.5 py-0.5 rounded">
                  <Moon className="h-3 w-3" /> Cena
                </span>
              )}
              {banquet.guests != null && banquet.guests > 0 && (
                <span className="inline-flex items-center gap-1 text-[13px] text-[var(--ds-text-secondary)]">
                  <Users className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                  <span className="font-semibold">{banquet.guests}</span> coperti
                  {banquet.children != null && banquet.children > 0 && (
                    <span className="text-[var(--ds-text-muted)]">({banquet.children} bambin{banquet.children === 1 ? 'o' : 'i'})</span>
                  )}
                </span>
              )}
              {canViewBanquetPrice && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--ds-text-primary)]">
                  €{banquet.price_per_person}/pax
                  {banquet.children_price != null && (
                    <span className="text-[var(--ds-text-muted)]">· €{banquet.children_price}/bambino</span>
                  )}
                </span>
              )}
            </div>
            {banquet.description && (
              <p className="text-sm text-[var(--ds-text-muted)] mt-2 line-clamp-2">{banquet.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-3">
            <button
              type="button"
              onClick={() => printBanquet(banquet, dishes, { showPrice: canViewBanquetPrice })}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              title="Stampa"
            >
              <Printer className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => printBanquet(banquet, dishes, { kitchenMode: true })}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              title="Stampa per cucina"
            >
              <ChefHat className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              title="Chiudi"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <h3 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2 flex items-center gap-1.5">
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
                    <div key={`${course.name}-${idx}`} className="border border-[var(--ds-border)] rounded-lg p-3 bg-[var(--ds-surface-row)]">
                      <h4 className="mb-2 text-[15px] font-semibold text-[var(--ds-text-primary)]">{course.name}</h4>
                      <ul className="space-y-2">
                        {items.map(d => (
                          <li key={d.id} className="flex items-center gap-3">
                            {d.photo_url ? (
                              <img
                                src={d.photo_url}
                                alt={d.name}
                                className="h-12 w-12 rounded-lg object-cover flex-shrink-0 border border-[var(--ds-border)]"
                              />
                            ) : (
                              <div className="h-12 w-12 rounded-lg bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0 border border-[var(--ds-border)]">
                                <ImageIcon className="h-5 w-5 text-[var(--ds-text-subtle)]" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-[var(--ds-text-primary)] font-medium truncate">{d.name}</div>
                              {d.allergens && d.allergens.length > 0 && (
                                <div className="text-[10px] text-[var(--ds-critical-text)] font-medium mt-0.5">
                                  {d.allergens.join(', ')}
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                      {course.notes && course.notes.trim() && (
                        <p className="text-xs italic text-[var(--ds-text-secondary)] mt-2 whitespace-pre-wrap">{course.notes}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : fallbackDishes.length > 0 ? (
              <ul className="space-y-2">
                {fallbackDishes.map(d => (
                  <li key={d.id} className="flex items-center gap-3">
                    {d.photo_url ? (
                      <img
                        src={d.photo_url}
                        alt={d.name}
                        className="h-12 w-12 rounded-lg object-cover flex-shrink-0 border border-[var(--ds-border)]"
                      />
                    ) : (
                      <div className="h-12 w-12 rounded-lg bg-[var(--ds-surface-row)] flex items-center justify-center flex-shrink-0 border border-[var(--ds-border)]">
                        <ImageIcon className="h-5 w-5 text-[var(--ds-text-subtle)]" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-[var(--ds-text-primary)] font-medium truncate">{d.name}</div>
                      {d.category && <div className="text-[10px] text-[var(--ds-text-subtle)]">{d.category}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-[var(--ds-text-subtle)] italic">Nessun piatto selezionato.</p>
            )}
          </div>

          {/* Notes */}
          {(banquet.notes_courses || banquet.notes_service || banquet.notes_mise_en_place) && (
            <div className="space-y-2 pt-2 border-t border-[var(--ds-border)]">
              <h3 className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-2 flex items-center gap-1.5">
                <StickyNote className="h-3.5 w-3.5" />
                Note operative
              </h3>
              {banquet.notes_courses && (
                <div className="border-l-3 border-l-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)] rounded-r-lg p-2.5 border border-[var(--ds-pending-tint)] dark:border-l-[var(--ds-pending-solid)]">
                  <h4 className="text-[13px] font-semibold text-[var(--ds-pending-text)] mb-1">Portate (Cucina)</h4>
                  <p className="text-sm text-[var(--ds-text-primary)] whitespace-pre-wrap">{banquet.notes_courses}</p>
                </div>
              )}
              {banquet.notes_service && (
                <div className="border-l-3 border-l-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)] rounded-r-lg p-2.5 border border-[var(--ds-pending-tint)] dark:border-l-[var(--ds-pending-solid)]">
                  <h4 className="text-[13px] font-semibold text-[var(--ds-pending-text)] mb-1">Servizio (Sala)</h4>
                  <p className="text-sm text-[var(--ds-text-primary)] whitespace-pre-wrap">{banquet.notes_service}</p>
                </div>
              )}
              {banquet.notes_mise_en_place && (
                <div className="border-l-3 border-l-[var(--ds-pending-solid)] bg-[var(--ds-pending-tint)] rounded-r-lg p-2.5 border border-[var(--ds-pending-tint)] dark:border-l-[var(--ds-pending-solid)]">
                  <h4 className="text-[13px] font-semibold text-[var(--ds-pending-text)] mb-1">Mise en Place</h4>
                  <p className="text-sm text-[var(--ds-text-primary)] whitespace-pre-wrap">{banquet.notes_mise_en_place}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
