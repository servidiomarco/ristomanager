# Piano modulo alloggio (camere e appartamenti) — Sympotia

Bozza settembre 2026. Stesso formato di `docs/saas-multitenant-plan.md`: decisioni prese,
fasi, un PR per unità di lavoro, rischi. Nulla qui è ancora implementato.

---

## Il pilota c'è, ed è il tenant 1

Il Vecchio Frantoio ha **7 appartamenti e 2 camere**. Questo non è un dettaglio
commerciale: è il fatto che cambia la natura del progetto.

Il modulo non si costruisce per un cliente ipotetico da trovare dopo. Si costruisce per
una struttura che lavora tutti i giorni, sullo stesso tenant, dentro lo stesso database, e
che può usarlo in produzione fase per fase. È la stessa condizione che ha tenuto onesti
comande, cassa e asporto: chi scrive il codice vede la sera stessa se regge.

E cambia il racconto commerciale: quando il modulo si venderà, non si venderà una
promessa. Si venderà un sistema che gestisce nove alloggi e un ristorante nello stesso
posto, con la colazione che è un servizio della cucina, l'extra del bar che va sul conto
del soggiorno, e Sofia che al telefono risponde sia a chi vuole un tavolo sia a chi vuole
un appartamento.

### Sette appartamenti e due camere non sono «nove camere»

La proporzione decide il design. Un modulo pensato per le camere e poi adattato agli
appartamenti sbaglia sei cose; pensarlo appartamento-first e trattare la camera come un
caso particolare ne sbaglia zero. In concreto:

| Il mix impone | Conseguenza sul piano |
|---|---|
| L'appartamento si vende **a unità**, la camera **a persona** | `rate_prices.pricing_basis` (`UNIT` \| `PERSON`) è una colonna di Fase 2, non un'estensione futura. La tassa di soggiorno resta per persona/notte in entrambi i casi: due assi diversi che non vanno confusi |
| Soggiorni lunghi, spesso sabato-sabato | soggiorno minimo per periodo e **giorni di arrivo ammessi** (maschera settimanale) servono subito, non sono raffinatezze da PMS |
| Fra due soggiorni c'è il **cambio: pulizie e biancheria** | non una tabella nuova: un'attività nel modulo Attività esistente, generata alla partenza. Il blocco a calendario serve solo a chi vuole la notte cuscinetto |
| **Il CIN è per unità**, non per struttura | nove codici: colonna su `accommodation_units`, non un campo in `legal_config`. Lo stesso vale per gli indirizzi se gli appartamenti non sono tutti nello stesso stabile |
| Sette unità in locazione breve superano ampiamente la soglia delle quattro | quasi certamente **attività imprenditoriale**, quindi fattura o corrispettivo con IVA, non ricevuta con bollo. Semplifica la 2.3: si implementa per prima la strada che il pilota usa davvero — **da confermare col commercialista** |
| Sugli appartamenti **Airbnb pesa quanto o più di Booking** | l'iCal sale di priorità: è il canale di sincronizzazione che Airbnb offre a tutti, ed è esattamente ciò che serve a nove unità |
| La colazione per l'appartamento è **opzionale e venduta a parte** | è l'upsell del ristorante, cioè il motivo per cui questo modulo vive qui e non in un verticale |
| Nove unità sono **poche** | il calendario a nastro entra in una schermata senza virtualizzazione, e nessuna query ha problemi di volume. Il lavoro è tutto nella correttezza, zero nella scala |

### Prima di tutto: Fase 0

Mezza giornata di ricognizione al Frantoio, prima di scrivere una riga. Senza queste
risposte si costruisce a memoria pur avendo il pilota in casa:

1. Come si gestiscono oggi i nove alloggi — extranet Booking, un gestionale, un foglio?
2. Da quali canali arrivano le prenotazioni e in che proporzione.
3. Chi fa Alloggiati Web oggi, con quali credenziali, e se le unità sono una struttura
   ricettiva sola o più d'una agli occhi della Questura.
4. Comune e regolamento della tassa di soggiorno; regione, per il portale ISTAT.
5. Regime fiscale e documento emesso oggi all'ospite.
6. I nove CIN (e i CIR regionali) già assegnati.
7. Tariffe reali: stagionalità, soggiorni minimi, giorni di arrivo, politica di caparra.

Le risposte 3-6 sono adempimenti: determinano metà della Fase 4. Le altre determinano se
la Fase 1 nasce già usabile o se resta una demo.

