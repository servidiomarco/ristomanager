import React from 'react';
import { Dish } from '../types';
import { X, ImageIcon, Tag, AlertCircle } from 'lucide-react';

interface Props {
  dish: Dish;
  onClose: () => void;
}

export const DishDetailModal: React.FC<Props> = ({ dish, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="relative">
          {dish.photo_url ? (
            <img
              src={dish.photo_url}
              alt={dish.name}
              className="w-full h-56 object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-full h-56 bg-slate-100 flex items-center justify-center">
              <ImageIcon className="h-16 w-16 text-slate-300" />
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-2 rounded-full bg-white/90 hover:bg-white text-slate-600 hover:text-slate-800 shadow-sm transition-colors"
            title="Chiudi"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h2 className="text-xl font-bold text-slate-800">{dish.name}</h2>
            <span className="text-xl font-bold text-indigo-600 whitespace-nowrap">
              € {Number(dish.price).toFixed(2)}
            </span>
          </div>

          {dish.category && (
            <div className="inline-flex items-center gap-1.5 text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 px-2.5 py-1 rounded-full mb-3">
              <Tag className="h-3 w-3" />
              {dish.category}
            </div>
          )}

          {dish.description && (
            <p className="text-sm text-slate-600 leading-relaxed mb-4">{dish.description}</p>
          )}

          {dish.allergens && dish.allergens.length > 0 && (
            <div className="border-t border-slate-100 pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
                Allergeni
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {dish.allergens.map(a => (
                  <span
                    key={a}
                    className="px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200"
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
