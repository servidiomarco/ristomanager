# Voice Agent Reservations — Piano di Integrazione ElevenLabs

## Premessa: stack

Il progetto è **Express.js** (non Next.js). Esiste già il pattern `/webhook/vonage-*`
in `server.ts` per WhatsApp inbound, e la helper `processWhatsAppBooking` che
parsifica un messaggio testuale e crea una prenotazione. Riutilizziamo lo stesso
pattern per ElevenLabs: nuovi endpoint `/webhook/elevenlabs/*` sullo stesso
server Express. Niente Next.js separato — ridurrebbe solo la coesione.

## Flusso end-to-end

```
PSTN call
    │
    ▼
Numero Twilio (importato in ElevenLabs)
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
- **Inbound phone**: numero Twilio importato (Twilio resta il carrier)
- **Post-call webhook**: enabled, punta a `/webhook/elevenlabs/post-call`

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
- Twilio inbound: ~$0.013/min + ~$1/mese numero
- 100 chiamate/mese × 4 min ≈ 400 min × $0.16 ≈ **€60/mese + Twilio ≈ $6**

Break-even vs personale telefonico: ovviamente sì.

## Deliverables (in ordine di PR consigliato)

**Track A — Operativo (parallelo al codice)**
- A1. Avvia porting numero ristorante → Twilio (LOA + bolletta)
- A2. Acquisire numero Twilio italiano temporaneo per dev/test (~$1/mese)
- A3. Creare account/agent ElevenLabs, configurare voce standard italiana

**Track B — Codice**
1. **PR #1 — Schema + service** (`db.ts`, `types.ts`, `services/elevenlabsService.ts`)
   con HMAC verify + helpers, senza endpoint vivi.
2. **PR #2 — `check_availability` endpoint** (Phase 1, read-only). Test con numero Twilio temporaneo.
3. **PR #3 — `create_reservation` + post-call webhook + WhatsApp recap** (Phase 2, con `requires_review`).
4. **PR #4 — Twilio Function routing orario di servizio** (deploy su Twilio Functions, non in questo repo).
5. **PR #5 — UI badge "VOICE" + filtro nel CRM** (lift `requires_review` quando metriche OK).

## File da creare/modificare

| File | Azione |
|------|--------|
| `services/elevenlabsService.ts` | **NUOVO** |
| `server.ts` | Aggiungere sezione endpoint `/webhook/elevenlabs/*` |
| `db.ts` | Aggiungere migration `source` + tabella `voice_calls` |
| `types.ts` | Aggiungere `ReservationSource` enum + campo su `Reservation` |
| `.env` | 2 nuove vars |
| `docs/voice-agent-setup.md` | **NUOVO** — istruzioni operative (Twilio + ElevenLabs dashboard) |

## Decisioni prese

1. **Numero**: porting del numero esistente del ristorante verso Twilio. Lead time 2-4 settimane in Italia, va avviato per primo.
2. **Voce**: standard italiana ElevenLabs (no voice-cloning).
3. **Scope**: solo prenotazioni. Niente FAQ/knowledge base nella v1.
4. **Conferma**: WhatsApp automatica post-call (riutilizza `sendVonageWhatsApp`).
5. **Orari attivi**: solo **fuori orario di servizio**. Durante il servizio le chiamate vanno alla sala come oggi.

### Implicazioni delle decisioni

**Routing orari di servizio (decisione 5)**

Il routing orario va fatto a livello Twilio (TwiML), non ElevenLabs. Logica:

```
Chiamata in entrata su numero portato
  │
  ├── ora corrente in [12:00-15:00] OR [19:00-23:00] (Europe/Rome)?
  │   ├── SÌ → forward al cellulare/fisso del ristorante (come oggi)
  │   └── NO → forward all'agent ElevenLabs
```

Implementazione: Twilio Function (Node) o TwiML Bin che valuta `Date()` con timezone
Europe/Rome e fa `<Dial>` al numero corretto. Gli orari restano configurabili come
costante nella Function — eventualmente li leggiamo da una tabella `restaurant_hours`
in futuro.

**Porting (decisione 1)**

Va avviato **prima del coding**: serve il numero attivo su Twilio per testare end-to-end.
Step paralleli al lavoro tecnico:
- Aprire ticket porting con Twilio (LOA firmata, ultima bolletta operatore attuale)
- Verificare che l'operatore attuale non abbia clausole anti-porting
- Durante il porting, tenere temporaneamente un numero Twilio italiano nuovo per dev/test

**WhatsApp post-call (decisione 4)**

Nel post-call webhook handler, se la chiamata ha prodotto una `reservation_id`,
fire-and-forget:
```ts
sendVonageWhatsApp(phone, formatItalianRecap(reservation))
```
Niente conferma vocale richiesta dal cliente — è automatica per tutti.
