# Piano SaaS multi-tenant — RistoManager

Decisioni prese (agosto 2026):

- **Modello**: multi-tenant condiviso — un backend, un database Postgres, colonna `tenant_id` + Row-Level Security.
- **Scala target**: decine di ristoranti.
- **Add-on a pagamento**: agente vocale, WhatsApp, prenotazioni web. Il core (sala, prenotazioni, comande, pagamenti, magazzino, HACCP, staff) è il piano base.

Vincolo permanente: **il Vecchio Frantoio è in produzione su questo database**. Ogni PR deve essere retro-compatibile e deployabile da solo; il Frantoio diventa il tenant 1 con una migrazione in place, mai con un reimport.

---

## Fase A — Fondamenta (nessun cambio di comportamento)

Prerequisiti non negoziabili prima di toccare 260 route: oggi non c'è né un migration tool né un solo test.

### PR A1 — Migration tool
- Introdurre `node-pg-migrate`. La baseline è lo schema attuale prodotto da `createSchema()` (`db.ts:129-2657`).
- `createSchema()` resta com'è per gli ambienti esistenti ma viene **congelato**: da qui in poi ogni modifica di schema è una migration versionata, non un `ALTER IF NOT EXISTS` in più.
- Spostare fuori dal boot i backfill massivi (`db.ts:1307`, `db.ts:2398`, `db.ts:2556`): a N tenant diventano un costo di avvio insostenibile.

### PR A2 — Rete di sicurezza (test + CI)
- Vitest + supertest contro un Postgres effimero (docker), riusando il pattern di `scripts/dev-comande.sh`.
- Smoke test sulle superfici che il refactor toccherà di più: login/refresh, CRUD prenotazioni, disponibilità pubblica, apertura/chiusura conto, comande.
- GitHub Actions: `npx tsc --noEmit` + `vite build` + test su ogni PR.

### PR A3 — De-hardcoding del brand (~45 punti in 17 file)
- Leggere nome/firma da `legal_config` (esiste già, `server.ts:14157`, ma `voice_business_name` e `app_name` non vengono mai letti): saluti e messaggi voce (`server.ts:771-871`), firme email/SMS/WA (`server.ts:11428-11725`, `4919`), `<title>` email.
- `public/prenota.html`: titolo, link, footer, logo → da endpoint `/public/branding` (nome, logo URL, colori).
- Loghi fuori dall'immagine Docker: `dishes.photo_url` è già base64 in Postgres — stessa via per i loghi tenant (colonna su `tenants` in Fase B; qui si prepara l'endpoint).
- `VoiceAgentWidget.tsx:5`: agent ID ElevenLabs da API, non nel bundle.
- Redirect host `prenotazioni.vecchiofrantoio.com` (`server.ts:170`) → tabella domini (Fase C).
- Ripulire i seed del Frantoio da `createSchema`: sale/location (`db.ts:201-208`), profilo sala con IP stampanti (`db.ts:2604-2620`), orari (`db.ts:1628`), stazioni (`db.ts:2214`) → estratti in funzioni `seedTenantDefaults()` riusate dal provisioning in Fase D.
- Placeholder `*@vecchiofrantoio.*` nelle card SMTP/IMAP; `Salsa Vecchio Frantoio` in `haccpApiService.ts:128`.
- **Nome prodotto**: il nome definitivo della piattaforma non è ancora deciso (non sarà RistoCRM). Centralizzare le occorrenze (`index.html`, `manifest.webmanifest`, sidebar `App.tsx`, `LoginPage.tsx`, seed email owner) in un'unica costante `PLATFORM_NAME`, così il rename futuro è una riga + loghi. Rimandare a nome deciso: dominio pubblico, dominio email mittente, template Meta, account Stripe (servono solo in Fase C/D).

### PR A4 — Turni di servizio configurabili
`LUNCH`/`DINNER` è un CHECK in 8 tabelle (`db.ts:246, 262, 278, 1147, 1172, 1656, 2395, 2555`) e un enum in `types.ts`. Un ristorante con orario continuato o 3 turni oggi non è rappresentabile. Minimo: rimuovere i CHECK e spostare la validazione in applicazione leggendo i turni da `opening_hours`; l'enum resta il default. Farlo ora evita di ri-migrare 8 tabelle dopo.

---

## Fase B — Modello tenant (il cuore del lavoro)