---

## Posizionamento

Il modulo **non** nasce per il B&B puro. Lì si compete con verticali maturi e a basso
prezzo (Octorate, Krossbooking, Beddy, Smoobu, Lodgify), che fanno solo quello da dieci
anni, e non si porta in dote nessun vantaggio.

Nasce per **l'ibrido: ristorante con alloggi, agriturismo, locanda, relais** — cioè per
quello che il Frantoio è già. Regola di design che ne discende, e che vale per ogni PR del
piano: **quando una scelta può privilegiare l'integrazione col resto dell'app o la
completezza da property management system, si sceglie l'integrazione.** Non stiamo
costruendo un PMS; stiamo aggiungendo gli alloggi a un sistema che già conosce l'ospite.

---

## Decisioni prese

- **Entità nuova, non estensione di `reservations`.** Motivazione nella sezione «Il motore
  di disponibilità»; è la decisione più importante del piano.
- **Non si chiamano `rooms`.** In questo codice `rooms` sono le *sale* del ristorante
  (`services/roomOccupancyService.ts`, eventi socket `room:*`, `room_occupancy_caps`).
  L'alloggio vendibile è `accommodation_units` a DB, `unit` nel codice, «alloggi» in UI —
  non «camere», visto che sette su nove sono appartamenti. `ViewState.ALLOGGI`.
- **Appartamento-first.** Dove i due casi divergono (prezzo, soggiorno minimo, pulizie,
  colazione), il caso di riferimento è l'appartamento e la camera è la semplificazione.
- **Add-on commerciale** come `takeaway`: feature `lodging` in `tenant_features`,
  `requireFeature('lodging')`, gate UI da `/auth/me`. Accesa per il tenant 1 dalla prima
  migration, spenta per tutti gli altri.
- **Adempimenti dentro il perimetro minimo**, non in un «poi»: Alloggiati Web e tassa di
  soggiorno sono il motivo per cui un gestore cambia gestionale, e il Frantoio li deve
  fare comunque dal primo giorno in cui il modulo è il sistema di riferimento.
- **OTA: iCal sì, channel manager no.** Connettività diretta con Booking e Airbnb fuori
  perimetro; si valuta una partnership (Fase 5).

---

## Cosa si riusa e cosa è davvero nuovo

### Si riusa così com'è

| Cosa | Dove | Nota |
|---|---|---|
| Multi-tenant + RLS | `db.ts` (`withTenant`, `runWithTenantContext`) | le tabelle nuove copiano il blocco `enableRls` di `migrations/1789430000000_modulo-asporto.js` |
| Entitlement add-on | `services/entitlements.ts`, `tenant_features` | una riga nell'array `TENANT_FEATURES` + il CHECK in migration |
| Permessi | `auth/permissions.ts` + `role_permissions` + `canAccessView` | tre punti da toccare, come sempre |
| Rubrica clienti | `customers` (+ `CustomerBilling`) | l'ospite è un cliente, non una tabella nuova |
| Incassi | `payment_requests` + Revolut/SumUp, `depositPolicy.ts`, `AutoDepositManager` | serve solo una FK `stay_id` accanto a `reservation_id` |
| Attività e to-do | `AttivitaPage.tsx`, `services/todoService.ts` | il cambio fra due soggiorni è un'attività, non un sottosistema |
| Messaggistica | WhatsApp/SMS/email, `remindersApiService`, template | conferma, istruzioni di arrivo, link di pagamento |
| Fiscalità | `services/fiscalService.ts` (driver Openapi) | copre fattura e corrispettivo; la ricevuta non fiscale, se serve, è nuova |
| Realtime | `services/socketService.ts` + `eventRegistry.ts` | eventi `stay:*`, `unit:*` |
| Pagina pubblica | `public/prenota.html` + `withPublicTenant` (`server.ts:492`) | modello esatto per `public/alloggi.html` |
| i18n | `public/locales/{it,en}` + `scripts/check-locales.mjs` | su appartamenti la clientela straniera è la norma |
| Design system | `components/ds/`, `docs/risto-design-system.md` | il calendario a nastro è l'unico componente davvero nuovo |

### È nuovo

1. Il motore di disponibilità a intervalli.
2. Il motore tariffario (con i due assi: per unità e per persona).
3. Il calendario a nastro.
4. Le schedine ospiti e l'invio ad Alloggiati Web.
5. La tassa di soggiorno.
6. La sincronizzazione iCal.

