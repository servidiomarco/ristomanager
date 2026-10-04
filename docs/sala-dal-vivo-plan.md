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

**Dove siamo:** PR1 (segnaposto di sala e interruttore per ristorante, spento di default),
PR2a (fondamenta, niente di visibile), PR2b (la pagina con la sala in 3D) e PR2c (gli ospiti
a tavola, fermi) sono fatte; PR3, le animazioni, è in corso. Lo stato di ogni fase è in §3. Il documento è la specifica del piano
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

### 1.3 Di Tina, il 4 ottobre (dopo la revisione di PR2b)

1. **Un'unione si disegna sempre come in 2D:** un tavolo solo, il primario al suo posto
   col nome unito e i posti sommati; i secondari non si disegnano. L'editor non lascia
   posare due tavoli a contatto, e ognuno al suo posto lasciava una tavolata divisa da un
   corridoio che in sala non c'è. Da PR2c una tavolata siede al tavolo unito e non si
   sparge mai sui tavoli fisici del gruppo (§7.2, §8).
2. **Sulle linguette, le persone a tavola adesso** in quella sala, non i coperti: la
   capienza non cambia durante il servizio, e uno schermo all'ingresso deve dire chi c'è.
   Da PR2c il numero viene dalla stessa regola di presenza delle figure: una linguetta non
   può dire 4 con 6 figure sedute (§8).
3. **La rotta dei dizionari resta in PR2b:** la `NetworkFirst` di `pwa/sw.js` sulla cache
   `locales`, per tutte le viste. A linea caduta l'app riparte con le parole e non con le
   chiavi grezze, e un tablet all'ingresso apre la sala anche dopo un'interruzione (G9).

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
| PR1 | `claude/segnaposto-di-sala` | Segnaposto: tabella, route, eventi, strumenti 2D. Interruttore e card in Impostazioni | Railway prima | fatta |
| PR2a | `claude/sala-dal-vivo-fondamenta` | Geometria del glifo condivisa, servizio in corso, test unitari. Niente di visibile | solo frontend | fatta |
| PR2b | `claude/sala-dal-vivo-pagina` | Vista, chiosco, caricamento a richiesta e PWA; sala, tavoli e segnaposto in 3D. **Collaudo sull'hardware dopo il merge** | Railway prima (enum `ViewState`) | fatta |
| PR2c | `claude/sala-dal-vivo-ospiti` | Ospiti statici con bambini e cane, cartelli, nomi spenti di default | solo frontend | fatta |
| PR3 | `claude/sala-dal-vivo-animazioni` | Regista, accompagnamenti, camminata, camerieri d'ambiente, striscia, «Segui il servizio»; `/staff/presence` come Personale | Railway prima | **in corso** |

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
      SceneDirector [PR3] (puro, orologio e seme iniettati): diff(partyStates) → copioni → attori
      └─ sonda WebGL2 ok → React.lazy(SalaVivoCanvas) + chunk three       assets/sala3d/
           <Canvas frameloop="demand" flat dpr={[1,1.5]}>  RoomShell · Fixtures · TablesLayer
             · TableLabels · People (InstancedMesh per parte) · Signs · CameraRig · FrameThrottle
           useFrame → director.step(dt) → matrici delle istanze (mai stato React per frame)
FloorPlan.tsx ─ useFloorMarkers(enabled) ─ strumenti segnaposto (interruttore + floorplan:full)
```

Tre confini reggono il resto: la pagina non importa mai three né la scena, o il chunk 3D
finirebbe su ogni palmare; il modello è TypeScript puro; niente stato React per frame.

---

## 5. PR1 — Segnaposto di sala e interruttore (fatta)

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

## 6. PR2a — Fondamenta (fatta)

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

**Il servizio di adesso**, com'è uscito, sta in due file. **`utils/reservationTime.ts`**,
che resta **senza import** perché lo compila anche il server, ha `currentServiceInTz(at, tz)`
(data del servizio, turno e `anchor`) e `serviceDayInTz(iso, tz)` (un walk-in delle 00:30 è
della cena di ieri), col fuso esplicito come `getDatePartInTz`. **`utils/displayTime.ts`**,
solo frontend, ha `currentService(at?)` e `serviceDayOf(iso)`, che passano il fuso della
sessione, cioè quello del ristorante (§13). L'ora si legge sempre lì, mai sul dispositivo;
App cancella la sua copia e usa `currentService`, e la pagina converte il turno in `Shift`.

| File | Cosa cambia |
|---|---|
| `utils/tableGeometry.ts` (nuovo, solo frontend) | le costanti `GLYPH`, `getGlyphDimensions` copiata identica, `getChairSlots`, `litChairIndices` |
| `components/TableGlyph.tsx` | disegna da queste funzioni con SVG identico e riesporta `getGlyphDimensions`: FloorPlan, ReservationList, ReceptionPage e la Piantina di Cassa non si toccano |
| `utils/tableOverlap.ts`, `utils/tableLayout.ts`, `utils/labelPlacement.ts` | importano `getGlyphDimensions` da `./tableGeometry`, così restano senza React |
| `utils/reservationTime.ts` · `utils/displayTime.ts` · `App.tsx` | `currentServiceInTz` e `serviceDayInTz`, senza import e col fuso esplicito · `currentService` e `serviceDayOf` sul fuso della sessione · App cancella la sua copia e usa `currentService` |
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

L'helper del servizio com'è uscito (la pagina mappa il letterale su `Shift` in
`model/service.ts`, così nessun cast arriva a `getTableMerges(date, shift: Shift)`):

```ts
// utils/reservationTime.ts — niente import: lo compila anche il server, dove ogni
// richiesta è di un tenant diverso e il fuso si passa esplicito.
export const SERVICE_DAY_START_HOUR = 5;   // il giorno di servizio comincia alle 05:00 del ristorante
export const DINNER_START_HOUR = 17;       // la cena alle 17:00, come resolveService sul server
export const currentServiceInTz = (at: Date, tz: string): { date: string; shift: 'LUNCH' | 'DINNER'; anchor: Date };
//   ora < 5 → { date: il giorno prima sul calendario, shift: 'DINNER', anchor: at − 6 h }
//   altrimenti → { date: getDatePartInTz(at, tz), shift: ora < 17 ? 'LUNCH' : 'DINNER', anchor: at }
export const serviceDayInTz = (iso: string | Date | null | undefined, tz: string): string;  // '' se illeggibile

// utils/displayTime.ts — solo frontend, sul fuso della sessione (setSessionTimeZone)
export const currentService = (at?: Date) => /* currentServiceInTz(at, fuso della sessione) */;
//   l'ancora passa a mezzogiorno locale quando il dispositivo sta in un altro fuso
export const serviceDayOf = (iso: string | Date | null | undefined): string;
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
nel fuso del ristorante, come lo intende il server» · «Test unitari della logica pura,
con il loro passo in CI».

---

## 7. PR2b — La pagina, con sala e tavoli in 3D (fatta)

### 7.1 Build, vista, App e pagina

- **Chunk:** `manualChunks` mette in `three` il solo `node_modules/three`, che non importa
  niente dal bundle principale e cambia hash solo con la libreria (R3F importa React dal
  chunk d'ingresso e viaggia con la scena); `chunkFileNames` manda `three`, `SalaVivo*` e
  un eventuale chunk comune fatto solo di moduli di `components/salaVivo/` in
  `assets/sala3d/`. In `pwa/sw.js` una CacheFirst `sala-3d` (8 voci, 60 giorni) tiene
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
  presenti, con le persone a tavola adesso in quella sala («Veranda · 14»: decisione di
  Tina, 4 ottobre — la capienza non cambia mai durante il servizio); al massimo due
  callout. Quelli sulla sala
  (sala da disporre, sovrapposizioni, segnaposto mancanti) li vede solo chi ha
  `floorplan:full`, e mai a schermo fissato, come l'avviso delle sovrapposizioni della
  piantina; portano «Disponi i tavoli» e «Posizionali». Quelli del dispositivo (niente
  WebGL2, vista semplificata) li vedono tutti. Le varianti del servizio si tengono fino
  all'arrivo di quelle nuove: al cambio di servizio la sala resta disegnata, e il canvas
  non si rismonta.

| Dato | Da dove · come si aggiorna |
|---|---|
| Sale, tavoli, prenotazioni, banchetti · servizio `{date, shift}` | prop e gestori socket di App · helper di PR2a sull'orologio al minuto di App, lo stesso che muove la LivePill |
| Unioni, nascosti, sale chiuse | `useServiceOverrides(date, shift)` · `getTableMerges`, `getTableHidden` e `getRoomClosed` in parallelo al cambio di servizio e al ritorno della connessione; gestori con nome filtrati per data e turno, con l'upsert copiato da FloorPlan; restituisce `{ merges, hiddenTableIds, closedRoomIds, ready }` |
| Segnaposto · modello | `useFloorMarkers(true)` · `useMemo(deriveSceneModel(…))` ai commit e al minuto, **mai per frame** |
| Preferenze del dispositivo | localStorage `salaVivo.room`, `.pinned`, `.reloadedFor` (la versione per cui lo schermo fissato si è già ricaricato), `.names` (PR2c), `.follow` (PR3), `.debug` |

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
        canEditFloor={hasPermission('floorplan:full')} onImmersive={setImmersive}
        onOpenFloorPlan={(focus) => { setFloorPlanFocus(focus ?? null); setSidebarCollapsed(true); setView(ViewState.FLOOR_PLAN); }} />
    </React.Suspense>
  </CardErrorBoundary>
)}
```

```ts
// components/salaVivo/types.ts (reservationsEpoch arriva con PR3)
export interface SalaVivoPageProps {
  rooms: Room[]; tables: Table[]; reservations: Reservation[]; banquetMenus: BanquetMenu[];
  isInitialLoading: boolean; isConnected: boolean; currentTime: Date;
  canEditFloor: boolean;                                // hasPermission('floorplan:full')
  onImmersive: (on: boolean) => void;
  onOpenFloorPlan: (focus?: FloorPlanFocus) => void;    // FloorPlanFocus = { roomId: number }
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
  // Anche un chunk comune fatto solo di moduli della Sala dal vivo: col nome di un
  // modulo qualsiasi finirebbe nel precache di tutti.
  chunkFileNames: (chunk) =>
    chunk.name === 'three' || chunk.name.startsWith('SalaVivo')
      || (chunk.moduleIds.length > 0 && chunk.moduleIds.every(id => /[\\/]components[\\/]salaVivo[\\/]/.test(id)))
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
  `D = 0.80`, quadrato `D = clamp(L, 0.80, 1.10)` e lato lungo uguale finché le sedie di
  un lato ci stanno (da 5 posti cresce come `L`: il glifo mette le sedie solo sopra e
  sotto), dentro il box del glifo meno 0,40 m di sedie. Piano 0,75 m, seduta 0,45,
  schienale 0,90. Sedie **esattamente** sugli slot 2D, spinte fuori fino a 0,30 m dal
  bordo; punto d'approccio 0,55 m dietro la sedia.
- **Disposizione.** Tavoli non nascosti, come in 2D. Un'unione si disegna **sempre come
  in 2D** (decisione di Tina, 4 ottobre): il primario al suo posto, col nome unito e la
  somma dei coperti, col corpo dai posti (le misure in cm sono del primario da solo); i
  secondari non si disegnano. Disegnarli ciascuno al suo posto non reggeva: l'editor non
  lascia posare due tavoli a contatto, e anche accostati quanto si può restavano a 1,3 m
  (affiancati) o 3,2 m (uno sopra l'altro), con una tavolata seduta di qua e di là da un
  corridoio che non c'è. Audit `overlaps` sui tavoli disegnati, su box orientati (così due
  vicini ruotati non sono un falso allarme), e `unset` (almeno 3 tavoli, metà sulla
  stessa posizione).
- **Nessun ripiego per una sala da disporre (deciso in PR2b).** Il piano usava
  `computeAutoLayout`, che oggi resta solo come misura di una sala vuota in Prenotazioni:
  la 2D quella vista non ce l'ha più, e una griglia solo in 3D romperebbe l'accordo fra
  le due. La 3D disegna sempre le x/y salvate, come la piantina; `unset` resta solo
  l'avviso «Tavoli di questa sala ancora da disporre.», con «Disponi i tavoli». Coi tavoli
  nuovi nel primo posto libero è un'eredità dei dati vecchi.
- **Segnaposto mancanti** (`missingMarkers[]`): ingresso a `(W/2, H − 20)`, il bordo
  verso la camera; accoglienza 60 px dentro e 40 di lato; pass a `(W − 60, 60)`.
- **Stato del tavolo:** `deriveTableDisplayStatus` sulla seduta più recente del gruppo,
  altrimenti sulla prossima WAITING del turno fra t−30 e t+120 minuti, come in 2D; fra
  due prossime la più vicina all'istante (alle 19:00 quella delle 19:15, non una delle
  17:30 mai arrivata), un no-show dopo le altre. Divergenze dichiarate: «oggi» è il giorno
  di servizio; un secondario accende tutta l'unione; con due sedute vince la più recente,
  dove la 2D prende la prima.

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
              agganciato alla normale del bordo se il segnaposto sta entro 1 m da un bordo; in
              basso e a destra il bordo si misura da dove finisce il pavimento allargato dal
              segnaposto stesso (chip, etichetta e margine: 120 px sotto, 100 a destra), quindi
              l'aggancio arriva a 3,4 m dal bordo basso e 3 m da quello destro
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
| `stageLabel` (`summaryLobby` arriva con PR2c, §8) | {{room}}: {{seated}} a tavola, {{arriving}} in arrivo | {{room}}: {{seated}} seated, {{arriving}} arriving |
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

