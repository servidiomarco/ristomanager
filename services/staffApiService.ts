import {
  StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType, Shift, TimeOffType,
  LeavePlan, LeaveRequest, LeaveSettings, LeaveProposalItem, MyLeave, LinkableUser,
} from '../types';
import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// Helper function to get headers with socket ID and auth token
const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }

  const token = authApiService.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
};

// Fetch with automatic token refresh on 401
const fetchWithAuth = async (
  url: string,
  options: RequestInit = {},
  retried = false
): Promise<Response> => {
  const response = await fetch(url, options);

  if (response.status === 401 && !retried) {
    const refreshed = await authApiService.refreshToken();

    if (refreshed) {
      const newHeaders = { ...options.headers } as Record<string, string>;
      newHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;
      return fetchWithAuth(url, { ...options, headers: newHeaders }, true);
    }
  }

  return response;
};

const apiRequest = async <T>(
  url: string,
  options: RequestInit = {},
  expectJson = true
): Promise<T> => {
  const response = await fetchWithAuth(url, options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }

  if (expectJson) {
    return response.json();
  }

  return undefined as T;
};

// ============================================
// STAFF MEMBER INTERFACES
// ============================================

export interface CreateStaffInput {
  name: string;
  surname: string;
  category: StaffCategory;
  staffType: StaffType;
  phone?: string;
  email?: string;
  role?: string;
  hireDate?: string;
  contractEndDate?: string;
  weeklyRestDay?: number | null;
  notes?: string;
  userId?: number | null;
  annualLeaveDays?: number | null;
}

export interface UpdateStaffInput {
  name?: string;
  surname?: string;
  category?: StaffCategory;
  staffType?: StaffType;
  phone?: string;
  email?: string;
  role?: string;
  hireDate?: string;
  contractEndDate?: string;
  weeklyRestDay?: number | null;
  notes?: string;
  isActive?: boolean;
  userId?: number | null;
  annualLeaveDays?: number | null;
}

// ============================================
// SHIFT INTERFACES
// ============================================

export interface CreateShiftInput {
  staffId: string;
  date: string;
  shift: Shift;
  present?: boolean;
  notes?: string;
}

export interface UpdateShiftInput {
  present?: boolean;
  notes?: string;
}

// ============================================
// TIME OFF INTERFACES
// ============================================

export interface CreateTimeOffInput {
  staffId: string;
  startDate: string;
  endDate: string;
  type: TimeOffType;
  shift?: Shift | null;
  notes?: string;
  approved?: boolean;
}

export interface UpdateTimeOffInput {
  startDate?: string;
  endDate?: string;
  type?: TimeOffType;
  shift?: Shift | null;
  notes?: string;
  approved?: boolean;
}

// ============================================
// STAFF API SERVICE
// ============================================

class StaffApiService {
  // ============================================
  // STAFF MEMBERS
  // ============================================

  async getStaffMembers(): Promise<StaffMember[]> {
    return apiRequest<StaffMember[]>(`${API_URL}/staff`, {
      headers: getHeaders(false)
    });
  }

  async getStaffMember(id: string): Promise<StaffMember> {
    return apiRequest<StaffMember>(`${API_URL}/staff/${id}`, {
      headers: getHeaders(false)
    });
  }

  async getStaffByCategory(category: StaffCategory): Promise<StaffMember[]> {
    return apiRequest<StaffMember[]>(`${API_URL}/staff?category=${category}`, {
      headers: getHeaders(false)
    });
  }

