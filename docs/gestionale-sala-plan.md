# Gestionale di Sala (comande + KDS) — Piano di Integrazione

Obiettivo: portare dentro il CRM il flusso operativo del servizio — **comanda
dal palmare → monitor cucina/bar → conto al tavolo** — senza nessuna stampa su
carta, riusando il pay-at-table già in produzione.

## Premessa: stack e confini

Lo stack è quello esistente: **Express + PostgreSQL + Socket.IO + React/Vite**.
Nessun servizio nuovo, nessun database nuovo, nessun broker di code. Il monitor
di cucina è una vista React che ascolta gli stessi socket che oggi muovono
prenotazioni e tavoli.

**Fuori scope di questo piano** (deliberatamente):

- **Registratore Telematico / documento commerciale.** Il gestionale si ferma
  al conto: totale, righe, incasso via Revolut o contanti. L'emissione del
  documento commerciale e la trasmissione dei corrispettivi restano fuori. Il
  confine è netto — `table_bills` è già il punto di aggancio naturale
  (`external_ref` è lì apposta) e un modulo RT futuro leggerà da lì senza
  toccare comande o KDS.
- Contabilità, food cost analitico, scarico magazzino da distinta base. Il
  gancio a `inventory_movements` è previsto ma è Fase 4.
- Asporto e delivery. Il modello dati non li esclude (vedi `order_type`), ma
  l'UI di questo piano è solo sala.

## Terminologia

Il dominio ha due oggetti che in italiano si confondono di continuo. Nel codice
li teniamo separati e in inglese, coerentemente con il resto della repo:

| Concetto | Tabella | Cos'è |
|---|---|---|
| **Comanda** | `orders` + `order_items` | Cosa è stato ordinato e a che punto è la preparazione. Vive in cucina. |
| **Conto** | `table_bills` + `table_bill_splits` | Quanto si deve e chi paga. Vive alla cassa. Già esistente. |

Sono due macchine a stati diverse con cicli di vita diversi: una comanda può
essere stornata dopo essere stata servita, un conto può restare aperto mentre
arrivano altre comande. Fonderle è l'errore classico dei POS fatti in casa —
ci si accorge del problema al primo storno post-pagamento.

## Cosa esiste già e viene riusato

| Mattone | Dove | Riuso |
|---|---|---|
| Anagrafica piatti | `dishes` (`db.ts:268`), `MenuManager.tsx` | catalogo comande |
| Mappa sala, stati, unioni | `tables`, `table_merges` (`db.ts:168,200`) | selezione tavolo |
| Conto, split, QR, Revolut | `table_bills`, `table_bill_splits` (`db.ts:509,538`) | chiusura conto |
| Broadcast realtime | `services/socketService.ts` | monitor cucina |
| Ruoli WAITER / KITCHEN | `auth/permissions.ts` | chi vede cosa |
| Feature flag runtime | `getFeatureFlag` (`server.ts:12530`) | rollout graduale |
| Coda offline + PWA | `services/offlineQueue.ts`, `pushClient.ts` | palmare con WiFi ballerino |
| Audit log | `activity_logs` (`db.ts:660`) | storni e sconti tracciati |

E l'aggancio è già dichiarato nel codice — `types.ts`, su `TableBill`:

```ts
// `items` is JSONB reserved for Fase 2 (Passepartout), unused today.
items: TableBillItem[] | null;
```

Oggi il cameriere digita a mano `total_cents` (`server.ts:3200`). Questo piano
è, in una riga, **ciò che riempie quel campo da solo**.

---

## Modello dati

### 1. Listini — `menu_price_lists`, `dish_prices`

`dishes.price` è un prezzo unico. Serve differenziare sala / asporto / eventi,
e cambiare i prezzi stagionali senza perdere lo storico dei conti già chiusi.

