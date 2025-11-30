import { Reservation, Table, Room, Dish, BanquetMenu } from '../types';

// Use import.meta.env for Vite frontend environment variables
// const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_URL =import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";



export const getReservations = async (): Promise<Reservation[]> => {
  const response = await fetch(`${API_URL}/reservations`);
  return response.json();
};

export const createReservation = async (reservation: Omit<Reservation, 'id'>): Promise<Reservation> => {
  const response = await fetch(`${API_URL}/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reservation),
  });
  return response.json();
};

export const updateReservation = async (id: number, reservation: Partial<Reservation>): Promise<Reservation> => {
  const response = await fetch(`${API_URL}/reservations/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reservation),
  });
  return response.json();
};

export const deleteReservation = async (id: number): Promise<void> => {
  await fetch(`${API_URL}/reservations/${id}`, {
    method: 'DELETE',
  });
};

export const getTables = async (): Promise<Table[]> => {
  const response = await fetch(`${API_URL}/tables`);
  return response.json();
};

export const createTable = async (table: Omit<Table, 'id'>): Promise<Table> => {
    const response = await fetch(`${API_URL}/tables`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(table),
    });
    return response.json();
};

export const updateTable = async (id: number, table: Partial<Table>): Promise<Table> => {
  const response = await fetch(`${API_URL}/tables/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(table),
  });
  return response.json();
};

export const deleteTable = async (id: number): Promise<void> => {
  await fetch(`${API_URL}/tables/${id}`, {
    method: 'DELETE',
  });
};

export const getRooms = async (): Promise<Room[]> => {
  const response = await fetch(`${API_URL}/rooms`);
  return response.json();
};

export const createRoom = async (room: Omit<Room, 'id'>): Promise<Room> => {
    const response = await fetch(`${API_URL}/rooms`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(room),
    });
    return response.json();
};

export const deleteRoom = async (id: number): Promise<void> => {
    await fetch(`${API_URL}/rooms/${id}`, {
        method: 'DELETE',
    });
};

export const getDishes = async (): Promise<Dish[]> => {
    const response = await fetch(`${API_URL}/dishes`);
    return response.json();
};

export const createDish = async (dish: Omit<Dish, 'id'>): Promise<Dish> => {
    const response = await fetch(`${API_URL}/dishes`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(dish),
    });
    return response.json();
};

export const updateDish = async (id: number, dish: Partial<Dish>): Promise<Dish> => {
    const response = await fetch(`${API_URL}/dishes/${id}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(dish),
    });
    return response.json();
};

export const deleteDish = async (id: number): Promise<void> => {
    await fetch(`${API_URL}/dishes/${id}`, {
        method: 'DELETE',
    });
};

export const getBanquetMenus = async (): Promise<BanquetMenu[]> => {
    const response = await fetch(`${API_URL}/banquet-menus`);
    return response.json();
};

export const createBanquetMenu = async (menu: Omit<BanquetMenu, 'id'>): Promise<BanquetMenu> => {
    const response = await fetch(`${API_URL}/banquet-menus`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(menu),
    });
    return response.json();
};

export const updateBanquetMenu = async (id: number, menu: Partial<BanquetMenu>): Promise<BanquetMenu> => {
    const response = await fetch(`${API_URL}/banquet-menus/${id}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(menu),
    });
    return response.json();
};

export const deleteBanquetMenu = async (id: number): Promise<void> => {
    await fetch(`${API_URL}/banquet-menus/${id}`, {
        method: 'DELETE',
    });
};
