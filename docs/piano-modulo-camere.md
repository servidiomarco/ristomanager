# Piano modulo camere (B&B / alloggio) — Sympotia

Bozza settembre 2026. Stesso formato di `docs/saas-multitenant-plan.md`: decisioni prese,
fasi, un PR per unità di lavoro, rischi. Nulla qui è ancora implementato.

---

## Premessa: chi è il cliente

Il modulo **non** nasce per il B&B puro. Lì si compete con verticali maturi e a basso
prezzo (Octorate, Krossbooking, Beddy, Smoobu, Lodgify), che fanno solo quello da dieci
anni e partono da poche decine di euro al mese, e non si porta in dote nessun vantaggio.

Il cliente naturale è **l'ibrido: ristorante con camere, agriturismo, locanda, relais**.
Lì il valore è esattamente ciò che i verticali non hanno: la colazione è un servizio del
ristorante, l'ospite è lo stesso record della rubrica, l'extra del bar si addebita in
camera e finisce sullo stesso conto, e Sofia risponde al telefono a chi chiede una camera
come a chi chiede un tavolo.

Conseguenza operativa su tutto il piano: **ogni volta che una scelta di design può
privilegiare l'integrazione col resto dell'app o la completezza da PMS puro, si sceglie
l'integrazione.** Non stiamo costruendo un property management system; stiamo aggiungendo
le camere a un sistema che già conosce l'ospite.

---

## Decisioni prese

- **Entità nuova, non estensione di `reservations`.** Motivazione nella sezione «Il motore
  di disponibilità»; è la decisione più importante del piano.
- **Non si chiamano `rooms`.** In questo codice `rooms` sono le *sale* del ristorante
  (`services/roomOccupancyService.ts`, eventi socket `room:*`, `room_occupancy_caps`). Le
  camere sono `accommodation_units` a DB, «camere» in UI, `unit` nel codice.
- **Add-on commerciale**, esattamente come `takeaway`: feature `lodging` in
  `tenant_features`, middleware `requireFeature('lodging')`, gate UI da `/auth/me`. Nasce
  spenta per tutti i tenant, incluso il Frantoio.
- **Adempimenti italiani dentro il perimetro minimo vendibile**, non in un «poi».
  Alloggiati Web e tassa di soggiorno non sono funzionalità premium: sono il motivo per
  cui un gestore cambia gestionale.
- **OTA: iCal sì, channel manager no.** L'import/export iCal è nel piano; la
  connettività diretta con Booking e Airbnb no — si valuta una partnership con un channel
  manager esistente (vedi Fase 5).
- **Regola del debutto**: la Fase 4 (adempimenti) va chiusa *prima* del primo cliente
  pagante, non dopo. Un modulo che non comunica ad Alloggiati Web espone il gestore a una
  sanzione, e quella sanzione diventa nostra.

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
| Messaggistica | WhatsApp/SMS/email, `remindersApiService`, template | conferma, promemoria pre-arrivo, link di pagamento |
| Fiscalità | `services/fiscalService.ts` (driver Openapi) | copre la fattura; la ricevuta non fiscale è nuova (vedi 2.3) |
| Realtime | `services/socketService.ts` + `eventRegistry.ts` | eventi `stay:*`, `unit:*` |
| Pagina pubblica | `public/prenota.html` + `withPublicTenant` (`server.ts:492`) | modello esatto per `public/camere.html` |
| i18n | `public/locales/{it,en}` + `scripts/check-locales.mjs` | per un B&B l'inglese non è un extra |
| Design system | `components/ds/`, `docs/risto-design-system.md` | il calendario a nastro è l'unico componente davvero nuovo |

### È nuovo

1. Il motore di disponibilità a intervalli.
2. Il motore tariffario.
3. Il calendario a nastro (tape chart).
4. Le schedine ospiti e l'invio ad Alloggiati Web.
5. La tassa di soggiorno.
6. La sincronizzazione iCal.

Cinque di questi sei sono contenuti e delimitabili. Il primo è quello che decide se il
modulo regge.

---

## Il motore di disponibilità: perché non si riusa niente

Tutto l'impianto attuale ragiona a **slot dentro un turno dentro un giorno**:

- `utils/slots.ts:129` → `getAvailableSlots(tenantId, date, shift)`
- `reservations` ha `reservation_time TIMESTAMPTZ`, `shift`, `guests`, `table_id`,
  `duration_minutes`
- gli indici sono `(tenant_id, date, shift)`, le chiusure sono `special_closures` e
  `disabled_slots`, i cap sono per sala e per turno

Un soggiorno è invece un **intervallo** `[check-in, check-out)` con inventario per notte.
Le domande che il dominio pone — «questa camera è libera dal 3 al 7?», «quante notti
minime in agosto?», «posso far arrivare qualcuno di domenica?» — non sono esprimibili
riusando lo slot, e ogni tentativo di piegarlo (una prenotazione per notte, oppure
`duration_minutes` a 1440×N) produce due difetti immediati: il conteggio delle presenze
sbaglia, e la prima query di disponibilità su due mesi diventa un ciclo di centinaia di
round trip — lo stesso errore che `/public/availability` nella forma `?from=&to=` evita
già deliberatamente con cinque query fisse.

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
l'unica difesa seria contro l'overbooking quando le scritture arrivano da tre canali
(staff, pagina pubblica, import OTA) e da più processi. `[inclusivo, esclusivo)` significa
che il check-out del 7 e il check-in del 7 non collidono — che è la semantica alberghiera
giusta e viene gratis.

Il motore va in `services/lodgingAvailability.ts` con una regola esplicita, scritta nel
commento in testa al file: **numero di query fisso rispetto alla lunghezza della
finestra**. Due mesi di calendario pubblico sono una query su `stays`, una su
`unit_blocks`, una su `rate_prices`, non 62 iterazioni.

---

## Modello dati proposto

Nomi al plurale, `tenant_id` ovunque, RLS su tutte le tabelle (la policy globale non copre
le tabelle nuove: va ripetuto il blocco `enableRls` della migration asporto).

```
accommodation_units   camera/appartamento vendibile
    id, tenant_id, name, code, kind (ROOM|APARTMENT|BED), sort_order, active,
    standard_occupancy, max_occupancy, extra_beds, cot_available,
    size_sqm, floor, description, photos JSONB, amenities JSONB

unit_blocks           chiusure: manutenzione, uso proprietario, blocchi da iCal
    id, tenant_id, unit_id, period DATERANGE, reason, source (STAFF|ICAL),
    external_uid, created_at            -- stesso EXCLUDE di stays

rate_plans            'Standard con colazione', 'Non rimborsabile'
    id, tenant_id, name, breakfast_included, cancellation_policy JSONB,
    deposit_percent, active

rate_prices           prezzo per periodo (il listino vero)
    id, tenant_id, rate_plan_id, unit_id NULL=tutte, period DATERANGE,
    price_cents,                        -- occupazione standard, per notte
    extra_adult_cents, child_price_rules JSONB,   -- fasce d'età
    min_stay, max_stay, closed_to_arrival, closed_to_departure

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

city_tax_rules        regolamento comunale (uno per tenant, versionato nel tempo)
    id, tenant_id, municipality, amount_cents_per_person_night, season DATERANGE NULL,
    max_nights, exempt_under_age, exempt_rules JSONB, active

ical_feeds            sincronizzazione OTA minima
    id, tenant_id, unit_id, direction (IMPORT|EXPORT), url, export_token,
    last_sync_at, last_error
```

Due scelte che vale la pena difendere adesso:

- **`children_ages` come array, non un contatore.** La tassa di soggiorno esenta per età e
  le tariffe bambini vanno a fasce: senza le età si riscrive la tabella al primo comune.
- **`stay_charges` separata da `stays.total_cents`.** L'addebito in camera dal ristorante
  (il motivo per cui questo modulo esiste) è una riga che arriva dopo; il totale è una
  somma, non un campo che qualcuno aggiorna a mano.

Naming: `status` usa lo stesso vocabolario del resto dell'app
(`REQUEST|OPTION|CONFIRMED|CHECKED_IN|CHECKED_OUT|NO_SHOW|CANCELLED`) e il colore di stato
si deriva dalle famiglie del design system, mai localmente — la regola di
`components/reservationState.tsx` vale identica qui.