```sql
CREATE TABLE IF NOT EXISTS menu_price_lists (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- un solo listino di default
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_lists_single_default
    ON menu_price_lists(is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS dish_prices (
    dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    price_list_id INTEGER NOT NULL REFERENCES menu_price_lists(id) ON DELETE CASCADE,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    PRIMARY KEY (dish_id, price_list_id)
);
```

**Nota sulle unità.** `dishes.price` è `DECIMAL(10,2)`, tutto il mondo conto è
`INTEGER` in centesimi. Da qui in avanti **i centesimi vincono**: ogni importo
nuovo è `INTEGER`. La conversione avviene in un punto solo, alla lettura del
listino, con `ROUND(price * 100)`. Non propagare i decimali dentro le comande —
è la sorgente numero uno di conti che sballano di un centesimo.

Migrazione: alla prima esecuzione si crea il listino `Sala` come default e si
copia `ROUND(dishes.price * 100)` in `dish_prices`. Zero configurazione per
l'utente, il comportamento attuale resta identico.

### 2. Varianti — `modifier_groups`, `modifiers`, `dish_modifier_groups`

«Senza cipolla», «cottura al sangue», «+ bufala € 2». Vanno previste dal primo
giorno: aggiungerle dopo significa riscrivere il calcolo del totale, il KDS e
la stampa del conto.

```sql
CREATE TABLE IF NOT EXISTS modifier_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,            -- "Cottura", "Aggiunte", "Rimuovi"
    min_select INTEGER NOT NULL DEFAULT 0, -- 1 = obbligatorio
    max_select INTEGER NOT NULL DEFAULT 1, -- >1 = multi-scelta
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS modifiers (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,            -- "Al sangue", "Senza cipolla"
    price_delta_cents INTEGER NOT NULL DEFAULT 0,  -- può essere negativo
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dish_modifier_groups (
    dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (dish_id, group_id)
);
```

I gruppi sono riusabili fra piatti (un solo gruppo «Cottura» per tutte le
carni). Sulla riga di comanda i modificatori vengono **snapshottati in JSONB**,
non referenziati: se domani il prezzo di «+ bufala» cambia, i conti di ieri non
si devono muovere.

### 3. Partite di preparazione — `stations`

Il routing delle righe verso il monitor giusto: freddi, caldi, pizzeria, bar,
dolci.

```sql
CREATE TABLE IF NOT EXISTS stations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    color VARCHAR(20),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE dishes ADD COLUMN IF NOT EXISTS station_id INTEGER
    REFERENCES stations(id) ON DELETE SET NULL;
```

`station_id` nullable: i piatti senza partita finiscono nel monitor generico.
Nessuna migrazione forzata sui piatti esistenti.

### 4. Comande — `orders`, `order_items`

Il cuore.

```sql
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    table_bill_id INTEGER REFERENCES table_bills(id) ON DELETE SET NULL,
    order_type VARCHAR(20) NOT NULL DEFAULT 'DINE_IN',  -- DINE_IN | TAKEAWAY (futuro)
    price_list_id INTEGER REFERENCES menu_price_lists(id) ON DELETE SET NULL,
    covers INTEGER NOT NULL DEFAULT 1 CHECK (covers > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED | VOIDED
    opened_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ,
    notes TEXT,
    CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_orders_open_table
    ON orders(table_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_orders_bill ON orders(table_bill_id)
    WHERE table_bill_id IS NOT NULL;
```

`reservation_id` **nullable** è intenzionale: i walk-in non hanno prenotazione.
Vedi «Walk-in» più avanti — è l'unico punto in cui il pay-at-table esistente va
esteso.

