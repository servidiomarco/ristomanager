import React, { useState, useEffect } from 'react';
import { Dish } from '../types';
import { X, ImageIcon, Tag, AlertCircle } from 'lucide-react';

interface Props {
  dish: Dish;
  onClose: () => void;
}

export const DishDetailModal: React.FC<Props> = ({ dish, onClose }) => {
  const [photoFullscreen, setPhotoFullscreen] = useState(false);

  useEffect(() => {
    if (!photoFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPhotoFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photoFullscreen]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-5xl w-full max-h-[95vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="relative bg-slate-100 flex items-center justify-center" style={{ minHeight: '50vh' }}>
          {dish.photo_url ? (
            <img
              src={dish.photo_url}
              alt={dish.name}
              className="w-full max-h-[70vh] object-contain bg-slate-100 cursor-zoom-in"
              onClick={() => setPhotoFullscreen(true)}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-full h-[50vh] flex items-center justify-center">
              <ImageIcon className="h-24 w-24 text-slate-300" />
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
              <h3 className="text-xs font-semibold tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
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

      {photoFullscreen && dish.photo_url && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={(e) => { e.stopPropagation(); setPhotoFullscreen(false); }}
        >
          <img
            src={dish.photo_url}
            alt={dish.name}
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPhotoFullscreen(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/90 hover:bg-white text-slate-700 shadow-lg transition-colors"
            title="Chiudi"
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      )}
    </div>
  );
};
