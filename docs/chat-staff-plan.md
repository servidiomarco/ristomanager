# Chat staff — piano tecnico

Messaggistica interna fra le sezioni del ristorante (sala, cucina, reception,
direzione). Non è una chat generica: durante il servizio lo staff segnala
("finito il branzino", "tavolo 12 chiede il conto"), non conversa. Il disegno
privilegia la velocità di invio (preset a un tap) e la consegna certa (socket
per chi ha lo schermo aperto, push per chi ha il telefono in tasca).

Tutto è costruito su tre pezzi già in produzione: il layer Socket.IO
(`services/socketService.ts`), il centro notifiche + Web Push
(`services/pushService.ts`, che persiste in `notifications` e aggiorna il
badge PWA) e `InboxPage.tsx` come blueprint UI.

## 1. Modello

### Canali fissi derivati dal ruolo — nessuna tabella di membership

Quattro canali, membership calcolata dal ruolo dell'utente. Niente canali
creabili, niente iscrizioni: chi sei decide cosa vedi.

| Canale | Ruoli membri |
|---|---|
| `generale` | tutti i ruoli del tenant |
| `sala` | WAITER + OWNER, GENERAL_MANAGER, MANAGER |
| `cucina` | KITCHEN + OWNER, GENERAL_MANAGER, MANAGER |
| `reception` | RECEPTION + OWNER, GENERAL_MANAGER, MANAGER |

PLATFORM_ADMIN è fuori: non entra nella room del tenant (vedi guardia D2 in
`socketService.ts`) e dentro un tenant si opera impersonando l'OWNER.

### Messaggi diretti

1-a-1 fra due utenti attivi dello stesso tenant. Nessun gruppo ad hoc: per
parlare a una sezione c'è il canale.

### Thread key

Ogni superficie (route, socket, cursori di lettura, deep-link push) identifica
un thread con la stessa stringa:

- `channel:<nome>` — es. `channel:cucina`
- `dm:<userId>` — l'id **dell'altro** utente, dal punto di vista di chi guarda.
  Nel DB il messaggio diretto porta mittente e destinatario espliciti; il
  threadKey è derivato lato client/server, mai persistito nel messaggio.

### Modulo condiviso `services/staffChat.ts`

Importato da entrambi i lati (come `text.ts`): quindi **import relativi con
estensione `.js`** al suo interno, e ships già col Dockerfile (copia
`services/`). Contiene:

```ts
export const STAFF_CHANNELS = ['generale', 'sala', 'cucina', 'reception'] as const;
export type StaffChannel = (typeof STAFF_CHANNELS)[number];

// Un'unica mappa: channelsForRole e rolesForChannel sono le due letture.
const CHANNEL_ROLES: Record<StaffChannel, UserRole[]> = { ... };

export const channelsForRole = (role: UserRole): StaffChannel[] => ...;
export const rolesForChannel = (channel: StaffChannel): UserRole[] => ...;

// threadKey: parsing e costruzione, unico punto di verità sul formato.
export type StaffThreadRef =
  | { kind: 'channel'; channel: StaffChannel }
  | { kind: 'direct'; otherUserId: number };
export const parseThreadKey = (key: string): StaffThreadRef | null => ...;
export const threadKeyFor = (msg: StaffMessage, myUserId: number): string => ...;

// Preset rapidi (MVP hardcoded; tabella gestibile rimandata).
export const STAFF_MESSAGE_PRESETS: { key: string; label: string }[] = [
  { key: 'piatto-finito',   label: 'Piatto finito' },
  { key: 'serve-runner',    label: 'Serve un runner' },
  { key: 'conto-richiesto', label: 'Chiedono il conto' },
  { key: 'vip-in-arrivo',   label: 'VIP in arrivo' },
  { key: 'walkin-gruppo',   label: 'Gruppo senza prenotazione' },
];
```

Il preset inserisce la sua label come `body` (eventualmente completata a mano)
e salva `preset_key` per icona/colore in lista.

## 2. Schema

Una migration (`npm run migrate:create -- chat-interna-staff`), due tabelle.
`createSchema` non si tocca (è frozen).

### `staff_messages`

```sql
CREATE TABLE staff_messages (
    id                    BIGSERIAL PRIMARY KEY,
    tenant_id             BIGINT NOT NULL,
    kind                  VARCHAR(10) NOT NULL CHECK (kind IN ('channel', 'direct')),
    channel               VARCHAR(20) CHECK (channel IN ('generale', 'sala', 'cucina', 'reception')),
    -- Mittente denormalizzato come in activity_logs: la riga sopravvive
    -- alla cancellazione dell'utente e la lista non fa join su users.
    sender_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sender_name           TEXT NOT NULL,
    sender_role           VARCHAR(20) NOT NULL,
    recipient_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    recipient_name        TEXT,
    body                  TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    preset_key            VARCHAR(40),
    -- Aggancio al contesto, come todos.linked_reservation_id: "tavolo 12
    -- chiede il conto" apre il tavolo con un tap.
    linked_reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    linked_table_id       INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- kind è il discriminante, i CHECK impediscono righe ibride. La coppia
    -- (recipient_user_id, recipient_name) può degradare a solo name se
    -- l'utente viene cancellato (SET NULL), per questo il vincolo è "OR".
    CHECK (kind <> 'channel' OR channel IS NOT NULL),
    CHECK (kind <> 'direct'  OR recipient_user_id IS NOT NULL OR recipient_name IS NOT NULL)
);
```