Cinque su sei sono contenuti e delimitabili. Il primo decide se il modulo regge.

---

## Il motore di disponibilità: perché non si riusa niente

Tutto l'impianto attuale ragiona a **slot dentro un turno dentro un giorno**:

- `utils/slots.ts:129` → `getAvailableSlots(tenantId, date, shift)`
- `reservations` ha `reservation_time TIMESTAMPTZ`, `shift`, `guests`, `table_id`,
  `duration_minutes`
- gli indici sono `(tenant_id, date, shift)`, le chiusure sono `special_closures` e
  `disabled_slots`, i cap sono per sala e per turno

Un soggiorno è invece un **intervallo** `[check-in, check-out)` con inventario per notte.
Le domande del dominio — «l'appartamento 3 è libero dal 3 al 7?», «quante notti minime ad
agosto?», «si può arrivare di domenica?» — non sono esprimibili riusando lo slot, e ogni
tentativo di piegarlo (una prenotazione per notte, oppure `duration_minutes` a 1440×N)
produce due difetti immediati: il conteggio delle presenze sbaglia, e la prima query di
disponibilità su due mesi diventa un ciclo di centinaia di round trip — lo stesso errore
che `/public/availability` nella forma `?from=&to=` evita già deliberatamente con cinque
query fisse.

Il modello corretto è nativo di Postgres:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- serve per l'EXCLUDE con colonne di uguaglianza

CREATE TABLE stays (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    unit_id     BIGINT NOT NULL REFERENCES accommodation_units(id),
    period      DATERANGE NOT NULL,          -- '[2026-08-03,2026-08-07)' — check-out escluso
    status      VARCHAR(20) NOT NULL,
    ...
    EXCLUDE USING gist (
        tenant_id WITH =, unit_id WITH =, period WITH &&
    ) WHERE (status IN ('OPTION', 'CONFIRMED', 'CHECKED_IN'))
);
```

Il vincolo di non sovrapposizione vive **nel database**, non in una `if` applicativa: è
l'unica difesa seria contro il doppio affitto quando le scritture arrivano da quattro
canali (staff, pagina pubblica, Sofia, import iCal) e da più processi. `[inclusivo,
esclusivo)` significa che la partenza del 7 e l'arrivo del 7 non collidono — semantica
giusta, e viene gratis.

Il motore va in `services/lodgingAvailability.ts` con una regola esplicita, scritta nel
commento in testa al file: **numero di query fisso rispetto alla lunghezza della
finestra**. Due mesi di calendario pubblico sono una query su `stays`, una su
`unit_blocks`, una su `rate_prices`, non 62 iterazioni.

---

## Modello dati proposto

Nomi al plurale, `tenant_id` ovunque, RLS su tutte le tabelle (la policy globale non copre
le tabelle nuove: va ripetuto il blocco `enableRls` della migration asporto).

```
accommodation_units   l'alloggio vendibile: appartamento, camera, posto letto
    id, tenant_id, name, code, kind (APARTMENT|ROOM|BED), sort_order, active,
    standard_occupancy, max_occupancy, extra_beds, cot_available,
    default_pricing_basis (UNIT|PERSON),
    cin, cir,                           -- per unità: nove codici, non uno
    address, floor, size_sqm, bedrooms, bathrooms,
    description, photos JSONB, amenities JSONB,
    checkin_info JSONB                  -- orari, consegna chiavi, istruzioni di arrivo

unit_blocks           chiusure: manutenzione, uso proprietario, cuscinetto, blocchi iCal
    id, tenant_id, unit_id, period DATERANGE, reason, source (STAFF|ICAL),
    external_uid, created_at            -- stesso EXCLUDE di stays

rate_plans            'Settimana con colazione', 'Non rimborsabile'
    id, tenant_id, name, breakfast_included, cancellation_policy JSONB,
    deposit_percent, active

rate_prices           il listino vero
    id, tenant_id, rate_plan_id, unit_id NULL=tutte, period DATERANGE,
    pricing_basis (UNIT|PERSON),        -- l'appartamento a unità, la camera a persona
    price_cents,                        -- per notte: dell'unità o dell'occupazione standard
    extra_adult_cents, child_price_rules JSONB,
    min_stay, max_stay,
    arrival_weekdays SMALLINT,          -- maschera: il sabato-sabato è una regola, non una nota
    closed_to_arrival, closed_to_departure

