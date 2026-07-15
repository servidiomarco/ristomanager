# Voice Agent Reservations — Piano di Integrazione ElevenLabs

## Premessa: stack

Il progetto è **Express.js** (non Next.js). Esiste già il pattern `/webhook/vonage-*`
in `server.ts` per WhatsApp inbound, e la helper `processWhatsAppBooking` che
parsifica un messaggio testuale e crea una prenotazione. Riutilizziamo lo stesso
pattern per ElevenLabs: nuovi endpoint `/webhook/elevenlabs/*` sullo stesso
server Express. Niente Next.js separato — ridurrebbe solo la coesione.

## Flusso end-to-end

Carrier scelto: **Vonage** (lo stesso provider già usato per WhatsApp inbound),
collegato a ElevenLabs via **SIP trunk**. Niente Twilio in produzione — riduce
fornitori e fatturazione, e i numeri italiani su Vonage sono più economici.

```
PSTN call
    │
    ▼
Numero Vonage (DID italiano)
    │
    ▼  SIP/RTP outbound trunk
Endpoint SIP ElevenLabs (sip:<agent-id>@sip.elevenlabs.io)
    │
    ▼
Agent ElevenLabs (it-IT, voce italiana)
    │  ── tool calls HTTPS ──>  Express /webhook/elevenlabs/*
    │                                │
    │                                ▼
    │                          PostgreSQL (reservations)
    │                                │
    │                                ▼
    │                          Socket.IO broadcast → dashboard live
    │
    ▼
Conferma vocale al cliente
    │
    ▼
Post-call webhook (transcript + summary)
    │
    ▼
Conferma WhatsApp via Vonage (path esistente)
```

### Perché SIP trunk e non WebSocket bridge

Vonage Voice API offre anche un percorso "WebSocket connect" (NCCO `connect`
verso un endpoint custom che fa da bridge audio). È più flessibile ma:

- richiede un servizio sempre attivo che fa proxy dell'audio bidirezionale,
- aggiunge un hop di rete e quindi latenza (peggiora la conversazione),
- raddoppia i punti di rottura (Vonage ↔ bridge ↔ ElevenLabs).

Il SIP trunk va da carrier direttamente a ElevenLabs senza nostro codice nel
percorso media: latenza minima, niente infra da operare.

## Tools esposti all'agent

| Tool | Parametri | Risposta | Uso |
|------|-----------|----------|-----|
| `check_availability` | `date`, `shift` (LUNCH/DINNER), `guests` | `{ available, suggested_times[], free_tables_count }` | Quick check prima di proporre ora |
| `create_reservation` | `customer_name`, `phone`, `date`, `time`, `shift`, `guests`, `notes?` | `{ success, reservation_id, confirmation_phrase }` | Crea la prenotazione |
| `lookup_customer` (v2) | `phone` | `{ exists, last_visit?, preferences? }` | Personalizzazione ("bentornato Mario") |
| `cancel_reservation` (v2) | `phone`, `date` | `{ cancelled, reservation_id }` | Self-service cancellazione |

Le definizioni tool si configurano nel dashboard ElevenLabs (JSON schema +
endpoint URL + secret).

## Configurazione agent ElevenLabs

- **Persona**: "Assistente del Ristorante <Nome>"
- **Lingua**: it-IT, voce italiana naturale (es. "Bella" o voice cloning di staff)
- **System prompt** (sintesi):
  - Saluta, identifica scopo (prenotazione/info/altro)
  - Per prenotazione: chiedi nome → numero ospiti → data → fascia oraria
  - Conferma sempre data+ora ad alta voce prima di chiamare `create_reservation`
  - Chiudi con riepilogo + "ti arriverà conferma su WhatsApp"
  - Se `check_availability` ritorna `available=false`, proponi `suggested_times[]`
- **Inbound phone**: numero Vonage italiano, instradato via SIP trunk verso
  ElevenLabs (vedi sezione "Setup SIP trunk Vonage → ElevenLabs")
- **Post-call webhook**: enabled, punta a `/webhook/elevenlabs/post-call`

### Regole prenotazione (da incollare nel system prompt ElevenLabs)

Testo canonico. Aggiornare qui *e* sulla dashboard ElevenLabs quando cambiano
gli orari o le eccezioni stagionali — la dashboard è la sorgente in produzione,
questo doc è il riferimento locale per non perdere il testo.

