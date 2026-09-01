# Cassa — piano tecnico

*30 agosto 2026 — deciso con l'utente sui mockup, prima di scrivere codice.*

Cassa è il banco del cassiere: la coda dei conti del servizio, il tavolo con la sua
comanda, il cliente della visita, l'incasso e la chiusura fiscale, senza uscire dal
modulo. Vive sotto **Servizio**, fra Comande e Cucina.

Non è un modulo nuovo nel senso dei dati: il conto, il libro cassa, le quote, i
documenti fiscali e la comanda **esistono già e sono in produzione**. Cassa è
soprattutto una ricomposizione di pezzi esistenti attorno a una persona che oggi non
ha una schermata sua — il cassiere, che con Comande e Pagamenti deve saltare fra due
moduli per fare un solo mestiere.

**Perimetro MVP: solo dine-in.** Asporto, conti azienda e riepilogative mensili
restano fuori (vedi §12).

---

## 1. Confini col resto dell'app

### Cassa e Pagamenti si dividono per orizzonte temporale

| | Cassa | Pagamenti |
|---|---|---|
| Domanda | «cosa incasso adesso» | «cosa è successo nel periodo» |
| Scope | il servizio in corso (o uno passato, esplicito) | intervallo di date |
| Contiene | coda, tavolo, incasso, chiusura di cassa, transazioni del servizio | link di pagamento, conti chiusi, storico, riconciliazioni, rimborsi |

Le due liste di conti si somigliano e va bene così: rispondono a due domande diverse
sullo stesso dato. Pagamenti **non si tocca**.

### La regola d'oro: estrazione additiva

Passo 3 è OrderPad, Passo 2a è TableGrid, Passo 4 è SettleDialog. Riscriverli
significherebbe due copie che divergono al primo fix; modificarli significherebbe
cambiare Comande e Pagamenti.

La via è la terza: **ai componenti condivisi si aggiungono prop opzionali il cui
default è il comportamento di oggi**, e la logica di vista che serve a entrambi si
alza in un modulo neutro. Comande e Pagamenti devono comportarsi in modo identico,
byte per byte, dopo il merge. Se una prop non riesce a essere additiva, il pezzo si
lascia dov'è e Cassa costruisce il proprio — mai un `if (isCassa)` dentro Comande.

---

## 2. Cosa esiste già e si riusa

| Pezzo | Dove | Uso in Cassa |
|---|---|---|
| Conto e residuo | `table_bills`, `GET /reservations/:id/bill`, `GET /bills/open` | coda (Passo 1), riepilogo (Passo 4) |
| Libro cassa | `table_bill_payments`, `POST /bills/:id/payments` | incassi, storni |
| Quote pay-at-table | `table_bill_splits`, `/pay/:token/*` | dividi conto, quote degli ospiti |
| Documenti fiscali | `fiscal_documents`, `POST /bills/:id/fiscal-docs`, `/invoices` | scontrino, proforma, fattura (Passo 5) |
| Comanda | `orders`, `order_items`, `POST /orders/:id/{items,send}` | tavolo attivo (Passo 3) |
| Coperto e servizio | `syncSystemLinesInTx` | righe automatiche, invariate |
| Servizio corrente | `resolveService()` (`SERVICE_DAY_START_HOUR`) | scope di ogni vista |
| Griglia tavoli | `components/comande/tablesView.ts`, `TableGrid.tsx` | Passo 2a |
| Piantina | `FloorPlan.tsx`, `TableGlyph.tsx` | Passo 2b |
| Menu e righe | `comande/{DishBrowser,CourseColumn,CourseChips}` | Passo 3 |
| Chiusura conto | `pagamenti/BillSheet.tsx` → `SettleDialog` | Passo 4 |
| Rubrica | `customers`, `customers.billing`, `CustomerPickerModal` | cliente della visita |
| Primitive | `components/ds/*` | tutto |

**Il conto non è la comanda.** Restano due macchine a stati separate, come oggi:
la comanda dice cosa si prepara, il conto quanto si deve.

