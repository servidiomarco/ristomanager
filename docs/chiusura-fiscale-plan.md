# Chiusura fiscale dal CRM — piano

*6 settembre 2026 — bozza da discutere, prima di scrivere codice.*

Oggi la giornata fiscale si chiude **sul registratore**: qualcuno va alla cassa e
lancia la chiusura giornaliera (la "Z"), che stampa il riepilogo, azzera i
totalizzatori e trasmette i corrispettivi all'Agenzia. Il CRM ha già il riscontro
serale (Pagamenti → Chiusura, `GET /reports/cash-closure`) e il cassetto (sessione di
cassa in Cassa), ma l'atto fiscale resta fuori.

Obiettivo: **chiudere la giornata fiscale da dentro il CRM**, con il riscontro
CRM ↔ registratore nella stessa schermata, e un registro delle chiusure.

**Non è la chiusura del cassetto.** `cash_sessions` (fondo, contato, differenza) è per
servizio e riguarda il denaro fisico; la chiusura fiscale è per **giornata** e riguarda
i corrispettivi trasmessi. Restano due atti separati, su due superfici che si linkano.

---

## 1. Cosa significa "chiusura fiscale" per ogni binario

Il significato dipende dal provider fiscale del tenant (`FISCAL_PROVIDERS` in
`server.ts`), e il piano copre tutti e tre i casi con la stessa superficie:

| Provider | Chi trasmette | La chiusura dal CRM è… |
|---|---|---|
| `rt-local` (Epson FP-81II via print agent) | l'RT, con la Z giornaliera | **il comando Z vero**, inviato all'RT via agente |
| `openapi` (e-receipts / receipts) | Openapi, documento per documento | **un riscontro registrato**: nessuna Z esiste; si verifica che tutti i documenti del giorno siano CONFIRMED e si fotografa il totale |
| `passepartout` / `external_rt` (il ponte di oggi) | l'RT della cassa Passepartout | **registrazione a posteriori**: la Z si fa in cassa, il CRM chiede numero Z e totale dal tagliando e li mette a registro col delta |

Il caso `rt-local` è il cuore del piano: è l'unico in cui il CRM *esegue* l'atto.
Gli altri due danno comunque il valore vero — il registro unico delle chiusure con il
delta CRM ↔ fiscale, sera per sera, che oggi vive su un foglietto.

### Il comando Z su rt-local

L'agente di stampa parla già il fiscale Epson (`fpmate.cgi`, job `RT_FISCALE`,
`scripts/print-agent.mjs:445`). La Z è lo stesso trasporto con un documento diverso:
`<printerFiscalReport><printZReport …/></printerFiscalReport>`.

Da verificare **sul firmware reale**, come fu per il tag lotteria:

- cosa torna nella risposta (`zRepNumber` sì; il totale giornaliero forse no — in tal
  caso il totale RT si inserisce a mano dal tagliando, come nel caso ponte);
- il timeout: la Z stampa un rapporto lungo e trasmette — i 10s del job scontrino
  probabilmente non bastano, il job Z ne chiede di più;
- l'eventuale lettura X (`printXReport`, senza azzeramento) come anteprima — utile ma
  non necessaria all'MVP.