---

## Adempimenti italiani

**Questa tabella va verificata con il commercialista e con un gestore reale prima di
scrivere codice.** È il riassunto di ciò che il prodotto deve saper fare, non un parere
professionale; le regole di dettaglio (soglie, scadenze, esenzioni) cambiano per comune e
per regione e alcune sono cambiate di recente.

| Adempimento | Riferimento | Cosa deve fare il prodotto |
|---|---|---|
| **Alloggiati Web** — schedine alloggiati alla Questura | art. 109 TULPS | raccogliere i dati documento di ogni ospite, generare il tracciato, inviarlo al web service entro le 24 ore dall'arrivo (termine più stretto per i soggiorni brevissimi), archiviare la ricevuta. Credenziali e certificato per tenant |
| **Tassa di soggiorno** | D.Lgs. 23/2011 art. 4 + regolamento del singolo comune | calcolare per persona/notte con le esenzioni comunali (età, durata massima, categorie), addebitarla come riga separata, produrre il prospetto periodico da versare al comune. Il gestore è responsabile d'imposta: l'errore lo paga lui |
| **CIN** (Codice Identificativo Nazionale) + CIR regionale | DL 145/2023 art. 13-ter, banca dati del Ministero del Turismo | conservarlo nei dati struttura, esporlo sulla pagina pubblica e nei documenti. Nessuna integrazione: è un campo, ma senza il campo l'annuncio è irregolare |
| **Rilevazione ISTAT movimento clienti** | portale regionale (Ross1000, Turismo5, SIRT… cambia per regione) | flusso arrivi/presenze per nazionalità. Una regione pilota con invio automatico, per le altre un export conforme |
| **Documento di vendita** | regime del gestore | impresa: fattura o corrispettivo, IVA alloggio agevolata; attività non imprenditoriale: ricevuta non fiscale, con imposta di bollo oltre la soglia di legge. Il driver fiscale attuale è tarato sullo scontrino del ristorante: la ricevuta è un documento nuovo |
| **Dati personali degli ospiti** | GDPR | documenti d'identità = trattamento delicato: permesso dedicato, minimizzazione, retention con cancellazione automatica, riga in più nel registro dei trattamenti e nell'informativa (`docs/Checklist_Conformita_Privacy_GDPR.docx`) |

Nota di prodotto, non normativa: nell'ordine di importanza percepita da chi compra,
**Alloggiati Web viene prima di qualsiasi funzione di vendita**. È l'adempimento che il
gestore fa ogni sera a mano e che odia.

---

## Fasi

### Fase 1 — Fondamenta (il modulo funziona, solo dal gestionale)

**PR 1.1 — Schema e inventario camere**
Migration con `accommodation_units`, `unit_blocks`, `stays` (incluso l'`EXCLUDE`), RLS,
feature `lodging` in `tenant_features` (+ CHECK aggiornato, + `TENANT_FEATURES` in
`services/entitlements.ts`), permessi `lodging:view` / `lodging:manage` /
`lodging:guests`, `ViewState.CAMERE`. UI: solo l'elenco camere in Impostazioni.

**PR 1.2 — Motore di disponibilità**
`services/lodgingAvailability.ts`: `getAvailability(tenantId, from, to, filtri)`,
`findFreeUnits(...)`, validazione soggiorno (min/max stay, closed-to-arrival/departure,
capienza vs occupanti). Query a numero fisso. Test API dedicati: sovrapposizioni, confine
check-in/check-out, blocchi, opzioni scadute.

**PR 1.3 — Calendario a nastro + CRUD soggiorno**
La vista operativa: righe = camere, colonne = giorni, barre = soggiorni, drag per spostare
e allungare. È l'unico componente davvero nuovo del design system (griglia virtualizzata,
44px di target, colori dalle famiglie di stato). Su mobile non è un nastro: è la lista del
giorno — arrivi, partenze, in casa.

**PR 1.4 — Arrivi, check-in e check-out**
Aggancio alla Reception esistente: la timeline del giorno mostra anche arrivi e partenze
camere. Check-in/check-out cambiano stato, liberano e occupano. Eventi socket `stay:*` e
`unit:*` registrati in `services/eventRegistry.ts` (altrimenti la CI li rifiuta).