`id BIGSERIAL` è anche l'ordine totale del thread: paginazione e cursori di
lettura ragionano per id, mai per timestamp (niente ambiguità su messaggi nello
stesso millisecondo).

Indici — le tre query calde sono "thread di canale", "thread DM", entrambe
paginate per id discendente:

```sql
CREATE INDEX staff_messages_canale
    ON staff_messages (tenant_id, channel, id DESC)
    WHERE kind = 'channel';
-- Il thread DM filtra con OR sui due versi (io→lui, lui→io): due indici
-- parziali, il planner li combina in BitmapOr. A volumi da ristorante è
-- ampiamente sufficiente.
CREATE INDEX staff_messages_dm_mittente
    ON staff_messages (tenant_id, sender_user_id, id DESC)
    WHERE kind = 'direct';
CREATE INDEX staff_messages_dm_destinatario
    ON staff_messages (tenant_id, recipient_user_id, id DESC)
    WHERE kind = 'direct';
```

### `staff_message_reads` — cursore di lettura, non ricevute per-messaggio

Una riga per (utente, thread) col massimo id letto — modello WhatsApp. Non
letti = messaggi del thread con `id > last_read_message_id` e mittente diverso
da me. Cursore assente = tutto non letto (l'UI tronca a "99+").

```sql
CREATE TABLE staff_message_reads (
    tenant_id            BIGINT NOT NULL,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_key           VARCHAR(40) NOT NULL,
    last_read_message_id BIGINT NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id, thread_key)
);
```

### RLS

La migration B4 ha coperto le tabelle esistenti: **ogni tabella nuova porta la
sua policy nella propria migration**, espressione copiata verbatim da
`1787600000000_outbox-eventi-comanda.js` (tenant match, oppure contesto
assente con strict spento o bypass acceso):

```sql
ALTER TABLE staff_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_messages USING (...) WITH CHECK (...);
-- idem per staff_message_reads
```

In produzione `app.rls_strict` è acceso a livello database (fuori dal repo):
tutte le query delle route passano da `tenantQuery`/`withTenant`, senza
eccezioni. Prima del deploy: `TEST_STRICT_RLS=1 npm test`.

### Seed del permesso (stessa migration)

Le migration girano con `app.rls_bypass = 'on'` (db.ts, `runMigrations`),
quindi l'insert cross-tenant passa anche sotto strict:

```sql
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, r.role, 'staffchat:use'
  FROM tenants t
 CROSS JOIN (VALUES ('PLATFORM_ADMIN'), ('OWNER'), ('GENERAL_MANAGER'),
                    ('MANAGER'), ('RECEPTION'), ('WAITER'), ('KITCHEN')) AS r(role)
    ON CONFLICT DO NOTHING;
```

`down`: `DELETE FROM role_permissions WHERE permission = 'staffchat:use'` +
`DROP TABLE` delle due tabelle.

## 3. Permesso `staffchat:use`

Un solo permesso: chi ce l'ha legge e scrive nei canali del suo ruolo e nei
DM. Tutti i ruoli lo ricevono di default; il singolo ristorante può toglierlo
a un ruolo dalla UI permessi. I quattro punti da toccare (regola: matrice,
guardia route, gate vista):

1. `auth/permissions.ts` — union `Permission` + `ROLE_PERMISSIONS` (tutti i
   ruoli) + `VIEW_PERMISSIONS[ViewState.CHAT_STAFF] = ['staffchat:use']`.
2. `auth/permissionService.ts` — `ALL_PERMISSIONS`: nuova feature
   `{ feature: 'Chat staff', permissions: ['staffchat:use'] }` (così compare
   da sola in `RolePermissions.tsx`).
3. Migration — seed per-tenant (sopra). I seed in `createSchema` sono baseline
   congelata del tenant 1, non si toccano.
4. Route — `authenticate, requirePermission('staffchat:use')` su tutte.

Nessun entitlement in `tenant_features`: è una feature di piattaforma per
tutti i tenant, non una integrazione a pagamento (il checklist a 8 punti degli
entitlement non si applica).

## 4. Route API

Blocco unico in `server.ts` con banner `// ==================== CHAT STAFF
====================`. Tutte con `authenticate` + `requirePermission
('staffchat:use')`, tutte su `tenantQuery`. Il client manda `X-Socket-ID`
come gli altri servizi.

### `GET /staff-chat/threads`

La schermata d'ingresso in una chiamata: canali visibili al ruolo (sempre
presenti, anche vuoti), thread DM esistenti, colleghi con cui aprirne di nuovi.