```
REGOLE PRENOTAZIONE

1) Turni e orari di apertura
   Il ristorante è aperto sia a pranzo sia a cena, tutti i giorni.
   - Turno pranzo (LUNCH): ultimo orario prenotabile 14:00.
   - Turno cena (DINNER): ultimo orario prenotabile 22:30.
     Eccezioni con orario esteso a 23:00:
       • tutti i giorni del mese di Agosto
       • Venerdì, Sabato e Domenica del mese di Luglio
   La sorgente di verità sui posti è check_availability: chiamalo
   sempre prima di dire "no" o proporre alternative. Se il cliente
   chiede un orario oltre l'ultimo slot del turno, spiega
   cortesemente qual è l'ultimo orario prenotabile e proponilo.
   Non chiamare create_reservation con orari oltre l'ultimo slot.

2) Prenotazioni con poco preavviso (anche pochi minuti)
   Il ristorante accetta prenotazioni anche per lo stesso momento
   della chiamata, purché ci sia disponibilità. Esempi validi:
   sono le 12:45 e il cliente vuole un tavolo per le 13:00; sono
   le 20:15 e vuole prenotare per le 20:30; sono le 13:30 e vuole
   arrivare "tra 10 minuti".
   - Chiama SEMPRE check_availability con la data di oggi e il
     turno corretto (LUNCH per orari 11:00-17:00, DINNER per il
     resto).
   - Se il tool restituisce disponibile, procedi con la conferma
     normale e chiama create_reservation.
   - Non usare mai frasi tipo "è troppo tardi", "serve più
     preavviso", "abbiamo bisogno di più tempo": la disponibilità
     la decide il tool, non tu.
   - Se check_availability restituisce indisponibile, proponi gli
     orari alternativi in suggested_times[].

3) Richieste particolari (es. torte / dolci portati da casa)
   - Non forniamo un servizio di pasticceria interna.
   - Il cliente può portare la torta da fuori, purché fornita di
     scontrino della pasticceria (obbligatorio).
   - Formula suggerita: "Mi dispiace, non offriamo il servizio di
     pasticceria, ma potete tranquillamente portare la torta da fuori:
     l'unica cosa che vi chiediamo è di portare anche lo scontrino
     della pasticceria."

4) Menu
   - Il menu è alla carta ed è visibile sulla nostra pagina Instagram.
   - Eccezione: il 15 Agosto il menu è fisso (comunicare al cliente
     che quel giorno non è alla carta).
   - Se il cliente chiede il menu, indirizzalo alla pagina Instagram
     del ristorante; se prenota per il 15 Agosto, anticipa che quel
     giorno il menu è fisso.

5) Numero di telefono (auto-capture da caller ID)
   - NON chiedere il numero al cliente all'inizio: usa la system
     variable {{system__caller_id}}, che contiene il numero da cui
     sta chiamando (letto dal SIP From: header).
   - Per il readback al cliente NON spellare i numeri autonomamente:
     il modello alluvina spesso le cifre (es. Luigi Noviello: agente
     ha letto "335…" invece di "347…"). Usa il campo
     `caller_id_spelled` restituito da `lookup_customer` — già
     formattato in italiano parlato ("più tre-nove, tre-quattro-sette,
     sette-otto-tre, sette-sei-otto-nove") — e leggilo TESTUALMENTE:
       "Confermo il numero: {{caller_id_spelled}}. È corretto?"
   - Se il cliente conferma → passa {{system__caller_id}} come `phone`
     alla tool call.
   - Se il cliente dice che è sbagliato o chiede di essere richiamato
     su un altro numero → chiedi il numero corretto, poi ripetilo
     TESTUALMENTE lettera per lettera come lo hai sentito (una sola
     cifra alla volta) e chiedi conferma finale. Passa quel numero
     come `phone`.
   - Se {{system__caller_id}} è vuoto (chiamante anonimo/CLIR):
     `caller_id_spelled` sarà vuoto → chiedi:
     "Non riesco a vedere il suo numero, me lo può dettare?"
     Poi ripetilo cifra per cifra e conferma.
   - Includi sempre anche `caller_id: {{system__caller_id}}` come
     parametro separato: il backend lo usa come fallback se `phone`
     è vuoto (belt-and-suspenders — vedi note server-side sotto).

6) Gestione errori tool call
   - Le tool `check_availability`, `create_reservation` e
     `cancel_reservation` rispondono SEMPRE con HTTP 200 quando la
     causa è azionabile dal cliente (data/orario/turno/ospiti/nome/
     telefono non validi, slot non nella griglia). Il body ha forma:
       - `create_reservation` / `cancel_reservation`:
         `{ success: false, error: "invalid_...", message: "..." }`
       - `check_availability`:
         `{ available: false, free_tables_count: 0, error: "invalid_...", message: "..." }`
   - Devi leggere il campo `message` al cliente TESTUALMENTE, senza
     paraphrasare e senza dire "problema tecnico". Il `message` è già
     scritto in italiano naturale per essere pronunciato ad alta voce
     e contiene le informazioni utili al cliente (es. gli slot
     disponibili, o il fatto che quella zona è al completo).
   - Esempio: se create_reservation risponde
     `{ success: false, error: "invalid_slot", message: "Per la cena
     possiamo prenotare solo alle 19:30, 20:00, 20:30, 21:00, 21:30,
     22:00, 22:30, 23:00. Quale orario preferisce?" }`, l'agente deve
     leggere esattamente quella frase e attendere la scelta del cliente,
     poi richiamare create_reservation con il nuovo orario.
   - Solo per HTTP 5xx (errore server reale) o HTTP 503
     (`voice_agent_disabled`) usa il `message` di quella risposta o,
     se assente, la formula generica: "Si è verificato un problema
     tecnico, posso richiamarla a breve?"
   - Non chiudere mai la conversazione con "la richiameremo per
     confermare" se non è stato create_reservation di successo
     (`success: true` + `reservation_id`): senza reservation_id in DB,
     la promessa è vuota e il tavolo resta libero.

7) Interpretazione date e giorni della settimana
   Gli LLM sbagliano regolarmente l'aritmetica giorno↔data (es.
   dicono "venerdì 11 luglio" quando venerdì è il 10). Non calcolare
   mai la data assoluta da solo: delega al backend.
   - Se il cliente dice un riferimento relativo — "oggi", "stasera",
     "domani", "dopodomani", "venerdì", "sabato prossimo",
     "domenica che viene" — passa la parola così com'è al tool nel
     campo `date` (es. `date: "venerdì"`, `date: "domani"`). Il
     backend converte in data ISO usando l'ora Europe/Rome corrente.
   - Se il cliente dice una data esplicita ("il 15 agosto",
     "quindici agosto", "15/08/2026") passala così com'è: il parser
     accetta entrambe le forme.
   - PROIBITO inventare la data assoluta a partire dal giorno della
     settimana. Non dire mai "venerdì 11 luglio" prima di aver
     ricevuto la risposta del tool.
   - Le risposte di `check_availability` e `create_reservation`
     contengono un campo `date_readback` calcolato dal server (es.
     `"venerdì 10 luglio"`). USALO SEMPRE VERBATIM quando confermi
     la data al cliente. Non ricostruire tu il giorno della settimana
     dalla data ISO — è esattamente lì che l'LLM fallisce.
   - Esempio di flusso corretto:
     - Cliente: "Vorrei prenotare per venerdì sera, 10 persone alle 20:30".
     - Tool call: `check_availability({ date: "venerdì", shift: "DINNER", guests: 10 })`.
     - Risposta: `{ available: true, ..., date_readback: "venerdì 10 luglio" }`.
     - Agente: "Ottimo, abbiamo disponibilità per venerdì 10 luglio alle 20:30…".