## 8. PR2c — Ospiti a tavola, statici (fatta)

Gli ospiti seduti dove sono davvero, ancora fermi: la camminata è PR3. Chi è a tavola si
vede seduto, una figura per persona: adulti e bambini (più piccoli) alternati sulle sedie
che la piantina accende, il cane sdraiato accanto al padrone, il seggiolone per il più
piccolo. Chi è segnato arrivato senza un tavolo aspetta in piedi all'ingresso, l'hostess
sta all'accoglienza, i tavoli liberi hanno i cartellini «Riservato · 20:30» ed «Evento».
I nomi degli ospiti restano spenti finché non li si accende su quel dispositivo.

I tipi sono in `components/salaVivo/types.ts`: `FigureSlot`, `PartyModel`,
`ChairModel.high`, `TableModel.extraChairs` / `sign` / `caption`, `ServiceSummary.lobby`,
`RoomModel.parties` / `figures`, `SceneModel.mainRoomId`, e fra gli ingressi del modello
`notePresets`, `showNames` e `copy`. Le regole che reggono il resto:

- **Un'unione è un tavolo solo** (§1.3): la tavolata siede al primario disegnato, sulle sue
  sedie sommate, e non si sparge mai sui tavoli fisici del gruppo.
- **Una regola di presenza sola** (`model/presence.ts`) fa le figure e tutti i numeri:
  `seated`, `arriving` e `lobby` di sale e testata vengono solo da `derivePresence`. Un
  test lo inchioda: in ogni sala `summary.seated` è il numero delle figure di persona ai
  tavoli, e quelle all'ingresso sono `min(6, summary.lobby)`.
- **La presenza è per tavolo disegnato**, come il colore: c'è la seduta più recente del
  tavolo (per orario, poi id), finché non passano 45 minuti dalla fine prevista. Una seduta
  più vecchia sullo stesso tavolo, o la più recente oltre la grazia, non ha figure, non si
  conta e non va all'ingresso: il tavolo resta `uscita`.
- **L'ingresso** è di chi è vivo e seduto senza un tavolo da disegnare (nessuno, uno
  nascosto per il turno, uno sotto un primario nascosto), fino a 60 minuti dall'ora
  prenotata. Aspetta nella sala di quel tavolo se c'è, altrimenti nella **sala
  principale**: la prima di `sortRooms` aperta e con l'ingresso posato, se no la prima
  aperta, se no la prima. Se ne disegnano al più 6, si contano tutti, e sopra l'ultimo una
  pastiglia «+N» dice quanti non sono disegnati. Il piano mandava
  all'ingresso chi ha un tavolo inutilizzabile: un seduto su un tavolo nascosto ora sta
  lì, e il test dei tavoli nascosti cambia di conseguenza.
- **Un banchetto che trabocca** (confermato da Tina il 4 ottobre): una tavolata collegata a un
  banchetto che non entra nel suo tavolo prende gli altri tavoli disegnati del banchetto,
  nella stessa sala e senza prenotazioni loro in tutto il turno (anche quelle che la piantina
  non colora ancora: un tavolo prenotato per le 20:30 è preso anche alle 19:59, e chi
  trabocca non si sposta allo scoccare del minuto), nell'ordine del banchetto. Il piano faceva
  un gruppo solo di tutto il banchetto (`group(T) ∪ table_ids`): con più famiglie
  prenotate sullo stesso banchetto ne restava seduta una sola.
- **Cartellini.** «Evento» batte «Riservato», come il colore del tavolo fa già vincere il
  banchetto. «Riservato · HH:MM» segue la prenotazione dell'anello o del colore `attesa`
  se è nella finestra, se no la più vicina all'istante fra adesso − 120 e adesso + 90
  minuti. Nessun cartellino dove siede qualcuno.
- **La seconda riga dell'etichetta:** il testo del cartellino, oppure, a nomi accesi, il
  nome della tavolata seduta o del banchetto; al più 24 caratteri, «…» compreso. I testi
  tradotti li dà la pagina (`SceneCopy`): il modello non conosce i18n.
- **«Nomi degli ospiti»** (`localStorage['salaVivo.names'] === '1'`), spenti di default.
  Spenti, nel modello non entra nessun nome di persona: `PartyModel.name` e
  `TableModel.caption` ne restano liberi. Il bottone (`Tag`, 44 px, `aria-pressed`, pieno
  da acceso come la puntina) sta prima della puntina, insieme alla sala in 3D; a schermo
  fissato non c'è (decisione di Tina, 4 ottobre): chi passa davanti non può accendere i nomi,
  e resta la scelta fatta prima di fissare.
- **Le sedie accese** di un tavolo dove siede qualcuno sono quelle occupate. Coincidono con la 2D tranne in tre casi: la sedia che il bambino del
  seggiolone lascia per la testa del tavolo (vuota, resta spenta), i tavoli dove trabocca
  un banchetto (si accendono quelle usate) e il tondo ridistribuito. Dove non siede
  nessuno, come in 2D.

Il dettaglio, per chi implementa. Il modello è TypeScript puro: niente DOM, three, rete né
`Date.now()`, e ogni campo si legge in difesa.