  async createStaffMember(staff: CreateStaffInput): Promise<StaffMember> {
    return apiRequest<StaffMember>(`${API_URL}/staff`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(staff),
    });
  }

  async updateStaffMember(id: string, updates: UpdateStaffInput): Promise<StaffMember> {
    return apiRequest<StaffMember>(`${API_URL}/staff/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  async deleteStaffMember(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/staff/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // ============================================
  // STAFF SHIFTS
  // ============================================

  async getShifts(date?: string, staffId?: string): Promise<StaffShift[]> {
    const params = new URLSearchParams();
    if (date) params.append('date', date);
    if (staffId) params.append('staffId', staffId);
    const queryString = params.toString();

    return apiRequest<StaffShift[]>(`${API_URL}/staff/shifts${queryString ? `?${queryString}` : ''}`, {
      headers: getHeaders(false)
    });
  }

  async getShiftsByDateRange(startDate: string, endDate: string, staffId?: string): Promise<StaffShift[]> {
    const params = new URLSearchParams();
    params.append('startDate', startDate);
    params.append('endDate', endDate);
    if (staffId) params.append('staffId', staffId);

    return apiRequest<StaffShift[]>(`${API_URL}/staff/shifts?${params.toString()}`, {
      headers: getHeaders(false)
    });
  }

  async createShift(shift: CreateShiftInput): Promise<StaffShift> {
    return apiRequest<StaffShift>(`${API_URL}/staff/shifts`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(shift),
    });
  }

  async updateShift(id: string, updates: UpdateShiftInput): Promise<StaffShift> {
    return apiRequest<StaffShift>(`${API_URL}/staff/shifts/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  async deleteShift(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/staff/shifts/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  async bulkCreateShifts(shifts: CreateShiftInput[]): Promise<StaffShift[]> {
    return apiRequest<StaffShift[]>(`${API_URL}/staff/shifts/bulk`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ shifts }),
    });
  }

  // ============================================
  // TIME OFF
  // ============================================

  async getTimeOff(staffId?: string): Promise<StaffTimeOff[]> {
    const params = staffId ? `?staffId=${staffId}` : '';
    return apiRequest<StaffTimeOff[]>(`${API_URL}/staff/time-off${params}`, {
      headers: getHeaders(false)
    });
  }

  async getTimeOffByDateRange(startDate: string, endDate: string, staffId?: string): Promise<StaffTimeOff[]> {
    const params = new URLSearchParams();
    params.append('startDate', startDate);
    params.append('endDate', endDate);
    if (staffId) params.append('staffId', staffId);

    return apiRequest<StaffTimeOff[]>(`${API_URL}/staff/time-off?${params.toString()}`, {
      headers: getHeaders(false)
    });
  }

  async createTimeOff(timeOff: CreateTimeOffInput): Promise<StaffTimeOff> {
    return apiRequest<StaffTimeOff>(`${API_URL}/staff/time-off`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(timeOff),
    });
  }

  async updateTimeOff(id: string, updates: UpdateTimeOffInput): Promise<StaffTimeOff> {
    return apiRequest<StaffTimeOff>(`${API_URL}/staff/time-off/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  async deleteTimeOff(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/staff/time-off/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // ============================================
  // PIANO FERIE
  // ============================================

  async getLeavePlan(year: number): Promise<LeavePlan> {
    return apiRequest<LeavePlan>(`${API_URL}/staff/leave-plan?year=${year}`, { headers: getHeaders(false) });
  }

  async getPendingLeaveCount(): Promise<{ count: number; byStaff: Record<string, number> }> {
    const r = await apiRequest<{ count?: number; byStaff?: Record<string, number> }>(
      `${API_URL}/staff/leave-requests/pending-count`,
      { headers: getHeaders(false) }
    );
    return {
      count: typeof r?.count === 'number' ? r.count : 0,
      byStaff: r?.byStaff && typeof r.byStaff === 'object' ? r.byStaff : {},
    };
  }

  async updateLeaveSettings(settings: LeaveSettings): Promise<LeaveSettings> {
    return apiRequest<LeaveSettings>(`${API_URL}/staff/leave-settings`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(settings),
    });
  }

  async createLeaveRequestFor(input: { staffId: string; startDate: string; endDate: string; note?: string }): Promise<LeaveRequest> {
    return apiRequest<LeaveRequest>(`${API_URL}/staff/leave-requests`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async decideLeaveRequests(
    decisions: Array<{ id: string; decision: 'APPROVE' | 'REJECT' | 'REVOKE'; note?: string }>
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const r = await apiRequest<{ results: Array<{ id: string; ok: boolean; error?: string }> }>(
      `${API_URL}/staff/leave-requests/decide`,
      { method: 'POST', headers: getHeaders(), body: JSON.stringify({ decisions }) }
    );
    return r.results ?? [];
  }

  async proposeLeavePlan(): Promise<LeaveProposalItem[]> {
    const r = await apiRequest<{ items: LeaveProposalItem[] }>(`${API_URL}/staff/leave-plan/proposal`, {
      method: 'POST',
      headers: getHeaders(),
      body: '{}',
    });
    return r.items ?? [];
  }

  async getLinkableUsers(): Promise<LinkableUser[]> {
    return apiRequest<LinkableUser[]>(`${API_URL}/staff/linkable-users`, { headers: getHeaders(false) });
  }

  async getMyLeave(year?: number): Promise<MyLeave> {
    const q = year ? `?year=${year}` : '';
    return apiRequest<MyLeave>(`${API_URL}/staff/my-leave${q}`, { headers: getHeaders(false) });
  }

  async requestMyLeave(input: { startDate: string; endDate: string; note?: string }): Promise<LeaveRequest> {
    return apiRequest<LeaveRequest>(`${API_URL}/staff/my-leave`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async cancelMyLeave(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/staff/my-leave/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get staff presence for a specific date
   */
  async getStaffPresence(date: string): Promise<{
    sala: { lunch: StaffMember[]; dinner: StaffMember[] };
    cucina: { lunch: StaffMember[]; dinner: StaffMember[] };
  }> {
    return apiRequest(`${API_URL}/staff/presence?date=${date}`, {
      headers: getHeaders(false)
    });
  }
}

export const staffApiService = new StaffApiService();