```

### Note server-side (auto-capture telefono)

Gli endpoint `/webhook/elevenlabs/create-reservation` e
`/webhook/elevenlabs/cancel-reservation` accettano due parametri
telefono:

- `phone`: quello che il cliente ha dettato o confermato a voce.
  Ha la precedenza.
- `caller_id`: il numero letto dal SIP header dell'inbound call.
  Usato come fallback quando `phone` è vuoto.

La sorgente effettivamente usata è loggata come `phone_source`
(`customer` | `caller_id` | `none`) per facilitare il debug quando
un booking arriva senza numero. La normalizzazione E.164
(`normalizeItalianPhone`) resta invariata: prepende `+39` alle
numerazioni nazionali senza prefisso e gestisce le varianti `00`,
`39…`, `+…`.

## Sicurezza webhook

ElevenLabs firma il body con HMAC-SHA256 (header `ElevenLabs-Signature`, formato
Stripe-style: `t=<unix_ts>,v0=<hex_digest>`).

Middleware Express: `services/elevenlabsService.ts → verifyElevenLabsSignature(req)`
- Calcola `HMAC_SHA256(secret, "<t>." + raw_body)`
- Confronta con `v0=` (timing-safe compare)
- Rigetta se `|now - t| > 300s`
- Rigetta se mismatch
- Risponde 401 senza dettagli

Variabile env: `ELEVENLABS_WEBHOOK_SECRET`.

## Modifiche backend

### Nuovo file: `services/elevenlabsService.ts`
```ts
export function verifyElevenLabsSignature(req): boolean
export async function findAvailability(date, shift, guests): { available, suggested_times[] }
export async function createVoiceReservation(input): Reservation
export function formatItalianConfirmation(r: Reservation): string
```

### Nuove route in `server.ts` (sezione "ELEVENLABS WEBHOOKS", sopra le route protette)
```ts
app.post('/webhook/elevenlabs/check-availability', rawBody, async (req, res) => {
  if (!verifyElevenLabsSignature(req)) return res.status(401).send();
  const { date, shift, guests } = req.body.parameters;
  const result = await findAvailability(date, shift, guests);
  res.json(result);
});