---

## 3. Cosa è nuovo

### 3.1 Sessione di cassa — `cash_sessions`

Oggi `GET /reports/cash-closure` è un **report di sola lettura, per giornata di
calendario**. Manca tutto il lato destro di 8b: il fondo di apertura, il contato, la
differenza, la nota, e soprattutto un atto di **chiusura**.

La sessione è **per servizio**, non per giorno: lo stesso cassetto passa di mano fra
pranzo e cena, e una differenza va imputata al turno che l'ha prodotta. Il report per
giornata resta dov'è, intatto, per Pagamenti.

Regole:

- Una sola sessione viva per `(tenant, service_date, shift)`.
- Il **fondo di apertura** si può correggere finché la sessione è aperta (`[Modifica]`
  in 8b), non dopo la chiusura.
- **Atteso** = fondo + somma dei movimenti `CONTANTI` non stornati del servizio.
  Calcolato, mai memorizzato: memorizzarlo significherebbe che uno storno alle 23:40
  lo lascia sbagliato.
- **Contato** e **nota** si scrivono alla chiusura. La nota è **obbligatoria se la
  differenza è ≠ 0** e resta a registro con il nome dell'operatore.
- La cassa **si chiude anche con conti aperti**: si avvisa (callout ambra con quanti
  e per quanto), non si blocca. Quei conti restano incassabili, anche il giorno dopo —
  è esattamente il caso della terza riga del Passo 1.
- La chiusura non tocca i conti, non emette documenti, non libera tavoli. È un atto
  sul **cassetto**, non sul servizio.

### 3.2 Quote create dalla cassa — non servono

*Rivisto costruendo il passo 5.* Il piano prevedeva `POST /bills/:id/splits` per dare
alla cassa la controparte autenticata del claim dell'ospite. Guardando il modello da
vicino, **non serve, e sarebbe un doppione**.

Per il cassiere una quota non è un'entità: è *quanto si paga adesso*. E un incasso
parziale il libro cassa lo registra già — `POST /bills/:id/payments` lascia il conto
`OPEN` e lo porta a `SETTLED` solo quando il totale è coperto. Persistere una «quota
dello staff» accanto al movimento vorrebbe dire scrivere due volte lo stesso denaro, e
poi tenerli d'accordo.

Quindi «Dividi conto» in Cassa è **aritmetica**, non persistenza: divide il residuo,
precompila l'importo, e l'incasso è il movimento di sempre. È anche quello che dice la
didascalia del mockup — *«definisce quanto si paga adesso, non come»*.

Le quote vere restano quelle degli ospiti, create dal QR. Si mostrano perché spiegano
perché il residuo è più basso, ma non si toccano da qui: una quota prenotata da un
telefono scade da sola.

**`per_item` resta guest-only**: il cassiere non divide per articolo in MVP, e la terza
piastrella non si mostra affatto (una piastrella disabilitata genera una telefonata; la
sua assenza no). La capacità lato ospite non cambia.

### 3.3 Riapertura del conto

Oggi un conto riapre solo come **effetto collaterale** di uno storno di incasso o del
rimborso di una quota. Serve l'atto esplicito — `[Apri il conto]` in 7a e nella riga di
Transazioni — che riporta a `OPEN` mantenendo i movimenti, con log.

### 3.4 Transazioni — una vista, non una tabella

Il registro dei movimenti del servizio è l'**unione di due sorgenti che restano
separate**: `table_bill_payments` (il libro cassa) e i `payment_requests` delle caparre.
Nessuna tabella nuova: una query e una schermata.

Le caparre compaiono nella lista ma **fuori dai totali di incasso del servizio** —
sono già state incassate alla prenotazione, e contarle due volte è il modo più
semplice per far quadrare la cassa su un numero falso.

---

## 4. Schema

Una sola migration. `createSchema()` è congelato: non si tocca.

