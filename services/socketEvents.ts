import { socketClient } from './socketClient';

/** Ascolta un evento socket anche attraverso le riconnessioni: il socket
 *  cambia istanza a ogni nuovo token, e un listener attaccato a quello
 *  vecchio smette di sentire in silenzio. Restituisce lo stacco, così si
 *  usa direttamente come cleanup di un useEffect. */
export const onSocketEvent = <T = any>(event: string, handler: (payload: T) => void): (() => void) => {
  let attached: ReturnType<typeof socketClient.getSocket> = null;
  const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
    if (attached === s) return;
    attached?.off(event, handler);
    attached = s;
    attached?.on(event, handler);
  };
  attach(socketClient.getSocket());
  const unsub = socketClient.onSocketChange(s => attach(s));
  return () => { unsub(); attach(null); };
};