```sql
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    dish_id INTEGER REFERENCES dishes(id) ON DELETE SET NULL,

    -- snapshot: il conto di ieri non cambia se domani rinomini il piatto
    name_snapshot VARCHAR(255) NOT NULL,
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    modifiers JSONB,          -- [{name, price_delta_cents}] già risolti
    qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),

    course_no INTEGER NOT NULL DEFAULT 1,   -- uscita: 1ª, 2ª, ...
    seat_no INTEGER,                        -- coperto, per "chi ha ordinato cosa"
    station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    note TEXT,                              -- nota libera al cuoco

    sent_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    served_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    voided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    void_reason TEXT,

    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_kds
    ON order_items(station_id, status) WHERE status IN ('SENT','PREPARING','READY');
```

Il **prezzo di riga** è `(unit_price_cents + Σ modifiers.price_delta_cents) * qty`.
Calcolato server-side, mai fidarsi del client — il palmare è un tablet in mano
a chiunque passi in sala.

### 5. Macchina a stati della riga

```
DRAFT ──invio──> SENT ──presa in carico──> PREPARING ──pronto──> READY ──ritirato──> SERVED
  │                │                           │                   │
  │                └───────────────┬───────────┴───────────────────┘
  └── delete libero                └── VOIDED (richiede motivazione + permesso)
```

Regole non negoziabili:

- **`DRAFT` si può cancellare, il resto no.** Finché la riga non è partita per
  la cucina il cameriere corregge liberamente. Dopo l'invio esiste solo lo
  storno, che lascia traccia.
- **Lo storno di una riga oltre `SENT` richiede `orders:void`** e una
  motivazione non vuota. Finisce in `activity_logs` con un `ResourceType.ORDER`
  nuovo, da aggiungere all'enum in `types.ts`.
- **Una riga `VOIDED` non concorre al totale** ma resta visibile nel dettaglio
  conto (barrata) e nelle statistiche di scarto.
- Il KDS scrive solo `SENT → PREPARING → READY`. Il passaggio a `SERVED` è
  della sala. Nessuna delle due parti può tornare indietro nel flusso senza
  passare da uno storno esplicito.

### 6. Il ponte comanda → conto

Qui sta la parte delicata, perché il conto esistente ha già un trigger che
protegge la somma degli split (`db.ts:600`, `enforce_table_bill_split_sum`).

**Regola d'oro: `table_bills.total_cents` diventa un valore derivato.**

```
total_cents = Σ (unit_price_cents + Σ modifier deltas) * qty
              su order_items non VOIDED delle orders con quel table_bill_id
            + coperti
            + servizio
            − sconti
```

Ricalcolato server-side dentro la stessa transazione, a ogni mutazione di riga.
Non è un campo che il client può scrivere.

Il conflitto da gestire: **il totale può scendere** (uno storno) sotto la somma
degli split già `CLAIMED`/`PAID`. Il trigger blocca gli split che sfondano il
totale, ma non il contrario. Serve quindi la regola simmetrica, applicata dal
ricalcolo:

- `nuovo_totale >= Σ split (CLAIMED|PAID)` → ricalcolo applicato.
- `nuovo_totale < Σ split PAID` → **rifiutato con 409**. Significa che gli
  ospiti hanno già pagato più di quanto il conto ora vale: la strada corretta è
  il rimborso via `POST /bills/splits/:id/refund`, che esiste già.
- `nuovo_totale` sta fra `Σ PAID` e `Σ (CLAIMED|PAID)` → i claim non pagati più
  recenti vengono rilasciati (`RELEASED`) fino a rientrare, poi il ricalcolo
  passa. Gli ospiti coinvolti vedono il residuo aggiornarsi in tempo reale
  (la pagina pubblica già fa polling).

Tutto questo dentro una transazione con `SELECT ... FOR UPDATE` sul bill, come
già fa `POST /bills/:id/close` (`server.ts:3390`).

Alla chiusura del conto, `table_bills.items` viene popolato con lo snapshot
delle righe — è esattamente il campo `TableBillItem[]` già dichiarato in
`types.ts`. Da lì in poi la pagina pubblica può mostrare il dettaglio invece
del solo totale, e lo split `per_item` (già previsto in `SplitKind`) diventa
finalmente implementabile.