```
party.ts       etichette: dog = le label dei preset con icon 'dog' (NFC, trim, non vuote, senza doppioni
               a maiuscole indifferenti, nell'ordine dei preset), poi 'Cane'; baby = icon 'baby', poi
               'Seggiolone'. Etichette e non id: gli id cambiano a ogni salvataggio. «Cane» e
               «Seggiolone» valgono sempre: note e scelte portano l'etichetta di quando la
               prenotazione è stata salvata, e un preset rinominato dopo non toglie il cane a quelle
               conta(r, etichette), vince la prima regola che dà più di zero (le note riportano anche
               le scelte strutturate come «2× X»: se la 1 non vincesse, una scelta conterebbe due volte)
                 1. note_selections, se è un array: Σ max(1, ⌊quantity⌋) delle voci con quella label
                    (trim, minuscole); quantity non finita = 1
                 2. notes: /(\d+)\s*[×x]\s*(?:ALT)(?=[^\p{L}\p{M}\p{N}]|$)/giu → Σ dei numeri
                 3. notes: /(?:^|[^\p{L}\p{M}\p{N}])(?:ALT)(?=[^\p{L}\p{M}\p{N}]|$)/iu → 1   // «canederli» ≠ «cane»
               ALT = le etichette escapate, gli spazi interni come \s+, la più lunga per prima (così
               «2× Cane piccolo» non è anche «Cane»); niente lookbehind (iPadOS < 16.4). Note ed
               etichette in NFC, e un segno staccato (\p{M}, l'accento di una «è» in NFD) non fa da
               confine: «Canè» non è «Cane»
               ospiti = max(1, ⌊guests⌋); bambini = clamp(⌊children⌋, 0, ospiti); adulti = ospiti − bambini
               cani = min(2, conta(dog)); seggiolone = conta(baby) > 0; col seggiolone, 0 bambini e
               almeno 2 adulti, un adulto diventa bambino
presence.ts    presenti = per tavolo disegnato, status.present && status.active
               in arrivo = per tavolo disegnato, status.pulse && status.active
               ingresso = isLiveParty && isSeated, tavolo nullo o in nessun groupIds disegnato,
                          adesso < inizio + 60 min; sala = quella del tavolo, se no la principale
               summaryFor(sala) = Σ persone (max(1, ⌊guests⌋), al più 150) di presenti, in arrivo e
               ingresso. Il tetto vale per figure e numeri insieme: una prenotazione vera così grande
               è un banchetto su più tavoli, e un numero sbagliato (500) metterebbe 344k triangoli
               attorno a un tavolo; a 150 sono ~104k, il budget di una sala
               tableStatus esporta withinGrace(r, adesso) e ci calcola present, senza cambiare
               comportamento; presence importa da tableStatus, mai il contrario
placement.ts   sedie: per tavolo, il proprio e poi quelli del banchetto, take = min(rimasti, posti);
               litChairIndices(forma, posti, take), i membri in ordine d'anello (orario come sulla
               piantina, dalla sedia d'indice più basso); adulti e bambini alternati:
               2A2K → a0 k0 a1 k1, 2A1K → a0 k0 a1, 0A3K → k0 k1 k2, 3A1K → a0 k0 a1 a2
               oltre, solo al tavolo proprio: tondo → l'anello ridistribuito allo stesso raggio R,
               N = min(posti + rimasti, max(posti, ⌊2πR / 0,48⌋)), sedia 0 a ore 12 e poi in senso
               orario, tutte occupate; rettangolo → le teste a (±(L/2 + 0,30), 0), prima la destra,
               tranne una che finirebbe nel muro (a meno di 0,3 m dal bordo del pavimento)
               ancora oltre: in piedi 0,55 m dietro le teste, poi dietro le sedie a giro attorno al
               tavolo (dalla sedia d'indice più basso), 0,5 m più fuori a ogni giro: ai capi chi sta
               in piedi non copre nessuno, dietro una fila di sedute sembrava una seconda fila di
               busti. Un posto nel muro si salta; dopo un giro intero nel muro chi resta (solo una
               comitiva enorme) sta sul bordo del pavimento
               seggiolone: rettangolo → il bambino più piccolo su una sedia alta alla testa dal lato
               del primo adulto (l'altra se quella è nel muro; nessuna testa libera → niente
               seggiolone, siede su una sedia); tondo → la sua sedia diventa alta. Seduta a 0,58 m
               (HIGH_CHAIR_SEAT_HEIGHT in geometry.ts): il bambino ha i polsi a 0,80 come gli
               adulti e le cosce sotto il piano; a 0,75 sedeva sul tavolo. Solo al tavolo proprio,
               mai all'ingresso
               cane k accanto all'adulto k (se no al primo adulto, dall'altro lato; se no alla prima
               persona): 0,45 m in fuori e 0,25 di lato verso l'esterno del tavolo, parallelo al
               bordo col muso lontano dal padrone; dietro una sedia contro il muro, sul bordo
               ingresso: griglia 2×3 dal lato della porta opposto all'accoglienza, file a 1,2 e 1,8 m
               dentro, colonne a 0,9, 1,5 e 2,1 m dall'asse della porta, a 0,3 m dai bordi del
               pavimento; in piedi, rivolti verso la sala; niente cani né seggioloni
               hostess: una per sala, senza nome (il nome arriva con PR3, nella sala principale),
               dietro il leggio per chi entra: 0,5 m oltre il leggio sulla linea porta → leggio
               (presa lungo l'asse della sala più vicino), rivolta alla porta col leggio davanti, e
               il piano del leggio girato verso di lei. Se porta e leggio coincidono, o quel posto
               finisce nel muro, 0,5 m dal leggio verso la sala (inward). Dal muro più vicino al
               leggio, come prima, un leggio a pari distanza da due muri la girava di spalle alla
               porta per due pixel
               tinta degli ospiti, per tavolata: j = ((imul(id, 2654435761) >>> 0) / 2³²) · 0,20;
               i bambini j + 0,15
               chiavi stabili r12:a0, r12:k1, r12:d0, host:3: PR3 fa camminare la stessa figura
               dall'ingresso al tavolo
signs.ts       «Riservato»: viva, non seduta, del turno, adesso − 120 ≤ t ≤ adesso + 90 min; vince
               status.active se è nella finestra, se no la più vicina all'istante, poi la prima, poi
               l'id più basso; HH:MM nel fuso del ristorante (timePart)
               seconda riga: tavolo occupato → a nomi accesi il nome della tavolata, se no niente;
               «Evento» → a nomi accesi il nome del banchetto, se no copy.event; «Riservato» →
               copy.reserved(ora); taglio a 24 caratteri, «…» compreso
sceneModel.ts  primo giro: sale, tavoli, stati e sedie della 2D; poi sala principale e presenza;
               secondo giro: sedie e figure delle tavolate presenti, ingresso, hostess, cartellini e
               seconde righe. L'inquadratura comprende sempre le sei caselle dell'ingresso e il posto
               dell'hostess, anche vuoti: la camera non salta quando arriva qualcuno. Un tavolo è
               libero per chi trabocca se nel turno non ha prenotazioni sue (del turno e non
               annullate né rifiutate, anche no-show o andate via; o sedute e vive di un altro
               turno), a qualunque ora: non il colore, che c'è solo da 30 minuti prima
               roomsToShow(sale): le linguette, cioè le aperte e le chiuse con qualcuno a tavola,
               all'ingresso o in arrivo; la somma delle sale mostrate è sempre la testata
```

**Figure** (`scene/figures.ts`). Parti rigide condivise, composte per posa: busto
`LatheGeometry` a 8 segmenti, dritto (il piano lo inclinava di 5°); testa icosaedro r 0,13;
coscia, stinco, braccio e avambraccio a capsula, divisi a ginocchio e gomito, perché la gamba
unica da 0,62 m del piano non si piega; chignon per l'hostess; il cane sdraiato in un pezzo
solo (`mergeGeometries`, come la sedia; PR3 lo può dividere per farlo camminare), col muso
lungo e le orecchie che pendono ai lati della testa (con un muso corto visto di punta e le
orecchie dritte in cima sembrava un orsetto). I bambini
sono le stesse parti a scala 0,62 attorno al bacino: siedono sulla seduta coi piedi che
penzolano. Circa 690 triangoli a persona (150 persone ≈ 104k, sotto i 150k), circa 390 a
cane. Bacino: seduto a (x; seduta + 0,07·s; z) più 0,02·s in avanti, in piedi a 0,92·s. Su
una sedia da 0,45 m le cosce stanno orizzontali, gli stinchi a terra, gli avambracci a
0,79–0,80 m sul bordo del piano (0,75), raccolti davanti al petto con le mani che si
toccano, e la testa a ≈ 1,34 m; in piedi ≈ 1,74 m. Il piano voleva gli
avambracci dritti in avanti (polso a (±0,18; 0,28; 0,42)): chi siede di schiena alla camera,
vista dall'alto a 52°, sembrava a mani alzate, perché un braccio che va avanti sul tavolo
sullo schermo sale. I gomiti seduti a ±0,19 (il piano ±0,22): col braccio arrivano a 0,24
dall'asse, e due vicini sulle sedie a 52 cm restano a 4 cm invece di toccarsi. Le lunghezze
dei pezzi non cambiano fra le pose: una geometria rigida per parte basta.

| Giunto (sinistra/destra = ±x), dal bacino, a scala 1 | Seduto | In piedi |
|---|---|---|
| anca | (±0,09; 0; 0) | (±0,09; 0; 0) |
| ginocchio | (±0,09; 0; 0,40) | (±0,09; −0,40; 0) |
| caviglia | (±0,09; −0,45; 0,40) | (±0,09; −0,85; 0) |
| spalla | (±0,21; 0,48; 0) | (±0,21; 0,48; 0) |
| gomito | (±0,19; 0,27; 0,15) | (±0,23; 0,22; 0,02) |
| polso | (±0,02; 0,28; 0,33) | (±0,23; −0,05; 0,05) |
| base del busto · centro della testa · chignon | (0; −0,06; 0) · (0; 0,69; 0) · testa + (0; 0,07; −0,10) | uguali |

**Istanze** (`scene/People.tsx`, `Signs.tsx`). Una `InstancedMesh` per tipo di parte (busto,
testa, coscia, stinco, braccio, avambraccio, chignon, cane) più le ombre a macchia di chi sta
in piedi e dei cani; un `MeshLambertMaterial` bianco per tutte, il colore per istanza. Su ogni
mesh `frustumCulled = false` (la bounding sphere non segue le matrici) e `instanceColor`
allocato nel costruttore, prima del primo render (o il materiale ignora `setColorAt`).
Capacità dalla sala: persone ⌈Σ posti × 1,25⌉ + 7 (sei all'ingresso e l'hostess), cani
max(4, quelli in scena); quando non basta si rifà a max(2 × capacità, ⌈count × 1,25⌉).
Matrici e colori si riscrivono solo quando cambia la firma delle figure (tipo, posa, x, z,
yaw, seduta e tinta, al millimetro) o il tema, poi `invalidate()`: niente `useFrame` in PR2c
e niente allocazioni nei cicli. In `TablesLayer` le sedie in più e il seggiolone, una parte
sua (seduta a 0,58 m, schienale a 0,90, quattro gambe e il poggiapiedi a 0,30, dove
arrivano i piedi). Il cartellino è una tenda triangolare sul piano, 30 × 16 cm (12 di base),
con le falde in `--tg-attesa-name` e la costa in `--tg-attesa-bg`, 1,3 volte più grande per
«Evento» e senza scritte: le parole stanno nella seconda riga dell'etichetta, che si legge
dalla porta. Al contrario (falde in `--tg-attesa-bg`) spariva sul piano, chiaro come lei per
un tavolo libero, in attesa o in arrivo, e restava una lineetta.

**Etichette** (`scene/TableLabels.tsx`). Sopra un tavolo vuoto a 1,2 m dal piano, sopra il
cartellino; sopra un tavolo dove siede o sta qualcuno sul piano (+0,1 m), al centro, come il
nome dentro il glifo della 2D: a 1,2 m la pastiglia copriva le teste di chi siede dall'altra
parte, che dalla camera a 52° stanno nella stessa fascia dello schermo. Le etichette si
disegnano sopra tutto (`depthTest` spento). Con la seconda riga il canvas è 464 × 128, il
nome a 52 px, la seconda riga a 42 (40 prima dei puntini) e l'altezza minima a schermo 42 px:
la seconda riga arriva a 13–14 px, come un testo dell'app (a 34 px su 40 stava a 10–11, un
nome lungo a 7–8). La crescita massima vale in proporzione all'altezza minima, così la
seconda riga resta leggibile fin dove si legge il nome a una riga. Quando all'ingresso
aspettano più dei sei disegnati, sopra l'ultimo una pastiglia «+N» neutra (`--ds-surface`,
`--ds-border-strong`, `--ds-text-secondary`): la testata li conta tutti, e alla porta si vede
che ne mancano.