app.post('/webhook/elevenlabs/create-reservation', rawBody, async (req, res) => {
  if (!verifyElevenLabsSignature(req)) return res.status(401).send();
  const r = await createVoiceReservation(req.body.parameters);
  socketService?.broadcastReservationCreated(r);
  LogService.logActivity(null, 'voice-agent@elevenlabs', 'Agent vocale',
    ActivityAction.CREATE, ResourceType.RESERVATION, r.id, r.customer_name,
    { source: 'VOICE', conversation_id: req.body.conversation_id });
  res.json({ success: true, reservation_id: r.id, confirmation_phrase: formatItalianConfirmation(r) });
});

app.post('/webhook/elevenlabs/post-call', rawBody, async (req, res) => {
  if (!verifyElevenLabsSignature(req)) return res.status(401).send();
  // body: { conversation_id, transcript, summary, status, duration_seconds }
  // Persisti transcript per audit (tabella opzionale voice_calls), poi:
  // se ha reservation_id legata → manda WhatsApp via sendVonageWhatsApp(phone, recap)
  res.status(200).send();
});
```

### Migration in `db.ts`
```sql
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'MANUAL';

-- Opzionale ma consigliato: tabella per audit chiamate
CREATE TABLE IF NOT EXISTS voice_calls (
    id SERIAL PRIMARY KEY,
    conversation_id VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(50),
    duration_seconds INTEGER,
    transcript TEXT,
    summary TEXT,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

### Type update (`types.ts`)
```ts
export enum ReservationSource {
  MANUAL = 'MANUAL',
  WHATSAPP = 'WHATSAPP',
  VOICE = 'VOICE'
}
// aggiungi a Reservation: source?: ReservationSource;
```

### UI hints (post-MVP, non nel v1)
- Dashboard: badge "X prenotazioni telefoniche oggi"
- ReservationList: icona telefono accanto alle voice-created
- Activity log: filtro per `user_email = 'voice-agent@elevenlabs'`

## Variabili d'ambiente nuove

```env
ELEVENLABS_WEBHOOK_SECRET=<shared secret per HMAC>
ELEVENLABS_AGENT_ID=<id agent, solo logging/tracing>
# ELEVENLABS_API_KEY  ← solo se gestiamo agent da codice (non necessario v1)
```

## Rischi e mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| Latenza tool call (~500-1500ms) blocca conversazione | Tutti gli handler <300ms: query DB con indice, niente HTTP esterno sincrono |
| Race condition: due chiamate prenotano stesso tavolo | Transaction + advisory lock su (date, shift, table_id), o gestione ottimistica con retry |
| Hallucination data/ora | System prompt obbliga riconferma vocale prima di `create_reservation` |
| Telefono non normalizzato | Helper `normalizeItalianPhone(s)` → forza `+39` |
| GDPR (transcript) | Retention policy: cancellazione transcript dopo 90 giorni; consenso vocale "questa chiamata viene registrata" |
| Costo agent fuori controllo | Cap mensile sul dashboard ElevenLabs; alert se >€100 |

## Roll-out per fasi

| Fase | Scope | Acceptance criteria |
|------|-------|---------------------|
| **1 — Read-only** | Solo `check_availability`. Agent risponde "Le richiamiamo per confermare" | Nessuna prenotazione auto-creata. Misuriamo accuratezza parsing date. |
| **2 — Booking con review** | Abilita `create_reservation`, ma con flag `requires_review=true` (badge giallo nel CRM) | Staff approva manualmente entro 1h. Misuriamo % corrette. |
| **3 — Full auto** | Rimuovi review quando accuratezza >95% su 100 chiamate consecutive | Conferme WhatsApp partono direttamente. |

## Costo stimato

- ElevenLabs Conversational AI: ~$0.10-0.15/min (voce italiana)
- Vonage DID italiano: ~€1.50/mese + inbound ~€0.008/min
- 100 chiamate/mese × 4 min ≈ 400 min × $0.16 ≈ **€60/mese + Vonage ≈ €5**

Break-even vs personale telefonico: ovviamente sì.

## Deliverables (in ordine di PR consigliato)

**Track A — Operativo (parallelo al codice)**
- A1. Aprire ticket porting del numero esistente del ristorante verso Vonage
  (richiede LOA + ultima bolletta dell'operatore attuale).
- A2. Nel frattempo, acquistare un numero Vonage italiano temporaneo per dev/test (~€1.50/mese).
- A3. Creare account/agent ElevenLabs, configurare voce standard italiana.
- A4. Su ElevenLabs Conversational AI, ricavare l'endpoint SIP dell'agent
  (`sip:<agent-id>@sip.elevenlabs.io`) e abilitare l'inbound SIP.
- A5. Su Vonage: creare un SIP trunk verso quell'endpoint e legare il DID al trunk.

**Track B — Codice**
1. **PR #1 — Schema + service** (`db.ts`, `types.ts`, `services/elevenlabsService.ts`)
   con HMAC verify + helpers, senza endpoint vivi. **(già fatto)**
2. **PR #2 — `check_availability` endpoint** (Phase 1, read-only). Test con DID Vonage temporaneo via SIP trunk.
3. **PR #3 — `create_reservation` + post-call webhook + WhatsApp recap** (Phase 2, con `requires_review`).
4. **PR #4 — Routing fascia oraria di servizio** (vedi sotto: NCCO Vonage o regola di forwarding).
5. **PR #5 — UI badge "VOICE" + filtro nel CRM** (lift `requires_review` quando metriche OK).

## File da creare/modificare

| File | Azione |
|------|--------|
| `services/elevenlabsService.ts` | **NUOVO** (già scaffoldato) |
| `server.ts` | Aggiungere sezione endpoint `/webhook/elevenlabs/*` |
| `db.ts` | Aggiungere migration `source` + tabella `voice_calls` (già fatto) |
| `types.ts` | Aggiungere `ReservationSource` enum + campo su `Reservation` (già fatto) |
| `.env` | 2 nuove vars |
| `docs/voice-agent-setup.md` | **NUOVO** — istruzioni operative (Vonage SIP + ElevenLabs dashboard) |

## Decisioni prese

1. **Carrier**: **Vonage**, lo stesso provider già usato per WhatsApp. Porting del numero esistente del ristorante verso Vonage. Lead time 2-4 settimane in Italia, va avviato per primo.
2. **Bridge**: **SIP trunk** Vonage → ElevenLabs (no WebSocket bridge — vedi sezione "Perché SIP trunk").
3. **Voce**: standard italiana ElevenLabs (no voice-cloning).
4. **Scope**: solo prenotazioni. Niente FAQ/knowledge base nella v1.
5. **Conferma**: WhatsApp automatica post-call (riutilizza `sendVonageWhatsApp`).
6. **Orari attivi**: solo **fuori orario di servizio**. Durante il servizio le chiamate vanno alla sala come oggi.

### Implicazioni delle decisioni

**Routing orari di servizio (decisione 6)**

Con Vonage il routing orario può essere fatto in due modi:

a) **NCCO dinamico** (richiede un nostro endpoint webhook `answer_url`):
   ```
   Chiamata in entrata sul DID Vonage
     │
     ▼
   Vonage POST a /webhook/vonage-voice/answer
     │
     ├── ora corrente in [12:00-15:00] OR [19:00-23:00] (Europe/Rome)?
     │   ├── SÌ → NCCO `connect` al cellulare/fisso del ristorante
     │   └── NO → NCCO `connect` al SIP URI di ElevenLabs
   ```
   Implementazione: nuovo endpoint Express `/webhook/vonage-voice/answer` che
   risponde con JSON NCCO. Logica oraria in TypeScript, timezone Europe/Rome,
   orari come costante (futuro: tabella `restaurant_hours`).

b) **Time-based routing nativo Vonage**: se la console offre regole di forwarding
   per fascia oraria si può fare zero-code. Da verificare nel piano contrattato —
   storicamente Vonage non lo offre per i DID standard, quindi (a) è la default.