### 7. Walk-in — l'unica estensione al pay-at-table

Oggi il conto si apre solo da una prenotazione: `POST /reservations/:id/bill`.
Un tavolo che entra senza prenotare non ha un `id` da mettere nell'URL.

`table_bills.reservation_id` è già nullable, quindi non serve migrare nulla:
basta un endpoint gemello `POST /tables/:id/bill` con la stessa logica e lo
stesso controllo «esiste già un bill attivo». Il controllo di unicità passa da
`reservation_id` a `COALESCE(reservation_id, -table_id)` per coprire entrambi i
casi con un indice solo:

```sql
-- serve prima il vincolo che garantisce che almeno una delle due colonne
-- sia valorizzata, altrimenti COALESCE(NULL, NULL) collassa tutti i bill
-- orfani sulla stessa chiave
ALTER TABLE table_bills ADD CONSTRAINT table_bills_anchor_present
    CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_table_bills_one_active
    ON table_bills(COALESCE(reservation_id, -table_id))
    WHERE status IN ('OPEN','LOCKED','SETTLED','SETTLED_PARTIAL');
```

Il `NOT VALID` evita che la migrazione fallisca su eventuali righe storiche con
`table_id` già azzerato da un `ON DELETE SET NULL`: il vincolo si applica solo
alle scritture nuove.

Nota: questo sostituisce il controllo applicativo con uno strutturale, quindi
chiude anche la race condition che oggi esiste fra due camerieri che aprono il
conto sullo stesso tavolo nello stesso istante.

### 8. Coperti e servizio

Righe di sistema, non piatti. Aggiunte automaticamente all'apertura della
comanda leggendo due chiavi nuove in `app_settings` — `cover_charge_cents` e
`service_charge_percent`, entrambe su `int_value`, la colonna companion che la
tabella ha già per i valori numerici (`db.ts:1664`) — con `dish_id NULL` e
`name_snapshot` = «Coperto».
Modificabili dal cameriere con permesso, perché il caso «coperto non dovuto»
esiste e va gestito senza chiamare l'amministratore.

---

## API

Tutti gli endpoint dietro `authenticate` e dietro il feature flag
`table_orders_enabled` (default `false`), esattamente come `pay_at_table_enabled`.

| Metodo | Path | Permesso | Cosa fa |
|---|---|---|---|
| `POST` | `/orders` | `orders:take` | Apre comanda su tavolo/prenotazione (idempotente, vedi sotto) |
| `GET` | `/orders/:id` | `orders:view` | Comanda + righe + totale calcolato |
| `GET` | `/tables/:id/order` | `orders:view` | Comanda aperta sul tavolo, se esiste |
| `POST` | `/orders/:id/items` | `orders:take` | Aggiunge righe in `DRAFT` (batch) |
| `PATCH` | `/orders/items/:id` | `orders:take` | Modifica qty/note/uscita — solo se `DRAFT` |
| `DELETE` | `/orders/items/:id` | `orders:take` | Elimina — solo se `DRAFT` |
| `POST` | `/orders/:id/send` | `orders:take` | `DRAFT → SENT`, opzionale `course_no` per mandare una sola uscita |
| `POST` | `/orders/items/:id/void` | `orders:void` | Storno con motivazione obbligatoria |
| `POST` | `/orders/:id/transfer` | `orders:take` | Sposta la comanda su un altro tavolo |
| `GET` | `/kds/queue` | `orders:kds` | Coda per partita (`?station_id=`) |
| `POST` | `/kds/items/:id/status` | `orders:kds` | `PREPARING` / `READY` |
| `POST` | `/orders/:id/close` | `orders:take` | Chiude comanda e genera/aggiorna il `table_bill` |
| CRUD | `/stations`, `/modifier-groups`, `/price-lists` | `menu:full` | Configurazione |