| Ruolo (mai un colore di stato) | Token |
|---|---|
| Ospiti | il corpo da `--ds-text-muted` verso il chiaro della tinta della tavolata (0–20 %, bambini +15 %), la testa al 35 % verso il chiaro: pedine monocrome, niente incarnato. Il chiaro è `--ds-surface` col tema chiaro e `--ds-text-primary` con lo scuro: verso il pavimento scuro teste e bambini diventavano più scuri dei corpi e degli adulti |
| Hostess · cane · cartellini | `--ds-cat-6-solid` (argilla) per corpo e chignon, la testa neutra degli ospiti (l'argilla schiarita diventerebbe un incarnato) · `--ds-cat-6-text` · falde `--tg-attesa-name`, costa `--tg-attesa-bg` |
| Camerieri (PR3) | `--ds-action-bg` col grembiule `--ds-surface` |

Il verde acqua `--ds-cat-1` resta fuori, troppo vicino a `uscita`.

**Pagina.** I preset delle note con `swrConfig('reservationNotePresets', …)`, la stessa
chiave di ReservationList, riletti a ogni cambio di servizio: uno schermo fissato non si
rismonta mai. Una risposta che non è un array vale `[]`, e restano «Cane» e «Seggiolone»,
che valgono sempre. Il riassunto aggiunge « · 2 all'ingresso» solo se qualcuno aspetta, e
così l'etichetta del palco per lo screen reader. Sul telefono la testata va su due righe
(decisione di Tina, 4 ottobre): titolo e riassunto sopra a tutta larghezza, i bottoni sotto;
da sm in su una riga sola. Fra le linguette c'è
anche una sala chiusa con qualcuno a tavola, all'ingresso o in arrivo (`roomsToShow`): la
testata somma tutte le sale, e ogni persona che conta deve stare in una sala che si apre.

| `salavivo.json` | it | en |
|---|---|---|
| `showNames` / `hideNames` | Nomi degli ospiti / Nascondi i nomi degli ospiti | Guest names / Hide guest names |
| `reserved` / `event` | Riservato · {{time}} / Evento | Reserved · {{time}} / Event |
| `summaryLobby` | {{count}} all'ingresso | {{count}} at the entrance |
| `stageLabelLobby` | {{room}}: {{seated}} a tavola, {{arriving}} in arrivo, {{lobby}} all'ingresso | {{room}}: {{seated}} seated, {{arriving}} arriving, {{lobby}} at the entrance |

**Test** (`tests/unit/`, ambiente node, fuso `Europe/Rome` dove conta l'ora):

| Test | Cosa prova |
|---|---|
| `party` | 4 ospiti, 2 bambini e «Cane» → 2 + 2 e un cane; «canederli» niente; «2× Cane» due, «3x cane» due (il tetto); una `note_selections` («cane », 2) vince sulla nota specchiata «1× Cane» senza contare due volte; «Seggiolone» con 0 bambini e 3 ospiti → 2 adulti e un bambino, con 1 ospite → 1 adulto; bambini oltre gli ospiti tagliati, 0 ospiti → 1 adulto; etichette dai preset («Cani» con l'icona del cane conta, e «Cane» resta valido; un preset rinominato non toglie cane e seggiolone alle prenotazioni di prima); lettere accentate composte o con l'accento staccato («Canè» non è «Cane», «Bebè» combacia in NFC e NFD); metacaratteri presi alla lettera; «2× Cane piccolo» due, non quattro |
| `presence` | doppia seduta (solo la più recente; l'altra né presente, né all'ingresso, né contata); la grazia (fine + 44 sì, + 46 no, colore sempre `uscita`); un pranzo delle 12:30 letto alle 19:00 no; ieri nemmeno vivo; ingresso (arrivato senza tavolo → sala principale, sparisce a inizio + 60; tavolo nascosto, o unito sotto un capofila nascosto → l'ingresso della sua sala; sala che non c'è → la principale); in arrivo; `summaryFor` conta persone; `mainRoomOf`; `roomsToShow` (una sala chiusa con qualcuno a tavola, all'ingresso o in arrivo ha la linguetta, e le sale mostrate sommano la testata) |
| `placement` | 6 posti e 4 ospiti → sedie 0, 1, 3, 4, accese solo quelle; alternanza in ordine d'anello; gli stessi indici col tavolo ruotato; teste (6 su un 4 → due teste a ±(L/2 + 0,30); 7 → anche uno in piedi 0,55 m dietro la testa destra; 13 → dietro le teste, poi dietro le sedie, poi il secondo giro); contro i muri (la testa nel muro non c'è, i posti in piedi nel muro si saltano, il cane resta sul pavimento, una comitiva enorme sta sul bordo); l'anello del tondo (6 su un tondo da 4, oltre il passo in piedi); seggiolone (rettangolo e tondo, l'altra testa se quella è nel muro, nessuno senza teste); cani; unione; banchetto che trabocca (mai su un tavolo con prenotazioni sue, nemmeno se arrivano dopo l'inizio del colore: alle 19:59 e alle 20:00 la stessa sala; mai in un'altra sala); 500 ospiti → 150 figure e 150 a tavola, tutte nella sala; caselle dell'ingresso; hostess (dietro il leggio per chi entra, o verso la sala); tinte; chiavi |
| `signs` | «Riservato · 20:30» dall'ora del ristorante; i bordi della finestra (+90 sì, +91 no, −120 sì); la prenotazione del colore vince su una più vicina; NO_SHOW, CANCELLED, seduti, altro turno mai; niente dove siede qualcuno; «Evento», anche sopra «Riservato»; seconde righe coi nomi solo a nomi accesi; 24 caratteri con «…» |
| `tableStatus` (aggiornato) | i nuovi ingressi di `scena()`, `lobby` in ogni riassunto, il seduto sul tavolo nascosto all'ingresso della Veranda; e l'invariante: figure di persona ai tavoli = `seated`, un'hostess per sala, ogni figura seduta su una sedia accesa o in più, nella stessa x/z |

Il catalogo cresce con «Gli ospiti», «Cartelli» e «Nomi degli ospiti», più una riga nel
Registro. Commit: «Sala dal vivo: gli ospiti a tavola, con bambini e cane dalle note» · «Sala
dal vivo: cartelli riservato ed evento, nomi spenti di default». Restano a PR3 la camminata,
gli accompagnamenti, alzarsi e sedersi per `DEPARTING` (in PR2c chi è in uscita resta seduto),
il nome dell'hostess, i camerieri, la striscia delle attività, «Segui il servizio» e
`reservationsEpoch`.

---

## 9. PR3 — Animazioni (in corso)

Il modello statico di PR2c resta l'unica verità su **dove** sta ognuno (figure con chiavi
stabili, regola di presenza, posti, hostess, ingresso); PR3 mette in scena soltanto il
passaggio fra due modelli. Quando Reception segna «Arrivato», l'hostess va dal leggio
all'ingresso, accoglie la tavolata (adulti, bambini più piccoli, il cane), la porta in fila al
tavolo e lo presenta; ognuno va alla sua sedia e si siede, il cane si sdraia, e lei torna. «In
uscita» fa alzare la tavolata, l'uscita la porta fuori dalla porta, un cambio di tavolo la fa
camminare, un «Arrivato» annullato la fa svanire. I camerieri di turno (quelli di Personale)
girano fra il pass e i tavoli occupati, prima quelli appena seduti; un'etichetta segue la
tavolata accompagnata, una striscia racconta le ultime cose successe, e «Segui il servizio»
porta lo schermo dove succede qualcosa.

Valgono su tutto, sopra la specifica: un'unione è un tavolo solo (accompagnamenti, cambi di
tavolo e visite vanno al tavolo disegnato, il capofila); i numeri vengono dalla regola di
presenza e il regista non ne cambia mai uno; nomi spenti di default e bottone dei nomi
nascosto a schermo fissato (spenti, `PartyModel.name` è `null`, e né la striscia né
l'etichetta portano un nome); posizioni = x/y salvate; ora = fuso del ristorante.

**L'epoca.** App tiene `reservationsEpoch` e la incrementa subito dopo `setReservations` in
`fetchData`, senza await di mezzo: stesso batch di React, quindi la pagina non vede mai la
lista nuova con l'epoca vecchia. `fetchData` gira alla connessione e riconnessione del socket,
al ritorno in primo piano (`visibilitychange`, `pageshow`) e dopo lo svuotamento della coda
offline: quei cambi sono un riallineamento e vanno in scena già conclusi. Un arrivo vero dopo
un buco del Wi-Fi arriva da un evento socket, senza epoca nuova, e si anima.
`loadReservationsArchive` (i giorni vecchi) non la tocca.

**Il server.** `/staff/presence` legge il giorno come Personale (`slotState` in
`StaffManagement.tsx`), con la stessa funzione dell'avviso «Il tuo turno è cambiato»:
`isOnDuty` in `utils/staffShiftChange.ts`, estratta da `shiftDayLabel` senza cambiarne
l'uscita. Tre letture diventano una.

```
isOnDuty(scheda, data, turno, righe, assenze)
  riga esplicita di (data, turno)                       → la riga decide, presente o assente
  assenza sulla data, intera o di quel turno            → no
  riposo settimanale (il giorno della data, in UTC)     → no
  FISSO o STAGIONALE in [assunzione, fine contratto]    → sì (una data che manca: aperto)
  altrimenti                                            → no
/staff/presence  solo schede attive; date lette come testo (to_char); una data non vera → 400;
                 la forma di sempre: { sala, cucina } × { lunch, dinner } di
                 { id, name, surname, category, staffType, role }
```

Prima contava solo i FISSO e l'assenza batteva il turno scritto (il `continue` sull'assenza di
tutto il giorno): uno stagionale di turno non c'era, e chi era richiamato dalle ferie per una
sera risultava a casa. Il commento di `makeDutyIndex` in `utils/leavePlan.ts` diceva «stessa
semantica di GET /staff/presence» e non è più vero: si corregge il commento, non la regola.
**Restano due letture di «di turno»**: Personale e Sala dal vivo da una parte, la copertura
del piano ferie dall'altra, dove l'assenza batte il turno scritto e solo il FISSO è implicito.
Allinearle è una scelta da chiedere a Tina (G23). Test API `presenza-personale`, nei due job
(`npm test`, `TEST_STRICT_RLS=1`): STAGIONALE senza turni a pranzo e a cena; un contratto di
un giorno solo, quel giorno (confini compresi); FISSO in ferie tutto il giorno con un pranzo
scritto, solo pranzo; FISSO nel riposo settimanale assente, e con una cena scritta solo cena;
EXTRA senza turni assente, con una cena scritta solo cena; FISSO col permesso della sola cena,
solo pranzo; un «assente» scritto a pranzo batte il contratto; contratto finito e assunzione
futura, assenti; inattivo, mai in lista; la cucina nelle liste della cucina; la forma della
risposta; date sbagliate, 400.

