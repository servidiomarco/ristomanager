# Sala dal vivo — piano tecnico

*3 ottobre 2026 — deciso con Tina prima di scrivere codice.*

La Sala dal vivo è la sala del ristorante in 3D e in tempo reale: sale e tavoli della
piantina con gli stessi colori di stato, e personaggi che nascono dalle prenotazioni
vere, cioè gli ospiti seduti dove sono davvero e i camerieri del turno che girano. La
scena che la riassume: la famiglia del tavolo 40 (due genitori, due bambini e il cane)
arriva, l'hostess va all'ingresso e la accompagna al tavolo, dove si siede.

Nei dati non c'è quasi niente di nuovo. Mancano tre cose, e le fasi le aggiungono
nell'ordine in cui servono: i punti fermi della sala (da dove si entra, da dove escono i
piatti, dove si accoglie), una pagina che carichi three.js solo su chi la apre, e un
regista che trasformi un cambio di stato in un movimento.

**Perimetro di questa tranche: solo PR1,** cioè segnaposto di sala e interruttore per
ristorante, spento di default; niente codice 3D. Il documento è la specifica del piano
approvato, revisione avversaria compresa, scritta su un clone del 20 settembre (`78336bf`)
e riallineata a `main` del 3 ottobre (`1f7c511`), 153 PR dopo (§2). Ne tiene tutto quello
che non dipende dalle righe (formule, soglie, tempi, codice di configurazione, seed e
copioni di prova) e lascia i numeri di riga, che invecchiano: le ancore si cercano per
nome. Ogni PR ricontrolla le ancore prima di scrivere.

---

## 1. Le decisioni

### 1.1 Di Tina, il 3 ottobre

1. **Una pagina sua, a schermo intero,** con voce di menu e link diretto, pensata per un
   tablet all'ingresso o una TV. Segue sempre il servizio *in corso*, mai la data scelta
   in testata.
2. **Segnaposto trascinabili per sala:** «Ingresso», «Pass» (il pass della cucina) e
   «Accoglienza», posizionati nell'editor 2D come i tavoli.
3. **Per ora i camerieri sono d'ambiente:** quanti e chi lo dicono le presenze di
   Personale, e girano fra il pass e i tavoli occupati, prima quelli appena seduti. I
   camerieri guidati dalle Comande sono la fase 2.
4. **Figure stilizzate costruite nel codice,** senza file di modelli: pedine arrotondate
   con testa, braccia e gambe, bambini più piccoli, un cane, tinte per ruolo. Tavoli e
   sedie usano gli stessi token di stato `--tg-*` della piantina, e la vista segue la
   modalità scura.

### 1.2 Default del piano, approvati con le decisioni

| Tema | Default |
|---|---|
| Nomi | Pagina «Sala dal vivo» («Live floor»), `ViewState.SALA_DAL_VIVO`, cartella `components/salaVivo/`, namespace `salavivo`. Interruttore per ristorante `sala_dal_vivo_enabled`, **spento di default**. Tabella `floor_markers`, route `/floor-markers`, eventi `floorMarker:updated` e `floorMarker:deleted` |
| Accesso | Il permesso che c'è già, `floorplan:view` (RECEPTION, WAITER, CASSA e direzione; KITCHEN no), più l'interruttore, che accende anche gli strumenti dei segnaposto |
| Posizioni | Le x/y salvate: la sala vera, la stessa che disegna la piantina 2D |
| Scala | 1 px della tela = 2 cm: i 26 px fra le sedie del glifo diventano 52 cm a coperto, una sala da 800×600 px diventa 16×12 m |
| Servizio in corso | La regola del server (`resolveService`): il giorno di servizio comincia alle 05:00, la cena alle 17:00. Una prenotazione è del giorno di servizio del proprio istante |
| Chiosco | Per dispositivo, «Fissa su questo schermo»: niente menu né barre, riapre la pagina all'avvio, tiene acceso lo schermo, si ricarica da sola a ogni versione nuova |
| Privacy | Nomi degli ospiti spenti di default su ogni dispositivo; su questa pagina i toast delle prenotazioni tacciono |
| Stack e test | `three ~0.186.1`, `@react-three/fiber ^9.8.1`, `@types/three ~0.186.0`, in **devDependencies**: l'immagine dell'API installa con `npm ci --only=production` e resta leggera. Niente drei: `MapControls` da `three/addons`. Test API in `tests/api/`, logica pura in `tests/unit/` con config e passo CI suoi |
| Caricamento | Due `React.lazy` annidati: App → pagina, pagina → canvas dopo una sonda WebGL2. I chunk 3D in `assets/sala3d/`, dove il glob del precache (`assets/*.{js,css}`) non arriva, serviti da una rotta CacheFirst |

---

## 2. Da dove si parte

Le posizioni vere dei tavoli ci sono (`tables.x/y`, px nella tela della sala, all'angolo
in alto a sinistra del glifo); i punti fermi no. `ARRIVED` vuol già dire «seduto» e non
c'è un orario d'arrivo: un accompagnamento si recita solo per un WAITING → ARRIVED visto
dal vivo, e `DEPARTED` spesso non arriva. `children` è una parte di `guests`, il cane è
solo la nota «Cane»; non c'è un ruolo hostess né un legame cameriere ↔ tavolo, e
`/staff/presence` non lo usa nessuno. Eco e risposta HTTP si rincorrono, e App ricarica
tutto a ogni connessione: i passaggi di stato si riconoscono confrontando istantanee. Non
c'è code splitting: three.js sarà il primo chunk a richiesta, fuori dal precache, che
oggi lo spingerebbe anche sugli schermi di cucina. **E su main, dopo il piano:**

| Su main | Cosa è cambiato | Effetto sul piano |
|---|---|---|
| #801 (`7fa78c1`) | La piantina, in Sale & Tavoli e in Prenotazioni, mostra **sempre** le posizioni salvate: niente più layout automatico per dispositivo. «Sposta tavoli» sblocca solo il trascinamento e riparte spento a ogni apertura; un tavolo nuovo nasce nel primo posto libero; chi modifica vede l'avviso delle sovrapposizioni anche fuori dallo spostamento | 3D e 2D concordano per costruzione. Cadono «solo nel layout manuale», il callout «Layout manuale», le chiavi `markersManualOnly` e `switchToManual` e la chiave localStorage condivisa. A interruttore acceso i segnaposto si vedono sempre, e si trascinano esattamente quando si trascinano i tavoli |
| #790 (`0241bf9`) | Due modalità che si escludono, «Sposta tavoli» (`isMoving`) e «Modifica tavoli» (`isSelectionMode`), bottoni che restano premuti, ognuno col suo chip sulla mappa | Il trascinamento dei segnaposto segue «Sposta tavoli»; segnaposto e tavoli non si selezionano insieme |
| Migration | `1789530000000` è già preso | `migrations/1791050226359_segnaposto-sala.js`: timestamp da `Date.now()`, più alto di tutti, o node-pg-migrate lo rifiuta |
| CI | Il passo «Bypass RLS motivati» (`npm run check:rls-bypass`) e il job «Test API (RLS rigida)», con `TEST_STRICT_RLS=1` | Route nuove solo con `queryWithRetry` nel contesto della richiesta, mai il pool nudo; i test passano in tutti e due i job |
| Tavoli prioritari | `tables.assign_priority` | Nessuno: il numero si vede solo modificando la piantina, la 3D non lo disegna |

---

## 3. Fasi e stato

| PR | Branch | Contenuto | Deploy | Stato |
|---|---|---|---|---|
| PR1 | `claude/segnaposto-di-sala` | Segnaposto: tabella, route, eventi, strumenti 2D. Interruttore e card in Impostazioni | Railway prima | **in corso** |
| PR2a | `claude/sala-dal-vivo-fondamenta` | Geometria del glifo condivisa, servizio in corso, test unitari. Niente di visibile | solo frontend | da fare |
| PR2b | `claude/sala-dal-vivo-pagina` | Vista, chiosco, caricamento a richiesta e PWA; sala, tavoli e segnaposto in 3D. **Collaudo sull'hardware dopo il merge** | Railway prima (enum `ViewState`) | da fare |
| PR2c | `claude/sala-dal-vivo-ospiti` | Ospiti statici con bambini e cane, cartelli, nomi spenti di default | solo frontend | da fare |
| PR3 | `claude/sala-dal-vivo-animazioni` | Regista, accompagnamenti, camminata, camerieri d'ambiente, striscia, «Segui il servizio»; `/staff/presence` come Personale | Railway prima | da fare |

Ogni PR parte da `origin/main` dopo `git fetch origin`, ricontrollando ancore e ultima
migration (§2 è quello che succede a non farlo). Il push lo fa Tina, con l'URL di confronto
`https://github.com/servidiomarco/ristomanager/compare/main...<branch>?expand=1`.

**Cosa cambia di quello che c'è,** da approvare a parte (il resto si aggiunge e basta):
l'helper del servizio legge l'ora del ristorante, non del dispositivo, e la matematica
delle sedie va in utils con test golden che provano la 2D identica (PR2a); toast muti,
testata nascosta e schermo fissato, solo sulla pagina nuova (PR2b); `/staff/presence`
come Personale (PR3); in FloorPlan i segnaposto (PR1) e una prop `focus` (PR2b).

---

## 4. Architettura

```
server.ts ─ floor_markers ─ GET/PUT/DELETE /floor-markers ─ floorMarker:* (mittente escluso) PR1
          ─ app_settings.sala_dal_vivo_enabled ─ features:updated                            PR1
          ─ GET /staff/presence allineato a Personale                                        PR3
App.tsx (rooms, tables, reservations, banquetMenus, interruttore, reservationsEpoch, onImmersive)
 └─ SALA_DAL_VIVO → React.lazy(SalaVivoPage)                              assets/sala3d/
      hook: useFloorMarkers · useServiceOverrides(date, shift) · useStaffOnShift · useWakeLock
      model/ (TS puro): service → tableStatus → layout → party/presence → placement ⇒ SceneModel
      SceneDirector [PR3] (puro, orologio e seme iniettati): diff(model.parties) → compiti → pose
      └─ sonda WebGL2 ok → React.lazy(SalaVivoCanvas) + chunk three       assets/sala3d/
           <Canvas frameloop="demand" flat dpr={[1,1.5]}>  RoomShell · Fixtures · TablesLayer
             · TableLabels · People (InstancedMesh per parte) · Signs · CameraRig · FrameThrottle
           useFrame → director.step(dt) → matrici delle istanze (mai stato React per frame)
FloorPlan.tsx ─ useFloorMarkers(enabled) ─ strumenti segnaposto (interruttore + floorplan:full)
```

Tre confini reggono il resto: la pagina non importa mai three né la scena, o il chunk 3D
finirebbe su ogni palmare; il modello è TypeScript puro; niente stato React per frame.

---

## 5. PR1 — Segnaposto di sala e interruttore (in corso)

### 5.1 Cosa si vede

- **Spento, il default:** nessuna schermata cambia; nessuna richiesta, nessun listener.
- **Acceso:** chi apre la piantina (`floorplan:view`) vede i segnaposto della sala attiva,
  chip da 44 px con icona ed etichetta, in ogni modalità.
- **Chi la modifica** (`floorplan:full`) ha tre strumenti dopo le forme dei tavoli:
  `LogIn` per l'ingresso (`DoorOpen` vuol già dire «riapri la sala»), `HandPlatter` per
  il pass, `ConciergeBell` per l'accoglienza. Da qualunque modalità, il tocco accende
  «Sposta tavoli» e spegne «Modifica tavoli» (una modalità alla volta), così il
  segnaposto si trascina subito. Se manca, lo crea al centro della mappa visibile, sulla
  griglia da 20 px; se c'è, lo seleziona, e selezionato mostra «Rimuovi». Gli strumenti
  restano spenti finché la lista dei segnaposto non è arrivata: una lista vuota per
  ignoranza farebbe nascere al centro un ingresso che esiste già, e l'upsert ce lo
  sposterebbe.
- **Si trascina quando si trascinano i tavoli,** con «Sposta tavoli» acceso, e si salva al
  rilascio, anche se il rilascio cade fuori dalla piantina; se fallisce torna dov'era, con
  «Segnaposto non salvato». Un tocco interrotto dal sistema lo rimette dov'era senza
  salvare. «Sposta tavoli» riparte spento a ogni apertura: in servizio i segnaposto non
  restano armati. Fuori da «Sposta tavoli» il tocco passa attraverso i segnaposto, per
  tutti, e arriva al tavolo che sta sotto.
- **Dal vivo** sugli altri dispositivi. Eliminata una sala, i suoi segnaposto spariscono
  nel database senza evento: i client filtrano per sala.

### 5.2 Schema e route

`migrations/1791050226359_segnaposto-sala.js`; `createSchema()` è congelato.

```sql
CREATE TABLE IF NOT EXISTS floor_markers (
    id         SERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kind       VARCHAR(20) NOT NULL CHECK (kind IN ('ENTRANCE', 'PASS', 'HOST_STAND')),
    x          INTEGER NOT NULL CHECK (x BETWEEN 0 AND 20000),
    y          INTEGER NOT NULL CHECK (y BETWEEN 0 AND 20000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (room_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_floor_markers_tenant ON floor_markers (tenant_id);
```

- **x/y è il centro,** nello spazio in px di `tables.x/y` (origine in alto a sinistra, y
  in basso): un segnaposto è un punto, che non cambia con lo zoom né col chip; il tavolo
  resta all'angolo perché una forma ce l'ha. In `types.ts`, dopo `RoomClosedOverride`:
  `FloorMarkerKind` e `FloorMarker { id, room_id, kind, x, y, updated_at? }`.