stays                 il soggiorno
    id, tenant_id, code, unit_id, period DATERANGE, status,
    adults, children, children_ages INTEGER[],
    rate_plan_id, total_cents, deposit_cents, currency,
    customer_id, guest_name, guest_email, guest_phone,
    channel (STAFF|WEB|VOICE|WHATSAPP|OTA_BOOKING|OTA_AIRBNB|OTHER),
    external_ref, notes, option_expires_at,
    checked_in_at, checked_out_at, cancelled_at, created_at, updated_at

stay_guests           le schedine (dato personale delicato — vedi 4.1)
    id, tenant_id, stay_id, role (SINGOLO|CAPOFAMIGLIA|CAPOGRUPPO|FAMILIARE|MEMBRO),
    last_name, first_name, sex, birth_date, birth_place, citizenship,
    doc_type, doc_number, doc_issue_place,
    alloggiati_sent_at, alloggiati_receipt_ref

stay_charges          righe del conto soggiorno
    id, tenant_id, stay_id, kind (LODGING|CITY_TAX|BREAKFAST|EXTRA|DISCOUNT),
    service_date, description, qty, unit_price_cents, vat_rate

city_tax_rules        regolamento comunale, versionato nel tempo
    id, tenant_id, municipality, amount_cents_per_person_night, season DATERANGE NULL,
    max_nights, exempt_under_age, exempt_rules JSONB, active

ical_feeds            sincronizzazione OTA minima
    id, tenant_id, unit_id, direction (IMPORT|EXPORT), url, export_token,
    last_sync_at, last_error