**Le fasi** (`SceneModel.partyStates`, dalla stessa `derivePresence` di figure e numeri). Una
riga per comitiva del servizio, che il regista confronta con quella dell'aggiornamento
prima; chi manca è andato (via, annullato, no-show, eliminato, fuori servizio). Non si chiama
`parties`: `RoomModel.parties` c'è già e vuol dire altro.

| Fase | Quando | Sala · tavolo |
|---|---|---|
| `seated` | presente a un tavolo disegnato | la sala · il tavolo disegnato |
| `standing` | presente, `DEPARTING` («In uscita») | la sala · il tavolo disegnato |
| `lobby` | seduta senza un tavolo da disegnare, entro un'ora dall'ora prenotata | la sala del suo ingresso |
| `hidden` | seduta e viva ma senza figure: spodestata da una più recente sullo stesso tavolo, oltre la grazia di 45 minuti, all'ingresso da più di un'ora | — |
| `waiting` | viva e non seduta | — |

Con la fase, `people` (al più 150) e `banquet` (legata a un banchetto). Ordine stabile: le
presenti nell'ordine dei tavoli, poi l'ingresso, poi nascoste e in attesa per ora e id.
**`DEPARTING` sta in piedi nel modello statico** (`placement.standUp`): le persone 0,55 m dietro
la loro sedia (`approachPoint`), rivolte al tavolo, i cani in piedi dove sono; i conti non
cambiano. PR2c le disegnava sedute; in piedi nel modello, il movimento ridotto, uno scatto e
la fine dell'alzata arrivano alla stessa figura.

**Il regista** (`model/director.ts`), puro e deterministico: orologio e seme da fuori
(`mulberry32`, una comitiva da `hash(serviceKey + ':' + id)`, un cameriere da
`seed ^ hash(chiave)`), mai `Math.random` né `Date.now`, costruttore senza effetti
(StrictMode lo crea due volte). La pagina lo crea con lo stesso seme su ogni schermo (la porta
e la TV girano uguali) e lo aggiorna; il canvas lo riceve come `SceneDirectorApi`, un tipo (il
codice resta nel chunk della pagina, e `boundaries` lo controlla), e lo fa avanzare.

```
update(model, motivo)  al commit di React, una volta, chiunque arrivi prima fra eco e risposta:
                       confronta partyStates e mette in scena, o con un motivo va dritto allo
                       stato finale; gli eventi escono da qui
step(dtMs)             una volta per fotogramma, nel useFrame a priorità −1 del canvas; dt
                       fermato a 100 ms quando qualcosa si muove, intero da fermi
fastForward()          tutto quello che è a metà arriva in fondo adesso
configure(patch)       reducedMotion · slowMode · lightMode · pinned · activeRoomId · staff
in lettura             actorsIn · movingKeys · tagIn · escortTargets · arrivalTargets ·
                       frameNeed · wakeInMs · isAnimating · revision; onEvent e subscribe
                       restituiscono lo stacco
```

| Motivo | Quando (lo calcola la pagina) | Effetto |
|---|---|---|
| `'initial'` | il primo update dopo il caricamento di App | scatto, nessun evento |
| `'refetch'` | `reservationsEpoch` è cambiata dall'ultimo update, o è arrivata una rilettura delle varianti del servizio (`reads`, alla riconnessione) | scatto, un `bulk` |
| `'hidden'` | scheda nascosta, o niente vista 3D (senza fotogrammi non finirebbe mai) | scatto, un `bulk` |
| `'reduced-motion'` | `prefers-reduced-motion: reduce` | scatto, gli eventi di ogni comitiva come se si animasse |
| cambio di servizio | `model.service.key` diverso | si riparte da zero, nessun evento |
| in blocco | più di 4 passaggi in un update, o entro 2 s | scatto di quelli dell'update, un `bulk` |

Tornando visibile la scheda, e quando la vista 3D sparisce, la pagina chiama `fastForward()`.
Alle 17:00 (e alle 05:00) il servizio cambia prima che arrivino le sue unioni, e per un attimo
la sala si disegna con quelle di prima: quel modello al regista non arriva (azzererebbe su una
sala sbagliata, e poi animerebbe come cose successe le unioni giuste). Lo riceve il primo
modello con le varianti del servizio nuovo (`useSettledOverrides` dà anche la chiave su cui si
è assestato; varianti vuote in tutti e due i servizi: la chiave passa subito), e quello
azzera.

| Da → a | Copione | Evento |
|---|---|---|
| assente o in attesa → seduta o in piedi | ESCORT dall'ingresso della sala del tavolo; oltre 12 persone o banchetto: compaiono sedute, una ogni 80 ms | `escort-start` · `snapped` |
| assente o in attesa → ingresso | LOBBY: entrano dalla porta una ogni 250 ms e vanno alle caselle | `lobby` |
| nascosta → seduta, in piedi o ingresso | FADE_IN sul posto: dalla sala non era mai uscita | — |
| ingresso → seduta, stessa sala · altra sala | ESCORT dall'ingresso · svaniscono, ESCORT dall'ingresso dell'altra | `escort-start` |
| ingresso → ingresso | caselle nuove: ci camminano; altra sala: svaniscono ed entrano là | — |
| ingresso → in attesa, assente o nascosta | FADE sul posto | — |
| seduta ↔ in piedi, stesso tavolo | STAND (si alzano, un passo indietro) · SIT | — |
| tavolo A → tavolo B, stessa sala · altra sala | RESEAT a piedi, uno ogni 150 ms · svaniscono, entrano dalla porta dell'altra; B pulsa «in arrivo» (nella sua sala) finché l'ultimo non si siede; oltre 12 persone o banchetto: compaiono sedute a B, senza anello | `moved` · `moved-end` |
| seduta o in piedi → assente o nascosta | LEAVE: in piedi, verso l'ingresso e fuori, in fila: parte prima chi ha meno strada, e ognuno arriva alla porta una distanza di fila (0,8 m, 0,7 il bambino) dopo chi lo precede; chi la spodesta aspetta in coda, col tavolo «in arrivo», che sia uscita (porta a senso unico) | `leaving` |
| seduta o in piedi → in attesa («Arrivato» annullato) | FADE sul posto | — |
| seduta o in piedi → ingresso | alle caselle a piedi; altra sala: svaniscono ed entrano là | `lobby` |
| il resto, anche in attesa → no-show | niente: cambia solo il cartello, dal modello | — |