- **Il tetto 0–20 000 sta due volte:** nella rotta (`FLOOR_MARKER_MAX_PX`) e nel `CHECK`,
  che cambiano insieme. La rotta dà il 400 leggibile; il `CHECK` ferma chi scrive senza
  passare di lì (uno script, una correzione a mano), perché un 999 999 allargherebbe la
  sala sulla piantina di tutti fino a non leggerne i tavoli.
- **`UNIQUE (room_id, kind)` senza tenant:** `rooms.id` è globale e la coppia basta.
- **`tenant_id` senza DEFAULT** (`rls.test.ts`: un INSERT dimenticato muore di NOT NULL
  invece di finire nel tenant 1) e **RLS `tenant_isolation`** copiata identica dalle
  migration recenti, come pretende `rls-invarianti.test.ts`: la tabella nasce chiusa.

| Metodo | Route | Permesso | Risposta |
|---|---|---|---|
| `GET` | `/floor-markers` | autenticato (la Sala dal vivo gira anche su RECEPTION e WAITER) | `FloorMarker[]` del ristorante, `ORDER BY room_id, kind` |
| `PUT` | `/floor-markers` `{ room_id, kind, x, y }` | `floorplan:full` | upsert: la riga `{ id, room_id, kind, x, y, updated_at }` |
| `DELETE` | `/floor-markers/:id` | `floorplan:full` | `{ id, room_id, kind }` |

| Caso | Risposta |
|---|---|
| `room_id` non intero positivo, o oltre 2³¹−1 (`rooms.id` è INTEGER: Postgres darebbe un 500) | 400 |
| `kind` fuori dai tre; `x` o `y` non numeri finiti (anche `'120'`), o fuori da 0–20 000 dopo l'arrotondamento | 400 |
| Sala inesistente o di un altro ristorante, controllata **prima** dell'upsert | 404 |
| DELETE di un id non intero, fuori range o altrui | 404 |

La sala si controlla prima perché `ON CONFLICT (room_id, kind)` non contiene il tenant:
un `room_id` altrui aggiornerebbe il segnaposto di un altro ristorante (lo fanno già
`POST /room-closed` e `/table-merges`). Solo `queryWithRetry` nel contesto che apre
`authenticate`, mai `pool.query` né `new Pool`: niente `// rls-bypass:` da motivare, e il
server non superuser del job a RLS rigida vede le stesse righe. Registro attività su
`ResourceType.ROOM` («Segnaposto ingresso · Veranda»), senza valori nuovi nell'enum.
**L'interruttore accende solo la UI:** le route rispondono comunque.

### 5.3 Realtime, interruttore, client

`floorMarker:updated` porta la riga, `floorMarker:deleted` porta `{ id, room_id, kind }`,
alla stanza del ristorante col **mittente escluso** via `X-Socket-ID`: chi trascina ha
già la risposta, e l'eco lo farebbe rimbalzare su due trascinamenti rapidi. Il modello è
`table:created`, **non** `room:*` come diceva il piano (§13). Due metodi pubblici in
`socketService.ts`, perché `emitTo` è privato ed è lui a rispecchiare l'evento sul nodo
di sala, dove un client riceve comunque l'eco: i gestori la reggono. In
`eventRegistry.ts`, blocco «Pianta e sala», tutti e due `spec('cloud')` come `room:*`
(il test legge ogni letterale `'parola:parola'` di `socketService.ts`, commenti compresi).
Niente outbox, `SNAPSHOT_TABLES` né `CONVERGENCE`: sul nodo nessuno li legge
(`/floor-markers` va sempre al cloud), e un nodo vecchio fallirebbe lo snapshot.

L'interruttore entra in `FeatureFlagKey`, in `FEATURE_FLAG_KEYS` (anche la lista ammessa
dal `PUT`) e, a `false`, in `FEATURE_FLAG_DEFAULTS`; viaggia su `/settings/features`
(`settings:full` per scrivere) e sul `features:updated` di sempre, senza maschere di
entitlement (G21). Nel client è opzionale, `sala_dal_vivo_enabled?: boolean`, perché un
server vecchio non lo manda; in App è `boolean | null` accanto a `tableOrdersEnabled`, e
dall'evento si legge solo se `typeof === 'boolean'`, perché l'altro emettitore manda il
solo `sala_node_authority_enabled`. `FLAG_LABELS` di `FeatureTogglesManager` lo pretende.

`apiService.ts` aggiunge `getFloorMarkers`, `saveFloorMarker` e `deleteFloorMarker`,
**fuori dalla coda offline**: è configurazione fatta a schermo, meglio un errore subito
che una posizione vecchia rigiocata dopo. `useFloorMarkers(enabled)` carica con
`swrConfig('floorMarkers')` (un 404 da un server vecchio diventa `[]`); coi gestori con
nome, `updated` sostituisce per id, scarta un altro segnaposto con la stessa `(room_id,
kind)` e ignora una riga più vecchia della copia locale, `deleted` lo toglie. Ricarica
quando `isConnected` torna vero, **mai** con un listener su `connect`, che App spegne
senza gestore. Spento, niente fetch e niente listener. Restituisce `{ markers, loaded,
upsertLocal, removeLocal }`: `loaded` diventa vero alla prima lista applicata, quella in
cache compresa, e resta falso dopo un fetch fallito fino alla ricarica della
riconnessione, perché prima una lista vuota vuol dire «non lo so».

### 5.4 Piantina, card, design system

`components/FloorPlan.tsx` prende `markersEnabled` (default `false`), che App passa come
`salaDalVivoEnabled === true`.

- **Disegno:** nel wrapper scalato, dopo tavoli ed etichette dei banchetti, un'ancora 0×0
  a `zIndex` 25 (tavolo selezionato 30, trascinato 100), col chip in
  `translate(-50%, -50%) scale(1/scale)`: 44 px a ogni zoom, sempre sotto il chip della
  modalità e la legenda. L'ancora sta in `(x, y)`, ma **disegnata** ad almeno
  `MARKER_EDGE_PX` (36 px a schermo, cioè `36 / scale` px della sala) dal bordo in alto a
  sinistra: mezzo chip più l'etichetta che sborda, perché la tela taglia quello che sta
  sopra o a sinistra dell'origine. Vale solo per il disegno e con la scala di chi guarda:
  salvato nel dato, il margine sarebbe giusto solo sullo schermo che ha posato il
  segnaposto, e un tablet più piccolo taglierebbe l'etichetta. `roomExtent` include i
  segnaposto (`x + 40`, `y + 60`); una sala senza tavoli resta almeno 800×600 e i
  segnaposto la allargano e basta, o il primo, posato al centro, farebbe zoomare la vista
  e scappare di lato.
- **Strumenti:** un divisore e tre bottoni dopo le forme, spenti finché `loaded` è falso.
  Il tocco accende «Sposta tavoli» e spegne «Modifica tavoli»; il segnaposto nuovo va in
  `max(0, snapToGrid(centro visibile / scale))`, lo stesso per ogni schermo, e compare
  dopo la risposta del PUT, che porta l'id.
- **Trascinamento:** un `markerDragRef` suo, prima della guardia `isDragging` dei tavoli;
  `endMarkerDrag()` in testa a `handleMouseUp` risponde falso se non c'è un segnaposto in
  volo, perché ogni mouseup della piantina passa di lì. Parte dal punto disegnato, così
  un segnaposto contro la parete non resta fermo per i primi pixel; il candidato è
  `max(0, snapToGrid(…))` come per i tavoli e l'anteprima corre fra punti disegnati. Al
  rilascio `flushSync`, poi il PUT; un contatore per segnaposto fa perdere una risposta
  tardiva a un rilascio più nuovo. La copia ottimistica parte dalla versione **in lista**,
  non da quella presa alla pressione: se intanto è arrivata la risposta del rilascio
  prima, quella copia ha un `updated_at` superato, l'upsert la scarterebbe e il chip
  tornerebbe indietro fino alla risposta. La stessa versione è quella a cui si torna se il
  salvataggio fallisce.
- **Rilasci persi:** un `mouseup` su `window` chiude il trascinamento rilasciato fuori
  dalla piantina (il rilascio dentro passa prima da `handleMouseUp` e lì non trova più
  niente); `touchcancel` lo annulla senza salvare. Premere un tavolo annulla un
  segnaposto rimasto armato, premere un segnaposto annulla un tavolo rimasto armato, e un
  rilascio che chiude un segnaposto azzera comunque il trascinamento dei tavoli: un
  rilascio non ne lascia mai uno attaccato al puntatore.
- **Selezione:** `stopPropagation` su mousedown, touchstart **e** click, perché il click
  della tela svuota la selezione; segnaposto e tavoli si escludono, o la barra dei tavoli
  resterebbe aperta. Fuori da «Sposta tavoli» i segnaposto hanno `pointer-events-none`
  per tutti, anche per chi modifica: il tocco arriva al tavolo che sta sotto.
  Sovrapposizioni: solo tavoli.

