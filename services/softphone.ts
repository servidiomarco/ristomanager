// Softphone nel CRM (docs/telefono-piano.md, Fase 3). Un browser con
// «Questo dispositivo squilla» acceso registra un Device Twilio: squilla
// insieme ai cellulari del locale quando arriva una chiamata al numero di
// Sofia, e può richiamare i clienti col numero del locale.
//
// Il Voice SDK si carica solo qui, con un import dinamico: chi non accende
// il telefono non lo scarica. Lo stato è un singleton (una sola registrazione
// per scheda) che i componenti leggono con useSoftphone().

import { useSyncExternalStore } from 'react';
import type { Call, Device } from '@twilio/voice-sdk';
import { voiceCallsApiService } from './voiceCallsApiService';

export type SoftphoneStatus = 'off' | 'starting' | 'ready' | 'unconfigured' | 'error';

export interface SoftphoneCall {
  direction: 'in' | 'out';
  /** CallSid della chiamata del cliente: aggancia il banner «chi chiama». */
  parentCallSid: string | null;
  /** Numero del cliente (in arrivo) o numero chiamato (in uscita). */
  number: string;
  /** Quando è iniziata la conversazione; null finché squilla. */
  connectedAt: number | null;
}

export interface SoftphoneState {
  status: SoftphoneStatus;
  incoming: SoftphoneCall | null;
  active: SoftphoneCall | null;
  muted: boolean;
}

const DEVICE_KEY = 'sympotia.phone.deviceKey';
const ENABLED_KEY = 'sympotia.phone.enabled';

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string | null) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* senza storage il telefono vale per questa scheda */ }
};

/** La chiave di questo browser, generata la prima volta. */
export const deviceKey = (): string => {
  let key = read(DEVICE_KEY);
  if (!key) {
    key = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');
    write(DEVICE_KEY, key);
  }
  return key;
};

export const isEnabledHere = (): boolean => read(ENABLED_KEY) === '1';

let state: SoftphoneState = { status: 'off', incoming: null, active: null, muted: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<SoftphoneState>) => {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
};

let device: Device | null = null;
let incomingCall: Call | null = null;
let activeCall: Call | null = null;

const callInfo = (call: Call, direction: 'in' | 'out', number: string): SoftphoneCall => ({
  direction,
  parentCallSid: direction === 'in' ? (call.customParameters.get('parentCallSid') ?? null) : null,
  number,
  connectedAt: null,
});

const fetchToken = async (): Promise<string | null> => {
  try {
    return (await voiceCallsApiService.phoneToken(deviceKey())).token;
  } catch (err: any) {
    // 404: il dispositivo è stato spento (anche da un altro browser, dalle
    // Impostazioni). 503: il server non ha ancora la API key.
    if (err?.status === 404) { write(ENABLED_KEY, null); set({ status: 'off' }); }
    else if (err?.status === 503) set({ status: 'unconfigured' });
    else set({ status: 'error' });
    return null;
  }
};

const watchActive = (call: Call, info: SoftphoneCall) => {
  activeCall = call;
  set({ active: info, muted: false });
  call.on('accept', () => set({ active: { ...info, connectedAt: Date.now() } }));
  call.on('mute', (muted: boolean) => set({ muted }));
  const end = () => {
    if (activeCall === call) { activeCall = null; set({ active: null, muted: false }); }
  };
  call.on('disconnect', end);
  call.on('cancel', end);
  call.on('reject', end);
  call.on('error', end);
};

export async function startSoftphone(): Promise<void> {
  if (device || !isEnabledHere()) return;
  set({ status: 'starting' });
  const token = await fetchToken();
  if (!token) return;
  const { Device: TwilioDevice, Call: TwilioCall } = await import('@twilio/voice-sdk');
  const d = new TwilioDevice(token, {
    codecPreferences: [TwilioCall.Codec.Opus, TwilioCall.Codec.PCMU],
    // Chiudere la scheda durante una chiamata chiede conferma.
    closeProtection: true,
    logLevel: 'warn',
  });
  device = d;
  d.on('registered', () => set({ status: 'ready' }));
  d.on('error', () => { if (state.status !== 'ready') set({ status: 'error' }); });
  d.on('tokenWillExpire', async () => {
    const fresh = await fetchToken();
    if (fresh) d.updateToken(fresh);
  });
  d.on('incoming', (call: Call) => {
    // Già al telefono: la seconda chiamata la prendono gli altri, o Sofia.
    if (activeCall) { call.reject(); return; }
    incomingCall = call;
    const info = callInfo(call, 'in', call.customParameters.get('caller') ?? '');
    set({ incoming: info });
    const clear = () => {
      if (incomingCall === call) { incomingCall = null; set({ incoming: null }); }
    };
    call.on('cancel', clear);
    call.on('reject', clear);
    call.on('disconnect', clear);
    call.on('accept', () => {
      clear();
      watchActive(call, { ...info, connectedAt: Date.now() });
    });
  });
  try {
    await d.register();
  } catch {
    set({ status: 'error' });
  }
}

export function stopSoftphone(): void {
  incomingCall = null;
  activeCall?.disconnect();
  activeCall = null;
  device?.destroy();
  device = null;
  set({ status: 'off', incoming: null, active: null, muted: false });
}

/** Accende «Questo dispositivo squilla» e registra il Device. */
export async function enableSoftphone(label: string): Promise<void> {
  await voiceCallsApiService.registerPhoneDevice(deviceKey(), label);
  write(ENABLED_KEY, '1');
  await startSoftphone();
}

export async function disableSoftphone(deviceId: number | null): Promise<void> {
  if (deviceId != null) await voiceCallsApiService.deletePhoneDevice(deviceId);
  write(ENABLED_KEY, null);
  stopSoftphone();
}

export const answer = () => incomingCall?.accept();
export const decline = () => incomingCall?.reject();
export const hangUp = () => activeCall?.disconnect();
export const toggleMute = () => activeCall?.mute(!activeCall.isMuted());

/** «Richiama»: col telefono acceso la chiamata parte dal CRM e restituisce
 *  true; altrimenti false e chi chiama usa il tel: del sistema. */
export function callFromCrm(number: string): boolean {
  if (!device || state.status !== 'ready' || activeCall) return false;
  void device.connect({ params: { To: number } }).then(call => {
    watchActive(call, { direction: 'out', parentCallSid: null, number, connectedAt: null });
  }).catch(() => set({ active: null }));
  return true;
}

export const getSoftphoneState = (): SoftphoneState => state;

export function useSoftphone(): SoftphoneState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
  );
}