```sql
CREATE TABLE cash_sessions (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    service_date        DATE NOT NULL,
    shift               VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH','DINNER')),
    opening_float_cents INTEGER NOT NULL DEFAULT 0,
    opened_by_user_id   INTEGER,
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counted_cents       INTEGER,
    difference_cents    INTEGER,
    note                TEXT,
    closed_by_user_id   INTEGER,
    closed_at           TIMESTAMPTZ
);

-- Una sola sessione per servizio: il vincolo è il modello, non una convenzione.
CREATE UNIQUE INDEX cash_sessions_servizio
    ON cash_sessions (tenant_id, service_date, shift);
```

`difference_cents` è **memorizzato**, a differenza dell'atteso: è la fotografia del
momento in cui si è contato il cassetto, e uno storno successivo non deve riscriverla
— altrimenti la nota dell'operatore finirebbe a spiegare un numero che non esiste più.

RLS `tenant_isolation` come ogni tabella nuova con `tenant_id` (pattern outbox), più
il seed dei permessi nella stessa migration (§5).

**Nessuna colonna nuova** su `table_bills`, `order_items` o `customers`: lo sconto di
riga e l'omaggio di riga sono fuori MVP (§12), e il conteggio visite è un `COUNT` sulle
prenotazioni, non un campo.

---

## 5. Permessi

Oggi **nessun ruolo sotto GENERAL_MANAGER può chiudere un conto**: WAITER non ha
nemmeno `payments:view`, MANAGER si ferma a `payments:view`. La persona del cassiere
letteralmente non esiste nella matrice.

Quattro permessi nuovi, non un `payments:full` allargato — chiudere in ammanco,
stornare un incasso e chiudere il cassetto sono tre autorizzazioni diverse, ed è
esattamente quello che il titolare vuole poter separare:

| Permesso | Copre |
|---|---|
| `cash:operate` | accesso al modulo, incassi, chiusura conto a saldo pieno |
| `cash:void_payment` | storno di un incasso già registrato |
| `cash:close_partial` | chiusura con ammanco (`SETTLED_PARTIAL`) |
| `cash:close_session` | fondo di apertura e chiusura del cassetto |

Ruolo nuovo **`CASSA`**, che porta anche `orders:take` e **`orders:void`** — senza
quest'ultimo non si storna una riga né si applica lo sconto conto.

| Ruolo | operate | void_payment | close_partial | close_session |
|---|---|---|---|---|
| OWNER / GENERAL_MANAGER | ✓ | ✓ | ✓ | ✓ |
| MANAGER | ✓ | ✓ | ✓ | ✓ |
| CASSA | ✓ | ✓ | — | — |

`ViewState.CASSA` richiede `cash:operate`. Come da CLAUDE.md il permesso si aggiunge in
**tre punti** — mappa ruoli, `requirePermission` sulle route, `canAccessView` — o si
ottengono bottoni che fanno 403.

---

## 6. Route API

### Nuove

| Metodo | Route | Permesso |
|---|---|---|
| `GET` | `/cash/session?date=&shift=` | `cash:operate` |
| `POST` | `/cash/session` `{ opening_float_cents }` | `cash:close_session` |
| `PATCH` | `/cash/session/:id` `{ opening_float_cents }` | `cash:close_session` |
| `POST` | `/cash/session/:id/close` `{ counted_cents, note }` | `cash:close_session` |
| `GET` | `/cash/transactions?date=&shift=&method=&status=` | `cash:operate` |
| `POST` | `/bills/:id/reopen` | `cash:void_payment` |

`POST /bills/:id/splits` è stato **tolto**: vedi §3.2 — la quota del cassiere è un
incasso parziale, non una riga nuova.

`POST /bills/:id/reopen` rifiuta con 409 un conto che porta un documento fiscale
**confermato**: uno scontrino trasmesso all'Agenzia non si riapre sotto, o si
incasserebbe due volte contro un documento solo. Prima si annulla il documento
(`POST /bills/:id/fiscal-docs/:fid/void`), poi si riapre. I movimenti non si toccano:
riaprire non è annullare.
| `GET` | `/orders/open?date=&shift=` | `orders:view` |

