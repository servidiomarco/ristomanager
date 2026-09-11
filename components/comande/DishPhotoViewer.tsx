import React from 'react';
import type { Dish } from '../../types';
import { euro } from './orderView';

// ---------------------------------------------------------------------------
// Il visore della foto piatto, da porgere al cliente: fondo nero pieno come
// il fullscreen della scheda piatto in gestione menu — il telefono si gira
// verso l'ospite, quindi la foto ha il palco e sotto solo nome e prezzo.
// Un tocco ovunque chiude. stopPropagation perché vive anche dentro il velo
// della ricerca piatti: chiudere la foto non deve chiudere la ricerca.
// ---------------------------------------------------------------------------

export const DishPhotoViewer: React.FC<{
  dish: Dish;
  onClose: () => void;
  /** z-50 di default; la ricerca piatti (velo a z-100) passa z-[110]. */
  zClass?: string;
}> = ({ dish, onClose, zClass = 'z-50' }) => {
  if (!dish.photo_url) return null;
  return (
    <div
      role="dialog"
      aria-label={`Foto di ${dish.name}`}
      onClick={e => { e.stopPropagation(); onClose(); }}
      className={`fixed inset-0 ${zClass} flex cursor-zoom-out flex-col items-center justify-center gap-5 bg-black/95 p-5`}
    >
      <img
        src={dish.photo_url}
        alt={dish.name}
        className="max-h-[78vh] max-w-full rounded-[20px] object-contain"
      />
      <div className="text-center">
        <div className="text-[22px] font-semibold text-white">{dish.name}</div>
        <div className="mt-0.5 text-[17px] tabular-nums text-white/70">
          {euro(Math.round(Number(dish.price) * 100))}
        </div>
      </div>
    </div>
  );
};
