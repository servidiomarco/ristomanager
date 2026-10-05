// Coda offline: scritture serializzate che sopravvivono al reload.
//
// La prima versione accodava closure: non serializzabili, quindi un reload
// della PWA perdeva le operazioni vere e il flush ripartiva a mani vuote.
// Qui si accoda la RICHIESTA (metodo, url, body già serializzato), che si
// riesegue tale e quale al riconnettersi — anche dopo un riavvio.
//
// Regole d'uso, pensate per non fare danni:
// - si accoda SOLO su errore di rete (il server non ha mai risposto), mai su
//   una risposta HTTP: 4xx/5xx significano che il server ha deciso, e la
//   decisione non va ricontestata in coda. L'unica eccezione è il 409
//   authority_on_node: il cloud non decide, rimanda al nodo di sala;
// - solo richieste sicure da rigiocare: PUT e DELETE (idempotenti per
//   semantica) o POST con chiave di idempotenza nel body;
// - le voci scadono: rigiocare lo stato di un tavolo di ieri sera non è
//   sincronizzare, è corrompere il servizio di oggi.
//
// Col nodo di sala (fase B4) la voce tiene l'URL del cloud e la
// destinazione si decide al replay: con l'autorità in sala si rigioca sul
// nodo, altrimenti sul cloud. Comande, conti e incassi NON passano di qui:
// una comanda che arriva in cucina venti minuti dopo, quando il cameriere
// l'ha già gridata, o un incasso rigiocato al buio fanno più danni di un
// errore visibile — lì il carrello resta sul palmare con le sue chiavi e
// l'Invia si ripete a mano.
import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { routeWriteUrl, fetchNodeAware, cloudFallbackUrl, isAuthorityOnNodeRefusal } from './apiRouting';

export type QueuedRequest = {
  id: string;
  method: 'PUT' | 'DELETE' | 'POST';
  url: string;
  /** Body già serializzato in JSON, o null per le richieste senza corpo. */
  body: string | null;
  /** Frase breve per i toast: «check-in di Rossi», «stato tavolo 12». */
  description: string;
  queuedAt: string;
};

export type FlushResult = { success: number; failed: number; dropped: number };

const STORAGE_KEY = 'offline_queue_v2';
/** Oltre questa età la voce non si rigioca: il servizio è un altro. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Tetto difensivo: una coda più lunga di così è un bug, non un outage. */
const MAX_QUEUE = 200;

class OfflineQueue {
  private queue: QueuedRequest[] = [];
  private isProcessing = false;

  constructor() {
    this.loadFromStorage();
  }

  enqueue(req: Omit<QueuedRequest, 'id' | 'queuedAt'>): string | null {
    if (this.queue.length >= MAX_QUEUE) {
      console.error(`Coda offline piena (${MAX_QUEUE}): «${req.description}» non accodata`);
      return null;
    }
    const item: QueuedRequest = {
      ...req,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      queuedAt: new Date().toISOString(),
    };
    this.queue.push(item);
    this.saveToStorage();
    console.log(`📥 In coda offline: ${item.description}`);
    return item.id;
  }

  size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Rigioca la coda in ordine. Si ferma al primo errore di rete (siamo
   *  ancora offline: inutile insistere); una risposta del server, qualunque
   *  sia, chiude la voce — la rete ha consegnato, la partita è decisa. */
  async flush(): Promise<FlushResult> {
    if (this.isProcessing || this.isEmpty()) {
      return { success: 0, failed: 0, dropped: 0 };
    }
    this.isProcessing = true;

    let success = 0;
    let failed = 0;
    let dropped = 0;

    try {
      while (this.queue.length > 0) {
        const op = this.queue[0];

        if (Date.now() - new Date(op.queuedAt).getTime() > MAX_AGE_MS) {
          console.warn(`Scaduta in coda offline, non rigiocata: ${op.description}`);
          this.queue.shift();
          dropped++;
          continue;
        }

        let response: Response;
        try {
          response = await this.execute(op);
        } catch {
          // Ancora offline: la coda resta com'è, si riproverà al prossimo
          // riconnettersi.
          break;
        }

        // Risposte che non sono una decisione sulla voce: si resta in coda
        // e ci si ferma come per la rete giù. 401 = sessione da rinnovare
        // (a linea giù la proroga del nodo può essere finita), 502–504 = il
        // proxy davanti a un server che riparte, 409 authority_on_node = il
        // cloud rimanda al nodo che da qui non si raggiunge.
        if (await this.notDecided(response)) break;

        this.queue.shift();
        // Un DELETE che trova 404 ha già avuto quello che voleva: il primo
        // tentativo era passato e la risposta si era persa per strada.
        if (response.ok || (op.method === 'DELETE' && response.status === 404)) {
          success++;
          console.log(`✅ Rigiocata: ${op.description}`);
        } else {
          failed++;
          console.error(`❌ Respinta dal server (${response.status}): ${op.description}`);
        }
      }
    } finally {
      this.isProcessing = false;
      this.saveToStorage();
    }

    return { success, failed, dropped };
  }

  /** Esegue una voce con credenziali FRESCHE: il token di quando la rete è
   *  caduta può essere scaduto, e un 401 si risolve col refresh, non
   *  buttando via la scrittura. */
  private async execute(op: QueuedRequest, retried = false): Promise<Response> {
    const headers: Record<string, string> = {};
    if (op.body != null) headers['Content-Type'] = 'application/json';
    const socketId = socketClient.getSocket()?.id;
    if (socketId) headers['X-Socket-ID'] = socketId;
    const token = authApiService.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method: op.method, headers, body: op.body, cache: 'no-store' };

    // Dove vive l'autorità ADESSO: la voce può essere nata col nodo spento
    // e partire col nodo acceso, o viceversa.
    const url = routeWriteUrl(op.url, op.method);
    let response: Response;
    try {
      response = await fetchNodeAware(url, init);
    } catch (err) {
      // Nodo muto: circuito aperto e un tentativo sul cloud (che, con
      // l'autorità in sala, risponde 409 e la voce resta in coda).
      const cloudUrl = cloudFallbackUrl(url);
      if (!cloudUrl) throw err;
      response = await fetch(cloudUrl, init);
    }

    if (response.status === 401 && !retried) {
      const refreshed = await authApiService.refreshToken();
      if (refreshed) return this.execute(op, true);
    }
    return response;
  }

  private async notDecided(response: Response): Promise<boolean> {
    if (response.status === 401 || (response.status >= 502 && response.status <= 504)) return true;
    if (response.status !== 409) return false;
    const body = await response.clone().json().catch(() => null);
    return isAuthorityOnNodeRefusal(response.status, body);
  }

  clear(): void {
    this.queue = [];
    this.saveToStorage();
  }

  getAll(): Pick<QueuedRequest, 'id' | 'description' | 'queuedAt'>[] {
    return this.queue.map(({ id, description, queuedAt }) => ({ id, description, queuedAt }));
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch (error) {
      // localStorage pieno o negato: la coda vive solo in memoria, che è
      // comunque meglio di perdere la scrittura subito.
      console.error('Coda offline non persistita:', error);
    }
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return;
      this.queue = parsed.filter(
        (op: any): op is QueuedRequest =>
          op && typeof op.url === 'string' && typeof op.method === 'string'
          && typeof op.queuedAt === 'string'
      );
      if (this.queue.length > 0) {
        console.log(`📦 Coda offline ripristinata: ${this.queue.length} scritture in attesa`);
      }
    } catch (error) {
      console.error('Coda offline non leggibile, riparto vuota:', error);
    }
  }
}

export const offlineQueue = new OfflineQueue();
