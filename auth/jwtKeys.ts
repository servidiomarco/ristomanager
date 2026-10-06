// Le chiavi della firma degli access token (tappa ES256 — fase A1 del piano
// «sala, comande e conto sul nodo»).
//
// Fino a qui ogni access token era firmato HS256 con JWT_SECRET, lo stesso
// segreto che lo VERIFICA. Il nodo di sala, per riconoscere i palmari, doveva
// quindi tenere JWT_SECRET nel suo .cmd: chi leggeva quel file poteva
// coniarsi un token di qualunque tenant, piattaforma compresa (audit H-05).
// Con ES256 il cloud firma con una chiave PRIVATA che non lascia Railway; il
// nodo riceve solo le chiavi PUBBLICHE (/sala-node/credentials): verifica,
// ma non conia.
//
// La transizione si fa da env, senza deploy, in tre passi:
// 1. JWT_ES256_PRIVATE_KEY impostata → il cloud PUBBLICA la chiave pubblica
//    (il nodo la scarica e la tiene su disco) ma firma ancora HS256.
// 2. JWT_SIGN_ES256=1 → i token nuovi escono ES256. Quelli HS256 già emessi
//    restano validi fino alla scadenza (6h) finché JWT_HS256_ACCEPT non è '0'.
// 3. JWT_HS256_ACCEPT=0 sul cloud, JWT_SECRET tolto dal .cmd del nodo e
//    ruotato su Railway (è stato sul PC).
//
// Rotazione della chiave: la pubblica uscente va in
// JWT_ES256_PREVIOUS_PUBLIC_KEY per almeno 6 ore, la vita di un access token.
//
// Fuori produzione, senza chiave in env, il cloud se ne genera una usa e
// getta al boot: la suite e gli stack locali provano ES256 senza segreti.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isServiceNode } from '../services/topology.js';

export interface PublicJwtKey {
  kid: string;
  pem: string;
}

// Railway conserva le variabili su più righe, ma un incolla da terminale
// può arrivare con i "\n" letterali: si accettano tutte e due le forme.
const normalizePem = (raw: string): string => raw.replace(/\\n/g, '\n').trim();

const isP256 = (key: KeyObject): boolean =>
  key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';

// kid = impronta della chiave pubblica: stabile fra i riavvii, cambia solo
// con la chiave. Nessuna configurazione in più da tenere allineata.
const kidOf = (publicKey: KeyObject): string =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url').slice(0, 16);

const signing: { kid: string; key: KeyObject } | null = (() => {
  if (isServiceNode) return null;
  const raw = (process.env.JWT_ES256_PRIVATE_KEY || '').trim();
  if (raw) {
    const key = createPrivateKey(normalizePem(raw));
    if (!isP256(key)) throw new Error('JWT_ES256_PRIVATE_KEY deve essere una chiave EC P-256');
    const kid = (process.env.JWT_ES256_KID || '').trim() || kidOf(createPublicKey(key));
    return { kid, key };
  }
  if (process.env.NODE_ENV === 'production') return null;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { kid: kidOf(createPublicKey(privateKey)), key: privateKey };
})();

const signEs256 = process.env.JWT_SIGN_ES256 === '1';
if (signEs256 && !signing && !isServiceNode) {
  throw new Error('JWT_SIGN_ES256=1 richiede JWT_ES256_PRIVATE_KEY');
}

// Chiavi pubbliche di cui ci si fida, per kid. Sul cloud: la propria e
// l'eventuale uscente. Sul nodo: quelle ricevute dal cloud (o dalla copia
// su disco, se il nodo riparte a linea giù).
const trusted = new Map<string, KeyObject>();

if (signing) trusted.set(signing.kid, createPublicKey(signing.key));
const previousRaw = (process.env.JWT_ES256_PREVIOUS_PUBLIC_KEY || '').trim();
if (previousRaw && !isServiceNode) {
  const previous = createPublicKey(normalizePem(previousRaw));
  if (!isP256(previous)) throw new Error('JWT_ES256_PREVIOUS_PUBLIC_KEY deve essere una chiave EC P-256');
  trusted.set(kidOf(previous), previous);
}