```jsonc
{
  "threads": [
    { "threadKey": "channel:sala", "kind": "channel", "channel": "sala",
      "lastMessage": { /* StaffMessage */ } | null, "unreadCount": 3 },
    { "threadKey": "dm:42", "kind": "direct",
      "otherUser": { "id": 42, "fullName": "Anna Bianchi", "role": "WAITER", "isActive": true },
      "lastMessage": { /* ... */ }, "unreadCount": 0 }
  ],
  "colleagues": [ { "id": 42, "fullName": "Anna Bianchi", "role": "WAITER" } ]
}
```

- Canali: `channelsForRole(req.user.role)`; ultimo messaggio con
  `DISTINCT ON (channel)`, non letti col join sul cursore
  (`sender_user_id IS DISTINCT FROM $me AND id > COALESCE(cursor, 0)`).
- DM: righe `kind='direct'` dove compaio, raggruppate sul contraltare
  (`CASE WHEN sender_user_id = $me THEN recipient_user_id ELSE sender_user_id END`).
- `colleagues`: utenti attivi del tenant, escluso me. Ordinamento thread:
  ultimo messaggio discendente, canali senza traffico in coda.

### `GET /staff-chat/threads/:threadKey/messages?before=<id>&limit=<n>`

Pagina di thread, id discendente, restituita in ordine cronologico ascendente.
`limit` default 50 max 100; `before` assente = pagina più recente.

Controllo d'accesso (identico sulla POST): `parseThreadKey`, poi

- canale → deve stare in `channelsForRole(req.user.role)`, altrimenti 403;
- DM → l'altro utente deve esistere ed essere del tenant (la RLS copre, la
  query verifica per dare un 404 pulito).

### `POST /staff-chat/messages`

```jsonc
{ "threadKey": "channel:cucina", "body": "Finito il branzino",
  "presetKey": "piatto-finito",          // opzionale
  "linkedReservationId": null, "linkedTableId": null }   // opzionali
```

- Validazioni: `body` trim non vuoto ≤ 1000; `presetKey` ∈
  `STAFF_MESSAGE_PRESETS` o scartato; per i DM il destinatario dev'essere
  attivo e diverso da me; i linked id verificati con una `tenantQuery`
  d'esistenza.
- `sender_name` dal record utente (lookup su `users`, non dal token: il nome
  può cambiare), `sender_role` dal token.
- Risposta `201` col messaggio creato (il mittente aggiorna il proprio stato
  dalla risposta; il broadcast lo esclude via `X-Socket-ID`, pattern tavoli).
- Side effect nell'ordine: INSERT → broadcast socket → push (push in
  try/catch: un fallimento web-push non deve far fallire l'invio).

### `POST /staff-chat/threads/:threadKey/read`

```jsonc
{ "lastReadMessageId": 1234 }
```

Upsert monotono del cursore:

```sql
INSERT INTO staff_message_reads (tenant_id, user_id, thread_key, last_read_message_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, user_id, thread_key)
DO UPDATE SET last_read_message_id = GREATEST(staff_message_reads.last_read_message_id, EXCLUDED.last_read_message_id),
              updated_at = CURRENT_TIMESTAMP;
```

Poi `staffchat:read` verso la room del solo utente (altri suoi device
allineano il badge), escludendo `X-Socket-ID`.

### `GET /staff-chat/unread-count`

`{ "count": n }` — somma non letti sui thread visibili. Serve al boot per il
badge in nav (poi vive di eventi socket), stesso ruolo di
`/messages/unread-count`.

## 5. Realtime

### Room nuove in `socketService.ts`

Nel connection handler, accanto al join `tenant:${tenantId}` (stessa guardia
PLATFORM_ADMIN):

```ts
socket.join(`tenant:${tenantId}:user:${socket.user!.userId}`);
socket.join(`tenant:${tenantId}:role:${socket.user!.role}`);
```

Join automatico, **non** su subscribe del client (a differenza di
`station:*`): la membership discende dal JWT, non è una scelta della UI. Un
cambio ruolo diventa effettivo alla riconnessione (refresh token → nuovo
handshake), coerente con come il ruolo vive nel token oggi.

Il DM non può passare da `broadcastToAll`: arriverebbe a tutto il tenant. Due
metodi nuovi:

```ts
broadcastToUsers(tenantId, userIds: number[], event, data, excludeSocketId?)  // io.to([room…]).except(…)
broadcastToRolesRoom(tenantId, roles: string[], event, data, excludeSocketId?)
```