### PR B1 — Tabella `tenants` + colonna ovunque
- `tenants`: `id`, `slug UNIQUE`, `name`, `status` (active/suspended), `plan`, `logo`/branding, `timezone` (default `Europe/Rome`), `created_at`.
- `tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants` su **tutte le tabelle** (il DEFAULT tiene in piedi le INSERT non ancora scopate; cade a fine Fase B con la RLS), indice su ogni tabella. Aggiunta dinamica su `pg_tables`, non un elenco a mano.
- ~~Riscrittura dei vincoli unici globali in compositi~~ **Spostata nei PR di dominio della B3**: molti vincoli sono bersaglio di `ON CONFLICT` nel codice, e cambiarli senza aggiornare le query nello stesso deploy rompe le scritture. Ogni PR B3 riscrive i vincoli del suo dominio insieme alle sue query. I bloccanti censiti nell'audit:
  - `customers` telefono unico → unico per `(tenant_id, digits)` (`db.ts:1243`)
  - `users.email` → **resta unico globale** (deviazione dal piano originale): il login è per sola email, senza discriminatore tenant — con email unica per tenant due utenti omonimi sarebbero indistinguibili al login. Un'email = un account = un ristorante; si rivede solo se servirà il multi-ristorante per persona.
  - `role_permissions` → `(tenant_id, role, permission)` (`db.ts:770`)
  - `app_settings` PK → `(tenant_id, key)`; `integration_settings` PK → `(tenant_id, provider)`
  - `opening_hours` PK → `(tenant_id, weekday)`; `special_closures`, `disabled_slots` idem
  - HACCP `(date, label)` → `(tenant_id, date, label)` (×3)
  - `printers.name`, `stations`, `menu_price_lists`, `sala_profiles`, `category_stations`, `inventory_*` → tutti compositi
  - `table_merges`/`hidden`/`room_closed` `(date, shift, …)` → compositi
- Decisione inclusa: **un utente appartiene a un solo tenant** (`users.tenant_id`). I gruppi multi-ristorante si gestiranno più avanti con una tabella membership; non ora.

### PR B2 — Tenant nel token e nel contesto richiesta
- Claim `tenantId` nel JWT (`auth/authService.ts:12-16`); login lo risolve da `users.tenant_id`; check `tenants.status = 'active'`.
- Middleware `tenantContext`: `req.tenantId` obbligatorio su tutte le route autenticate; helper `tquery(tenantId, sql, params)` che apre una transazione con `SET LOCAL app.tenant_id` (predispone la RLS di B4).
- `RolePermissionService`: cache keyed per tenant (`server.ts:19224` warm-up globale oggi).
- Frontend: `GET /auth/me` ritorna anche tenant (nome, branding, feature attive); `AuthContext` lo espone. Nessun selettore tenant in UI: un login = un ristorante.

### PR B3 — Scoping delle route, un dominio per PR
La coda lunga: ~260 route in `server.ts` da scopare su `req.tenantId`. Un PR per dominio, ciascuno con i suoi test, in quest'ordine (dal più isolato al più intrecciato):

1. Impostazioni & config (`app_settings`, orari, chiusure, legal)
2. Staff, todo, spesa, fornitori, reminder
3. HACCP
4. Inventario
5. Menu (piatti, listini, modificatori, stazioni)
6. Sale & tavoli (merge, override, profili sala)
7. Clienti & messaggistica outbound
8. Prenotazioni (+ disponibilità pubblica)
9. Comande & cucina & stampa
10. Conti & pagamenti (`/pay/:token` è già sicuro by-design via `share_token`; va solo scopata la creazione)
11. Notifiche, push, activity log, dev board