**Porting (decisione 1)**

Va avviato **prima del coding** end-to-end: serve il numero attivo su Vonage
per testare con il vero traffico. Step paralleli al lavoro tecnico:
- Aprire ticket porting con Vonage (LOA firmata, ultima bolletta operatore attuale)
- Verificare che l'operatore attuale non abbia clausole anti-porting
- Durante il porting, tenere temporaneamente un DID Vonage italiano nuovo per dev/test

## Setup SIP trunk Vonage → ElevenLabs

Operazioni nella console Vonage (Voice → SIP trunks):

1. Creare un **outbound SIP trunk** con:
   - URI: `sip:+<DID>@sip.rtc.elevenlabs.io:5060;transport=tcp`
     (es. `sip:+447451263812@sip.rtc.elevenlabs.io:5060;transport=tcp`)
   - Codec: G.711 µ-law / A-law (default ElevenLabs)
   - Auth: nessuna se l'inbound trunk ElevenLabs ha "Allowed IPs = any" e
     "Authentication = none" (default), altrimenti credenziali digest.
2. Sul DID italiano: routing → "Forward inbound calls via SIP trunk →
   <nome trunk>" (oppure NCCO `connect.endpoint.type=sip`).
3. Test: chiamare il DID → deve atterrare sull'agent ElevenLabs entro 2-3 secondi.
4. Verificare in ElevenLabs Conversational AI → Calls che la chiamata appaia,
   con caller_id valorizzato (numero del chiamante).