`io.to([...])` deduplica i socket presenti in più room. (Il nome
`broadcastToRolesRoom` evita la collisione con `pushService.sendToRoles`.)

### Eventi

| Evento | Room | Payload |
|---|---|---|
| `staffchat:message` | canale → `role:*` dei ruoli membri; DM → `user:*` di mittente e destinatario | il messaggio; il client ricava il threadKey con `threadKeyFor(msg, myUserId)` |
| `staffchat:read` | `user:*` di chi ha letto | `{ threadKey, lastReadMessageId }` |

Esclusione mittente via `X-Socket-ID` su entrambi (chi origina ha già la
risposta HTTP); il mittente resta incluso come *utente* nel giro DM, così i
suoi altri device vedono il messaggio.

## 6. Push

Sulla POST, dopo il broadcast — API esistenti di `pushService`, nessuna
modifica al servizio:

- **DM**: `sendToUser(recipientUserId, payload)`.
- **Canale**: `sendToRoles(tenantId, rolesForChannel(channel), payload,
  { excludeUserId: senderUserId })`.

Payload:

```ts
{ title: senderName,                       // DM
  // canale: `${senderName} · ${labelCanale}`
  body: body.slice(0, 120),
  url: `/?staffchat=${encodeURIComponent(threadKey)}`,
  tag: `staffchat:${threadKey}`,           // i messaggi dello stesso thread collassano
  category: 'staff',
  persist: false }
```

`persist: false` è deliberato: la chat ha già il suo stato di lettura, una
riga in `notifications` per ogni messaggio farebbe del centro notifiche un
duplicato rumoroso della chat. Conseguenza accettata nell'MVP: i non letti
chat non entrano in `computeAttentionBadge` (badge icona PWA) — rifinitura
rimandata (§9).

Il deep-link `?staffchat=` viaggia sul canale già esistente
(`sw.js` → `NOTIFICATION_CLICK` → SPA): in `App.tsx` va aggiunto il ramo che
lo risolve in `setView(ViewState.CHAT_STAFF)` + thread aperto.

## 7. Frontend (perimetro, non specifica)

- `types.ts`: `ViewState.CHAT_STAFF`; tipi `StaffMessage`, `StaffThread`.
- `components/StaffChatPage.tsx` ricalcata su `InboxPage.tsx`: `SplitPane`
  lista thread + thread aperto, `useMediaQuery` per sheet mobile, composer con
  chip preset, tutto da `components/ds` e token `--ds-*`.
- `services/staffChatApiService.ts` con header `X-Socket-ID` in `getHeaders()`.
- `App.tsx`: stato `staffChatUnreadCount` (boot da `/staff-chat/unread-count`,
  live su `staffchat:message`/`staffchat:read` col pattern
  `attach/onSocketChange`), voce in nav con `CountBadge`, somma in
  `commsBadgeTotal`, ramo deep-link `?staffchat=`.
- Copy: minuscolo, asciutto (§5.2 e §10 del design system).

## 8. Piano PR e verifica

1. **PR 1 — backend completo**: migration, `services/staffChat.ts`, permesso
   (4 punti), route, room + metodi socket, push, test API
   `tests/api/staff-chat.test.ts` (canale: invio/lettura/non letti; DM fra due
   utenti; 403 su canale fuori ruolo; cursore monotono). Attenzione allo stato
   condiviso: i file di test girano in sequenza sullo stesso DB.
2. **PR 2 — frontend**: pagina, badge, deep-link.
3. **PR 3 — rifiniture** (dopo uso reale in servizio): vedi §9.

Gate: `npx tsc --noEmit`, `npx vite build`, `npm test`, e
`TEST_STRICT_RLS=1 npm test` (route nuove su percorsi DB). Dockerfile: nessuna
modifica (`services/` e `migrations/` sono già copiati).

## 9. Deliberatamente fuori dall'MVP

- **Allegati / foto** (riusare `outbound_media` o `media_library`).
- **Menzioni @utente** con push mirato dentro un canale.
- **Preset gestibili da UI** (tabella sul modello `reservation_note_presets`).
- **Banner cucina sul KDS** (striscia per i messaggi del canale `cucina`
  dentro `KitchenDisplay.tsx`, senza aprire la chat).
- **Chat nel badge PWA**: subquery non letti in `computeAttentionBadge` +
  `useAppBadge`.
- **Throttling push sui canali** se il volume in servizio si rivela rumoroso
  (oggi: un push per messaggio, collassato dal `tag`).
- **Retention**: nessuna cancellazione automatica per ora; se la tabella
  cresce, purge dei messaggi > 90 giorni nello scheduler esistente.
- **Ricevute di lettura visibili agli altri** (il cursore è per il proprio
  badge, non mostrato ai colleghi).