/** La chiave con cui firmare gli access token, o null = si firma ancora HS256. */
export const getEs256SigningKey = (): { kid: string; key: KeyObject } | null =>
  signEs256 ? signing : null;

export const getTrustedPublicKey = (kid: string): KeyObject | null => trusted.get(kid) ?? null;

// --- La chiave di sessione del NODO (PIN di sala, fase A2) -----------------
// A linea giù il nodo conia lui le sessioni di chi entra col PIN. Chiave sua,
// generata alla prima accensione e tenuta su disco (0600): non lascia mai il
// PC e il cloud non la conosce, quindi un token del nodo non apre niente nel
// cloud. Il kid comincia per «node-»: due mondi che non si confondono.
export const NODE_SESSION_AUDIENCE = 'sala-node';
let nodeSession: { kid: string; key: KeyObject; publicKey: KeyObject } | null = null;

export const getNodeSessionKey = (): { kid: string; key: KeyObject; publicKey: KeyObject } | null => {
  if (!isServiceNode) return null;
  if (nodeSession) return nodeSession;
  const file = path.join(process.env.SALA_NODE_STATE_DIR || process.cwd(), 'sala-node-session-key.pem');
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(file, 'utf8'));
    if (!isP256(key)) throw new Error('curva inattesa');
  } catch {
    key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
    } catch (err: any) {
      // Senza disco la chiave vive in memoria: le sessioni PIN cadono al
      // riavvio del nodo, nient'altro.
      console.warn('[pin] chiave di sessione del nodo non scritta su disco:', err?.message || err);
    }
  }
  const publicKey = createPublicKey(key);
  nodeSession = { kid: `node-${kidOf(publicKey)}`, key, publicKey };
  return nodeSession;
};

/** Le chiavi pubbliche che il cloud consegna ai nodi. */
export const publicKeysForNodes = (): PublicJwtKey[] =>
  [...trusted.entries()].map(([kid, key]) => ({ kid, pem: key.export({ type: 'spki', format: 'pem' }) as string }));

/** Sul nodo: sostituisce l'insieme fidato con quello ricevuto dal cloud.
 *  Le voci malformate o di curva diversa si scartano. Ritorna quante ne
 *  sono state accettate (0 = insieme invariato). */
export const setTrustedPublicKeys = (keys: unknown): number => {
  if (!isServiceNode || !Array.isArray(keys)) return 0;
  const next = new Map<string, KeyObject>();
  for (const entry of keys) {
    if (typeof entry?.kid !== 'string' || !entry.kid || typeof entry?.pem !== 'string') continue;
    try {
      const key = createPublicKey(normalizePem(entry.pem));
      if (isP256(key)) next.set(entry.kid, key);
    } catch { /* voce scartata */ }
  }
  // Un elenco vuoto non cancella chiavi già note: il cloud senza chiave
  // (passo 0 della transizione) non deve spegnere un nodo che ne ha una.
  if (next.size === 0) return 0;
  trusted.clear();
  for (const [kid, key] of next) trusted.set(kid, key);
  return next.size;
};

// HS256 si accetta solo durante la transizione (passo 3: JWT_HS256_ACCEPT=0).
// Sul nodo serve in più un JWT_SECRET esplicito: vedi authService.
export const hs256Accepted = (): boolean => process.env.JWT_HS256_ACCEPT !== '0';

// Kid sconosciuto sul nodo = il cloud ha appena cambiato chiave: si chiede
// subito un rinfresco delle credenziali invece di aspettare il giro
// periodico. Al massimo uno ogni 30 secondi.
let unknownKidHandler: (() => void) | null = null;
let lastUnknownKidKick = 0;

export const setUnknownKidHandler = (handler: (() => void) | null): void => {
  unknownKidHandler = handler;
};

export const notifyUnknownKid = (): void => {
  if (!unknownKidHandler) return;
  const now = Date.now();
  if (now - lastUnknownKidKick < 30_000) return;
  lastUnknownKidKick = now;
  try { unknownKidHandler(); } catch { /* best effort */ }
};