**A metà strada** il nuovo stato finale sostituisce il vecchio e si riparte da dove sono gli
attori, mai un salto (una dissolvenza riparte dall'opacità che ha). Un accompagnamento in coda
verso un altro tavolo della sala cambia meta (`moved`); verso un'altra sala si chiude qui
(`escort-end` non seduto) e si riapre là (`escort-start`). In corso nella stessa sala è un
RETARGET: l'hostess rifà il percorso da dov'è e la fila continua sul suo binario. Annullato, o
finito all'ingresso: i membri svaniscono o vanno alle caselle, l'hostess torna o prende il
prossimo. Annullata un'uscita («Tavolo liberato» tolto), la tavolata torna alle sedie a
piedi; se era già uscita, rientra con l'hostess. Rimessa invece a un altro tavolo mentre è
ancora in sala (un'uscita o un «Arrivato» tolti con un tavolo nuovo, o spodestata e spostata
da Reception), ci va a piedi da quello che lasciava: è un cambio di tavolo, `moved` col
tavolo lasciato come `from`, e il tavolo nuovo pulsa fino a `moved-end`.

```
hostess    una per sala (ogni sala ha un leggio, almeno quello di ripiego)
           AT_STAND ─coda≠∅→ TO_ENTRANCE (percorso dal suo posto al punto d'accoglienza,
           sulla strada della fila 0,6 m oltre «dentro», 1,3 m/s · f) o TO_LOBBY (verso il
           gruppo all'ingresso)
           → GREET 800 ms / f (prima rivolta al primo, il braccio giù; poi verso la strada,
             il braccio che sale: «prego, da questa parte», mai sulla testa di chi arriva)
           → ESCORT 1,0 m/s · f, la fila dietro sul suo binario
           → PRESENT 1200 ms / f (rivolta al tavolo, braccio teso; i membri lasciano la fila
             uno ogni 150 ms; l'etichetta svanisce in 400 ms mentre torna il suo nome), poi
             ferma finché i suoi non sono ai posti, al più 5 s (voltandosi subito ripassava
             in mezzo a loro) → un altro in coda ? TO_ENTRANCE : RETURN 1,3 m/s → AT_STAND
           f = 2 con 4 o più fra la coda e l'accompagnamento in corso (spec: «coda > 3»);
           oltre 6 fra tutti, i più vecchi della coda si siedono subito (snapped 'queue')
testa      il capo del rettangolo più vicino all'ingresso a ±(L/2 + 0,45), o il varco del tondo
           più vicino all'ingresso a Dc/2 + 0,5
binario    [fuori − 12 m, fuori, dentro, …percorso fino alla testa]: una polilinea con le
           lunghezze d'arco, nota in anticipo (un RETARGET la allunga). L'accoglienza ci sta
           sopra: prima la fila andava fino a un punto accanto alla porta e tornava indietro
           verso un tavolo dall'altra parte (un tornante sulla soglia). Il membro k sta a
           s_hostess − Σ distanze (0,8 m l'adulto, 0,7 il bambino), raggiunge il suo posto a
           1,5 m/s e non lo supera; chi aspetta oltre la porta è sul prolungamento,
           invisibile
cane       a 0,45 m di lato al suo adulto, sempre dallo stesso lato (quello dove compare, la
           destra se c'è posto): se lì c'è un mobile o qualcuno (l'hostess, un cameriere,
           un'altra comitiva) scivola dietro in diagonale sullo stesso lato, e ci torna
           quando si libera; il lato gira al più a 2,5 rad/s alle svolte secche. Rincorre il
           suo posto in linea retta ma non entra nello spazio di nessuno (0,45 m, 0,32 dai
           suoi): ci scivola attorno. Prima, cambiando lato, passava attraverso il padrone
porta      i 0,8 m fuori dalla griglia fra «fuori» e la porta: chi ci passa sfuma con la
           posizione (invisibile oltre «fuori»), non col tempo; così sfuma anche chi esce
senso      la porta a senso unico, prima chi esce: finché una tavolata in LEAVE è in scena
unico      l'hostess non va a prendere nessuno (la coda aspetta, i tavoli restano «in
           arrivo»), e chi entra da solo (all'ingresso, da un'altra sala) aspetta invisibile
           dietro la porta; chi si alza per uscire mentre l'hostess accompagna aspetta in
           piedi al suo tavolo che lei presenti. Senza, la fila (che segue il binario e non si
           scansa) e chi esce si attraversavano nell'ingresso
sedersi    percorso fino al punto d'approccio della sedia, un passo fuori griglia (0,55 m,
           500 ms), si gira (250 ms), si siede (600 ms); il cane si sdraia (600 ms); un posto in
           piedi: ci cammina e si gira
fine       escort-end quando si siede l'ultimo: lì il tavolo smette di essere «in arrivo»;
           moved-end lo stesso per il tavolo nuovo di un cambio di tavolo a piedi
precedenza chi cammina su un percorso si ferma se un altro, non della sua fila, è entro 0,45 m
           davanti (cono di ±45°), al più 1,5 s; verso la porta anche dietro i suoi, fermi o
           no. L'hostess ferma (al leggio, accogliendo, presentando) è un ostacolo per chi
           cerca un percorso: le sue celle si chiudono per quella ricerca (se così chiude
           l'unico passaggio, le si passa accanto invece di tagliare per i mobili)
sicurezza  un copione oltre 90 s di simulazione, o un accompagnamento oltre 90 s da quando
           l'hostess lo prende (in coda dall'arrivo), va in fondo da solo: isAnimating() non
           resta mai acceso. Il ritocco della geometria, che passa a ogni update (almeno uno
           al minuto), non rimette l'orologio
```

**Gli eventi** nascono in `update` (tranne `escort-end` e `moved-end`), quindi arrivano anche
col movimento ridotto, a scheda nascosta e senza vista 3D: `escort-start` già all'accodamento,
`escort-end` (seduti o no) quando l'accompagnamento esce di scena, `lobby`, `moved`,
`moved-end` (arrivati o no) quando un cambio di tavolo a piedi esce di scena, `leaving`, `bulk`
col numero dei tavoli toccati (chi lascia un tavolo e chi ci arriva al suo posto sono uno;
senza tavoli, chi aspetta all'ingresso, nessun `bulk`), `snapped` con le comitive (`'large'` o
`'queue'`). Ogni cambio dei tavoli «in arrivo» (`arrivalTargets`: quelli degli
accompagnamenti, `escortTargets`, più il tavolo nuovo di un cambio a piedi) arriva con un
evento: la pagina li ridisegna (`withArrivalTargets`: stato `inarrivo` e anello finché
l'ultimo non si siede, anche se Reception ha già premuto «Arrivato» o spostato la tavolata) a
ogni evento, mai per fotogramma. Solo l'azzeramento (il primo modello, un cambio di servizio)
li svuota senza raccontare niente: lì li ridisegna la pagina, dopo l'update, perché il render
che lo precede li ha calcolati col regista di prima (senza, un anello del pranzo restava
acceso fino al minuto dopo). Chi è in coda non si vede, né alla porta né al tavolo, e
il suo tavolo pulsa «in arrivo». Un cambio di tavolo scattato (scheda nascosta, epoca nuova,
cambi in blocco, movimento ridotto) l'anello non lo accende: nessuno ci cammina. «Segui il
servizio» guarda solo `escortTargets`: aspetta la fine di un accompagnamento, non di un
cambio di tavolo (`moved-end` non libera chi aspetta).

**Chi disegna chi.** People disegna `room.figures` meno `movingKeys(room.id)`, Walkers
disegna `actorsIn(room.id)`: il regista cambia i due insiemi nello stesso `step` e alza
`revision`, e People si riscrive nello stesso fotogramma (priorità 0, dopo lo step a −1). Un
attore torna a People solo quando posa, punto, imbardata e seduta sono esattamente quelli della
figura statica: il passaggio non si vede. L'hostess la disegna sempre il regista, così il suo
nome la segue. `movingKeys` comprende anche chi il regista tiene in quella sala e nel modello
non c'è più (chi esce, chi svanisce, chi passa a un'altra sala): il canvas fa il commit dopo la
pagina, e un People con la lista vecchia lo ridisegnerebbe fermo al suo posto. La pagina aggiorna il regista in un effetto di layout: con uno passivo una
comitiva appena arrivata comparirebbe seduta per un fotogramma, prima di entrare dalla porta.

```
griglia      celle da 0,20 m per sala, rifatta quando cambia la geometria (navKey): bordo
             bloccato tranne il varco della porta; tavoli (rettangolo orientato o disco)
             gonfiati di 0,22 m; sedie dischi da 0,25 + 0,22; banco del pass 1,6 × 0,5
             gonfiato; leggio disco da 0,3 gonfiato come gli altri, tranne la tasca di
             0,15 m attorno al posto dell'hostess (a 0,5 m: non gonfiato, lei ci entrava di
             10 cm partendo e tornando);
             chi sta fermo in piedi (all'ingresso, accanto al tavolo) e i cani dischi da
             0,2 + 0,22, con la loro posizione nella navKey: chi aspetta all'ingresso sta sulla
             strada della porta, e senza la fila gli passava in mezzo
nearestFree  BFS entro 1,0 m, poi entro 2,0 m
A*           8 vicini, costi 1 e √2, octile, niente tagli d'angolo, heap binario su array
             tipizzati riusati, tetto di 40k espansioni → linea retta; poi filo teso con
             linea di vista supercover. 30k celle in meno di 20 ms
passo        velocità costante sul binario, imbardata ≤ 7 rad/s, fase += distanza / falcata
             (un ciclo, due passi: 1,4 m adulti, hostess e camerieri; 0,9 bambini; 0,4 il
             cane; con 0,7 e 0,45 della spec i piedi scivolavano del doppio); gambe ±28°,
             braccia in controfase ×0,8, dondolio 2,5 cm; il cane a coppie diagonali
velocità     ospiti 1,1 m/s (±5 % per comitiva), hostess 1,3 libera e 1,0 accompagnando,
             chi recupera e il cane 1,5, camerieri 1,3
```

**I camerieri** (`model/waiters.ts`, `hooks/useStaffOnShift.ts`). La lista di sala del turno
da `/staff/presence`, letta in difesa (`{ id, name, role }`, righe senza id o nome scartate):
finché non arriva niente camerieri e hostess senza nome; un errore senza una lista buona di
questo servizio dà due camerieri senza nome se c'è qualcuno a tavola, se no uno. Si rilegge
al cambio di servizio, a ogni epoca e 1,5 s dopo l'ultimo `staff:*`, `shift:*`, `timeoff:*`,
`leave:changed` (il salvataggio in blocco della griglia non manda eventi: lo recupera l'epoca
dopo). Il nome è `staff_members.name`, già il nome di battesimo. Chi ha un ruolo da
accoglienza (`/host|accoglien|ma[iî]tre/i`) dà il nome all'hostess della sala principale; gli
altri girano, divisi fra le sale con qualcuno a tavola (uno a testa finché bastano, poi a
resto maggiore sulle persone; a ristorante vuoto uno al pass della sala a video), al più 8 in
cammino per sala.

```
AT_PASS   al suo posto (file da 3 a 0,6 m davanti al banco, solo su celle libere: un tavolo
          accanto al banco toglie un posto e si va al prossimo; rivolto al banco), fermo
          2–6 s, 8–20 a schermo fissato; la pausa dopo il giro e l'attesa si sommano senza
          perdere il tempo in più (da fermi il canvas dorme fino alla partenza)
→ tavolo  prima il mai visitato più recente non preso da altri, se no un'estrazione pesata sul
          tempo dall'ultima visita
→ TO_TABLE il lato del tavolo verso il pass, a 0,5 m, col vassoio
→ SERVE 3–8 s → TO_PASS → posa 1 s → AT_PASS
riassegnazione solo fra un compito e l'altro (svanisce al pass vecchio, compare al nuovo);
movimento ridotto o modalità lenta: fermi al pass; modalità leggera: niente camerieri
```

Le comitive già presenti a uno scatto contano come visitate (una visita, l'ultima da 0 a 120 s
prima): «prima i tavoli appena seduti» vale per chi si è visto arrivare.

**Fotogrammi.** `frameNeed()` è `'active'` (30 fps) se un ospite o un'hostess si muovono in
qualunque sala, o c'è un accompagnamento in coda; `'ambient'` (20 fps) se si muovono solo i
camerieri della sala a video; `'none'` (0 fps) da fermi, e allora `wakeInMs()` dice quando il
prossimo cameriere riparte: il canvas si risveglia da solo invece di girare a vuoto. Gli
anelli 12 fps, i controlli 30, la modalità lenta al più 15. La modalità leggera (niente
camerieri) scatta quando, in 10 s di movimento continuo, l'intervallo medio supera
`max(50, 1,5 × il fotogramma atteso)`: 50 ms a 30 fps, 75 a 20, dove 50 sarebbe il ritmo
stesso. Resta finché il canvas non si rimonta. Da fermi `step` fa passare il tempo vero, ma
solo fino alla prossima partenza più un passo: dopo la scheda nascosta il primo fotogramma
porta tutto il tempo passato, e le pause di tutti scadevano insieme.

**La pagina.** L'etichetta della tavolata accompagnata è un elemento DOM solo, mosso via ref:
«Tavolo 40 · 4 (2 bambini) + cane», col nome della tavolata a nomi accesi, già tradotta dalla
pagina. La striscia (`ActivityStrip`, `role="log"` e `aria-live="polite"`, sempre montata con
la vista 3D; i conti puri in `model/activity.ts`) tiene le 4 righe più recenti per 90 s,
composte a ogni render così spegnendo i nomi spariscono anche da quelle già a video: «4 (2
bambini) + cane → tavolo 40», «2 all'ingresso», «… · tavolo 40 → 41», «… · tavolo 40 →
uscita», «Tavolo 12 · 30 a tavola», «3 tavoli aggiornati». Ogni riga ha due parti: chi (si
accorcia coi puntini) e dove (mai: su un telefono i puntini tagliavano proprio «→ 41»); e una
frase per lo screen reader, senza frecce né «più» («4 persone, 2 bambini, un cane, al tavolo
40»), con la pastiglia nascosta. Un riallineamento subito dopo un altro si somma a quello, e
a scheda nascosta i 90 s non partono: tornando, una riga sola dice quanti tavoli sono cambiati.
Le righe che il modello smentisce se ne vanno: l'arrivo, l'ingresso e il cambio di tavolo di
una comitiva tornata in attesa o sparita, l'uscita di una comitiva di nuovo al suo tavolo (un
annullamento non sempre manda un evento), e l'arrivo di un accompagnamento finito senza
sedersi, per comitiva e non per tavolo (cambiato tavolo a metà strada, la fine dice il tavolo
nuovo). **«Segui il servizio»** (`salaVivo.follow` per dispositivo; senza una scelta vale lo
schermo fissato), un bottone da 44 px con le impronte, anche a schermo fissato: non mostra
niente di privato; solo con la vista 3D (senza, non c'è niente da seguire, e il giro delle
sale non avrebbe un bottone per fermarlo). Un `escort-start` in un'altra sala porta lì lo
schermo con un calo d'opacità di 150 ms (secco col movimento ridotto), senza toccare la sala
scelta; se nella sala a video un accompagnamento è ancora in corso si aspetta che finisca, e
si va solo se l'altro è ancora in corso (prima ogni partenza tagliava via quello che si stava
guardando); dopo 20 s di calma e niente in corso si torna a casa; fissato e fermo da 45 s, la
sala dopo fra quelle con qualcuno a tavola; un tocco su una linguetta (che sceglie la casa) o
un trascinamento lo mettono in pausa per 2 minuti. Linguette, numeri del palco e avvisi
parlano della sala a video, e la linguetta della sala a video si porta in vista nella barra.
La ricarica automatica dello schermo fissato aspetta che `isAnimating()` torni falso.
L'orologio Live della pagina è all'ora del ristorante (`timeZone` di `LivePill`, solo qui),
come i cartelli.