### Fase 2 — Prezzi e incassi

**PR 2.1 — Listini e preventivo**
`rate_plans` + `rate_prices`, funzione `quoteStay(...)` pura e testabile: notti ×
occupazione, extra letto, fasce bambini, sconti per soggiorno lungo. Ogni prezzo mostrato
altrove passa da qui, mai ricalcolato in UI.

**PR 2.2 — Caparra e saldo**
`payment_requests` prende `stay_id` accanto a `reservation_id` (nullable, vincolo: uno dei
due). Policy caparra per rate plan (percentuale o prima notte), link inviato via
WhatsApp/email con i template esistenti, riconciliazione dal webhook già in piedi.

**PR 2.3 — Conto del soggiorno e documento**
`stay_charges` come conto: notti, colazioni, tassa di soggiorno, extra. **Addebito in
camera**: dal conto tavolo (`table_bills`) si sposta il totale su un soggiorno aperto —
questa è la funzione che giustifica l'intero modulo per l'ibrido. Emissione: fattura via
`fiscalService`, ricevuta non fiscale come documento nuovo (riusa `utils/printDocument.ts`
e i token `--ds-print-*`, da restare in `PRINT_TOKENS_CSS`).

### Fase 3 — Canale diretto

**PR 3.1 — Pagina pubblica camere**
`public/camere.html` sullo stampo di `prenota.html`: un file, niente React, token
`--ds-public-*` ricopiati a mano (trappola nota, documentata in CLAUDE.md). Route
`/public/lodging/*` doppie (`/public/...` e `/public/:slug/...`) via `withPublicTenant`,
rate limiter per tenant, honeypot. Default sicuro: se il bootstrap fallisce, la pagina
resta in manutenzione.

**PR 3.2 — iCal import/export**
Export di un feed per camera (token in URL) e import dei blocchi da Booking/Airbnb in
`unit_blocks`. Sync periodico dallo scheduler già protetto da advisory lock. Non risolve
l'overbooking entro la finestra di polling: va detto al cliente, non nascosto.

**PR 3.3 — Sofia e WhatsApp**
Estensione di `services/bookingTools.ts` con disponibilità e prenotazione camere. Arriva
dopo 1.2 e 3.1 perché deve dire al telefono *le stesse cose* che la pagina pubblica dice
allo schermo: una sola fonte di verità sulla disponibilità, come già vale per
`getCappedRoomIds` fra `/public/rooms` e il submit.

### Fase 4 — Adempimenti (prima del primo cliente pagante)

**PR 4.1 — Schedine ospiti**
`stay_guests`, form di censimento rapido (l'operatore lo compila col documento in mano, al
banco: pochi campi, tastiera giusta, nessuna schermata di troppo), permesso
`lodging:guests` separato, retention configurata e cancellazione automatica, aggiornamento
dell'informativa privacy.

**PR 4.2 — Invio ad Alloggiati Web**
Generazione del tracciato, invio al web service, archiviazione della ricevuta, stato per
soggiorno, coda con retry e allarme se una schedina resta non inviata oltre il termine.
Credenziali per tenant in `integration_settings` (pattern già esistente). Da collaudare
sull'ambiente di test del servizio prima della produzione, come è stato fatto per il
fiscale (`scripts/collaudo-fiscale.mjs` è il precedente).

**PR 4.3 — Tassa di soggiorno**
`city_tax_rules`, calcolo automatico come riga `CITY_TAX` alla creazione del soggiorno,
esenzioni per età e durata, prospetto periodico esportabile per il comune.

**PR 4.4 — ISTAT regione pilota + CIN/CIR**
Campi CIN/CIR nei dati struttura (stesso giro in quattro punti dei campi `legal_config`,
vedi CLAUDE.md) ed esposizione sulla pagina pubblica. Invio ISTAT automatico per una sola
regione, export conforme per le altre.

### Fase 5 — OTA (decisione strategica, non solo tecnica)

La connettività diretta con Booking.com richiede certificazione e un impegno di
manutenzione continuo; Airbnb idem. Costruirla è un prodotto a sé, non un PR. Tre strade,
in ordine di preferenza:

1. **Partnership con un channel manager** (Octorate, Krossbooking e simili espongono API):
   noi restiamo il sistema del gestore, loro fanno i canali.
2. **iCal e basta**, dichiarando il limite: va bene per chi ha poche camere e vende
   soprattutto diretto.
3. Connettività diretta: solo con volumi che oggi non abbiamo.

---

## Ordine di esecuzione

```
1.1 → 1.2 → 1.3 → 1.4
            └→ 2.1 → 2.2, 2.3 (parallele)
                  └→ 3.1 → 3.2, 3.3 (parallele)
4.1 → 4.2, 4.3, 4.4 (parallele)   ← può partire in parallelo alla Fase 2
                                     dopo 1.4; deve chiudersi prima della vendita
5 → dopo il primo cliente reale
```

Il percorso critico è `1.2` (motore) e `1.3` (nastro). Se il motore è giusto, il resto è
lavoro conosciuto; se è sbagliato, ogni PR successivo paga il debito.

---

## Stima

Unità di misura: «asporto» = l'intero modulo take-away già consegnato (fondamenta +
gestione + pagina pubblica + conto), che è il riferimento più onesto che abbiamo.

| Fase | Dimensione | Nota |
|---|---|---|
| 1 — Fondamenta | ~2 asporti | il motore di disponibilità e il nastro non hanno precedenti nel repo |
| 2 — Prezzi e incassi | ~1 asporto | il tariffario è più lavoro di quanto sembri; gli incassi sono riuso |
| 3 — Canale diretto | ~1 asporto | `prenota.html` è un modello quasi completo; iCal è piccolo |
| 4 — Adempimenti | ~1,5 asporti | poco codice, molta verifica: collaudo, casi limite, un gestore vero che lo usi |
| 5 — OTA | non stimabile come sviluppo | è una decisione di partnership |

In tempo: **quattro-sei mesi di lavoro continuativo** per qualcosa che si può vendere a un
cliente che non sia il pilota. Non quattro-sei settimane.

---

## Rischi

1. **Riusare `reservations`.** È la scorciatoia che si ripresenterà a ogni PR di Fase 1 e
   che va rifiutata ogni volta: vincolo di sovrapposizione perso, presenze sbagliate,
   disponibilità O(giorni).
2. **Confondere camere e sale.** `rooms` è già occupato; un `room_id` ambiguo dentro 36k
   righe di `server.ts` non si recupera più.
3. **Adempimenti sottostimati.** È il rischio che trasforma un modulo funzionante in uno
   invendibile. Mitigazione: Fase 4 pianificata prima della vendita e collaudata su
   ambiente di test.
4. **Overbooking da OTA.** Con il solo iCal esiste una finestra di sincronizzazione.
   Dichiararla nel materiale commerciale; l'alternativa è la Fase 5.
5. **Dati documento.** Categoria di dati che oggi il sistema non tratta. Permesso
   dedicato, retention, informativa: non è burocrazia, è la cosa che un'ispezione guarda.
6. **Nessun pilota.** Il Frantoio non porta camere: senza un gestore reale che usi il
   modulo ogni giorno durante la Fase 1, si costruisce a memoria. Trovare il pilota è un
   prerequisito, non un dettaglio commerciale.

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
  `public/camere.html` ricopia i token a mano.
- **Lettura difensiva dei campi nuovi** sul frontend: fra il deploy del backend e quello
  del frontend c'è sempre una finestra, e `npm run dev` è quella finestra in permanenza.
- `npx tsc --noEmit` dopo ogni modifica, `npx vite build` prima del commit.

---

## Da decidere prima di iniziare

1. **Il pilota**: chi è la struttura reale che usa la Fase 1 durante lo sviluppo?
2. **Regione** della Fase 4.4 — determina quale portale ISTAT si integra per primo.
3. **Regime fiscale** dei primi clienti (impresa o attività non imprenditoriale): decide
   quale documento di vendita si implementa per primo in 2.3.
4. **OTA**: si vende «diretto + iCal» o si cerca la partnership prima del lancio?
5. **Prezzo dell'add-on**: il posizionamento ibrido regge un prezzo sopra i verticali puri
   solo se l'addebito in camera e Sofia sono nel racconto fin dal primo giorno.