**La Z è irreversibile e azzera.** Due Z nello stesso giorno producono la seconda a
zero: il server rifiuta con 409 se esiste già una chiusura CONFIRMED per la data
(niente flag di forzatura in MVP — il caso raro si gestisce dall'RT).

---

## 2. Schema

Una migration. `createSchema()` è congelato.

```sql
CREATE TABLE fiscal_closures (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            BIGINT NOT NULL,
    closure_date         DATE NOT NULL,           -- giornata fiscale (Europe/Rome)
    provider             VARCHAR(20) NOT NULL,    -- rt-local | openapi | external_rt
    status               VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
    zrep_number          VARCHAR(20),             -- dalla risposta RT o dal tagliando
    rt_total_cents       INTEGER,                 -- totale del rapporto Z (se noto)
    crm_docs_count       INTEGER NOT NULL,
    crm_total_cents      INTEGER NOT NULL,        -- corrispettivi dei documenti CRM del giorno
    breakdown            JSONB,                   -- per doc_type e per stato, la fotografia
    note                 TEXT,
    requested_by_user_id INTEGER,
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at         TIMESTAMPTZ,
    raw                  JSONB                    -- risposta dell'RT, per il forense
);

CREATE UNIQUE INDEX fiscal_closures_giornata
    ON fiscal_closures (tenant_id, closure_date)
    WHERE status <> 'FAILED';   -- una FAILED non blocca il nuovo tentativo
```

I totali CRM sono **memorizzati**, non ricalcolati: come `difference_cents` della
sessione di cassa, sono la fotografia del momento della firma — uno scontrino emesso
dopo (il tavolo che paga a mezzanotte e mezza) non deve riscrivere un numero già
riscontrato. Il registro vivo resta `GET /reports/cash-closure`, che è calcolato.

`crm_total_cents` conta i documenti **CONFIRMED con corrispettivo**: scontrini e
scontrini di cassa registrati; fuori proforma (non è corrispettivo), note di credito
(a storno), documenti PENDING/FAILED — che però compaiono nel `breakdown` e nella UI
come righe da sistemare *prima* di chiudere.

RLS `tenant_isolation` come ogni tabella nuova (pattern outbox), nella stessa migration.

---

## 3. Route

| Metodo | Route | Permesso |
|---|---|---|
| `GET` | `/fiscal/closure?date=` | `payments:view` |
| `POST` | `/fiscal/closure` `{ date, zrep_number?, rt_total_cents?, note? }` | `cash:close_session` |

`GET` risponde anche a giornata **non chiusa**: la fotografia calcolata (documenti per
stato e tipo, totale, conti senza documento) più l'eventuale riga di chiusura. È quello
che la card mostra prima del bottone.

`POST` si comporta per provider:

- **rt-local** — inserisce la riga PENDING e accoda il job `RT_CHIUSURA` (target
  `rt`, come `RT_FISCALE`). L'ack dell'agente porta la riga a CONFIRMED con
  `zrep_number` (stesso pattern dell'ack che chiude il documento,
  `server.ts:31080`); il nack la porta a FAILED col messaggio. `zrep_number` nel
  body è ignorato: lo dice l'RT.
- **openapi** — nessuna rete: verifica che non ci siano documenti PENDING/FAILED del
  giorno (409 con l'elenco, altrimenti si firma un riscontro bucato), scrive la riga
  CONFIRMED. `zrep_number` non esiste su questo binario.
- **passepartout / external_rt / none** — registrazione manuale: `zrep_number` e
  `rt_total_cents` dal tagliando, riga subito CONFIRMED. È il gemello del bottone
  «Scontrino di cassa» per i documenti: il fatto è successo altrove, il CRM lo mette
  a registro.

Riuso pieno del permesso **`cash:close_session`**: chi può contare il cassetto può
chiudere la giornata — nessun permesso nuovo, quindi nessun giro su matrice + route +
view gate. Se in futuro il titolare vorrà separarli, si estrae allora.

Realtime: `fiscal:closure-updated` sulla rotta di sempre, broadcast a tutti (come le
prenotazioni: l'esito confermato dal server, mai la previsione ottimistica).

**Offline**: la chiusura fiscale è una scrittura che muove lo stato fiscale — vale la
regola della cassa: banner e primario disattivato, mai in coda offline.

---

## 4. Frontend

Nessuna vista nuova: **una card "Chiusura fiscale" in Pagamenti → Chiusura**
(`components/pagamenti/ChiusuraCassa.tsx`), sotto i totali per metodo — la pagina che
già si legge a fine serata, e che ha il perimetro giusto (la giornata, non il turno).

La card, dall'alto:

1. **Lo stato dei documenti del giorno** — confermati (n · €), in emissione, falliti,
   conti senza documento. Le ultime tre righe sono critiche/pending e linkano al
   filtro corrispondente della lista sotto, che esiste già: si sistemano *lì*, poi si
   chiude.
2. **Il bottone** — «Chiudi la giornata fiscale» (rt-local: manda la Z; openapi:
   registra il riscontro) oppure «Registra la chiusura dell'RT» (ponte: campo numero Z
   + totale dal tagliando). Disabilitato con documenti in emissione; con conti senza
   documento avvisa (callout ambra) ma non blocca — come la sessione di cassa.
3. **A chiusura fatta** — la riga a registro: numero Z, totale CRM, totale RT se noto,
   **delta** con la nota. Durante il ponte Passepartout un delta ≠ 0 è normale (il
   battuto fuori CRM): la nota è lì per spiegarlo, obbligatoria se il delta ≠ 0 —
   stessa regola della differenza di cassa.

In Cassa, `FondoEChiusura` (8b) guadagna solo un **rimando**: chiusa la sessione
DINNER, una riga «La giornata fiscale si chiude da Pagamenti → Chiusura» con link.
Niente doppione del bottone: un atto per giornata vive su una superficie sola.

Design system: primitive dal barrel `ds`, copy al minimo, mai maiuscolo, ambra =
pending («chiede un'azione», che qui è vero), critico solo per i falliti.

---

## 5. Piano PR

1. **Migration + route + ack dell'agente** — `fiscal_closures`, `GET`/`POST`,
   job `RT_CHIUSURA` nell'agente, eventi socket. Test API: i tre provider, il 409
   sulla doppia chiusura, il 409 openapi con PENDING vivi, la matrice permessi.
2. **Card in Pagamenti → Chiusura** + rimando in 8b.
3. **Collaudo su RT vero** (LAN ristorante): risposta della Z sul firmware, timeout,
   poi aggiornare l'agente sul PC Windows (`C:\ristomanager-agents\`, procedura
   Invoke-WebRequest di sempre).
4. **`docs/funzionalita-app.md`** — solo dopo il collaudo, in una PR sua (stessa
   scelta di cassa-plan §13: non si annuncia un atto fiscale mai eseguito).

---

## 6. Fuori dal perimetro, apposta

- **Z automatica a orario** (cron o pianificazione dell'RT stesso — molti RT la
  offrono nativa: chiedere al tecnico prima di costruirla nel CRM).
- **Chiusura comandata via AdapterWS a Passepartout**: forse esiste un'operazione nel
  WSDL, ma il ponte è a scadenza — non vale il collaudo.
- **Lettura X come anteprima** e letture dei totalizzatori via directIO.
- **Multi-RT** (un solo registratore in sala).
- **Riscontro automatico coi corrispettivi su Fatture e Corrispettivi** (portale AdE):
  non c'è API pubblica sensata; resta il controllo del commercialista.

---

## 7. Decisioni prese (6/09, con l'utente)

1. **Si parte ora**, per il ponte: il registro col delta serve già stasera. Vincolo
   esplicito: la chiusura **dal registratore Passepartout resta sempre possibile** —
   la via manuale («Registra la chiusura dell'RT») è il percorso normale del ponte,
   non un ripiego, e niente nel CRM la presuppone o la blocca.
2. **`closure_date` = giorno di calendario Europe/Rome**, non `service_date`: è come
   ragionano l'RT e l'Agenzia. Il tavolo di mezzanotte finisce nel giorno in cui il
   suo scontrino è stato battuto.
3. **Nota obbligatoria sul delta** quando il totale RT è noto e il delta ≠ 0; libera
   quando l'RT non riporta il totale.