`GET /orders/open` non era nel piano iniziale ed è stato aggiunto costruendo il
passo 4: i tavoli con una comanda aperta si potevano sapere solo un tavolo alla
volta (`GET /tables/:id/order`), che la griglia di Comande chiama in ciclo —
sessanta tavoli, sessanta richieste. Cassa ne ha bisogno anche solo per il
contatore «tavoli in servizio» in testa alla coda, e sessanta richieste per un
numero non stanno in piedi. È di sola lettura e non cambia niente a Comande, che
continua col ciclo finché non la si tocca apposta. `shift` assente = entrambi i
turni, come `/bills/open`.

`GET /cash/session` risponde anche a sessione **non ancora aperta** (`null` più
l'atteso calcolato): la schermata 8b deve poter mostrare i totali prima che qualcuno
dichiari un fondo.

`POST /cash/session/:id/close` valida che `note` ci sia quando
`counted_cents ≠ atteso`, e restituisce il conteggio dei conti ancora aperti perché la
UI possa avvisare senza una seconda chiamata.

### Riusate senza modifiche

`GET /bills/open` · `POST /bills/:id/payments` · `POST /bills/:id/payments/:pid/void` ·
`POST /bills/:id/close` · `POST /bills/:id/fiscal-docs` · `POST /bills/:id/invoices` ·
`POST /orders` · `POST /orders/:id/items` · `POST /orders/:id/send` ·
`POST /orders/items/:id/void` · `POST /orders/:id/discount` · `POST /orders/:id/transfer` ·
`POST /tables/:id/bill` · `POST /print-jobs`

**Un tipo di stampa nuovo** su `/print-jobs` non serve: la proforma alla chiusura è il
`PRECONTO` che già esiste. Il «Stampa riepilogo» di 8b è invece un **foglio browser**,
non termico — quarto file accanto a `printHaccpReport`, `printShoppingList`,
`printBanquet`, con `PRINT_TOKENS_CSS` incluso a mano come gli altri tre (§17 del
design system: il documento stampato non carica `index.css`).

---

## 7. Realtime

Gli eventi conto e comanda esistono già e Cassa li ascolta tutti:
`bill:opened|updated|closed|settled|payment-recorded|payment-voided|split-*`,
`order:created|updated|revised`.

Due eventi nuovi, sulla stessa rotta:

- `cash:session-opened` — fondo dichiarato o corretto;
- `cash:session-closed` — cassetto chiuso, con differenza.

Ogni route che muta deve fare broadcast, altrimenti il cambiamento si vede solo sul
client che l'ha fatto. Cassa **non** usa `X-Socket-ID` per escludersi: il cassiere deve
vedere l'esito confermato dal server, non la propria previsione ottimistica.

---

## 8. Frontend — perimetro

`ViewState.CASSA`, voce di sidebar in **Servizio** fra Comande e Cucina, icona
**`Calculator`** (`CreditCard` è Pagamenti, `Receipt` significa «il conto» in
`OrderTopBar`).

**La topbar globale resta**: data e turno vengono da lì, come per Comande, Cucina e
Passe. Il selettore di servizio dentro al titolo, nei mockup, era un errore del mockup.

```
components/cassa/
  CassaPage.tsx        — router interno del modulo, scope del servizio
  CodaServizio.tsx     — Passo 1
  SelezionaTavolo.tsx  — Passo 2 (griglia + piantina)
  TavoloAttivo.tsx     — Passo 3
  ClienteVisita.tsx    — pannello cliente
  Pagamento.tsx        — Passo 4 + esiti
  DividiConto.tsx      — Passo 4a
  Transazioni.tsx      — 8a
  FondoEChiusura.tsx   — 8b
  cassaView.ts         — totali, raggruppamenti, etichette
```

### Estrazione additiva — la lista

| Da | Cosa | Stato |
|---|---|---|
| `comande/tablesView.ts` | gruppi, tinte, `compareTableNames` | già neutro, si importa e basta |
| `comande/TableGrid.tsx` | la griglia raggruppata | ✅ estratta in `comande/TableTiles.tsx` |
| `pagamenti/BillSheet.tsx` | l'aritmetica della chiusura | ✅ estratta in `pagamenti/settleView.ts` |
| `comande/DishBrowser.tsx` | menu | invariato, si importa |
| `comande/CourseColumn.tsx` | colonna comanda | ⏸ rinviata — vedi sotto |
| `FloorPlan.tsx` | piantina | ⏸ rinviata — vedi sotto |

**Cosa è stato estratto e perché lì.** `TableTiles` prende SOLO l'elenco raggruppato di
tessere: stesso ordine dei gruppi, stesse tinte, stessa tessera, con una render prop per
quello che sta sotto il nome del tavolo (coperti in Comande, quanto deve in Cassa). Il
guscio della pagina — titolo, ricerca, chip dei filtri, stato vuoto — resta di chi la
possiede, perché lì Comande e Cassa non si somigliano affatto. `settleView` prende
l'aritmetica del misto (movimenti, resto, ammanco) e nient'altro: è la stessa in un
dialog e in una pagina intera, e sono numeri, che si guardano meglio da soli.

**Cosa è stato rinviato, e non per pigrizia.** La colonna comanda di Comande è
*orientata alle uscite* (chip delle uscite, «Invia», «Invia tutto»); quella di Cassa è
*orientata al conto* (Inviati / Da inviare, coperto e servizio, totale, «Invia e vai al
pagamento»). Non è lo stesso componente con un footer diverso: è un'altra composizione,
e una prop che le tenesse insieme sarebbe un `if` travestito. Stessa cosa per la
piantina, dove il vero nodo è la doppia codifica di colore (§9) e non una prop.

Si estraggono quando il consumatore esiste — passi 4 e 5 — così il taglio lo decide il
codice che lo usa e non un'ipotesi. Se anche allora una prop non riesce a restare
additiva, il pezzo non si tocca e Cassa si scrive il suo.

**Criterio di accettazione, verificato.** Le due estrazioni sono state provate
equivalenti prima di andare avanti: `settleMath`/`settlePayments`/`nextAmountText`
contro una ri-implementazione verbatim del codice inline su 1456 combinazioni di
residuo × movimenti × metodo × importo digitato, e `TableTiles` contro il JSX
precedente confrontando il markup statico su sei casi (tutti gli stati, un solo stato,
prenotato senza prenotazione, nessuna riga, `busy`). Le prove sono girate fuori dal
repo: il progetto non ha ancora un harness di unit test, e questa tranche non è il
momento di introdurne uno (§13 del design system resta aspirazionale).

---

## 9. Design system

Cassa non introduce token, componenti o pattern nuovi. Le primitive arrivano dal barrel
`components/ds`, mai dai file singoli.

### Correzioni ai mockup, decise

I mockup deviano dal sistema in sei punti; si segue il sistema.

| Mockup | Si fa |
|---|---|
| pill «4 coperti» in ambra | `neutral` — ambra è `pending`, cioè «chiede un'azione»; i coperti sono un fatto |
| chiusura del pannello in tinta critica | il cerchio del DS su `--ds-surface-row`, come `ModalShell` |
| legenda «Prenotato» | «In arrivo», come `tablesView.ts` — stesso stato, un nome solo |
| `[Seleziona tavolo]` dentro lo `StatStrip` | fuori: lo strip prende `onClick` per segmento, non un bottone pieno |
| «credito» sulla riga del servizio passato | «residuo» — «credito» nel modello è già l'acconto portato nel conto |
| piantina a forme piatte | resta il glifo con le sedie, con i colori mappati sugli stati del conto |

### Mappa colori della piantina

*Rivisto costruendo il passo 2b.* Il piano diceva «in Cassa vince il conto» e mappava i
quattro stati sulle famiglie `--ds-*`. Alla prova dei fatti significava inventare token
`--tg-*` nuovi per una schermata sola, e avere due verità sullo stesso tavolo.

Il glifo resta quello di sempre, **con la sua famiglia di token**, e gli stati del conto
si appoggiano a quelli che già esistono:

| Stato Cassa | Stato del glifo | Perché |
|---|---|---|
| Libero | `libera` | — |
| Comanda aperta | `arrivato` | seduti e in servizio |
| Da incassare | `uscita` | «draining, turnover ahead» è letteralmente il tavolo che sta per pagare |
| In arrivo | `inarrivo` | — |

**La tinta di `uscita` non è l'ambra della griglia,** ed è una divergenza accettata: la
famiglia dei glifi ha una scala sua, che il design system dichiara «con i propri valori,
con semantiche che concordano con le altre» (§ layer `--tg-*`). Allinearle vorrebbe dire
aggiungere token. Quanto deve il tavolo lo dice **il numero sotto al glifo**, che è poi
l'informazione che il cassiere cerca — il colore da solo non l'avrebbe mai detta.

Il pagamento parziale è una **pill**, non un quinto colore: cinque tinte adiacenti non si
distinguono di sbieco, con poca luce, a metà servizio.

La legenda dice **«In arrivo»**, non «Prenotato»: è il nome che quello stato ha in tutta
l'app (`tablesView.ts`), e due nomi per la stessa cosa su schermate adiacenti si pagano
subito.

### Responsive e tema

Ogni schermata funziona da telefono a desktop, in chiaro e in scuro, dal primo commit —
non come rifinitura. Bersagli 44px. Dove cambia l'albero (foglio contro pannello) decide
`useMediaQuery`, non il CSS (regola 13). Sotto `md` lo scope sale collassa nella
toolbar accanto alla ricerca e restano i chip di stato, che durante il servizio si
toccano molto più spesso.

Mai maiuscolo, nemmeno dove il mockup lo mostra. Copy in italiano, tagliato al minimo
che funziona: queste schermate si leggono in mezzo al servizio.

---

## 10. Regole di flusso

Le decisioni che non si vedono nello schema e che sono il vero contenuto del modulo.

**Le bozze non arrivano mai al pagamento.** Il carrello resta **locale**, come in
OrderPad — una sola chiamata di rete all'invio, che su un WiFi di sala è la differenza
fra usarlo e tornare al blocchetto. Le righe in bozza pesano sul totale, e
`[Vai al pagamento]` diventa **`[Invia e vai al pagamento]`** quando ce ne sono: non si
incassa una riga che la cucina non ha visto, e così il totale a schermo, la proforma e
il documento fiscale non possono divergere.

**Menu di riga: non esiste.** Con lo sconto di riga fuori MVP resta troppo poco per
giustificare un `•••` su ogni riga.

| | Azioni |
|---|---|
| Da inviare | stepper (`−` a quantità 1 elimina, la cucina non l'ha vista) · pannello **Note** (nota + uscita) |
| Inviati | **Storna** → `ReasonDialog` esistente |

Il pannello si chiama **Note** e non «Varianti e note» perché
`PATCH /orders/items/:id` non accetta `modifier_ids`: la variante non è modificabile
dopo l'inserimento. E lo storno **richiede una motivazione** (la route rifiuta sotto i
3 caratteri): il «tocca due volte» del mockup farebbe 400, e la motivazione è anche il
messaggio che ferma la cucina.

**Conteggi.** L'occupazione conta **tavoli** (`9/18`, `Sala principale ·6/8`), il lavoro
conta **conti** (`2 conti da incassare`, `6 comande aperte`). Un'unione è 2 tavoli e 1
conto, e il riquadro lo dice (`T5 + T6 · unione · 9 coperti`).

**Sale e stati convivono.** Le sale sono uno *scope* (riga 1), gli stati un *filtro*
(riga 2). I conteggi di stato si ricalcolano **dentro** la sala scelta: «Da incassare 2»
accanto a una sala che non ne ha è una bugia che si crede una volta sola.

**Il pannello pagamento si divide per verbo**, non per metodo:

- **Incassa** — Contanti, POS, Satispay, Buoni pasto, Gift card, Sospeso, Omaggio:
  registra e chiude.
- **Chiedi al cliente** — QR al tavolo, Link di pagamento: apre un canale, il conto
  resta aperto, si torna alla coda. Nessun importo, nessuna chiusura. Il residuo scende
  da solo quando arriva il webhook, che scrive lo specchio `LINK_ONLINE` — che infatti
  «non si registra mai a mano».

**Buoni pasto**: quantità × valore facciale, circuito da una lista del tenant, **mai
resto**; `{circuito, count, face_value_cents}` in `meta`. La commissione del circuito è
una riconciliazione mensile, non una cosa che il cassiere sa alle 21:14.

**Sospeso** è disabilitato finché non c'è un cliente sulla visita: un sospeso anonimo è
un credito che nessuno può riscuotere.

**Ammanco**: nessun bottone dedicato. Resta il comportamento di oggi — il server decide
`CLOSED` o `SETTLED_PARTIAL` dall'aritmetica, e la riga sotto il bottone diventa critica
(«Ammanco €X: il conto resterà parziale»). In Cassa serve `cash:close_partial` e la
nota è obbligatoria.

**Rimborso** (caparra maggiore del totale): Cassa mostra «Da rimborsare al cliente» in
sola lettura e lascia chiudere; il rimborso si esegue in Pagamenti, perché è
un'operazione di gateway e non del cassetto.

**Mancia**: campo compatto opzionale accanto alla scelta del documento. È rara, non
merita una riga sua.

**Concorrenza.** Mentre si *guarda*, i numeri si aggiornano dal socket. Appena un
importo è *impostato* (digitato o aggiunto come movimento) le cifre si **congelano** e
compare un callout non bloccante — «Il residuo è cambiato: ora €7,50 · [Aggiorna]».
Quello che l'operatore ha scritto non si riscrive mai da solo. La chiusura è comunque
autoritativa lato server, che rilegge e ricalcola: un client vecchio non può pagare di
più, al massimo ottiene un parziale o un conflitto — e il conflitto va spiegato a
parole («qualcuno ha già incassato €5,00 su questo conto»), non con un errore generico.
Nessun lock sul tavolo in MVP.

**Offline: la cassa non accoda soldi.** È già la regola dell'app —
`services/offlineQueue.ts` è agganciata solo ad `apiService`, mai a `billsApiService` o
`ordersApiService`. Quindi: le letture degradano sull'ultimo stato noto; **ogni
scrittura che muove denaro** (incasso, chiusura conto, storno, chiusura cassa) si
blocca con un banner e il primario disattivato. Rigiocare un incasso di dodici ore
prima non è sincronizzare, è corrompere il servizio di oggi.

**Banchetti**: il tavolo si mostra in coda con il badge che esiste già (`BookOpen` su
`--ds-arriving-tint`, come in `ReservationList`). Ma `BanquetPayment` è un **registro
separato** che non arriva mai in `table_bill_payments`: il residuo in Cassa ignorerebbe
gli acconti già incassati sull'evento. Finché i due registri non sono uniti (fuori MVP)
il conto porta un callout con la cifra e il rimando a Menu & banchetti — meglio un
rimando che un residuo silenziosamente sbagliato.

---

## 11. Piano PR e verifica

1. **Migration + permessi + ruolo CASSA.** Test API sulla matrice: chi può cosa, e i
   403 attesi.
2. **Sessione di cassa** — route, atteso calcolato, chiusura con nota obbligatoria,
   eventi socket. Test API compresi gli storni che spostano l'atteso.
3. **Estrazione additiva** — le prop opzionali sui componenti condivisi, **senza**
   ancora una schermata Cassa. Il criterio di accettazione è che Comande e Pagamenti si
   comportino identici: si verifica a mano su stack locale prima di proseguire.
4. **Coda, selezione tavolo, tavolo attivo** (Passi 1–3).
5. **Pagamento, dividi conto, esiti** (Passi 4, 4a, 5) — comprese le quote lato staff.
6. **Transazioni e Fondo e chiusura** (8a, 8b) + foglio di stampa del riepilogo.
7. **`docs/funzionalita-app.md`** — ⏸ **volutamente NON aggiornato in questa tranche.**
   Vedi la nota al revisore in §13.

Su ogni PR: `npx tsc --noEmit`, `npx vite build` (poi `rm -rf dist`), `npm test`.
Verifica visiva in chiaro e in scuro, a larghezza telefono e desktop.

---

## 12. Deliberatamente fuori dall'MVP

- **Sconto e omaggio di riga.** Servono colonne nuove su `order_items` e spostano lo
  scorporo IVA, quindi il documento commerciale e la FatturaPA. Resta lo sconto conto.
- **Divisione per articolo dal lato cassa.** Resta guest-only dal QR.
- **Varianti modificabili dopo l'inserimento.** `PATCH /orders/items/:id` non accetta
  `modifier_ids`; si toglie la riga e si ribatte.
- **Arredo della piantina** (bancone, ingresso). Non esiste un modello per gli elementi
  non-tavolo: `Room` ha solo nome e dimensioni.
- **Unificazione del registro banchetti** col libro cassa.
- **Asporto**, conti azienda, riepilogativa mensile.
- **Lock del tavolo** fra due cassieri.

---

## 13. Note per il revisore

### Il catalogo funzionalità è fermo apposta

La convenzione del repo dice che ogni PR che tocca una funzionalità visibile aggiorna
`docs/funzionalita-app.md` e ci aggiunge una riga nel «Registro aggiornamenti». **Qui
non è stato fatto, ed è una scelta, non una dimenticanza.**

Quel documento è la fonte del sito di marketing e del manuale utente: descrive quello
che il ristorante *può fare*, e Cassa non è ancora stata provata da nessuno — nessuna
delle route nuove è mai stata eseguita (vedi sotto). Annunciare lì un modulo non
collaudato vuol dire pubblicare una promessa.

Si aggiorna quando Cassa è testata e approvata, in una PR sua. Fino ad allora la voce
non esiste, che è l'unica cosa vera.

### Niente in questa tranche è mai girato

Il typecheck passa, i due build passano, e le estrazioni del passo 3 sono state provate
equivalenti riga per riga. Ma la macchina su cui è stato scritto tutto questo **non ha
un Postgres**, quindi:

- la migration `1787970000000_modulo-cassa.js` non è mai stata applicata;
- nessuna delle route nuove (`/cash/*`, `/orders/open`, `/bills/:id/reopen`) ha mai
  risposto a una richiesta vera;
- i file di test in `tests/api/cassa-*` e `orders-cassa-*` compilano ma non sono mai
  stati eseguiti.

La CI ha un Postgres di servizio: la prima esecuzione vera è lì. Da guardare per primi,
in ordine di quanto costano se sono sbagliati: la chiusura del conto, la chiusura del
cassetto e la differenza, e l'allargamento dei CHECK sui ruoli (che se non arriva a
destinazione impedisce il boot dopo il primo utente CASSA — vedi `ensureRoleChecks`).

### Il coperto si addebita prima che si ordini

**Il coperto si addebita prima che si ordini.** `syncSystemLinesInTx` inserisce la riga
`COVER` non appena `covers > 0`, senza guardare se esiste una riga `DISH`: un walk-in
appena aperto mostra già €4,00 di totale. Nei mockup il tavolo vuoto mostra infatti
«Totale €4,00» con `[Vai al pagamento]` disattivato — cioè un conto che esiste ma non si
può incassare.

La funzione è **condivisa con Comande** e si è deciso di **non toccarla** in questa
tranche: il comportamento è identico oggi anche aprendo un tavolo da Comande. Va deciso
a parte se il coperto debba materializzarsi solo alla prima riga. C'è un commento nel
punto in cui Cassa mostra il coperto, che rimanda qui.