`SalaDalVivoSettingsCard.tsx` sta nel blocco «Ristorante» delle Impostazioni, dopo «Sala
& Cucina», in un `CardErrorBoundary` con l'etichetta `common:settings.liveFloor`: una riga
di almeno 44 px con `Cuboid` su tessera neutra (la tinta `pending` vuol dire «chiede
un'azione»), disattivata senza `settings:full`. Se i flag non si leggono, al posto
dell'interruttore c'è «Stato non disponibile» in `--ds-text-muted`: è l'unico segno che
manca qualcosa, e `--ds-text-subtle` non regge l'AA. Chip su `--ds-surface`, bordo
`--ds-border-strong`; etichetta da 12 px in `--ds-text-secondary`, perché sulla tela
`--ds-text-muted` fa 4,26:1 ed è l'unica cosa che nomina l'icona; «Rimuovi» da 44 px su
`--ds-surface` con l'ombra della card, perché sta sulla tela e un `surface-row` lì fa
1,06:1 (la regola dell'annidamento). **La trappola:** in Tailwind 4.1 due utility
arbitrarie sulla stessa proprietà escono in ordine alfabetico e vince l'ultima, quindi
`${dsIconButton} ${TOOL_BUTTON_ON}` resta su `--ds-surface`: i bottoni dei segnaposto
partono da una base senza sfondo, poi `TOOL_BUTTON_ON` o `EDIT_ACTION_QUIET`.

### 5.5 Testi

| Chiave | it | en |
|---|---|---|
| `sala.json` · `markerEntrance` / `placeEntrance` | Ingresso / Posiziona l'ingresso | Entrance / Place the entrance |
| `markerPass` / `placePass` | Pass / Posiziona il pass | Pass / Place the pass |
| `markerHostStand` / `placeHostStand` | Accoglienza / Posiziona l'accoglienza | Host stand / Place the host stand |
| `removeMarker` / `markerSaveError` | Rimuovi / Segnaposto non salvato | Remove / Marker not saved |
| `salavivo.json` (nuovo) · `settingsTitle` | Sala dal vivo | Live floor |
| `settingsHint` | Ingresso, pass e accoglienza sulla piantina di Sale & Tavoli. | Entrance, pass and host stand on the Rooms & Tables map. |
| `turnOn` / `turnOff` | Accendi Sala dal vivo / Spegni Sala dal vivo | Turn the live floor on / off |
| `onToast` / `offToast` | Sala dal vivo accesa / Sala dal vivo spenta | Live floor on / off |
| `statusOn` / `statusOff` · `saveError` / `loadError` | Accesa / Spenta · Impostazione non salvata / Stato non disponibile | On / Off · Setting not saved / Status unavailable |
| `common.json` · `settings.liveFloor` | Sala dal vivo | Live floor |

Un namespace nuovo si carica alla prima `useTranslation('salavivo')` e `check:locales` lo
vede da solo. La «&» è letterale, mai `&amp;`, che con `escapeValue: false` va a video.

### 5.6 Test, cancelli, commit

| `tests/api/segnaposto-sala.test.ts` | Atteso |
|---|---|
| Interruttore | `false` di default; l'owner lo accende e lo rilegge, poi lo rispegne, così **tutte le route si provano a interruttore spento** (una rotta che un giorno lo guardasse fallirebbe qui); `afterAll` lo rispegne comunque, perché i file girano in fila sullo stesso server |
| Upsert | due PUT sulla stessa (sala, `ENTRANCE`) danno lo stesso id con le ultime x/y; `120.6` → `121`; GET ne elenca uno |
| Validazione | `kind: 'BAR'`, `x: -1`, `x: 20001`, `x: 'abc'`, `room_id: 'x'` → 400; sala ben formata ma inesistente → 404 |
| Database | un `INSERT` diretto con `x` o `y` a 20 001, o `x` a −1, muore di `23514`, in una transazione annullata |
| Eliminazione | 200 con `{ id, room_id, kind }`; ripetuta, `/abc` o `/99999999999` → 404 |
| Permessi | WAITER (`floorplan:view`, non `full`): GET 200, PUT e DELETE 403 |
| Fra ristoranti | tenant 902 con sala e segnaposto inseriti via `pg`: PUT e DELETE → 404, GET non lo mostra |
| Cascata | `DELETE /rooms/:id` → 204, e zero segnaposto per quella sala |
| Tempo reale | due socket dell'owner, A e B. Senza `X-Socket-ID` l'evento arriva a tutti e due ed è la riga della risposta, con le sole chiavi `id, kind, room_id, updated_at, x, y`; con `X-Socket-ID` = A, B riceve `updated` e `deleted` (`{ id, room_id, kind }` esatto) e ad A in 300 ms non arriva niente |

Gira in «Test API» e in «Test API (RLS rigida)», dove una query fuori contesto vede zero
righe; le fixture via `pg` restano superuser, e le FK della cascata scavalcano la RLS.

```bash
npx tsc --noEmit && npm run build:server && npm run check:rls-bypass && npm run check:locales
npx vitest run tests/api/{segnaposto-sala,event-registry,rls,rls-invarianti}.test.ts  # e con TEST_STRICT_RLS=1
npx vite build && rm -rf dist   # mai mentre girano i test API, e mai npm run dev: è produzione
```

Nella stessa PR, un punto in «Sale & Tavoli (planimetria)» di `docs/funzionalita-app.md`,
una riga del «Registro aggiornamenti» per chi usa l'app (niente «flag» né «socket») e
questo documento. Commit: «Segnaposto di sala: tabella, rotte ed eventi» · «Sala dal
vivo: interruttore in Impostazioni, spento di default» · «Sale & Tavoli: ingresso, pass
e accoglienza si posizionano sulla piantina» · «Catalogo funzionalità: i segnaposto di
sala».

---

## 6. PR2a — Fondamenta (da fare)

Niente di visibile, nessuna riga nel Registro. **`utils/tableGeometry.ts`** (solo
frontend) prende le costanti `GLYPH`, `getGlyphDimensions` spostata identica,
`getChairSlots` e `litChairIndices` estratte da `TableGlyph.tsx`, che ne disegna **SVG
identico** e riesporta `getGlyphDimensions`: gli altri renderer non si toccano, e
`tableOverlap`, `tableLayout` e `labelPlacement` importano da utils, senza React.

```ts
// ChairSlot { index, edge: top | bottom | ring, i, cx, cy, rotDeg, nx, ny }: centro e verso il tavolo
// CIRCLE: d = max(74, 34 + 10n), raggio d/2 + 9.5, a_i = 2πi/n − π/2 (sedia 0 a ore 12)
// RECT/SQUARE: sopra ⌈n/2⌉, sotto ⌊n/2⌋, bodyW = max(64, max(sopra, sotto)·26 + 16);
//   x_i = 12 + bodyW/2 − (k−1)·13 + i·26; y 7.5 sopra, 92.5 sotto; prima sopra, poi sotto
// litChairIndices: accese = party > 0 ? min(party, seats) : seats;
//   litTop = min(sopra, ⌈accese/2⌉), litBot = accese − litTop; confronti esatti sulla forma
```

**`utils/reservationTime.ts`** prende da App.tsx `currentServiceRome(at)`, che legge l'ora
del ristorante con `Intl` e non quella del dispositivo, più `serviceDayOf(iso)` (un
walk-in delle 00:30 è della cena di ieri). Il file resta **senza import**, perché lo
compila anche il server; la pagina converte in `Shift`. Il fuso va riallineato (§13).

| File | Cosa cambia |
|---|---|
| `utils/tableGeometry.ts` (nuovo, solo frontend) | le costanti `GLYPH`, `getGlyphDimensions` copiata identica, `getChairSlots`, `litChairIndices` |
| `components/TableGlyph.tsx` | disegna da queste funzioni con SVG identico e riesporta `getGlyphDimensions`: FloorPlan, ReservationList, ReceptionPage e la Piantina di Cassa non si toccano |
| `utils/tableOverlap.ts`, `utils/tableLayout.ts`, `utils/labelPlacement.ts` | importano `getGlyphDimensions` da `./tableGeometry`, così restano senza React |
| `utils/reservationTime.ts` · `App.tsx` | `currentServiceRome` e `serviceDayOf`, senza import · App cancella la sua copia e la importa da utils |
| `vitest.unit.config.ts` (nuovo) · `package.json` | `defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' } })`, con un commento: niente Postgres, separato dalla suite API che droppa il database · `"test:unit": "vitest run --config vitest.unit.config.ts"` |
| `.github/workflows/ci.yml` | nel job «Typecheck e build», dopo «Bypass RLS motivati»: `- name: Test unitari` / `run: npm run test:unit` |
| `tests/unit/tableGeometry.test.ts`, `tests/unit/currentService.test.ts` | i test qui sotto |

```ts
export type ChairSlot = { index: number; edge: 'top' | 'bottom' | 'ring'; i: number; cx: number; cy: number; rotDeg: number; nx: number; ny: number };
// cx/cy = centro della sedia nel box del glifo (px, prima della rotazione); (nx, ny) = verso il tavolo
export function getChairSlots(shape: TableShape, seats: number): ChairSlot[];
//  RECT/SQUARE: bodyX = 12, bodyY = 17; ordine: sopra da sinistra a destra, poi sotto
export function litChairIndices(shape: TableShape, seats: number, party: number): number[];
```

L'helper del servizio, come approvato (il fuso diventerà un parametro, §13; la pagina
mappa il letterale su `Shift` in `model/service.ts`, così nessun cast arriva a
`getTableMerges(date, shift: Shift)`):

```ts
// Il servizio «di adesso» come lo intende il server (resolveService): il giorno di
// servizio comincia alle 05:00 di Roma, la cena alle 17:00. Ora di ROMA, non del
// dispositivo. `anchor` è un Date dentro quel giorno di servizio (per setGlobalDate):
// alle 00:30 punta a ieri. Niente import qui: questo file lo compila anche il server.
const romeHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', hourCycle: 'h23' });
export const SERVICE_DAY_START_HOUR = 5;
export const DINNER_START_HOUR = 17;
export const currentServiceRome = (at: Date = new Date()): { date: string; shift: 'LUNCH' | 'DINNER'; anchor: Date } => {
    const hour = Number(romeHourFmt.format(at));
    if (hour < SERVICE_DAY_START_HOUR) {
        const anchor = new Date(at.getTime() - 6 * 3600 * 1000);
        return { date: getRomeDatePart(anchor), shift: 'DINNER', anchor };
    }
    return { date: getRomeDatePart(at), shift: hour < DINNER_START_HOUR ? 'LUNCH' : 'DINNER', anchor: at };
};
// Il giorno di servizio di un istante: un walk-in delle 00:30 è della cena di ieri.
export const serviceDayOf = (iso: string | Date): string =>
    currentServiceRome(iso instanceof Date ? iso : new Date(iso)).date;
```

**Test unitari:** `vitest.unit.config.ts` su `tests/unit/**`, ambiente node, **senza** il
globalSetup che droppa il database; `npm run test:unit`; un passo «Test unitari» nel job
«Typecheck e build», dopo «Bypass RLS motivati». `tableGeometry` confronta con le formule
inline originali di `TableGlyph.tsx`, copiate nel test come riferimento, per n = 1..24 e
tre forme (dimensioni, centri, `rotDeg`, sedie accese per comitive da 0 a n+2);
`currentService` prova i confini, in UTC (Roma è UTC+2 d'estate, UTC+1 d'inverno):

| Istante | A Roma | Atteso |
|---|---|---|
| 2026-10-03 02:59Z / 03:00Z | 04:59 / 05:00 | 2026-10-02 DINNER / 2026-10-03 LUNCH |
| 14:59Z / 15:00Z | 16:59 / 17:00 | LUNCH / DINNER |
| 2026-03-29 02:59Z / 03:00Z e 2026-10-25 03:59Z / 04:00Z | 04:59 / 05:00 nelle notti dei cambi d'ora | il giorno prima DINNER / quel giorno LUNCH |
| `serviceDayOf('2026-10-04T22:30:00Z')` | 00:30 del 5 | `'2026-10-04'` |

Commit: «Geometria del glyph tavolo in un modulo condiviso» · «Il servizio di adesso
in utils, come lo intende il server» · «Test unitari della logica pura, con il loro
passo in CI».

---

## 7. PR2b — La pagina, con sala e tavoli in 3D (da fare)

### 7.1 Build, vista, App e pagina

- **Chunk:** `manualChunks` mette in `three` il solo `node_modules/three`, che non importa
  niente dal bundle principale e cambia hash solo con la libreria (R3F importa React dal
  chunk d'ingresso e viaggia con la scena); `chunkFileNames` manda `three` e `SalaVivo*`
  in `assets/sala3d/`. In `pwa/sw.js` una CacheFirst `sala-3d` (8 voci, 60 giorni) tiene
  **solo risposte JavaScript**: Vercel risponde ai file mancanti con `index.html` e 200.
- **Vista:** `ViewState.SALA_DAL_VIVO` → `floorplan:view` nelle due mappe dei permessi;
  voce dopo «Sale & Tavoli» (`Cuboid`, `servizio`, `sidebarCollapse`), nascosta a
  interruttore spento; il redirect parte **solo a interruttore noto**, o un link diretto
  morirebbe al boot. Atterraggio: prima `?view=`, poi lo schermo fissato, poi la preferita.
- **App:** testata nascosta come in Cucina; toast delle prenotazioni muti su questa vista
  (la campanella no). Montaggio in `CardErrorBoundary` e `Suspense`, col `.catch` che rende
  `LazyChunkError` e «Ricarica»: un import lazy rifiutato resta rifiutato. FloorPlan riceve
  `focus?: { roomId: number } | null` (come `initialTableId` di OrderPad) e apre la sala
  giusta; il ramo che col layout automatico accendeva un avviso è caduto col #801.
- **Pagina:** `components/salaVivo/SalaVivoPage.tsx`, export di default, **mai** un import
  di `three` o `./scene`. Testata con riassunto («12 a tavola · 3 in arrivo»), «Centra»,
  fissa, «Schermo intero» e LivePill; linguette delle sale aperte e delle chiuse con
  presenti, coi coperti («Veranda · 38»); al massimo due callout, con «Posizionali» e
  «Disponi i tavoli» solo per `floorplan:full` a schermo non fissato.

| Dato | Da dove · come si aggiorna |
|---|---|
| Sale, tavoli, prenotazioni, banchetti · servizio `{date, shift}` | prop e gestori socket di App · helper di PR2a sull'orologio al minuto di App, lo stesso che muove la LivePill |
| Unioni, nascosti, sale chiuse | `useServiceOverrides(date, shift)` · `getTableMerges`, `getTableHidden` e `getRoomClosed` in parallelo al cambio di servizio e al ritorno della connessione; gestori con nome filtrati per data e turno, con l'upsert copiato da FloorPlan; restituisce `{ merges, hiddenTableIds, closedRoomIds, ready }` |
| Segnaposto · modello | `useFloorMarkers(true)` · `useMemo(deriveSceneModel(…))` ai commit e al minuto, **mai per frame** |
| Preferenze del dispositivo | localStorage `salaVivo.room`, `.pinned`, `.names` (PR2c), `.follow` (PR3), `.debug` |

| File | Cosa cambia |
|---|---|
| `package.json`, `package-lock.json` | devDependencies `three ~0.186.1`, `@react-three/fiber ^9.8.1`, `@types/three ~0.186.0`: l'immagine dell'API installa con `npm ci --only=production` e resta leggera |
| `vite.config.ts` · `pwa/sw.js` | il blocco `build` e la rotta CacheFirst qui sotto, dopo quelle dei font |
| `types.ts` | `SALA_DAL_VIVO = 'SALA_DAL_VIVO'` in `ViewState`; `location?: string \| null` su `Room` |
| `contexts/AuthContext.tsx` · `auth/permissions.ts` | `[ViewState.SALA_DAL_VIVO]: 'floorplan:view'` · `[ViewState.SALA_DAL_VIVO]: ['floorplan:view']`: tutte e due le mappe sono esaustive, `tsc` lo pretende |
| `components/FloorPlan.tsx` | `focus?: { roomId: number } \| null` e `onFocusConsumed?: () => void`, come `initialTableId` di OrderPad: al focus `setActiveRoomId`, poi consuma |
| `components/LazyChunkError.tsx` (nuovo, nel bundle principale) | `Callout tone="critical"` con `common:lazy.chunkError` e un `dsButton` «Ricarica» (`common:actions.reload`) che chiama `window.location.reload()` |
| `components/SalaDalVivoSettingsCard.tsx` | il testo finale di `settingsHint` |
| `hooks/useServiceOverrides.ts`, `hooks/usePrefersReducedMotion.ts`, `hooks/useWakeLock.ts` (nuovi) | gli hook della pagina |
| `components/salaVivo/types.ts` · `SalaVivoPage.tsx` · `SalaVivoCanvas.tsx` | le prop · la pagina, export di default, mai un import di `three` o `./scene` · il canvas, export di default |
| `components/salaVivo/model/{service,geometry,layout,tableStatus,sceneModel}.ts` | il modello, TypeScript puro |
| `components/salaVivo/scene/{theme.ts,RoomShell.tsx,Fixtures.tsx,TablesLayer.tsx,TableLabels.tsx,CameraRig.tsx,FrameThrottle.tsx,DebugStats.tsx}` | three e R3F |
| `public/locales/{it,en}/common.json` · `salavivo.json` | `nav.items.liveFloor`, `lazy.chunkError` · le chiavi della pagina |
| `tests/unit/{geometry3d,layout,tableStatus,boundaries}.test.ts`, `tests/api/sala-dal-vivo.test.ts` · `docs/funzionalita-app.md` | test · catalogo |

**App.tsx**, ancora per ancora (si cercano per nome):

| Ancora | Cambio |
|---|---|
| Dopo gli import | l'import lazy qui sotto |
| `NAV_ITEMS`, dopo «Sale & Tavoli» | `{ kind: 'link', label: 'Sala dal vivo', labelKey: 'nav.items.liveFloor', Icon: Cuboid, group: 'servizio', isTab: false, view: ViewState.SALA_DAL_VIVO, sidebarCollapse: true }` |
| `canSeeNavItem` | `if (item.view === ViewState.SALA_DAL_VIVO && salaDalVivoEnabled !== true) return false;` |
| L'effetto di redirect | `if (salaDalVivoEnabled === false && view === ViewState.SALA_DAL_VIVO) setView(ViewState.DASHBOARD);`, con `salaDalVivoEnabled` fra le dipendenze: solo a interruttore noto, o un link diretto morirebbe al boot |
| L'effetto d'atterraggio | dopo il blocco `?view=` e prima della vista preferita: con `localStorage['salaVivo.pinned'] === '1'` e la vista accessibile, `setView(SALA_DAL_VIVO)`, `setSidebarCollapsed(true)`, segnato come applicato, `return` |
| Testata | `view === ViewState.CUCINA \|\| view === ViewState.SALA_DAL_VIVO ? 'hidden'`: la pagina ha la sua LivePill, come Cucina |
| Barra laterale | `const salaVivoKiosk = view === ViewState.SALA_DAL_VIVO && immersive;` la condizione dello stub diventa `comandeNavStubbed \|\| salaVivoKiosk`, anche in `aria-hidden`; barra in basso e spazio `pb-mobile-nav` seguono già `immersive` |
| I tre toast delle prenotazioni | `const viewRef = useRef(view)`, allineato in un effetto; ogni toast con `if (viewRef.current !== ViewState.SALA_DAL_VIVO)`. Le notifiche della campanella restano |
| Stato del focus | `const [floorPlanFocus, setFloorPlanFocus] = useState<{ roomId: number } \| null>(null)`, passato a FloorPlan |
| Scelta della pagina di partenza | `getAccessibleViews().filter(v => v !== ViewState.SALA_DAL_VIVO \|\| salaDalVivoEnabled === true)` |
| Montaggio, dopo `FLOOR_PLAN` | qui sotto |

```tsx
// La prima vista caricata a richiesta: three e la scena (~250 KB gzip) non
// entrano nel bundle che ogni palmare e ogni schermo di cucina scarica.
// Il .catch trasforma un chunk mancante (offline al primo accesso, hash
// sparito dopo un deploy) in una pagina con «Ricarica»: un lazy rigettato
// resterebbe rigettato per sempre.
const SalaVivoPage = React.lazy<React.ComponentType<SalaVivoPageProps>>(() =>
  import('./components/salaVivo/SalaVivoPage').catch((err) => {
    console.error('[sala-dal-vivo] chunk non caricato', err);
    return { default: () => <LazyChunkError /> };
  }));

{view === ViewState.SALA_DAL_VIVO && (
  <CardErrorBoundary label={t('nav.items.liveFloor')}>
    <React.Suspense fallback={<Loader label={t('loading')} className="h-full" />}>
      <SalaVivoPage rooms={rooms} tables={tables} reservations={reservations} banquetMenus={banquetMenus}
        isInitialLoading={isInitialDataLoading} isConnected={isConnected} currentTime={currentTime}
        onImmersive={setImmersive}
        onOpenFloorPlan={(focus) => { setFloorPlanFocus(focus ?? null); setView(ViewState.FLOOR_PLAN); }} />
    </React.Suspense>
  </CardErrorBoundary>
)}
```

```ts
export interface SalaVivoPageProps {
  rooms: Room[]; tables: Table[]; reservations: Reservation[]; banquetMenus: BanquetMenu[];
  isInitialLoading: boolean; isConnected: boolean; currentTime: Date;
  onImmersive: (on: boolean) => void;
  onOpenFloorPlan: (focus?: { roomId: number }) => void;
  reservationsEpoch?: number; // PR3
}
```

**`vite.config.ts`**, un blocco `build` nuovo:

```ts
build: { rollupOptions: { output: {
  // Solo three in un chunk suo: non importa niente dal bundle principale, quindi
  // il suo hash cambia solo quando si aggiorna la libreria. R3F importa React dal
  // chunk d'ingresso (e cambierebbe a ogni deploy): viaggia col chunk della scena.
  manualChunks: (id) => (/[\\/]node_modules[\\/]three[\\/]/.test(id) ? 'three' : undefined),
  // La Sala dal vivo in assets/sala3d/: il glob del precache ('assets/*.{js,css}')
  // non scende nelle sottocartelle, così palmari e schermi di cucina non la
  // scaricano mai. La serve la rotta CacheFirst di pwa/sw.js a chi apre la pagina.
  chunkFileNames: (chunk) =>
    chunk.name === 'three' || chunk.name.startsWith('SalaVivo')
      ? 'assets/sala3d/[name]-[hash].js' : 'assets/[name]-[hash].js',
} } },
```

**`pwa/sw.js`** (`CacheFirst` ed `ExpirationPlugin` sono già importati):

```js
// Sala dal vivo (3D): fuori dal precache — la scaricano solo i dispositivi che
// aprono la pagina. Nomi con hash = immutabili: CacheFirst, la scadenza pulisce.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/sala3d/'),
  new CacheFirst({ cacheName: 'sala-3d', plugins: [
    // Vercel riscrive i file mancanti su index.html con 200 (vercel.json):
    // un vecchio URL dopo un deploy tornerebbe HTML — mai in cache.
    { cacheWillUpdate: async ({ response }) =>
        response && response.ok && (response.headers.get('content-type') || '').includes('javascript') ? response : null },
    new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 60 * 24 * 60 * 60 }),
  ] }),
);
```

Da riusare: `getTableFootprint` e `boxesOverlap` (`tableOverlap.ts`), `buildMergeGroups`
(`comande/tablesView.ts`, puro), `deriveTableDisplayStatus`, `isSeated`,
`isArrivingSoon` e `getEffectiveDurationMin` (`reservationState.tsx`), `getRomeTimePart`,
`sortRooms`, `useAppVersion()` (`{ currentVersion, remoteVersion, reload }`),
`useToast()`, dal barrel `LivePill`, `Callout`, `EmptyState`, `dsIconButton`, `dsButton`,
`useMediaQuery`, e `Loader`, `CardErrorBoundary`. Le classi `ROOM_TAB_*` si copiano come
letterali da FloorPlan (Tailwind vuole letterali); `onImmersive` segue l'effetto di OrderPad.

### 7.2 Il modello

- **Geometria.** X = x·M, Z = y·M, `rotation.y = −θ` (il verso orario del CSS con la y in
  basso). Corpi da `width_cm` (profondità) e `length_cm` (lato lungo); altrimenti cerchio
  `Dc = max(0.80, 0.16n + 0.30)`, rettangolo `L = max(0.70, (⌈n/2⌉−1)·0.52 + 0.60)` per
  `D = 0.80`, quadrato `D = clamp(L, 0.80, 1.10)`, dentro il box del glifo meno 0,40 m di
  sedie. Piano 0,75 m, seduta 0,45, schienale 0,90. Sedie **esattamente** sugli slot 2D,
  spinte fuori fino a 0,30 m dal bordo; punto d'approccio 0,55 m dietro la sedia.
- **Disposizione.** Tavoli non nascosti, come in 2D; un'unione con un membro a più di
  25 px dagli altri si disegna come in 2D (il primario, per la somma dei coperti). Audit
  `overlaps` su box orientati, così due vicini ruotati non sono un falso allarme, e
  `unset` (almeno 3 tavoli, metà sulla stessa posizione).
- **Il ripiego per una sala da disporre è da rivalutare in PR2b.** Il piano usava
  `computeAutoLayout`, che oggi resta solo come misura di una sala vuota in Prenotazioni:
  la 2D quella vista non ce l'ha più, e una griglia solo in 3D romperebbe l'accordo. Coi
  tavoli nuovi nel primo posto libero è un'eredità dei dati vecchi, già nell'avviso.
- **Segnaposto mancanti** (`missingMarkers[]`): ingresso a `(W/2, H − 20)`, il bordo
  verso la camera; accoglienza 60 px dentro e 40 di lato; pass a `(W − 60, 60)`.
- **Stato del tavolo:** `deriveTableDisplayStatus` sulla seduta più recente del gruppo,
  altrimenti sulla prossima WAITING del turno fra t−30 e t+120 minuti, come in 2D.
  Divergenze dichiarate: «oggi» è il giorno di servizio; un secondario accende tutta
  l'unione; con due sedute vince la più recente, dove la 2D prende la prima.

Il dettaglio, per chi implementa:

```
geometry.ts   M = 0,02 m/px · assi X = x·M, Z = y·M, Y in alto
              centro C = ((t.x + w/2)·M, (t.y + h/2)·M); θ = rotation·π/180; group.rotation.y = −θ
              rot(lx, lz) = (lx·cosθ − lz·sinθ, lx·sinθ + lz·cosθ)        // orario del CSS con y in basso
              corpi da width_cm (profondità) e length_cm (lato lungo) quando > 0, poi dentro il box
              del glifo meno 0,40 m di sedie: rettangolo D ≤ 1,20 m e L ≤ w·M − 0,10; cerchio Dc ≤ size·M − 0,80
              sedia locale ((s.cx − w/2)·M, (s.cy − h/2)·M), esatta; un corpo più profondo la spinge
              lungo −n fino a ≥ 0,30 m dal bordo; facingYaw = atan2(dx, dz) di rot(n); approach = seat − rot(n)·0,55
layout.ts     overlaps: separazione degli assi sui rettangoli del glifo, cerchi come dischi, senza
              margine né fascia delle etichette · unset: n ≥ 3 e la (x, y) più comune tiene ≥ 50 %
              dei tavoli · estensione W = max(room.width, maxRight + 60), H = max(room.height, maxBottom + 60)
              su glifi e segnaposto; la camera inquadra il contenuto
              «verso l'interno» dei ripieghi = il versore dal segnaposto al baricentro della sala,
              agganciato alla normale del bordo se il segnaposto sta entro 1 m da un bordo
tableStatus.ts opzioni { banquet: banchetto del servizio sul tavolo, tempLocked: temp_lock_expires_at > now, now };
              le comitive vive sono quelle del giorno di servizio di §8
```

### 7.3 La scena e il chiosco

- **Tema:** token letti con `getComputedStyle` in `THREE.Color` aggiornati sul posto e
  riletti solo quando cambia `.dark`; luci `flat`, niente shadow map, un piano visto
  dall'alto entro ±3 % del glifo 2D. Tavoli `--tg-{stato}-bg`, `-stroke`, `-chair`; sedie
  vuote di un tavolo occupato a `lerp(chair, surface, 0.75)`; anello `inarrivo` a 2,2 s,
  fermo col movimento ridotto; pavimento `--ds-surface`, o `--ds-cat-5-tint` all'aperto
  (serve `location` su `Room`). Porta, pass e leggio sui segnaposto; un'etichetta per tavolo.
- **Camera:** fov 35°, 52° d'elevazione, dal bordo basso della mappa, così destra e
  sinistra sono quelle della 2D; MapControls limitati; «Centra» in 400 ms. Frame a
  richiesta: 30 fps coi controlli, 12 se pulsa un anello, zero da fermi; `dpr` 1–1,5.
- **Sonda WebGL2** con `failIfMajorPerformanceCaveat`: se riesce solo senza, modalità
  lenta (DPR 1, 15 fps, in PR3 niente camerieri); se non riesce, callout, e il chunk non
  si scarica mai. Contesto perso: «Riavvia la vista». Smontando si libera tutto.
- **Chiosco:** «Fissa» scrive `salaVivo.pinned`; la pagina chiama `onImmersive(true)` e
  alla pulizia `false`, così un crash rende menu e barre. Fissato: controlli che
  svaniscono dopo 6 s, audit nascosti, wake lock, ricarica alla versione nuova se nessun
  accompagnamento è in corso. «Schermo intero» va su `document.documentElement`, così
  toast e modali restano visibili.

Il dettaglio, per chi implementa:

| Elemento | Token |
|---|---|
| Sfondo · pavimento · zoccolo | `--ds-canvas` · `--ds-surface`, o `--ds-cat-5-tint` con `room.location === 'OUTDOOR'` (una categoria, non uno stato) · `--ds-border-strong` |
| Piano / bordo del tavolo · sedie occupate | `--tg-{stato}-bg` / `--tg-{stato}-stroke` · `--tg-{stato}-chair` |
| Sedie vuote di un tavolo occupato | `lerp(chair, surface, 0.75)`, come l'opacità 0,25 della 2D |
| Anello `inarrivo` | `--tg-inarrivo-accent`, ciclo di 2,2 s: opacità 0,85 → 0 nel 70 % e scala 1 → 1,08, come `index.css`; fermo col movimento ridotto |
| Banco del pass, leggio, telaio della porta · ombre a macchia | `--ds-surface-row` / `--ds-border-strong` · nero a 0,12 (chiaro) e 0,30 (scuro) |

- **Tema:** `readTokens()` = `getComputedStyle(document.documentElement).getPropertyValue(k).trim()
  || '#888888'`, riletto solo quando un `MutationObserver` su `<html>` vede cambiare
  `.dark`; una tavolozza di `THREE.Color` creata una volta e aggiornata con `.set()`,
  poi `invalidate()`. Tutti i token usati sono esadecimali puri. Luci `flat` (niente tone
  mapping), MeshLambert, una ambientale e una direzionale, niente shadow map: un piano
  rivolto in alto deve stare entro ±3 % dal glifo 2D, col contagocce.
- **Camera:** prospettiva, fov 35°, 52° d'elevazione, da +Z (il bordo basso della mappa)
  verso −Z. **Inquadratura:** ricerca binaria sulla distanza (24 iterazioni) finché gli
  angoli del contenuto sul pavimento, e gli stessi a 1,8 m d'altezza, stanno tutti in
  `max(|ndc|) ≤ 0.88`. **MapControls:** smorzamento 0,12; angolo polare 25–65°; azimut
  ±35°; distanza da 0,35 a 1,6 volte l'inquadratura; bersaglio tenuto sul pavimento.
  «Centra» torna all'inquadratura in 400 ms, subito col movimento ridotto.
- **Etichette:** uno `THREE.Sprite` per tavolo, `CanvasTexture` 256×128, 1,2 m sopra il
  tavolo, alto 0,45 m; si disegna dopo `document.fonts.load('500 64px "Hanken Grotesk"')`
  (la famiglia di `--font-sans`) e si ridisegna solo quando cambiano tema o nome.
- **Frame:** `frameloop="demand"`, e `FrameThrottle` chiama `invalidate()`: 30 fps coi
  controlli attivi (da `start` a `end` + 600 ms), 12 se pulsa un anello, altrimenti zero.
  `dpr={[1, 1.5]}`, e `setDpr(1)` quando il frame medio supera 40 ms per 3 s.
- **Sonda WebGL2:** `getContext('webgl2', { failIfMajorPerformanceCaveat: true })`; se
  fallisce si riprova senza, e riuscire così vuol dire modalità lenta (callout
  `slowDevice`, DPR 1, tetto 15 fps, in PR3 niente camerieri). Tutte e due le sonde si
  rilasciano con `WEBGL_lose_context`. Se nessuna riesce, callout `noWebgl` e il chunk del
  canvas non si scarica mai. Su `webglcontextlost`: `preventDefault`, poi un velo con
  «Riavvia la vista», che rimonta il canvas con `key++`. Le pulizie degli effetti
  liberano geometrie, materiali, `CanvasTexture` e controlli; il renderer lo libera R3F
  ≥ 9.8.1 (#3942).
- **Fissato:** bottone `Pin` / `PinOff` da 44 px con `aria-pressed`; padding `p-3`;
  controlli che svaniscono dopo 6 s senza puntatore (opacità in ≤ 180 ms) e tornano al
  primo tocco; callout degli audit nascosti; `useWakeLock` tiene `navigator.wakeLock`
  finché la pagina è visibile e lo riprende su `visibilitychange`, anche a schermo
  intero. Una volta al minuto, se `remoteVersion` è diversa da `currentVersion` (e
  nessuna delle due è `'dev'`), nessun accompagnamento è in corso (PR3) e
  `localStorage['salaVivo.reloadedFor'] !== remoteVersion`: si salva la versione, poi
  `reload()`. «Schermo intero» usa `requestFullscreen()` o la variante `webkit`, e sparisce
  dove non c'è (iPhone).
- **Guscio della pagina:** radice `flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6 lg:p-8`;
  in testata h1, riassunto e, a destra, i `dsIconButton` da 44 px con `title` e
  `aria-label` («Centra», fissa, schermo intero), poi la `LivePill` (`variant="dot"` sotto
  md). Il palco: `relative min-h-0 flex-1 overflow-hidden rounded-[var(--ds-radius)]
  bg-[var(--ds-canvas)]`, con `role="img"` e `aria-label={t('stageLabel', …)}`.
  «Posizionali» e «Disponi i tavoli» chiamano `onOpenFloorPlan({ roomId })`.
- **Scena statica di questa PR:** guscio della sala, telaio della porta all'ingresso,
  banco del pass, leggio dell'accoglienza, tavoli, sedie, etichette, anello `inarrivo`,
  camera e audit. Niente persone.

### 7.4 Testi, test e collaudo

| `common.json` · `salavivo.json` | it | en |
|---|---|---|
| `nav.items.liveFloor` / `title` · `lazy.chunkError` | Sala dal vivo · La pagina non si è caricata. | Live floor · The page didn't load. |
| `summary` | {{seated}} a tavola · {{arriving}} in arrivo | {{seated}} seated · {{arriving}} arriving |
| `summaryLobby` / `stageLabel` | {{count}} all'ingresso / {{room}}: {{seated}} a tavola, {{arriving}} in arrivo | {{count}} at the entrance / {{room}}: {{seated}} seated, {{arriving}} arriving |
| `recenter` / `loading3d` / `noTables` | Centra la sala / Preparo la vista 3D… / Nessun tavolo in questa sala. | Recenter / Preparing the 3D view… / No tables in this room. |
| `fullscreen` / `exitFullscreen` | Schermo intero / Esci da schermo intero | Full screen / Exit full screen |
| `pin` / `unpin` / `pinnedToast` | Fissa su questo schermo / Sblocca questo schermo / All'avvio questo schermo apre la Sala dal vivo | Pin to this screen / Unpin this screen / On start this screen opens the live floor |
| `noWebgl` / `slowDevice` | Questo dispositivo non mostra la vista 3D. / Vista semplificata: questo dispositivo disegna il 3D senza accelerazione. | This device can't show the 3D view. / Simplified view: this device draws 3D without acceleration. |
| `markersMissing` / `placeMarkers` / `openFloorPlan` | Ingresso, pass o accoglienza da posizionare. / Posizionali / Apri Sale & Tavoli | Entrance, pass or host stand still to place. / Place them / Open Rooms & Tables |
| `overlap` / `layoutUnset` / `arrangeTables` | Tavoli sovrapposti: {{pairs}}. / Tavoli di questa sala ancora da disporre. / Disponi i tavoli | Overlapping tables: {{pairs}}. / Tables in this room still to be laid out. / Lay out the tables |
| `contextLost` / `restart3d` | La vista 3D si è interrotta. / Riavvia la vista | The 3D view stopped. / Restart the view |
| `settingsHint`, testo finale | La sala in 3D in tempo reale, per un tablet all'ingresso o una TV. | The floor in live 3D, for a door tablet or a TV. |

Test unitari `geometry3d`, `layout`, `tableStatus` e `boundaries` (pagina e `model/**` non
importano `three`, `@react-three/` né `./scene`); API: `PUT /auth/me/preferences` accetta
`SALA_DAL_VIVO`. Catalogo: «Sala dal vivo (3D)» in «Sale & Tavoli», tavoli **nelle stesse
posizioni** della piantina, e uno schermo fissato è una sessione completa del suo account.

| Test | Cosa prova |
|---|---|
| `geometry3d` | px → metri; centro del tavolo; una rotazione di 90° porta il +x locale sul +Z del mondo; le sedie nel mondo sono i centri del glifo × M; i corpi dai cm si stringono e spingono fuori le sedie |
| `layout` | box orientati (vicini ruotati coi box allineati che si toccano e le forme no → niente sovrapposizione); l'euristica `unset`; estensione coi segnaposto; ripieghi dei segnaposto; la soglia dell'unione virtuale |
| `tableStatus` | colori uguali a `deriveTableDisplayStatus`; una comitiva su un secondario accende il gruppo; un walk-in delle 00:30 con turno LUNCH è della cena di ieri; i tavoli di un banchetto sono `attesa` |
| `boundaries` | il sorgente di `SalaVivoPage.tsx` e di `model/**` non contiene né `from ['"](three\|@react-three/)` né `from ['"]\.\.?/scene` |
| API `tests/api/sala-dal-vivo.test.ts` | `PUT /auth/me/preferences { preferred_landing_view: 'SALA_DAL_VIVO' }` → 200, poi di nuovo `null` |

Il punto del catalogo, dentro «Sale & Tavoli (planimetria)», più una riga nel Registro:

> **Sala dal vivo (3D)** — pagina a schermo intero con la sala in 3D in tempo reale, per un
> tablet all'ingresso o una TV: segue sempre il servizio in corso, non la data scelta in
> testata. Tavoli e sedie con gli stessi colori di stato della piantina, nelle stesse
> posizioni; ingresso, pass e accoglienza dai segnaposto. «Fissa su questo schermo»: il
> dispositivo riapre la pagina a ogni avvio, senza menu né barre, e si sblocca dalla
> pagina stessa. Uno schermo fissato è una sessione completa dell'account con cui è
> aperto: meglio un account dedicato. Si accende da Impostazioni → Ristorante.
Commit: «Sala dal vivo: vista, permesso e caricamento a richiesta fuori dal precache» ·
«Sala dal vivo: schermo fissato senza menu, che si tiene acceso e si aggiorna da solo» ·
«Sala dal vivo: sala, tavoli e segnaposto in 3D dai dati della piantina» · «Catalogo
funzionalità: Sala dal vivo».

**Collaudo sull'hardware, dopo il merge:** tablet e TV veri, `salaVivo.debug = '1'`:
modalità lenta o no, fps da fermi e spostando la vista, draw call, nella descrizione di
PR2c. Se la TV non tiene 30 fps, PR2c parte con la modalità leggera lì.

---

## 8. PR2c — Ospiti a tavola, statici (da fare)

```
inService(r) = |r.reservation_time − adesso| < 30 h  e  serviceDayOf(r.reservation_time) = servizio
live(r)      = inService(r) · stato ∉ {CANCELLED, DECLINED, NO_SHOW} · arrival_status ≠ DEPARTED
group(T)     = l'unione del turno che contiene T, altrimenti [T]; più i tavoli del banchetto di r
present(r)   = isSeated(r) · tavolo utilizzabile (esiste, non nascosto, sala esistente)
               · la live seduta più recente del gruppo (reservation_time, poi id)
               · adesso < inizio + durata effettiva + 45 min      // DEPARTED spesso mai impostato
lobby(r)     = isSeated(r) · tavolo assente o inutilizzabile · adesso < inizio + 60 min (max 6)
sign(T)      = nessun presente: prossima WAITING del turno fra adesso − 120 e + 90 minuti
               → «Riservato · HH:MM»; banchetto del servizio (QUOTE o CONFIRMED) → «Evento»
conta(r, etichetta del preset 'dog' o 'baby'), vince la prima regola che trova:
  1. note_selections con quell'etichetta (trim, maiuscole indifferenti): Σ max(1, quantity)
  2. nelle note «2× Cane»: /(\d+)\s*[×x]\s*LABEL(?=[^\p{L}\p{N}]|$)/iu → N
  3. la parola intera: /(^|[^\p{L}\p{N}])LABEL([^\p{L}\p{N}]|$)/iu → 1  // «canederli» ≠ «cane»
ospiti = max(1, ⌊guests⌋); bambini = clamp(⌊children⌋, 0, ospiti); adulti = ospiti − bambini
cani = min(2, conta(cane)); seggiolone senza bambini e con ≥ 2 adulti → 1 bambino
sedie = litChairIndices(forma, coperti, min(rimasti, coperti)) per tavolo, da r.table_id in poi
```

Una seduta più vecchia su un gruppo preso da una più recente non ha figure: senza
`DEPARTED` resterebbe seduta sotto la nuova; dopo la grazia il tavolo resta `uscita` ma
vuoto, e un banchetto senza sedute collegate ha solo il cartello. Etichette e non id,
perché gli id dei preset cambiano a ogni salvataggio; niente lookbehind (iPadOS < 16.4).
Chi non entra nelle sedie accese va sulle teste libere o sull'anello ridistribuito, poi
in piedi; adulti e bambini alternati; il seggiolone porta il più piccolo su una testa
accanto a un adulto; il cane sdraiato fuori dalla sedia del primo adulto; lobby a griglia
2×3 all'ingresso. Un'hostess per sala con l'accoglienza, col nome nella sala principale.

**Figure.** Parti in codice (gambe e braccia a capsula, busto a `LatheGeometry`, testa a
icosaedro, un cane a pezzi), bambini a scala 0,62, circa 550 triangoli a persona. **Una
`InstancedMesh` per tipo di parte,** con tre trappole: `frustumCulled = false`, perché la
bounding sphere non segue le matrici; `instanceColor` allocato prima del primo render, o
il materiale ignora `setColorAt`; capacità Σ coperti × 1,25, rifatta al doppio se manca.

| Ruolo (mai un colore di stato) | Token |
|---|---|
| Ospiti | `--ds-text-muted`, schiarito fino al 20 % verso `--ds-surface` per tavolata, bambini +15 %, teste al 35 %: pedine monocrome |
| Hostess · camerieri (PR3) · cane · cartelli | `--ds-cat-6-solid`, argilla: una categoria, l'unica tinta fuori dalle famiglie di stato · `--ds-action-bg` col grembiule `--ds-surface` · `--ds-cat-6-text` · `--tg-attesa-bg` / `-name` |

Il verde acqua `--ds-cat-1` resta fuori, troppo vicino a `uscita`. **«Nomi degli
ospiti»** (`showNames`), per dispositivo e spento di default, mostra `toTitleCase` del
nome tagliato a 24 caratteri. Testi: `reserved` «Riservato · {{time}}» («Reserved ·
{{time}}»), `event` «Evento» («Event»). Test: `party` (4 ospiti, 2 bambini e «Cane» →
2 + 2 + cane; «canederli» niente; «2× Cane» due; `note_selections` vince sul testo;
seggiolone), `placement` (6 posti e 4 ospiti → sopra 0–1, sotto 0–1; alternanza; teste
e anello; gruppi), `presence` (doppia seduta, grazia, pranzo vecchio a cena, lobby che
scade), `signs`. Commit: «Sala dal vivo: gli ospiti a tavola, con bambini e cane dalle
note» · «Sala dal vivo: cartelli riservato ed evento, nomi spenti di default».

Il dettaglio, per chi implementa. File: `components/salaVivo/model/{party,presence,
placement,signs}.ts`, `scene/{figures.ts,People.tsx,Signs.tsx}`, l'interruttore dei nomi
e il conteggio della lobby nella pagina, le chiavi nuove di `salavivo.json`,
`tests/unit/{party,presence,signs,placement}.test.ts`, catalogo e Registro.

```
gruppi       group(T) = buildMergeGroups(merges).get(`${service.shift}:${T}`) ?? [T]
             ∪ (r.banquet_menu_id → i table_ids di quel banchetto nel servizio)
cartelli     «Evento» col nome del banchetto solo a nomi accesi
etichette    dai preset delle note via swrConfig('reservationNotePresets', …), la stessa chiave
             di ReservationList: dog = le etichette dei preset con icona 'dog' (ripiego ['Cane']),
             baby = quelle con icona 'baby' (ripiego ['Seggiolone']). Le note riportano anche le
             scelte strutturate come «2× X»: per questo la regola 1 vince sulle altre
ordine       r.table_id, poi il resto del gruppo nell'ordine [primario, ...merged_ids] o i
             table_ids del banchetto; per tavolo take = min(rimasti, seats_t)
oltre        RECT/SQUARE: teste libere a (±(L/2 + 0,30), 0); CIRCLE: anello ridistribuito
             (sedia 0 a ore 12); oltre ancora, in piedi ai punti d'approccio
alternanza   anello attorno al baricentro; 2A2K → A K A K, 2A1K → A K A, 0A → tutti K
seggiolone   il bambino più piccolo su una testa libera accanto a un adulto (RECT), seduta alta
             0,75 m; CIRCLE: la stessa sedia
cane         sdraiato fuori dalla sedia del primo adulto (+0,45 m in fuori, +0,25 m di lato),
             parallelo al bordo
lobby        griglia 2×3 accanto a entranceInside, passo 0,6 m: al massimo 6, il resto si conta
accoglienza  hostSpot = segnaposto HOST_STAND (o il ripiego) + 0,5 m verso l'interno; un'hostess per
             sala, col nome solo nella principale (la prima di sortRooms con un ENTRANCE), da PR3
figure       gambe a capsula r 0,07 lunghe 0,62; busto LatheGeometry a 8 segmenti; braccia a
             capsula r 0,055; testa icosaedro r 0,13, dettaglio 1; chignon dell'hostess,
             grembiule e vassoio dei camerieri, pezzi del cane; bambini con le stesse parti a 0,62
             ~550 triangoli a persona: 150 persone ≈ 85k
             composePerson(pose, transform, out: Matrix4[]); seduti: bacino a 0,45 m, cosce in
             avanti, busto inclinato di 5°
istanze      capacità Σ coperti della sala × 1,25, più lobby e personale; si rifà al doppio, perché
             count non supera la capacità. Il set si ricostruisce solo quando cambia la chiave
             di disposizione del modello, senza allocare nel ciclo (vettori e matrici riusati)
```

Il punto del catalogo cresce così, con una riga nel Registro:

> Gli ospiti seduti ai tavoli: adulti, bambini più piccoli, il cane se è segnato nelle
> note; cartelli «Riservato» e «Evento». I nomi degli ospiti restano nascosti finché non
> li si accende su quel dispositivo.

---

## 9. PR3 — Animazioni (da fare)

**L'epoca.** App incrementa `reservationsEpoch` subito dopo `setReservations` in
`fetchData`, nello stesso batch: i ricaricamenti in blocco (connessione,
`visibilitychange`, `pageshow`) non si animano, un arrivo dopo un buco del Wi-Fi sì.
**Il server:** `/staff/presence` prende la regola di Personale (`slotState`): turno
esplicito, poi assenza, riposo settimanale e presenza implicita di FISSO **e
STAGIONALE** nel contratto. Test: STAGIONALE senza turni presente; FISSO in ferie con un
pranzo esplicito, solo pranzo; a riposo con una cena esplicita, solo cena; EXTRA assente.

**Il regista** (`model/director.ts`), puro e deterministico: `new SceneDirector({ now,
seed, tuning })`, `update(model, reason)`, `step(dtMs)`, `actorsIn(roomId)`,
`isAnimating()`, `fastForward()`, `onEvent(cb)`. Confronta `model.parties` al commit di
React, una volta sola, qualunque arrivi prima fra eco e risposta. **Scatto** (lo stato
finale, senza animazione) al primo caricamento, a epoca cambiata, a scheda nascosta, col
movimento ridotto e con più di 4 passaggi in 2 s (i rigiochi offline, «3 tavoli
aggiornati»). Un cambio di servizio azzera; tornando visibile, `fastForward()`.

| Da → a | Azione |
|---|---|
| nessuno o in attesa → seduto | **ESCORT**; oltre 12 persone, o legati a un banchetto, compaiono già seduti (80 ms a persona) |
| nessuno o in attesa → lobby | **LOBBY**: fuori dall'ingresso della sala principale, poi a un posto |
| lobby → seduto | **ESCORT** dalla lobby; in un'altra sala, dissolvenza e via dall'ingresso di quella |
| seduto A → seduto B | **RESEAT** in colonna; altra sala, dissolvenza; uno scambio di tavoli sono due reseat |
| seduto ↔ in piedi | **STAND** dietro le sedie con `DEPARTING`, **SIT** al ritorno |
| seduto o in piedi → andato (DEPARTED, CANCELLED, NO_SHOW, eliminata, fuori finestra, oltre la grazia) | **LEAVE** verso l'ingresso e fuori; spodestati da una più recente, escono mentre lei entra |
| qualsiasi → in attesa | **FADE** sul posto (annullato «Arrivato»): l'accompagnamento si annulla, l'hostess torna |
| in accompagnamento → altro tavolo | **RETARGET** da dov'è l'hostess; altra sala, dissolvenza e coda là |
| tavolo inutilizzabile · in attesa → NO_SHOW | **LOBBY**, e una sala chiusa con presenti resta una linguetta · niente: sparisce il cartello |

```
hostess: AT_STAND ─coda≠∅→ TO_ENTRANCE → GREET 800 ms → ESCORT (testa del tavolo, 1,0 m/s)
         → PRESENT 1200 ms (ognuno alla sua sedia, il cane si sdraia) → coda≠∅ ? TO_ENTRANCE
         : AT_STAND · coda > 3 → velocità ×2 · coda > 6 → i più vecchi oltre il sesto scattano
colonna: briciole ogni 0,1 m, distanza d'arco 0,8 m l'adulto, 0,7 il bambino, cane a 0,45 m;
         il tavolo resta `inarrivo` con l'anello finché tutti siedono
griglia: celle 0,20 m, raggio 0,22; tavoli esatti, sedie, banco e leggio; rifatta se cambia
A*: 8 vicini, octile, niente tagli d'angolo, array tipizzati, tetto 40k celle → retta; filo teso
passo: velocità costante, imbardata ≤ 7 rad/s, gambe ±28°, dondolio 2,5 cm; precedenza ≤ 1,5 s
tempi: ospiti 1,1 m/s, hostess e camerieri 1,3 · seduta 600 ms, alzata 500, dissolvenza 400
seme: mulberry32(hash(servizio + id)); nel modello niente Math.random né Date.now
```

**I camerieri** (`waiters.ts`, `useStaffOnShift`) sono quelli di turno, letti in modo
difensivo: chi ha un ruolo da hostess dà il nome all'hostess, gli altri il solo nome di
battesimo, senza nomi uno o due anonimi. Divisi fra le sale coi coperti presenti a resto
maggiore, al massimo 8 in cammino per sala, girano: fermi al pass 2–6 s (8–20 a schermo
fissato), poi la tavolata mai visitata più recente, o una pesata sul tempo dall'ultima
visita, 3–8 s col vassoio, e poi al pass. Fermi col movimento ridotto o in modalità lenta.

**Frame e livelli.** 30 fps con accompagnamenti o controlli, 20 coi soli camerieri, 12
coi soli anelli, 0 da fermi; oltre 50 ms di frame medio per 10 s i camerieri si
spengono. Un'etichetta sola segue il gruppo accompagnato, mossa via ref senza render di
React: «Tavolo 40 · 4 (2 bambini) + cane», o il nome a nomi accesi. La striscia
(`role="log"`) tiene gli ultimi 4 eventi per 90 s. **«Segui il servizio»**, acceso di
default a schermo fissato, va dove parte un accompagnamento e gira le sale con presenti.

| `salavivo.json` | it | en |
|---|---|---|
| `follow` · `strip.seatedLarge` | Segui il servizio · {{name}} · {{count}} a tavola | Follow the service · {{name}} · {{count}} seated |
| `strip.party` / `strip.anonymous` | {{name}} · {{count}} / Tavolo {{table}} | {{name}} · {{count}} / Table {{table}} |
| `strip.kids_one` / `_other` · `strip.dog_one` / `_other` | ({{count}} bambino) / ({{count}} bambini) · + cane / + {{count}} cani | ({{count}} child) / ({{count}} children) · + dog / + {{count}} dogs |
| `strip.toTable` / `strip.atEntrance` · `strip.moved` / `strip.leaving` | → tavolo {{table}} / all'ingresso · tavolo {{from}} → {{to}} / lascia il tavolo {{table}} | → table {{table}} / at the entrance · table {{from}} → {{to}} / leaving table {{table}} |
| `strip.updatedMany_one` / `_other` | {{count}} tavolo aggiornato / {{count}} tavoli aggiornati | {{count}} table updated / {{count}} tables updated |

Test: `navGrid` (aggira un tavolo, niente tagli d'angolo, 30k celle sotto i 20 ms),
`motion`, `director` con orologio finto e seme fisso (ogni passaggio e ogni scatto,
l'epoca, la coda, stesso seme stesse posizioni), `waiters`. Commit: «Presenze del
personale: stessa regola della pagina Personale» · «Sala dal vivo: griglia di cammino e
percorsi» · «Sala dal vivo: il regista della scena» · «Sala dal vivo: l'accoglienza
accompagna gli ospiti al tavolo» · «Sala dal vivo: i camerieri di turno girano fra pass e
tavoli».

Il dettaglio, per chi implementa. File: in App `const [reservationsEpoch,
setReservationsEpoch] = useState(0)` e `setReservationsEpoch(e => e + 1)` subito dopo
`setReservations(…)` in `fetchData`, passato alla pagina; `/staff/presence` in
`server.ts`; `components/salaVivo/model/{rng,navGrid,motion,director,waiters}.ts`; il set
dinamico in `scene/People.tsx`; `NameTagLayer.tsx`, `ActivityStrip.tsx`,
`useStaffOnShift.ts`; nella pagina i motivi di scatto, «Segui il servizio» e la guardia
della ricarica su `director.isAnimating()`; `tests/unit/{navGrid,motion,director,
waiters}.test.ts` e `tests/api/presenza-personale.test.ts`.

**Il server.** Oggi `/staff/presence` conta solo i FISSO e fa vincere l'assenza su un
turno esplicito; la rotta ha un solo client, `staffApiService.getStaffPresence`, che oggi
nessuno chiama. Sparisce il `continue` anticipato sull'assenza di tutto il giorno, e:

```ts
// Stessa lettura della pagina Personale (slotState, StaffManagement.tsx): il
// turno esplicito vince sull'assenza; poi assenza, riposo settimanale, presenza
// implicita di FISSO e STAGIONALE nel periodo di contratto.
const autoShifts = row.staff_type === 'FISSO' || row.staff_type === 'STAGIONALE';
const inContract = (!row.hire_date || row.hire_date <= dateStr) && (!row.contract_end_date || row.contract_end_date >= dateStr);
for (const shift of ['LUNCH', 'DINNER'] as const) {
    const explicit = explicitShifts.get(`${row.id}-${shift}`);
    const present = explicit !== undefined ? explicit
        : (onTimeOffFullDay.has(row.id) || onTimeOffShift.has(`${row.id}-${shift}`)) ? false
        : isWeeklyRest ? false
        : autoShifts && inContract;
    if (present) staffByShift[categoryKey][shift === 'LUNCH' ? 'lunch' : 'dinner'].push(staff);
}
```

Il test API usa una data futura e cancella il suo personale alla fine.

**Il regista.** Nella pagina `useState(() => new SceneDirector(…))[0]`; `update(model,
reason)` con `reason` fra `'initial' | 'refetch' | 'hidden' | 'reduced-motion' | null`,
calcolato in un effetto su `[model, reservationsEpoch, reducedMotion]`:

| Motivo | Quando |
|---|---|
| `initial` | non c'è ancora una base |
| `refetch` | `reservationsEpoch` è cambiata dall'ultimo `update`: connessione, `visibilitychange`, `pageshow` e il ricaricamento dopo lo svuotamento della coda offline |
| `hidden` · `reduced-motion` | `document.visibilityState === 'hidden'` · l'utente preferisce meno movimento |
| cambio di servizio | cambia `model.serviceKey`: il regista si azzera |

Più di 4 passaggi che toccano attori in un `update`, o in 2 s, scattano anche loro ed
emettono `{ kind: 'bulk', count }`. Il confronto è su `model.parties` (`{ id, state:
'waiting'|'lobby'|'seated'|'standing'|'gone', roomId, groupKey, present }`). Lobby →
andato e qualsiasi → in attesa sono **FADE** sul posto; un accompagnamento verso un'altra
sala fa svanire i membri e li rimette in coda all'ingresso di quella, uno verso «andato»
li fa svanire e l'hostess torna. Per un tavolo inutilizzabile (mancante, nascosto, sala
eliminata) si va in **LOBBY**; in attesa → NO_SHOW o CANCELLED non fa niente, sparisce
solo il cartello.

```
testa        tableHead(gruppo) = il capo del rettangolo più vicino all'ingresso a ±(L/2 + 0,45),
             o per un cerchio il varco più vicino all'ingresso a raggio Dc/2 + 0,5
hostess      AT_STAND ─coda≠∅→ TO_ENTRANCE(hostSpot→entranceInside) → GREET 800 ms
             → ESCORT(→ tableHead, 1,0 m/s, membri in colonna) → PRESENT 1200 ms (braccio verso
             il tavolo; ognuno seat(chair); cane sdraiato) → emit('escort-end')
             → coda≠∅ ? TO_ENTRANCE : RETURN → AT_STAND; coda > 6 → emit('snapped')
colonna      il membro k segue alla distanza d'arco s_leader − Σgap; il cane cammina a 0,45 m
             accanto al suo adulto
riconcilia   comitive senza attori nascono già al loro posto; se cambia la geometria i seduti
             scattano sulle sedie nuove e chi cammina rifà il percorso
semi         mulberry32(hashString(serviceKey + ':' + id)); i camerieri seed ^ hash(name)
tuning       adulti e bambini 1,1 m/s · hostess libera 1,3, accompagnando 1,0 · camerieri 1,3
             seduta 600 ms · alzata 500 · dissolvenza 400 · BULK_K 4, BULK_WINDOW_MS 2000
             coda: ×2 oltre 3, scatto oltre 6 · ESCORT_MAX_PARTY 12
griglia      CELL 0,20 m · AGENT_R 0,22 m · una per sala, rifatta quando cambiano tavoli, unioni,
             nascosti o segnaposto. Bloccati: il bordo (una cella, tranne la porta); i tavoli con
             l'AABB di getTableFootprint(t, x, y, AGENT_R/M, 0) e dentro il test esatto (OBB del
             piano o disco Dc gonfiati di AGENT_R; sedie: distanza < 0,25 + AGENT_R); il PASS
             1,6×0,5 m; l'HOST_STAND disco da 0,3 m
nearestFree  BFS entro 1,0 m, poi 2,0 m; se niente, retta (compenetrazione accettata)
A*           8-connesso, costi 1 e √2, euristica octile, niente tagli d'angolo, heap binario,
             Float32Array/Int32Array, tetto 40k celle → retta
lisciatura   filo teso con linea di vista supercover; inseguimento su lunghezze cumulative
seat(chair)  A* fino all'approach, poi l'ultimo passo fuori griglia approach → sedia (0,55 m,
             0,5 s), rotazione (0,25 s), seduta (0,6 s)
camminata    phase += v·dt/passo (0,7 m; bambini 0,45); gambe sin(2πφ)·28°; braccia −0,8×;
             dondolio |sin 2πφ|·0,025 m; il cane a coppie diagonali
precedenza   chi cammina si ferma se un altro (non leader né follower) è entro 0,45 m davanti,
             al massimo 1,5 s
```

**I camerieri.** Da `staffApiService.getStaffPresence(service.date).sala[lunch|dinner]`,
letti come `{ id, name, role }`; si rileggono con 1,5 s di debounce sugli eventi
`staff:*`, `shift:*` e `timeoff:*` e al cambio d'epoca; un errore dà `null`. Il ruolo
`/host|accoglien|ma[iî]tre/i` dà il nome all'hostess principale. Senza nomi: 2 se c'è
qualcuno seduto, altrimenti 1. A ristorante vuoto, uno al pass della sala attiva. I nomi
girano in ordine `sortRooms`; quelli oltre gli 8 in cammino stanno al pass; si
riassegnano solo fra un compito e l'altro (il vecchio svanisce al pass, il nuovo
compare). Il giro:

```
AT_PASS fermo U(2,6) s (fissato: U(8,20) s) → bersaglio:
  p1 = gruppi presenti mai visitati, i più recenti prima, non già presi; p2 = estrazione pesata su (now − lastVisitAt)
→ WALK(passFront → servicePoint: testa libera o varco più vicino al pass, raggio +0,5 m) → SERVE U(3,8) s (vassoio)
→ WALK(→ passFront) → AT_PASS (posa 1 s)
```

**Livelli.** Il set dinamico ha le stesse parti, capacità 48, `frustumCulled = false` e
`DynamicDrawUsage`; tiene chi cammina e chi è a metà passaggio, riscritto a ogni frame
disegnato con temporanei riusati. `dt` si ferma a 100 ms. L'etichetta del gruppo è **un**
elemento DOM, messo con `head.project(camera)` e un transform via ref. La striscia sta in
basso a sinistra, `role="log" aria-live="polite"`, con `animate-view-in`. **«Segui il
servizio»**, per dispositivo: a un `escort-start` in un'altra sala cambia linguetta con
un calo d'opacità di 150 ms; 20 s dopo l'`escort-end`, senza altro, torna alla sala di
casa; fissato e fermo, gira le sale con presenti ogni 45 s; un tocco su una linguetta o
un trascinamento lo mettono in pausa per 120 s. Un iPad all'ingresso, in servizio,
disegna di continuo a 20 fps: si misura in §10.

| Test | Cosa prova |
|---|---|
| `navGrid` | il percorso aggira un tavolo; niente tagli d'angolo; la lisciatura toglie i nodi allineati; un bersaglio bloccato va alla cella libera più vicina; 30k celle sotto i 20 ms |
| `motion` | velocità costante lungo il percorso; il limite d'imbardata regge |
| `director` (orologio finto, seme fisso) | il primo `update` scatta; WAITING → ARRIVED con tavolo: un accompagnamento che parte dall'accoglienza; lobby → tavolo, e in un'altra sala dissolvenza e ricomparsa; RESEAT, STAND, SIT, LEAVE, FADE; annullare durante l'accompagnamento fa svanire i membri; RETARGET nella stessa sala; una comitiva più recente fa uscire la vecchia; un'epoca nuova scatta e un arrivo dopo si anima (il Wi-Fi ballerino); più di 4 passaggi scattano; coda ≥ 4 a ×2, oltre 6 scattano i più vecchi; un cambio di servizio azzera; stesso seme e stessi ingressi, stesse posizioni dopo N passi |
| `waiters` | divisione a resto maggiore; prima la comitiva più recente mai visitata; tetto per sala; numero di ripiego senza nomi |
| API `presenza-personale` | STAGIONALE senza turni: presente a pranzo e a cena; FISSO in ferie tutto il giorno con un pranzo esplicito: solo pranzo; FISSO nel riposo settimanale: assente, e con una cena esplicita solo cena; EXTRA senza turno: assente |

La riga del Registro:

> L'accoglienza va all'ingresso e accompagna gli ospiti al tavolo; i camerieri di turno —
> gli stessi di Personale, stagionali compresi — girano fra pass e tavoli, prima i tavoli
> appena seduti.

**Fase 2, solo traccia: i camerieri delle Comande.** Con `table_orders_enabled` e
`orders:view`, `GET /orders/open` dà la mappa comanda → tavolo: `course:fired` porta la
comanda al pass, `course:ready` / `course:called` il vassoio, `course:served` chiude la
consegna, `bill:opened` porta la cartellina, `bill:closed` / `bill:settled` fanno LEAVE
(e chiudono il buco del «DEPARTED mai impostato»), `orderpad:presence` mette il cameriere
al tavolo. Una comanda aperta spegne il finto accompagnamento di `associateCustomer` (G4).
Gli eventi sono tutti `broadcastToAll`, quindi la pagina li riceve; la mappa comanda →
tavolo si aggiorna su `order:created` e `order:updated`, e per `course:called`, che a
volte non ha l'ordine, si passa da `table_name`. Una comanda aperta su un tavolo senza
prenotazione presente vuol dire «c'è gente»: banchetti senza arrivi collegati e walk-in
senza prenotazione. Senza modulo o senza eventi resta il comportamento d'ambiente di
PR3. Buchi noti: nessun «servito da», alcuni payload senza `table_id`, nessun evento
«conto chiesto».

---

## 10. Verifica

```bash
npx tsc --noEmit
npm run check:locales         # it/en allineati e chiavi t('…') nei file a namespace unico
npm run check:rls-bypass      # ogni bypass del contesto tenant porta il suo perché
npm run test:unit             # da PR2a
npm test && TEST_STRICT_RLS=1 npm test   # build:server + test API, poi col server non superuser
npx vite build --manifest     # poi i controlli del bundle (da PR2b), e rm -rf dist
```

**Bundle, da PR2b:** dal manifest, partendo da `index.html`, nessun chunk `sala3d/`
raggiungibile staticamente e nessun three importato dalla pagina; in `dist/sw.js` almeno
un URL `assets/index-` e nessun `assets/sala3d/` (si leggono gli URL: il codice della
rotta contiene già «sala3d»); gzip three ≈ 180 KB, canvas 70–90, pagina 15–25, bundle
principale meno di 10 KB in più; dopo una modifica alla sola app `three-*.js` non cambia.

```bash
node -e 'const m=require("./dist/.vite/manifest.json");const s=new Set();const w=k=>{if(s.has(k))return;s.add(k);(m[k].imports||[]).forEach(w)};w("index.html");const f=[...s].map(k=>m[k].file);if(f.length<2)throw new Error("walk vuoto");const bad=f.filter(x=>x.includes("sala3d/"));const p=m["components/salaVivo/SalaVivoPage.tsx"];const pt=(p&&p.imports||[]).map(k=>m[k].file).filter(x=>x.includes("three"));console.log({static:f.length,bad,pageThree:pt});process.exit(bad.length||pt.length?1:0)'
grep -oE '"?url"?:"assets/[^"]+"' dist/sw.js | grep -c 'assets/index-'    # ≥ 1: il filtro morde
grep -oE '"?url"?:"assets/[^"]+"' dist/sw.js | grep -c 'assets/sala3d/'   # 0
for f in dist/assets/sala3d/*.js; do echo "$f $(gzip -c "$f" | wc -c)"; done
ls -la dist/assets/index-*.js                                             # confronto con main
rm -rf dist
```

**Hash stabile (PR2b):** una build, si annota `dist/assets/sala3d/three-*.js`; si cambia
una stringa in `components/Dashboard.tsx` e si rifà la build: il nome di `three-*` non
cambia. Poi si annulla la modifica e `rm -rf dist`.

**Stack locale.** Mai `npm run dev`, e prima di tutto `cat .env.local`.
`./scripts/dev-comande.sh` dà il database `ristocomande`, API su :4599, web su :5199
(`collaudo@ristomanager.local` / `Comande2026!`) e applica le migration. Per precache e
chunk serve una build vera (`VITE_API_URL=http://localhost:4599 npx vite build && npx
vite preview --port 5198`, poi `rm -rf dist`). Mai fra le 00:00 e le 05:00. Il seed:

| Cosa | Valori |
|---|---|
| Sala e tavoli | Veranda 800×600: 40 rettangolo da 6 in (360, 300) · 41 rettangolo da 4 (140, 300) · 42 cerchio da 4 (600, 300) · 43 rettangolo da 8 (140, 80) · 44 cerchio da 6 (420, 60) · 45 quadrato da 4 (620, 80) ruotato di 45° |
| Segnaposto | `ENTRANCE` (400, 560) · `HOST_STAND` (520, 520) · `PASS` (60, 40) |
| Personale di sala | Giulia Neri, FISSO, Hostess · Marco Galli, FISSO, Cameriere · Sara Fontana, STAGIONALE, Cameriera |
| Prenotazioni | Famiglia Esposito, 4 con 2 bambini, nota «Cane», tavolo 40, fra 10 minuti · Coppia Bianchi, 2, fra 40 minuti; turno di adesso, CONFIRMED e WAITING; interruttore acceso in `app_settings` |

Lo stesso seed in SQL, per `psql postgresql://localhost/ristocomande` (lo script passa
`VITE_API_URL` in linea e applica `createSchema` e le migration, quindi `floor_markers`
c'è; CORS accetta qualunque porta di localhost):

```sql
INSERT INTO rooms (tenant_id, name, width, height) SELECT 1, 'Veranda', 800, 600 WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE name = 'Veranda');
INSERT INTO tables (tenant_id, name, shape, seats, x, y, room_id, status, rotation)
SELECT 1, t.n, t.s, t.c, t.x, t.y, (SELECT id FROM rooms WHERE name = 'Veranda'), 'FREE', t.r
FROM (VALUES ('40','RECTANGLE',6,360,300,0), ('41','RECTANGLE',4,140,300,0), ('42','CIRCLE',4,600,300,0),
             ('43','RECTANGLE',8,140,80,0), ('44','CIRCLE',6,420,60,0), ('45','SQUARE',4,620,80,45)) AS t(n,s,c,x,y,r)
WHERE NOT EXISTS (SELECT 1 FROM tables WHERE name = t.n);
INSERT INTO floor_markers (tenant_id, room_id, kind, x, y)
SELECT 1, (SELECT id FROM rooms WHERE name = 'Veranda'), k.kind, k.x, k.y
FROM (VALUES ('ENTRANCE',400,560), ('HOST_STAND',520,520), ('PASS',60,40)) AS k(kind,x,y)
ON CONFLICT (room_id, kind) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y;
INSERT INTO staff_members (tenant_id, name, surname, category, staff_type, role, is_active) VALUES
 (1,'Giulia','Neri','SALA','FISSO','Hostess',true), (1,'Marco','Galli','SALA','FISSO','Cameriere',true),
 (1,'Sara','Fontana','SALA','STAGIONALE','Cameriera',true);
INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, children, notes, table_id,
                          payment_status, reservation_status, arrival_status)
SELECT 1, v.name, now() + v.dt, CASE WHEN (now() AT TIME ZONE 'Europe/Rome')::time < time '17:00' THEN 'LUNCH' ELSE 'DINNER' END,
       v.g, v.k, v.notes, (SELECT id FROM tables WHERE name = '40'), 'PENDING', 'CONFIRMED', 'WAITING'
FROM (VALUES ('Famiglia Esposito', interval '10 minutes', 4, 2, 'Cane'),
             ('Coppia Bianchi',    interval '40 minutes', 2, 0, NULL)) AS v(name, dt, g, k, notes);
INSERT INTO app_settings (tenant_id, key, value) VALUES (1, 'sala_dal_vivo_enabled', 'true')
ON CONFLICT (tenant_id, key) DO UPDATE SET value = 'true';   -- la stessa forma di pay_at_table in dev-comande.sh
```

**Il copione,** in Chrome con due schede, A `?view=RECEPTION` e B `?view=SALA_DAL_VIVO`,
registrato in GIF:

| In A, o sul dispositivo | In B |
|---|---|
| niente | Veranda, «Riservato · HH:MM» sul 40, l'hostess all'accoglienza; da PR3 Marco e Sara che girano (Sara stagionale prova il server) |
| «Arrivato» su Famiglia Esposito | entro 1 s l'hostess va all'ingresso; 2 adulti, 2 bambini e il cane la seguono; «Tavolo 40 · 4 (2 bambini) + cane»; alternati sulle sedie che la 2D accende (sopra 0–1, sotto 0–1); il tavolo diventa `arrivato`; il primo cameriere va al 40. Con «Nomi degli ospiti» acceso l'etichetta diventa «Famiglia Esposito …» |
| tavolo 41, poi 40 · Coppia Bianchi «Arrivato» al 40 | si alzano, camminano, si siedono · gli Esposito escono mentre la coppia entra |
| «Arrivato» e subito «In attesa» · «In uscita», poi «Tavolo liberato» | il gruppo svanisce e l'hostess torna · si alzano, poi escono |
| B offline, 3 arrivi, B online; poi un buco di 1 s e un arrivo | seduti subito, «3 tavoli aggiornati»; l'arrivo dopo il buco si anima |
| B in background per 30 s durante un accompagnamento · movimento ridotto · modalità scura | già seduti al ritorno · arrivi immediati e camerieri fermi · colori cambiati sul posto, senza ricreare il contesto |
| `--disable-webgl` su una build di preview · 15 ingressi e uscite | il callout, nessuna richiesta a `/assets/sala3d/` · nessun «Too many active WebGL contexts», heap piatto dopo un GC forzato |
| fissa e ricarica · prenotazione nuova in A · sblocca · errore forzato | atterra sulla pagina, niente testata, barra in basso né laterale, l'orologio della LivePill avanza, lo schermo non si spegne · nessun toast col nome · il menu torna, anche dopo l'errore |
| **PR1**, in Sale & Tavoli | spento: niente strumenti né richieste. Acceso: strumenti spenti per un attimo, finché arriva la lista; un tocco crea il segnaposto al centro e accende «Sposta tavoli» (spegnendo «Modifica tavoli»), così si trascina subito; 44 px a ogni zoom; spinto contro la parete resta intero, e rilasciato sulla barra laterale si posa; con «Sposta tavoli» spento il tocco passa al tavolo sotto; una seconda scheda si aggiorna; un WAITER vede e non tocca. Da PR2b: l'ingresso spostato sposta la porta in B, «Posizionali» apre la sala giusta |

Senza WebGL, su una build di preview: `open -na "Google Chrome" --args
--user-data-dir="$(mktemp -d)" --disable-webgl`. Il movimento ridotto si accende da
DevTools → Rendering → `prefers-reduced-motion: reduce` («Centra» salta invece di
scorrere); l'errore forzato del chiosco si provoca da React DevTools.

La ricarica alla versione nuova si prova solo su un'anteprima Vercel (in locale la
versione è `'dev'`). **Prestazioni:** sala «Carico» 1400×1100, 31 tavoli da 4, 30
tavolate sedute e 8 camerieri, CPU ×4: almeno 30 fps in accompagnamento, circa 20
d'ambiente, 0 da fermi; meno di 200 draw call e di 150k triangoli; heap piatto in 10
minuti. Poi tablet e TV veri.

```sql
INSERT INTO rooms (tenant_id, name, width, height) SELECT 1, 'Carico', 1400, 1100 WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE name = 'Carico');
INSERT INTO tables (tenant_id, name, shape, seats, x, y, room_id, status)
SELECT 1, 'P' || i, 'RECTANGLE', 4, 40 + (i % 6) * 220, 40 + (i / 6) * 220, (SELECT id FROM rooms WHERE name = 'Carico'), 'FREE'
FROM generate_series(0, 30) AS i WHERE NOT EXISTS (SELECT 1 FROM tables WHERE name = 'P' || i);
INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, children, table_id, payment_status, reservation_status, arrival_status)
SELECT 1, 'Carico ' || i, now() - interval '20 minutes', CASE WHEN (now() AT TIME ZONE 'Europe/Rome')::time < time '17:00' THEN 'LUNCH' ELSE 'DINNER' END,
       4, i % 3, (SELECT id FROM tables WHERE name = 'P' || i), 'PENDING', 'CONFIRMED', CASE WHEN i < 30 THEN 'ARRIVED' ELSE 'WAITING' END
FROM generate_series(0, 30) AS i;
INSERT INTO staff_members (tenant_id, name, surname, category, staff_type, role, is_active)
SELECT 1, 'Cameriere' || i, 'Prova', 'SALA', 'FISSO', 'Cameriere', true FROM generate_series(1, 8) AS i;
```

Si misura con DevTools Performance a CPU ×4 e Rendering → Frame Rendering Stats:
l'accompagnamento di «Carico 30» con 8 camerieri in cammino ad almeno 30 fps. Con
`localStorage['salaVivo.debug'] = '1'` il riquadro di debug mostra `gl.info.render`:
draw call e triangoli si leggono lì.

---

## 11. Rischi e default

| # | Rischio | Default |
|---|---|---|
| G1 | Le posizioni salvate in produzione non sono mai state guardate, e il seed vecchio sta su un reticolo di 100 px che sovrappone i glifi da sei | Callout di sovrapposizione e di sala da disporre. **Prima di accendere l'interruttore** Tina sistema le sale con «Sposta tavoli» e posiziona i tre segnaposto. Dal #801 la piantina mostra la stessa verità della 3D, quindi il controllo si fa in 2D |
| G2 | Forme minuscole ereditate dal seed | La 3D imita la 2D esattamente; normalizzarle è un fix a parte |
| G3 | Nomi degli ospiti su schermi che gli ospiti vedono | Spenti di default per dispositivo; toast muti; audit nascosti a schermo fissato. Uno schermo fissato è una sessione completa del suo account (RECEPTION ha `reservations:full`, `customers:full`, `payments:view`): meglio un account dedicato. Un ruolo di sola visione è lavoro futuro |
| G4 | `associateCustomer` di Cassa fa partire un finto accompagnamento | Accettato; la fase 2 lo spegne quando c'è una comanda aperta |
| G5 | `DEPARTED` impostato di rado | 45 min di grazia dopo la fine prevista, poi niente figure (in PR3 escono camminando); il colore resta `uscita` |
| G6 | Presenze del server diverse da Personale | Allineate in PR3 |
| G7 | Hardware sconosciuto; rendering continuo in servizio (calore, risparmio energetico di iOS) | Collaudo dopo PR2b; modalità lenta; 20 fps d'ambiente; pause più lunghe a schermo fissato; modalità leggera |
| G8 | Limite di contesti WebGL di Safari; StrictMode | R3F ≥ 9.8.1; un canvas solo; sonde rilasciate; prova dei rimontaggi |
| G9 | Prima apertura di una TV durante un'interruzione | `LazyChunkError` con «Ricarica»; aprire la pagina una volta all'installazione |
| G10 | Il confine fra pranzo e cena non è lo stesso su ogni schermo | La 3D segue il server; FloorPlan, Reception, Cassa e Prenotazioni potranno adottare l'helper più avanti |
| G11 | Un ingresso per sala; sale senza posizione fra loro | `UNIQUE (room_id, kind)`; dissolvenza fra sale. Più ingressi: via il vincolo, più un'etichetta |
| G12 | Falsi positivi del cane («senza cane»); numero ignoto | Parola intera; al massimo due cani |
| G13 | `width_cm` e `length_cm`: significato e valori fuori misura | Larghezza = profondità, lunghezza = lato lungo; corpi dentro il box del glifo |
| G14 | Finestre di deploy | Railway prima per PR1, PR2b e PR3; la SPA regge un 404 sui segnaposto e un interruttore assente |
| G15 | Il bundle principale cresce per sbaglio | I controlli del manifest e `tests/unit/boundaries.test.ts` |
| G16 | `three` in devDependencies rompe un futuro build della SPA con `--omit=dev` | Vercel e CI installano le devDependencies; va scritto nella descrizione di PR2b |
| G17 | I tavoli nascosti sono mobili veri | Omessi, come in 2D |
| G18 | I banchetti non hanno orario né ciclo d'arrivo | Figure solo dalle prenotazioni collegate e sedute, altrimenti il cartello |
| G19 | Tavoli uniti salvati lontani | Disegnati come in 2D: un primario per la somma dei coperti |
| G20 | Chiosco in trappola dopo un crash | Il chrome lo chiede la pagina con `onImmersive`: smontata lei, torna la navigazione |
| G21 | Interruttore o entitlement, se Sympotia vende la vista 3D | Interruttore operativo ora; un entitlement seguirebbe il modello delle recensioni, chiuso in caso d'errore |
| G22 | Clone vecchio | `git fetch` prima di tutto, poi migration e ancore: è già successo (§2) |

---

## 12. Deliberatamente fuori

Camerieri guidati dalle Comande (§9), un ruolo di sola visione per gli schermi fissati,
più ingressi per sala e una posizione delle sale fra loro. L'arredo vero (bancone,
pareti): `docs/cassa-plan.md` §12 metteva «Arredo della piantina (bancone, ingresso)» fra
le cose senza modello, e l'ingresso ora ce l'ha, ma i segnaposto sono punti, non mobili.
Figure dei banchetti per tutto il turno (§13), forme del seed, altri schermi sull'helper.

---

## 13. Note per il revisore

**Correzioni trovate riallineando.** «Come `room:*`» era sbagliato sull'esclusione del
mittente: `broadcastRoom*` non escludono nessuno; il contratto resta, sul modello di
`table:created`. La trappola di Tailwind (§5.4) morde già il bottone di conferma della
sala in FloorPlan (`${dsIconButton} bg-[var(--ds-action-bg)]`), disegnato bianco, e
`salacucina.json` scrive «Sala &amp; Cucina», che esce così a video: tutti e due fuori
perimetro. `dist/` è condiviso fra `vite build` e i test API: mai in parallelo.

**Da decidere con Tina: il pieno dei segnaposto posati.** Uno strumento col segnaposto
già sulla piantina usa `TOOL_BUTTON_ON`, come chiedeva la specifica; ma quel pieno vuol
dire «modalità accesa» per «Sposta tavoli» e «Modifica tavoli», e a segnaposto posati
(lo stato normale) chi modifica vede tre bottoni pieni accanto ai due delle modalità,
anche a modalità spente. L'alternativa è lasciarli su `EDIT_ACTION_QUIET` e segnare il
posato con un indizio più piccolo (un segno di spunta, o l'etichetta che cambia, come già
fa). Resta com'è finché Tina non sceglie.

**«Pass» o «Passe».** Nel resto dell'app la postazione si chiama «Passe»
(`passe_enabled`, Impostazioni → Sala e cucina → Passe). «Pass» è il testo approvato per
il segnaposto e resta finché Tina non dice altrimenti: è una riga per lingua.

**Il fuso del ristorante, per PR2a.** Il piano diceva «ora di Roma». Dal 20 settembre il
tenant ha un fuso suo (`tenant.timezone`), che il frontend tiene come fuso di sessione
(`sessionTimeZone()` in `utils/displayTime.ts`), e il server ha `resolveService(at, tz)`
con Roma di default. La strada coerente è un helper col fuso come parametro esplicito, a
cui il frontend passa quello di sessione; per Vecchio Frantoio non cambia niente.

**La revisione avversaria.** Accolti: M1, con lo schermo intero su `documentElement`
(modali e toast restano visibili) e il chrome via `onImmersive` (un crash rende la
navigazione); M3–M6, con l'epoca di M4 estesa a `visibilitychange` e `pageshow`; M7,
interruttore e cancello in PR1; i minori 1 e 3 più semplici (broadcast diretto, via
outbox, snapshot e convergenza), il 2 (niente coda offline), 4–9, 11–22 e 24 come
proposti, e il 23, con PR2 divisa in tre e audit ed etichette già in 2b. Respinti: M2,
«solo la prima parola del nome», perché «Famiglia Esposito» diventerebbe «Famiglia»; M7,
«catalogo solo in PR2», perché la convenzione lo vuole nella stessa PR; il minore 10,
«figure dei banchetti per tutto il turno», perché senza orario 40 persone alle 17:05 per
un evento serale sarebbero false; il 16, perché «ancora da disporre» suona meglio.

Otto errori della bozza sono già corretti nel testo, fra cui l'helper senza import,
l'anello a 2,2 s e non 1,4, `LogIn` per `DoorOpen`, le date NOT NULL e i box orientati.