### PR B4 — Row-Level Security
- `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` + policy su tutte le tabelle (FORCE perché l'app si connette come owner, che altrimenti bypassa). **Policy in due stadi**: nella fase di transizione il predicato ha fallback permissivo quando `app.tenant_id` non è impostata (la B3 ha scopato con predicati espliciti, non tutto passa da `withTenant`); PRIMA di accendere il tenant 2 il fallback si rimuove (policy rigida) migrando i percorsi caldi su `withTenant`, e cade anche il `DEFAULT 1` su `tenant_id`.
- È la rete di sicurezza contro la query dimenticata: con 19k righe di server e nessuna copertura test storica, una svista in B3 è una certezza statistica. Con RLS una query non scopata ritorna zero righe invece dei dati di un altro ristorante.

### PR B5 — Socket.IO per tenant
- Alla connessione (`socketService.ts:50-65`) il socket entra in `tenant:${tenantId}` (claim dal JWT).
- Tutti i ~30 metodi broadcast prendono `tenantId` e usano `io.to('tenant:'+id)` al posto di `io.emit`; rimuovere il bypass "TEMPORARY" di `broadcastToAll` (`socketService.ts:260`).
- Le room esistenti diventano composite: `tenant:${id}:room:${roomId}`, `tenant:${id}:station:${stationId}`.
- Ogni call site in `server.ts` passa il tenant — meccanico ma esteso; stessa suddivisione per dominio di B3.

---

## Fase C — Canali per tenant + add-on

### PR C1 — Entitlements
- Tabella `tenant_features` (`tenant_id`, `feature`, `enabled`, `config JSONB`) con feature: `voice`, `whatsapp`, `web_booking` (+ margine per le prossime).
- Middleware `requireFeature('voice')` sulle route dei canali; frontend nasconde le sezioni non attive (via `/auth/me`).
- I flag oggi in `app_settings` (`voice_agent_enabled`, `public_bookings_enabled`) restano come interruttori *operativi* del tenant; l'entitlement è il livello commerciale sopra di essi.
- Nota (implementazione C1): il gating UI è rimandato alla Fase D (wizard D1) — `/auth/me` e il login espongono già `tenant.features`, il frontend per ora non nasconde nulla.

### PR C2 — Webhook instradabili per tenant
Il pattern è quello già esistente di SumUp (`/webhook/sumup/:token`, unico webhook già discriminato):
- Colonna `webhook_token UNIQUE` su `tenants`; tutti i webhook diventano `/webhook/:provider/:tenantToken` mantenendo i vecchi path alias del tenant 1 finché i provider non sono riconfigurati.
- ElevenLabs: **un agent per tenant** (l'add-on voice include la creazione dell'agent via API ElevenLabs, prompt template con nome/orari/regole dal DB); i 7 webhook (`server.ts:790-1907`) risolvono il tenant dal token URL; mappa `agent_id → tenant` come verifica incrociata.
- Twilio/Meta WhatsApp: numero mittente per tenant in `integration_settings`; inbound risolto per token URL + lookup numero `To`. Nota costi/tempi: template Meta da approvare per ogni tenant (l'URL `crm.vecchiofrantoio.com` è dentro il template approvato, `server.ts:11286` — serve un template parametrico sul dominio).
- Revolut/Resend/Vonage: stesso schema token.
- Print agent: token per tenant al posto del globale `PRINT_AGENT_TOKEN` (`server.ts:18566`) — oggi qualunque agent può drenare la coda di stampa di chiunque.

### PR C3 — Prenotazioni web per tenant
- `/prenota/:slug` (+ tabella `tenant_domains` per domini custom tipo `prenotazioni.vecchiofrantoio.com`, che sostituisce il redirect hardcoded di `server.ts:170`).
- `prenota.html` → branding, contatti, orari via `/public/:slug/…`; gli endpoint pubblici (`/public/availability`, `/public/contact`, `server.ts:15357-15431`) prendono lo slug.
- Rate limiter pubblici (`server.ts:4016-15351`) keyed per tenant: oggi un tenant sotto carico strozzerebbe tutti.

### PR C4 — Email/IMAP per tenant
- SMTP/Resend è già in `integration_settings` (pattern giusto): con la PK composita di B1 diventa per-tenant quasi gratis.
- IMAP: da singola connessione IDLE al boot (`server.ts:19265`) a supervisore che gestisce N connessioni (una per tenant con IMAP attivo), con reconnect e stato per tenant.

---

## Fase D — Piattaforma

### PR D1 — Provisioning & onboarding
- `POST /admin/tenants`: crea tenant, chiama `seedTenantDefaults()` (da A3), genera `webhook_token`, invita l'OWNER via email (sostituisce il seed `admin@ristomanager.com`, `db.ts:774`).
- Wizard primo accesso: dati legali, sale/tavoli, orari, menu minimo.

### PR D2 — Pannello piattaforma
- Ruolo `PLATFORM_ADMIN` sopra OWNER (fuori dalla gerarchia tenant): lista tenant, stato, feature, sospensione, impersonation con audit log.

### PR D3 — Billing
- Stripe Billing: subscription per tenant, base + add-on come subscription items; webhook Stripe → `tenants.status` e `tenant_features`. Nessun dato carta nel nostro DB.

### PR D4 — Ops multi-tenant
- Scheduler (`server.ts:7157-7437`): i tick iterano per tenant; restano in-process finché `numReplicas: 1`, ma con lock advisory Postgres per essere pronti a scalare.
- Backup: pg_dump automatizzato (i dump manuali in `backups/` non sono un processo).
- CORS: chiudere `origin: true` (`server.ts:139`) su allowlist da `tenant_domains`; idem per Socket.IO (`socketService.ts:17-35`).
- Ruotare le credenziali Vonage committate in `.env.example`.
- Timezone: `SET TIME ZONE 'Europe/Rome'` a livello pool (`db.ts:74`) va bene finché i tenant sono italiani; `tenants.timezone` esiste già per il futuro, ma niente lavoro ora.

---

## Ordine di esecuzione e dipendenze

```
A1 → A2 → A3, A4 (parallele)
      └→ B1 → B2 → B3 (11 PR in sequenza) → B4 → B5
                                  └→ C1 → C2, C3, C4 (parallele)
                                              └→ D1 → D2, D3, D4
```

Il grosso del rischio e del tempo è B3+B5 (scoping di 260 route e ~30 broadcast). Tutto il resto è delimitato. Fino a B4 compreso, il sistema resta funzionalmente identico per il Frantoio: il primo tenant nuovo si può accendere dopo D1.

## Rischi principali

1. **Nessuna copertura test storica** → A2 è il primo investimento, non un lusso; B3 senza test è inaccettabile.
2. **Query dimenticate in B3** → mitigata da RLS (B4): fallisce chiuso, non aperto.
3. **Leak real-time** → B5 va completato prima di accendere il secondo tenant; un `io.emit` residuo trasmette le prenotazioni di tutti a tutti.
4. **Template Meta WhatsApp** → approvazioni per tenant lente: avviare la pratica del template parametrico presto, in parallelo a B.
5. **Migrazione vincoli unici su dati live** (B1) → provare ogni migration su un restore del dump di produzione prima del deploy.
