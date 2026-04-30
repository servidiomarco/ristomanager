import type { Room } from '../types';

// Canonical display order for rooms across the app. Match is case-insensitive.
// Rooms whose names are not in this list fall to the end, sorted alphabetically.
export const ROOM_ORDER = ['veranda', 'macine', 'fiume', 'fuori', 'tettoia', 'pergolato'];

const orderIndex = (name: string): number => {
  const idx = ROOM_ORDER.indexOf(name.trim().toLowerCase());
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
};

export const sortRooms = <T extends Pick<Room, 'name'>>(rooms: readonly T[]): T[] =>
  [...rooms].sort((a, b) => {
    const ai = orderIndex(a.name);
    const bi = orderIndex(b.name);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