**Idempotenza.** `POST /orders` e `POST /orders/:id/items` accettano un header
`Idempotency-Key` generato dal client. Il palmare in sala perde il WiFi a metà
richiesta e ritenta — senza chiave, il tavolo si ritrova due volte lo stesso
antipasto e il cliente se ne accorge prima di noi. La chiave va in una colonna
`UNIQUE` su `orders` / `order_items`; il replay restituisce la risorsa
esistente con `200` invece di crearne una nuova. Si integra direttamente con
`services/offlineQueue.ts`, che già fa da coda di ritentativi.

---

## Eventi Socket.IO

Convenzione `namespace:evento` come il resto (`services/socketService.ts`):

| Evento | Payload | Chi ascolta |
|---|---|---|
| `order:created` | `Order` | sala |
| `order:updated` | `Order` (con totale) | sala, cassa |
| `order:sent` | `{ order_id, items[] }` | **KDS** |
| `orderItem:status` | `{ id, status, station_id, ts }` | KDS + sala |
| `orderItem:voided` | `{ id, order_id, reason }` | KDS + sala |
| `bill:updated` | `TableBillWithSplits` | cassa + pagina pubblica |

Il KDS si iscrive alla propria partita con `subscribe:station` — il pattern
`subscribe:room` esiste già (`socketService.ts:76`) e si clona pari pari. Un
monitor pizzeria non deve ricevere il traffico dei dolci.

`bill:updated` è nuovo ma affianca `bill:opened`/`bill:closed` già emessi
(`server.ts:3252,3461`), quindi la pagina pubblica di pagamento si aggiorna in
tempo reale invece di aspettare il polling.

---

## Permessi e ruoli

Quattro permessi nuovi in `auth/permissions.ts`, più la voce in
`ALL_PERMISSIONS` (`auth/permissionService.ts:8`) così compaiono nella UI di
`RolePermissions.tsx` senza altro lavoro:

```ts
| 'orders:view'    // vede comande e conti di sala
| 'orders:take'    // prende e invia comande
| 'orders:kds'     // opera sul monitor di cucina
| 'orders:void'    // storna righe già inviate
```

Assegnazione di default:

| Ruolo | Permessi |
|---|---|
| OWNER / GENERAL_MANAGER | tutti e quattro |
| MANAGER | `view`, `take`, `void` |
| WAITER | `view`, `take` |
| KITCHEN | `view`, `kds` |
| RECEPTION | `view` |

Nota: `KITCHEN` oggi ha `inventory:full` ma non vede le prenotazioni in
dettaglio. Con `orders:kds` la cucina guadagna una vista propria senza toccare
il resto — nessuna regressione sui permessi esistenti.

Due `ViewState` nuovi (`types.ts`) con il relativo `VIEW_PERMISSIONS`:
`COMANDE` → `orders:take`, `CUCINA` → `orders:kds`.

---

## UI

### A. Palmare cameriere — `components/OrderPad.tsx`

Pensato per una mano sola su telefono, in piedi, con poca luce.

```
┌─────────────────────────────┐
│  ← Tav. 12 · 4 cop · Rossi  │   ← prenotazione agganciata: nome e allergeni
│  ⚠ Glutine (Maria)          │      arrivano dal CRM, gratis
├─────────────────────────────┤
│ [Antipasti][Primi][Secondi] │   ← categorie da dishes.category
│                             │
│  Tagliere              14,00│   ← tap = +1
│  Bruschette             8,00│      long-press = varianti
│  Polpo                 18,00│
├─────────────────────────────┤
│  1ª USCITA                  │
│   2× Tagliere         28,00 │
│   1× Polpo            18,00 │
│     ↳ senza aglio           │
│  2ª USCITA            [+]   │
├─────────────────────────────┤
│  Totale 46,00   [ INVIA ]   │
└─────────────────────────────┘
```

Dettagli che decidono se il cameriere lo usa o torna al blocchetto:

- Gli **allergeni della prenotazione** (`reservation_allergen_presets`,
  `customer_dietary_notes`) compaiono in testa e viaggiano sulla comanda fino
  al monitor di cucina. È il pezzo che nessun POS standalone può fare e il tuo
  CRM ha già in tabella.
- **Le uscite si gestiscono qui**, trascinando le righe. Mandare la seconda
  uscita è un tap, non un nuovo giro di comanda.
- Il carrello resta in `DRAFT` locale finché non si preme INVIA: il cameriere
  può correggersi senza generare rumore in cucina.

### B. Monitor cucina — `components/KitchenDisplay.tsx`

A colonne, per tavolo, ordinate per anzianità. Nessuna interazione fine: si usa
con le mani sporche, i target di tap sono grandi.

```
┌──────────┬──────────┬──────────┐
│  T12 4' │  T7  9'  │  T3  14' │  ← timer, verde→ambra→rosso
│  1ª usc. │  2ª usc. │  1ª usc. │
├──────────┼──────────┼──────────┤
│ 2 Taglie │ 3 Cacio  │ 1 Polpo  │
│ 1 Polpo  │ 1 Amatri │ 2 Tartar │
│  ⚠glutine│          │          │
├──────────┼──────────┼──────────┤
│ [PRONTO] │ [PRONTO] │ [PRONTO] │
└──────────┴──────────┴──────────┘
```

- Una colonna per tavolo/uscita, non per riga: il cuoco ragiona per tavolo.
- Timer dal `sent_at`, soglie configurabili. È il singolo indicatore che fa
  guadagnare più minuti a servizio.
- Filtro per partita via `subscribe:station`.
- **Modalità sola lettura** su schermo grande + **modalità tap** su tablet.
- Riconnessione: alla `connect` del socket il KDS rifà `GET /kds/queue`. Un
  monitor che perde eventi durante un blip di rete e resta indietro è peggio
  di nessun monitor.

### C. Cassa / chiusura — estensione di `PagamentiPage.tsx`

La schermata esiste. Cambia che il totale non si digita più: arriva dalle
righe. Si aggiungono il dettaglio conto, lo sconto (riga o totale, con
motivazione e audit), la separazione del conto e il bottone che apre il QR
già in produzione.

---

## Piano di rilascio

Stessa granularità delle PR pay-at-table già fatte: ogni PR è deployabile da
sola, dietro flag, senza rompere niente di esistente.