> **Gotcha SIP URI (verificato 2026-05-29 con DID `+447451263812`).**
> Sia il DID come *user part* sia `;transport=tcp` sono obbligatori.
> - Senza user part (`sip:sip.rtc.elevenlabs.io:5060`) ElevenLabs non sa
>   verso quale agent instradare e Vonage riporta solo "Internal error occurred".
> - Senza `;transport=tcp` Vonage manda UDP, che l'inbound trunk ElevenLabs
>   non accetta — i server pubblicizzati sono `:5060;transport=tcp` e
>   `:5061;transport=tls`.
> In alternativa al TCP, usare TLS: `sip:+<DID>@sip.rtc.elevenlabs.io:5061;transport=tls`
> (richiede TLS attivo sul trunk Vonage — vedi link "How to enable TLS and custom ports"
> nella dialog di configurazione del numero).

Lato ElevenLabs (Conversational AI → Numeri di telefono → Importa numero → SIP Trunk):
- **Numero**: `+<DID>` in formato E.164.
- **Agente assegnato**: quello che deve rispondere (es. `agent_5401kq7cjqa8evzbvwpbeghefm6w`).
- **Inbound trunk → Crittografia dei Media**: `Allowed (Default)`.
- **Inbound trunk → Indirizzi Consentiti**: `Tutti gli indirizzi` (oppure
  IP egress Vonage se si vuole stringere).
- **Inbound trunk → Autenticazione**: non configurata (oppure digest se
  configurato anche su Vonage).
- **Tool** dell'agent: URL `/webhook/elevenlabs/*` su Railway + header con il
  secret HMAC (`ELEVENLABS_WEBHOOK_SECRET`).
- **Post-call webhook**: `https://<host>/webhook/elevenlabs/post-call`.

**WhatsApp post-call (decisione 4)**

Nel post-call webhook handler, se la chiamata ha prodotto una `reservation_id`,
fire-and-forget:
```ts
sendVonageWhatsApp(phone, formatItalianRecap(reservation))
```
Niente conferma vocale richiesta dal cliente — è automatica per tutti.