| `salavivo.json` | it | en |
|---|---|---|
| `follow` / `unfollow` | Segui il servizio / Smetti di seguire il servizio | Follow the service / Stop following the service |
| `strip.title` · `strip.party` · `strip.anonymous` | Attività della sala · {{name}} · {{people}} · Tavolo {{table}} | Floor activity · {{name}} · {{people}} · Table {{table}} |
| `strip.kids_one` / `_other` · `strip.dog_one` / `_other` | ({{count}} bambino) / ({{count}} bambini) · + cane / + {{count}} cani | ({{count}} child) / ({{count}} children) · + dog / + {{count}} dogs |
| `strip.toTable` · `strip.atEntrance` | → tavolo {{table}} · all'ingresso | → table {{table}} · at the entrance |
| `strip.moved` · `strip.leaving` | tavolo {{from}} → {{to}} · tavolo {{table}} → uscita | table {{from}} → {{to}} · table {{table}} → exit |
| `strip.seatedCount` · `strip.updatedMany_one` / `_other` | {{count}} a tavola · {{count}} tavolo aggiornato / {{count}} tavoli aggiornati | {{count}} seated · {{count}} table updated / {{count}} tables updated |
| `strip.sr.people_one` / `_other` · `strip.sr.kids_one` / `_other` · `strip.sr.dog_one` / `_other` | {{count}} persona / {{count}} persone · {{count}} bambino / {{count}} bambini · un cane / {{count}} cani | {{count}} person / {{count}} people · {{count}} child / {{count}} children · a dog / {{count}} dogs |
| `strip.sr.toTable` · `strip.sr.moved` · `strip.sr.leaving` | al tavolo {{table}} · dal tavolo {{from}} al tavolo {{to}} · lascia il tavolo {{table}} | to table {{table}} · from table {{from}} to table {{to}} · leaving table {{table}} |

`strip.party` usa `{{people}}` e non `{{count}}`: i18next legge `count` come selettore del
plurale, e il testo composto («4 (2 bambini) + cane») lo manderebbe a cercare
`strip.party_other`. `unfollow` e `strip.title` non erano nella specifica: il title del
bottone premuto, come «Nascondi i nomi degli ospiti», e il nome della regione della striscia.
Dalla revisione: `strip.leaving` era «lascia il tavolo {{table}}» («4 · lascia il tavolo 40»,
un conto soggetto di un verbo, e con i nomi due punti di fila), ora la freccia come le altre
righe; `strip.seatedLarge` diventa `strip.seatedCount`, la sola parte «dove»; le chiavi
`strip.sr.*` sono le frasi per lo screen reader.

**Le scelte rispetto alla specifica**, le prime cinque da confermare (§13): la lista
`partyStates` con la fase `hidden` (nascosta → seduta ricompare sul posto: annullare un arrivo
più recente sbagliato non fa rifare l'ingresso alla tavolata di prima); `DEPARTING` in piedi
nel modello statico; l'hostess sempre disegnata dal regista; in fila solo l'accompagnamento
(cambi di tavolo e uscite su percorsi propri, sfalsati), e le tavolate grandi o dei banchetti
mai a piedi; la porta che sfuma con la posizione. Poi: `escort-start` già all'accodamento;
`'hidden'` anche senza vista 3D; il fabbisogno di fotogrammi per schermo, coi camerieri fermi a
0 fps; la soglia della modalità leggera in proporzione al ritmo; il leggio gonfiato meno la
tasca dell'hostess (era non gonfiato); il
personale non ancora letto (niente camerieri) distinto dall'errore (camerieri senza nome); le
comitive viste a uno scatto già visitate; la pagina che aggiorna il regista in un effetto di
layout. Dal collaudo visivo dell'integrazione: chi sta in piedi e i cani fanno ostacolo nella
griglia; la porta a senso unico (chi la spodesta entra dopo l'uscita della tavolata di prima,
non insieme); la falcata come ciclo intero (1,4 m e 0,9); il lato del cane smorzato. Dalla
revisione (§13): l'accoglienza sulla strada della fila; il cane sempre dallo stesso lato e
fuori dallo spazio altrui; chi esce in fila per strada; i posti al pass sulle celle libere;
l'hostess che aspetta i suoi ai posti e che fa da ostacolo da ferma; il ×2 della coda col
conto dello spec; i 90 s di un accompagnamento da quando parte; il `bulk` in tavoli; la
pagina che non dà al regista il modello delle 17:00 con le unioni del pranzo, e che mette in
scena già conclusa una rilettura delle varianti.

**Test** (`tests/unit/`): `navGrid` (aggira un tavolo, niente tagli d'angolo, la lisciatura,
il bersaglio bloccato, il varco della porta, le ancore, 30k celle sotto i 20 ms, stesso
ingresso stesso percorso); `motion` (velocità costante, imbardata, fase, oltre i capi, binario
allungato); `rng`; `partyStates` (fasi, ordine, `DEPARTING` in piedi, conti invariati);
`director` (orologio finto e seme fisso: ogni riga della tabella, ogni scatto, l'epoca e il
Wi-Fi ballerino, la coda ×2 e lo scatto oltre 6, il servizio nuovo, il movimento ridotto,
`fastForward`, stesse posizioni con lo stesso seme, e a ogni passo ogni figura disegnata da uno
strato solo); `waiters` (ruoli e ripiego, divisione, prossima visita, tetto per sala, modi);
`frameDemand` (fps, risveglio, soglia leggera); `boundaries` (striscia e hook del personale fra
i file puri, e il canvas che non importa il codice del regista); `activity` (le righe degli
eventi, le smentite, la somma dei riallineamenti, chi e dove, la frase detta); `overrides`
(la chiave assestata alle 17:00, le letture contate). Più l'API `presenza-personale` (anche
un'assenza di più giorni, e le schede di un altro ristorante mai in lista). Commit: «Presenze del personale: stessa regola della pagina Personale» ·
«Sala dal vivo: griglia di cammino e percorsi» · «Sala dal vivo: il regista della scena» ·
«Sala dal vivo: l'accoglienza accompagna gli ospiti al tavolo» · «Sala dal vivo: i camerieri
di turno girano fra pass e tavoli».

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
rotta contiene già «sala3d»); gzip three ≈ 197 KB (MapControls compreso), canvas ≈ 67,
pagina ≈ 11, bundle principale meno di 10 KB in più (PR2b: +1,2 KB); dopo una modifica
alla sola app `three-*.js` non cambia.

Il controllo del manifest regge una build giusta: dal punto d'ingresso può partire un
chunk solo (tutto il resto è a richiesta), e la pagina non ha una chiave col suo
sorgente (`_SalaVivoPage-<hash>.js`, senza facciata), quindi si cerca per `name` e si
segue la sua chiusura statica, non solo gli import diretti. Provato anche al contrario:
una pagina che importa il canvas, o un `index.html` che importa three, escono con 1.