```

Quattro scelte che vale la pena difendere adesso:

- **`pricing_basis` sulla riga di listino, non sull'unità.** Lo stesso appartamento può
  vendersi a forfait in alta stagione e a persona fuori stagione; legarlo all'unità
  costringerebbe a duplicare l'inventario.
- **`cin` e `address` sull'unità.** Sette appartamenti hanno sette codici e possono avere
  indirizzi diversi. Metterli nei dati di struttura è il genere di scelta che si paga il
  giorno del controllo.
- **`children_ages` come array, non un contatore.** La tassa di soggiorno esenta per età e
  le tariffe bambini vanno a fasce: senza le età si riscrive la tabella al primo comune.
- **`stay_charges` separata da `stays.total_cents`.** L'addebito in camera dal ristorante —
  il motivo per cui questo modulo vive qui — è una riga che arriva dopo; il totale è una
  somma, non un campo che qualcuno aggiorna a mano.

Gli stati (`REQUEST|OPTION|CONFIRMED|CHECKED_IN|CHECKED_OUT|NO_SHOW|CANCELLED`) usano il
vocabolario del resto dell'app, e il colore si deriva dalle famiglie del design system,
mai localmente: la regola di `components/reservationState.tsx` vale identica qui.

---

## Adempimenti italiani

**Da verificare col commercialista e con chi al Frantoio li fa oggi, prima di scrivere
codice.** È il riassunto di ciò che il prodotto deve saper fare, non un parere
professionale: soglie, scadenze ed esenzioni cambiano per comune e per regione, e alcune
regole sono cambiate di recente.

| Adempimento | Riferimento | Cosa deve fare il prodotto |
|---|---|---|
| **Alloggiati Web** — schedine alla Questura | art. 109 TULPS | raccogliere i dati documento di ogni ospite, generare il tracciato, inviarlo al web service entro le 24 ore dall'arrivo (termine più stretto per i soggiorni brevissimi), archiviare la ricevuta. Da chiarire in Fase 0 se le nove unità sono una struttura sola o più d'una: cambia il numero di credenziali e di invii |
| **Tassa di soggiorno** | D.Lgs. 23/2011 art. 4 + regolamento comunale | calcolo per persona/notte con le esenzioni del comune (età, durata massima, categorie), riga separata sul conto, prospetto periodico da versare. Il gestore è responsabile d'imposta: l'errore lo paga lui |
| **CIN** + CIR regionale | DL 145/2023 art. 13-ter, banca dati del Ministero del Turismo | un codice per unità, conservato sull'unità, esposto sulla pagina pubblica e nei documenti. Nessuna integrazione: è un campo — ma senza il campo l'annuncio è irregolare |
| **Rilevazione ISTAT movimento clienti** | portale regionale (Ross1000, Turismo5, SIRT… cambia per regione) | arrivi e presenze per nazionalità. Si integra la regione del Frantoio; per le altre, export conforme |
| **Documento di vendita** | regime del gestore | con sette unità in locazione breve si è quasi certamente in regime d'impresa: fattura o corrispettivo con IVA alloggio agevolata, entrambi già nel perimetro di `fiscalService`. La ricevuta non fiscale con bollo serve solo al caso non imprenditoriale |
| **Dati personali degli ospiti** | GDPR | documenti d'identità = trattamento delicato: permesso dedicato, minimizzazione, retention con cancellazione automatica, riga in più nel registro dei trattamenti e nell'informativa (`docs/Checklist_Conformita_Privacy_GDPR.docx`) |

Nota di prodotto, non normativa: nell'ordine di importanza percepita da chi compra,
**Alloggiati Web viene prima di qualsiasi funzione di vendita**. È l'adempimento che si fa
ogni sera a mano e che tutti odiano.

---

## Fasi

### Fase 1 — Fondamenta (il modulo funziona, solo dal gestionale)

**PR 1.1 — Schema e inventario alloggi**
Migration con `accommodation_units`, `unit_blocks`, `stays` (incluso l'`EXCLUDE`), RLS,
feature `lodging` accesa per il tenant 1, permessi `lodging:view` / `lodging:manage` /
`lodging:guests`, `ViewState.ALLOGGI`. UI: l'elenco delle nove unità in Impostazioni, con
CIN e indirizzo — si carica l'inventario vero subito, serve a tutto il resto.

**PR 1.2 — Motore di disponibilità**
`services/lodgingAvailability.ts`: `getAvailability(tenantId, from, to, filtri)`,
`findFreeUnits(...)`, validazione (soggiorno minimo e massimo, giorni di arrivo ammessi,
chiusure in arrivo e partenza, capienza contro occupanti). Query a numero fisso. Test API:
sovrapposizioni, confine partenza/arrivo nello stesso giorno, blocchi, opzioni scadute.

**PR 1.3 — Calendario a nastro + CRUD soggiorno**
Righe = unità, colonne = giorni, barre = soggiorni, trascinamento per spostare e
allungare. Nove righe entrano in una schermata: niente virtualizzazione, il lavoro è tutto
nella correttezza del drag e nei 44px di target. Su mobile non è un nastro ma la lista del
giorno: arrivi, partenze, in casa.

**PR 1.4 — Arrivi, partenze e cambio**
Check-in e check-out cambiano stato. La Reception mostra anche arrivi e partenze alloggi
accanto a quelli del ristorante. Alla partenza nasce l'attività di cambio (pulizie e
biancheria) nel modulo Attività, assegnabile come qualsiasi altra. Eventi `stay:*` e
`unit:*` registrati in `services/eventRegistry.ts`, altrimenti la CI li rifiuta.

A valle di 1.4 il Frantoio può già tenere i nove alloggi qui dentro, con le tariffe fuori
dal sistema. È il primo punto di verifica reale del piano.

### Fase 2 — Prezzi e incassi

**PR 2.1 — Listini e preventivo**
`rate_plans` + `rate_prices` con i due `pricing_basis`, e `quoteStay(...)` funzione pura e
testabile: notti, unità o occupazione, extra letto, fasce bambini, sconto per soggiorno
lungo. Ogni prezzo mostrato altrove passa da qui, mai ricalcolato in UI.

**PR 2.2 — Caparra e saldo**
`payment_requests` prende `stay_id` accanto a `reservation_id` (nullable, vincolo: uno dei
due). Policy di caparra per rate plan (percentuale o prima notte), link via WhatsApp o
email con i template esistenti, riconciliazione dal webhook già in piedi.

**PR 2.3 — Conto del soggiorno e documento**
`stay_charges` come conto: notti, colazioni, tassa di soggiorno, extra. **Addebito in
camera**: dal conto tavolo (`table_bills`) il totale si sposta su un soggiorno aperto — è
la funzione che giustifica l'intero modulo, e al Frantoio si può collaudare la settimana
dopo averla scritta. Emissione con `fiscalService` nella forma che il pilota usa davvero
(vedi Fase 0); la ricevuta non fiscale solo se serve.

### Fase 3 — Canale diretto

**PR 3.1 — Pagina pubblica alloggi**
`public/alloggi.html` sullo stampo di `prenota.html`: un file, niente React, token
`--ds-public-*` ricopiati a mano (trappola nota, documentata in CLAUDE.md). Route
`/public/lodging/*` doppie (`/public/...` e `/public/:slug/...`) via `withPublicTenant`,
rate limiter per tenant, honeypot, CIN dell'unità in pagina. Default sicuro: se il
bootstrap fallisce, la pagina resta in manutenzione.

**PR 3.2 — iCal import/export**
Export di un feed per unità (token in URL) e import dei blocchi da Airbnb e Booking in
`unit_blocks`. Sync periodico dallo scheduler già protetto da advisory lock. Non elimina
la finestra di disallineamento fra due sync: va detto, non nascosto. Su questo mix è il
PR che più riduce il lavoro manuale quotidiano, e andrebbe anticipato se la Fase 0 dice
che oggi il grosso arriva da Airbnb.

**PR 3.3 — Sofia e WhatsApp**
Estensione di `services/bookingTools.ts` con disponibilità e prenotazione alloggi. Dopo
1.2 e 3.1, perché al telefono deve dire *le stesse cose* che la pagina dice allo schermo:
una sola fonte di verità, come già vale per `getCappedRoomIds` fra `/public/rooms` e il
submit.

### Fase 4 — Adempimenti

**PR 4.1 — Schedine ospiti**
`stay_guests`, censimento rapido col documento in mano (pochi campi, tastiera giusta,
nessuna schermata di troppo), permesso `lodging:guests` separato, retention configurata
con cancellazione automatica, informativa privacy aggiornata.

**PR 4.2 — Invio ad Alloggiati Web**
Generazione del tracciato, invio al web service, archiviazione della ricevuta, stato per
soggiorno, coda con retry e allarme se una schedina resta non inviata oltre il termine.
Credenziali per tenant in `integration_settings`. Collaudo sull'ambiente di test del
servizio prima della produzione: il precedente è `scripts/collaudo-fiscale.mjs`.

**PR 4.3 — Tassa di soggiorno**
`city_tax_rules` col regolamento del comune del Frantoio, calcolo automatico come riga
`CITY_TAX`, esenzioni per età e durata, prospetto periodico esportabile.

**PR 4.4 — ISTAT + CIN/CIR**
CIN e CIR già introdotti in 1.1 arrivano in pagina pubblica e sui documenti. Invio ISTAT
automatico per la regione del Frantoio, export conforme altrove.

Questa fase non aspetta la vendita: dal giorno in cui il modulo è il sistema di
riferimento del Frantoio, gli adempimenti li deve fare lui.

### Fase 5 — OTA (decisione strategica, non solo tecnica)

La connettività diretta con Booking.com richiede certificazione e manutenzione continua;
Airbnb idem. È un prodotto a sé, non un PR. Tre strade, in ordine di preferenza:

1. **Partnership con un channel manager** (Octorate, Krossbooking e simili espongono API):
   noi restiamo il sistema del gestore, loro fanno i canali.
2. **iCal e basta**, dichiarando il limite: regge bene per chi ha poche unità e vende
   soprattutto diretto — cioè, oggi, per il pilota.
3. Connettività diretta: solo con volumi che oggi non abbiamo.

---

## Ordine di esecuzione

```
Fase 0 (ricognizione al Frantoio)
   └→ 1.1 → 1.2 → 1.3 → 1.4 ────────────► il Frantoio ci lavora
                          ├→ 2.1 → 2.2, 2.3 (parallele)
                          │        └→ 3.1 → 3.2, 3.3 (parallele)
                          └→ 4.1 → 4.2, 4.3, 4.4 (parallele)
5 → quando il pilota gira e si guarda al secondo cliente
```

Il percorso critico è `1.2` (motore) e `1.3` (nastro). Se il motore è giusto il resto è
lavoro conosciuto; se è sbagliato, ogni PR successivo paga il debito. Fase 2 e Fase 4
possono procedere in parallelo: toccano tabelle diverse e persone diverse.

---

## Stima

Unità di misura: «asporto» = l'intero modulo take-away già consegnato (fondamenta +
gestione + pagina pubblica + conto), il riferimento più onesto che abbiamo.

| Fase | Dimensione | Nota |
|---|---|---|
| 0 — Ricognizione | mezza giornata | non è sviluppo, ed è il miglior investimento del piano |
| 1 — Fondamenta | ~1,5 asporti | il motore non ha precedenti nel repo; il nastro è più semplice del previsto con nove unità |
| 2 — Prezzi e incassi | ~1 asporto | il tariffario a due assi è più lavoro di quanto sembri; gli incassi sono riuso |
| 3 — Canale diretto | ~1 asporto | `prenota.html` è un modello quasi completo; l'iCal è piccolo e rende molto |
| 4 — Adempimenti | ~1,5 asporti | poco codice, molta verifica: collaudo, casi limite, e il pilota che lo usa davvero |
| 5 — OTA | non stimabile come sviluppo | è una decisione di partnership |

In tempo: **tre-cinque mesi** per un modulo che il Frantoio usa in pieno e che si può
mostrare a un secondo cliente. Meno della stima iniziale per una ragione sola: il pilota
in casa elimina il lavoro speculativo, non perché il lavoro sia meno.

---

## Rischi

1. **Riusare `reservations`.** La scorciatoia si ripresenterà a ogni PR di Fase 1 e va
   rifiutata ogni volta: vincolo di sovrapposizione perso, presenze sbagliate,
   disponibilità O(giorni).
2. **Confondere alloggi e sale.** `rooms` è già occupato; un `room_id` ambiguo dentro 36k
   righe di `server.ts` non si recupera più.
3. **Costruire solo per il Frantoio.** Il pilota in casa è un vantaggio enorme e una
   trappola: nove unità, un comune, una regione, un regime fiscale. Mitigazione: le regole
   specifiche stanno sempre in tabella (`city_tax_rules`, `rate_prices`, credenziali per
   tenant), mai in costanti nel codice — la stessa disciplina che ha retto nel
   de-hardcoding del brand.
4. **Adempimenti sottostimati.** Trasforma un modulo funzionante in uno inutilizzabile, e
   col pilota in produzione il danno è immediato, non commerciale.
5. **Doppio affitto da OTA.** Con il solo iCal resta una finestra fra due sync.
   Dichiararla; l'alternativa è la Fase 5.
6. **Dati documento.** Categoria che oggi il sistema non tratta. Permesso dedicato,
   retention, informativa: non è burocrazia, è ciò che un controllo guarda per primo.
7. **Il pilota è in produzione.** Le tabelle sono nuove e la feature nasce accesa solo per
   il tenant 1, quindi il rischio sul ristorante è basso — ma vale la regola di sempre:
   ogni migration si prova su un restore del dump prima del deploy.

---

## Cose del repo da non dimenticare (checklist meccanica)

Per ogni PR di questo piano:

- **Migration versionata**, mai `createSchema()` (congelato). `npm run migrate:create -- nome`.
- **RLS sulle tabelle nuove**: la policy globale non le copre, si ricopia `enableRls`.
- **Dockerfile**: una directory backend nuova va aggiunta alle `COPY`, altrimenti non parte
  in produzione. `migrations/` e `public/` sono già coperte.
- **`services/eventRegistry.ts`**: ogni evento socket nuovo va registrato o la CI fallisce.
- **Permessi in tre punti**: mappa ruoli, `requirePermission` sulla route, `canAccessView`.
- **`tenant_features`**: valore nell'array in `entitlements.ts` *e* nel CHECK in migration.
- **Traduzioni it + en** in `public/locales/`, altrimenti `check-locales.mjs` blocca la CI.
- **`docs/funzionalita-app.md`**: sezione nuova + riga nel registro aggiornamenti, nello
  stesso PR.
- **Design system**: token `--ds-*`, mai `--color-*`; niente maiuscolo; tre raggi;
  `public/alloggi.html` ricopia i token a mano.
- **Lettura difensiva dei campi nuovi** sul frontend: fra il deploy del backend e quello
  del frontend c'è sempre una finestra, e `npm run dev` è quella finestra in permanenza.
- `npx tsc --noEmit` dopo ogni modifica, `npx vite build` prima del commit.

---

## Da decidere

Quasi tutto passa dalla Fase 0. Restano aperte due domande che la ricognizione non
risolve:

1. **OTA**: si parte con «diretto + iCal» e si cerca la partnership dopo, o la si cerca
   prima del secondo cliente?
2. **Prezzo dell'add-on**: il posizionamento ibrido regge un prezzo sopra i verticali puri
   solo se l'addebito in camera, la colazione del ristorante e Sofia sono nel racconto dal
   primo giorno. Il Frantoio è anche il caso di studio che lo dimostra.