| PR | Contenuto | Verificabile con |
|---|---|---|
| **1** | Migrazioni: listini, varianti, partite. Backfill `dish_prices` dal prezzo attuale. Nessuna UI. | il CRM funziona identico, `dish_prices` popolata |
| **2** | Tabelle `orders`/`order_items`, CRUD API, ricalcolo totale, idempotenza. Nessuna UI. | test via `curl`, totali corretti con varianti |
| **3** | `OrderPad.tsx` + flag `table_orders_enabled`. Comanda che si apre, si compila, si invia. | un tavolo reale a servizio chiuso |
| **4** | `KitchenDisplay.tsx` + eventi socket + `subscribe:station`. | due dispositivi affiancati |
| **5** | Ponte al conto: `POST /orders/:id/close`, `total_cents` derivato, `items` popolato, endpoint walk-in, indice unico bill attivo. | conto che si apre già valorizzato |
| **6** | Storni con motivazione, sconti, trasferimento tavolo, coperti/servizio, audit completo. | prova gli scenari sporchi |
| **7** | Split `per_item` sulla pagina pubblica (ora che `items` c'è), statistiche tempi di preparazione. | — |

Le PR 1-2 sono invisibili all'utente: si possono mergiare e deployare mentre il
ristorante lavora. Il primo momento di verità è la PR 3, e va provata a servizio
chiuso con il blocchetto di carta come rete di sicurezza per almeno tre servizi.

**Stima**: PR 1-5 (MVP che regge un servizio) ≈ 2-3 settimane di lavoro pieno.
PR 6-7 ≈ altre 2-3 settimane. La coda lunga — i casi che scopri solo al
sabato sera pieno — è realisticamente un altro mese di aggiustamenti.

---

## Scenari sporchi da non scoprire in produzione

Sono i casi che distinguono un POS usabile da una demo. Vanno tutti coperti
entro la PR 6.

1. **Due camerieri sullo stesso tavolo.** Risolto strutturalmente: una sola
   comanda `OPEN` per tavolo (indice parziale), entrambi ci scrivono, il socket
   li allinea. Non serve locking pessimistico.
2. **Tavoli uniti.** `table_merges` esiste già: la comanda si aggancia al
   `primary_id`, i tavoli uniti risolvono lì.
3. **Spostamento di tavolo a metà cena.** `POST /orders/:id/transfer` sposta
   comanda e conto insieme, con log. Se il conto ha già split pagati, il
   trasferimento è permesso ma loggato — i soldi restano attaccati al conto.
4. **Storno dopo il pagamento.** Non si tocca il totale: si va di rimborso
   Revolut, percorso già esistente e già testato.
5. **Cliente che paga a metà cena e poi ordina ancora.** Il conto passa
   `SETTLED` ma la comanda resta `OPEN`; le righe nuove riportano il conto a
   `OPEN` con residuo. Da esplicitare nella macchina a stati del bill: è il caso
   che rompe l'assunzione «SETTLED è finale».
6. **Palmare offline.** `offlineQueue` + `Idempotency-Key`. La comanda si compone
   offline e parte alla riconnessione. Il cameriere deve **vedere** che è in coda,
   con un badge esplicito — un invio che il cameriere crede partito e non è
   partito è peggio del blocchetto.
7. **Piatto eliminato dal menu con comande aperte.** `dish_id` è
   `ON DELETE SET NULL` e il nome è snapshottato: la riga sopravvive.
8. **Riavvio del server a metà servizio.** Tutto lo stato è in Postgres, niente
   in memoria. Il KDS si ricostruisce da `GET /kds/queue` alla riconnessione.

---

## Decisioni aperte

Da chiudere prima della PR 3, perché toccano la UI:

1. **Un monitor unico o uno per partita?** Il modello dati regge entrambi. Con
   una cucina piccola il monitor unico è più semplice e probabilmente migliore —
   ma va deciso ora perché cambia il layout.
2. **`seat_no` (chi ha ordinato cosa) serve davvero?** Costa un tap in più per
   riga al cameriere. Serve solo se volete lo split per persona automatico. La
   colonna la mettiamo comunque (nullable, costo zero); la domanda è se l'UI
   la chiede.
3. **Coperto: riga o campo del conto?** Come riga è più uniforme e si sconta
   con lo stesso codice degli altri sconti. Preferenza per la riga.
4. **Il KDS gira su tablet o su TV con Chromecast?** Cambia solo se serve la
   modalità tap. Il codice è lo stesso.

## Perché questo vale più di comprare Passepartout

Passepartout Menu ha trent'anni di casi limite che qui non ci sono e per un po'
non ci saranno. Non ha senso inseguirlo funzione per funzione.

Il vantaggio è un altro: prenotazioni, CRM clienti, agente vocale, WhatsApp,
HACCP, magazzino e conti stanno **nello stesso database**. L'allergene raccolto
al telefono dall'agente vocale finisce sul monitor di cucina con una `JOIN`. Il
piatto venduto scarica il magazzino senza export notturni. Il cliente abituale
si vede proporre il suo tavolo e il suo vino. Un POS esterno queste cose le fa
con un file CSV a fine giornata, quando le fa.

Il gestionale di sala non è un prodotto in più: è il pezzo che chiude il
cerchio fra tutto quello che è già stato costruito.