```bash
node -e 'const m=require("./dist/.vite/manifest.json");if(!m["index.html"])throw new Error("manifest senza index.html");const chiusura=k0=>{const s=new Set();const w=k=>{if(s.has(k)||!m[k])return;s.add(k);(m[k].imports||[]).forEach(w)};w(k0);return [...s].map(k=>m[k].file)};const f=chiusura("index.html");const bad=f.filter(x=>x.includes("sala3d/"));const pk=Object.keys(m).filter(k=>m[k].name==="SalaVivoPage");if(pk.length!==1)throw new Error("chunk della pagina: "+pk.length);const pt=chiusura(pk[0]).filter(x=>/three|SalaVivoCanvas/.test(x));console.log({static:f.length,bad,page:m[pk[0]].file,pageThree:pt});process.exit(bad.length||pt.length?1:0)'
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
| G9 | Prima apertura di una TV durante un'interruzione | `LazyChunkError` con «Ricarica»; aprire la pagina una volta all'installazione: poi il codice 3D (cache `sala-3d`) e i testi (cache `locales`, la rotta dei dizionari del service worker, per tutta l'app) ripartono anche a linea caduta. A schermo fissato una vista 3D interrotta riparte da sola, al più una volta al minuto e tre per caricamento |
| G10 | Il confine fra pranzo e cena non è lo stesso su ogni schermo | La 3D segue il server; FloorPlan, Reception, Cassa e Prenotazioni potranno adottare l'helper più avanti |
| G11 | Un ingresso per sala; sale senza posizione fra loro | `UNIQUE (room_id, kind)`; dissolvenza fra sale. Più ingressi: via il vincolo, più un'etichetta |
| G12 | Falsi positivi del cane («senza cane»); numero ignoto | Parola intera; al massimo due cani |
| G13 | `width_cm` e `length_cm`: significato e valori fuori misura | Larghezza = profondità, lunghezza = lato lungo; corpi dentro il box del glifo |
| G14 | Finestre di deploy | Railway prima per PR1, PR2b e PR3; la SPA regge un 404 sui segnaposto e un interruttore assente |
| G15 | Il bundle principale cresce per sbaglio | I controlli del manifest e `tests/unit/boundaries.test.ts` |
| G16 | `three` in devDependencies rompe un futuro build della SPA con `--omit=dev` | Vercel e CI installano le devDependencies; va scritto nella descrizione di PR2b |
| G17 | I tavoli nascosti sono mobili veri | Omessi, come in 2D |
| G18 | I banchetti non hanno orario né ciclo d'arrivo | Figure solo dalle prenotazioni collegate e sedute, altrimenti il cartello |
| G19 | Tavoli uniti | Sempre come in 2D, vicini o lontani: un primario per la somma dei coperti, col corpo dai posti (decisione di Tina, 4 ottobre) |
| G20 | Chiosco in trappola dopo un crash | Il chrome lo chiede la pagina con `onImmersive`: smontata lei, torna la navigazione |
| G21 | Interruttore o entitlement, se Sympotia vende la vista 3D | Interruttore operativo ora; un entitlement seguirebbe il modello delle recensioni, chiuso in caso d'errore |
| G22 | Clone vecchio | `git fetch` prima di tutto, poi migration e ancore: è già successo (§2) |
| G23 | Due letture di «di turno»: Personale, l'avviso del cambio turno e la Sala dal vivo (`isOnDuty`) da una parte, la copertura del piano ferie (`makeDutyIndex`: l'assenza batte il turno scritto, solo il FISSO è implicito) dall'altra | PR3 allinea `/staff/presence` a Personale e corregge solo il commento del piano ferie; la regola della copertura la decide Tina |

---

## 12. Deliberatamente fuori

Camerieri guidati dalle Comande (§9), un ruolo di sola visione per gli schermi fissati,
più ingressi per sala e una posizione delle sale fra loro, il nome del cameriere sui tavoli
che serve, la copertura del piano ferie letta come Personale (G23, da chiedere a Tina).
L'arredo vero (bancone, pareti): `docs/cassa-plan.md` §12 metteva «Arredo della piantina
(bancone, ingresso)» fra le cose senza modello, e l'ingresso ora ce l'ha, ma i segnaposto
sono punti, non mobili. Figure dei banchetti per tutto il turno (§13), forme del seed, altri
schermi sull'helper.

---

## 13. Note per il revisore

**Correzioni trovate riallineando.** «Come `room:*`» era sbagliato sull'esclusione del
mittente: `broadcastRoom*` non escludono nessuno; il contratto resta, sul modello di
`table:created`. La trappola di Tailwind (§5.4) morde già il bottone di conferma della
sala in FloorPlan (`${dsIconButton} bg-[var(--ds-action-bg)]`), disegnato bianco, e
`salacucina.json` scrive «Sala &amp; Cucina», che esce così a video: tutti e due fuori
perimetro. `dist/` è condiviso fra `vite build` e i test API: mai in parallelo.

**Il pieno dei segnaposto posati: deciso il 3 ottobre.** Uno strumento col segnaposto
già sulla piantina usa `TOOL_BUTTON_ON`, come chiedeva la specifica; ma quel pieno vuol
dire «modalità accesa» per «Sposta tavoli» e «Modifica tavoli», e a segnaposto posati
(lo stato normale) chi modifica vede tre bottoni pieni accanto ai due delle modalità,
anche a modalità spente. L'alternativa è lasciarli su `EDIT_ACTION_QUIET` e segnare il
posato con un indizio più piccolo (un segno di spunta, o l'etichetta che cambia, come già
fa). Tina, il 3 ottobre, ha scelto di tenere il pieno: lo strumento di un segnaposto già
posato resta su `TOOL_BUTTON_ON`.

**«Pass» o «Passe».** Nel resto dell'app la postazione si chiama «Passe»
(`passe_enabled`, Impostazioni → Sala e cucina → Passe). «Pass» è il testo approvato per
il segnaposto e resta finché Tina non dice altrimenti: è una riga per lingua.

**Il fuso del ristorante, per PR2a.** Il piano diceva «ora di Roma». Dal 20 settembre il
tenant ha un fuso suo (`tenant.timezone`), che il frontend tiene come fuso di sessione
(`sessionTimeZone()` in `utils/displayTime.ts`), e il server ha `resolveService(at, tz)`
con Roma di default. La strada coerente è un helper col fuso come parametro esplicito, a
cui il frontend passa quello di sessione; per Vecchio Frantoio non cambia niente. Fatto
così in PR2a: `currentServiceInTz` e `serviceDayInTz` in `utils/reservationTime.ts` col fuso
esplicito, `currentService` e `serviceDayOf` in `utils/displayTime.ts` sul fuso di sessione
(§6).

**Cinque scelte di PR2c, decise con Tina il 4 ottobre** (§8).
- *Il banchetto che trabocca:* sì. Ognuna delle famiglie di un banchetto siede al suo
  tavolo, e solo chi non ci entra prende i tavoli del banchetto senza prenotazioni sue nel
  turno. Tornare indietro è una riga: `spillTableIds` restituisce `[]`.
- *Il bottone dei nomi a schermo fissato:* nascosto. Chi passa davanti a uno schermo
  pubblico non accende i nomi; vale la scelta fatta prima di fissare, e per cambiarla si
  sblocca.
- *Le sedie accese dove siede qualcuno* sono quelle occupate. Tenere la 2D esatta vorrebbe
  dire una sedia accesa e vuota accanto al bambino seduto in testa sul seggiolone, e sedie
  spente sotto chi siede ai tavoli di un banchetto che trabocca.
- *Il seggiolone dall'icona:* resta così. Ogni nota rapida con l'icona «Bambino /
  Seggiolone» dà il seggiolone; oggi l'unica nota con quell'icona è «Seggiolone».
- *La testata sul telefono:* due righe sotto sm, titolo e riassunto sopra, i bottoni sotto.
  Nessun bottone tolto.

**Cinque scelte di PR3 da confermare** (§9).
- *La lista delle fasi e la fase nascosta:* `partyStates` e non `parties` (il nome è già di
  `RoomModel`), con `hidden` per chi è seduto ma senza figure. Uscire di lì è un'uscita a piedi;
  tornarci (l'arrivo più recente annullato) fa ricomparire la tavolata sul posto, senza un
  secondo ingresso dalla porta.
- *«In uscita» in piedi nel modello statico:* dietro le sedie, i cani in piedi. PR2c li
  disegnava seduti; così movimento ridotto, scatti e fine dell'alzata danno la stessa figura.
- *L'hostess sempre del regista:* cammina, e il suo nome la deve seguire.
- *In fila solo l'accompagnamento:* i cambi di tavolo e le uscite vanno su percorsi propri,
  sfalsati; le tavolate oltre 12 persone o di un banchetto non camminano mai, compaiono e
  svaniscono sedute.
- *La porta sfuma con la posizione:* chi aspetta oltre la porta non si vede, compare passandola.

**Quattro ritocchi del collaudo visivo di PR3** (§9), su fotogrammi della pagina vera.
- *Chi aspetta all'ingresso è un ostacolo.* La fila dell'hostess passava in mezzo a chi
  aspetta accanto alla porta, e così chi esce: ora chi sta fermo in piedi e i cani sono
  dischi nella griglia (il cameriere non serve più in piedi sul cane).
- *La porta a senso unico.* Una tavolata più recente sullo stesso tavolo entrava mentre la
  vecchia usciva, e le due si attraversavano nell'ingresso (la fila segue il suo binario e
  non si scansa). Prima esce chi lascia il tavolo, poi l'hostess va a prendere chi arriva; chi
  si alza per uscire mentre lei accompagna aspetta in piedi che presenti il tavolo. La
  specifica le voleva insieme; da confermare.
- *La falcata è un ciclo intero.* Con 0,7 m (adulti) e 0,45 (bambini) le gambe facevano tre
  passi al secondo e i piedi scivolavano del doppio; 1,4 e 0,9.
- *Il cane accanto al padrone* gira con calma alle svolte secche invece di trottare di
  traverso davanti alla porta.

**La revisione di PR3** (§9). Corretti nel regista: alle 17:00 la pagina aspetta le varianti
del servizio nuovo prima di dare il modello al regista, e una rilettura delle varianti alla
riconnessione va in scena già conclusa; la pausa del cameriere al pass non si conta due volte
quando il canvas dorme, e dopo la scheda nascosta i camerieri non partono tutti insieme; la
rete dei 90 s scatta anche con l'aggiornamento al minuto, e un accompagnamento rimasto in coda
non viene tagliato a metà strada; il ×2 della coda con quattro comitive, come la specifica;
`movingKeys` con chi esce dal modello. Nella scena: l'accoglienza sulla strada della fila (il
tornante), il braccio che indica la strada, l'etichetta che svanisce, l'hostess che aspetta
i suoi ai posti e fa da ostacolo da ferma, il cane sempre dallo stesso lato e mai addosso a
nessuno, chi esce in fila per strada, i posti al pass sulle celle libere, il leggio gonfiato.
Nella pagina: la striscia (chi e dove, la frase detta, le smentite, i riallineamenti sommati,
«→ uscita»), «Segui il servizio» che aspetta la fine dell'accompagnamento a video e che senza
vista 3D è spento, la linguetta in vista, l'orologio all'ora del ristorante.

Deciso da Tina il 4 ottobre: durante un cambio di tavolo a piedi il tavolo nuovo resta «in
arrivo» con l'anello finché l'ultimo non si siede, come quello di un accompagnamento (prima
era già «arrivato» mentre la tavolata ci camminava). Il regista lo tiene in `arrivalTargets` e
lo spegne con `moved-end`. Vale anche per chi, mentre esce, viene rimesso a un altro tavolo
(spodestato, un'uscita o un «Arrivato» tolti): ci torna a piedi, ed è un cambio di tavolo.

Restano aperti, per Tina:
- *Chi si siede passa attraverso lo schienale* (si vede solo da vicino). Il rimedio vero è la
  sedia che si scosta e torna, cioè uno spostamento per sedia esposto dal regista alla scena:
  un'aggiunta al contratto dei tipi.
- *L'orologio Live di tutta l'app all'ora del ristorante?* Qui sì; la testata di App e le
  Comande leggono ancora l'ora del dispositivo, e su un portatile in un altro fuso differiscono
  dai cartelli.
- *Le due letture di «di turno»* (Personale e Sala dal vivo, contro la copertura del piano
  ferie), come sopra.

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
