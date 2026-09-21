# Recensioni Google, Fase B — piano tecnico

*21 settembre 2026 — messo in cantiere prima di scrivere codice.*

Portare le recensioni Google **dentro** il CRM: leggerle, farsi proporre le risposte
dall'AI, pubblicarle, e vedere come si muove la media nel tempo.

**Stato: sospeso per scelta, non per difficoltà tecnica.** Il beneficio è alto, ma
l'iter di autorizzazione di Google è lungo e fastidioso (due approvazioni separate,
settimane, con una trappola nota ancora aperta) e non vale il disturbo adesso. Il
codice della Fase B **non esiste**: nel repo c'è solo la Fase A.

Questo documento serve a riprendere il lavoro a freddo, senza rifare la ricerca.

---

## 1. Cosa c'è già (Fase A, in produzione dal 15/09/2026)

PR #580–583, più la #644 che ha chiuso l'incidente degli SMS ripetuti.

- Add-on commerciale `reviews` in `tenant_features`, acceso per il tenant 1.
- Permessi `reviews:view` / `reviews:manage` (OWNER, GENERAL_MANAGER, MANAGER).
- **Richiesta di recensione post-visita**: `startReviewRequestScheduler` in `server.ts`
  (lock 761007), invio via `dispatchBookingNotification`, persistenza in
  `services/reviewRequests.ts` (presa in carico prima dell'invio).
- `integration_settings` riga `provider='google_business'` con `google_place_id`: da
  solo basta per il link «scrivi una recensione», che **non richiede nessuna API**.
- Sezione **Impostazioni → Recensioni** (`ReviewSettingsCard`): interruttore, timing,
  destinatari, Place ID e **il livello di automazione delle risposte già scelto e
  salvato** (`review_reply_automation`: `off` | `draft` | `auto_positive` | `auto_all`,
  default `draft`). La Fase B lo trova pronto: non va riprogettato, va solo eseguito.
- Pagina **Recensioni** (`ViewState.RECENSIONI`, `components/RecensioniPage.tsx`) col
  registro delle richieste inviate. È il contenitore in cui atterrano le recensioni.

---

## 2. Il vero costo: le due autorizzazioni di Google

Verificato il 21/09/2026 sulla documentazione ufficiale. **Questa è la parte lunga:
il codice, al confronto, è la parte facile.**

### 2.1 Accesso alle API (Basic API Access)

Le API delle recensioni nascono con **quota 0**: finché Google non approva il progetto
Cloud, ogni chiamata fallisce e la `Google My Business API` non è nemmeno visibile
nella console — è Google stessa a scriverlo: *«only visible in the Google Cloud console
to users who submit and receive approval»*.

- Modulo: <https://support.google.com/business/contact/api_default> → **«Application
  for Basic API Access»**, entrando con l'account **proprietario o gestore** del
  profilo del ristorante. Chiede il **numero del progetto** Google Cloud e il caso d'uso.
- Requisiti dichiarati ([prerequisites](https://developers.google.com/my-business/content/prereqs)):
  profilo **verificato e attivo da 60+ giorni**, **sito web** collegato al profilo,
  richiedente owner/manager. Il Vecchio Frantoio li soddisfa.
- Prima di inviare va configurata la schermata di consenso OAuth del progetto (nome,
  logo, privacy policy): chi valuta guarda il progetto.
- **Come si capisce che è passata**: la quota nella console sale da 0 a **300 QPM**.
  La mail di conferma è dichiarata ma spesso non arriva.
- Tempi: nessuno SLA. Segnalazioni 2025–2026: da 3–10 giorni lavorativi a settimane.

API da abilitare (le prime tre bastano per leggere e rispondere):
`My Business Account Management API` (per `accounts.list`), `My Business Business
Information API` (per le location e il Place ID), **`Google My Business API`** — che è
la v4 legacy, quella che possiede le recensioni, e compare solo dopo l'approvazione.

> **Trappola nota, aperta da agosto 2026.** Più sviluppatori con l'accesso *già
> concesso* non riescono comunque ad abilitare `mybusiness.googleapis.com`: resta
> invisibile, e `gcloud services enable` risponde `PERMISSION_DENIED` / precondizione
> **110002**. Nessuna risposta di Google al 1° settembre 2026.
> [Thread](https://discuss.google.dev/t/business-profile-api-reviews-endpoint-mybusiness-googleapis-com-cant-be-enabled-basic-access-pending-10-business-days/389462).
> Se capita non è un errore nostro: si risponde al thread dell'approvazione chiedendo
> l'abilitazione esplicita. È il punto in cui si perdono giorni credendo di aver
> sbagliato la procedura.

### 2.2 Verifica dell'app OAuth

Lo scope è `https://www.googleapis.com/auth/business.manage`, **sensibile** (non
«restricted»: niente security assessment CASA). Lo stato di pubblicazione decide se la
sincronizzazione automatica è possibile:

| Stato dell'app | Conseguenza |
|---|---|
| **Testing** | Refresh token che **scade ogni 7 giorni**: qualcuno dovrebbe ridare il consenso ogni settimana. Incompatibile con una sync automatica. |
| **In produzione, non verificata** | Funziona, ma schermata «app non verificata» e tetto di **100 account** in tutto (da trattare come non azzerabile). |
| **In produzione, verificata** | Nessun avviso, nessun tetto, token normali. |
| **Internal** (solo Google Workspace) | Salta la verifica, ma vale solo dentro un dominio Workspace nostro: non serve per vendere ad altri ristoranti. |

La verifica chiede: proprietà del dominio in Search Console, homepage pubblica
pertinente, privacy policy che dichiari il trattamento dei dati Google, **video
dimostrativo non in elenco** che mostri consenso e uso dello scope, e una
giustificazione per scope. Google dichiara 3–5 giorni lavorativi, in pratica di più.

### 2.3 La decisione che cambia il percorso — ancora aperta

**Le recensioni servono al solo Frantoio o sono una funzione da vendere con Sympotia?**

- Solo Frantoio → si può partire *In produzione non verificata* e convivere con la
  schermata d'avviso, oppure *Internal* se l'account del profilo sta in un Workspace nostro.
- Da vendere → la verifica completa è obbligatoria, e tanto vale affrontarla subito:
  l'approvazione dell'accesso API è **per progetto Cloud**, non per ristorante, quindi
  un solo progetto approvato serve tutti i tenant.

Da decidere con Marco prima di scrivere la prima riga: cambia il contenuto della
richiesta di verifica, non l'architettura.

---

## 3. Piano tecnico, cinque PR

Struttura e convenzioni già fissate nel piano originale
(`~/.claude/plans/ppianifichiamo-una-nuova-feature-mossy-catmull.md`).

### B1 — Collegamento OAuth e salute della connessione

Migration `google-business-oauth`:

- `integration_settings` (riga `google_business`, accanto a `google_place_id`):
  `google_refresh_token`, `google_account_email`, `google_account_name` (`accounts/{id}`),
  `google_location_name` (`locations/{id}`), `google_connection_status`
  (`ok|invalid_grant|error`), `google_connected_at`, `google_last_sync_at`,
  `google_last_sync_error`.
- Tabella `google_reviews`, con l'helper RLS copiato **verbatim** da
  `migrations/1789412295060_compensi-personale.js` (FORCE RLS + `tenant_isolation`):
  `id UUID`, `tenant_id BIGINT NOT NULL`, `google_review_name TEXT` + `UNIQUE
  (tenant_id, google_review_name)`, `reviewer_name`, `reviewer_photo_url`,
  `star_rating SMALLINT CHECK 1-5`, `comment`, `review_language`, `create_time`,
  `update_time`, `reply_text`, `reply_update_time`, `reply_source`
  (`manual|ai_approved|ai_auto|imported`), `reply_state`
  (`NONE|DRAFT|PENDING|PUBLISHED|FAILED`), `publish_after`, `publish_error`,
  `ai_draft_text`, `ai_draft_model`, `ai_draft_created_at`, `first_seen_at`,
  `last_synced_at`, `raw JSONB`. Indici `(tenant_id, create_time DESC)` e parziale su
  `reply_state = 'PENDING'`.

Nuovo `services/googleBusinessService.ts` — **ogni chiamata a Google passa di qui**,
così una migrazione futura della v4 tocca un file solo. Config con cache 30s sul
modello di `services/revolutService.ts`; refresh del token; `listAccounts`,
`listLocations` (riempie anche `google_place_id`), `listReviews`, `upsertReply`,
`deleteReply`; riconoscimento di `invalid_grant` → connessione malata.

Route: `POST /integrations/google-business/connect` (torna l'URL di autorizzazione,
`access_type=offline&prompt=consent`, `state` firmato HMAC con `{tenantId, userId, exp,
nonce}` — il callback è un redirect del browser e non porta l'header di autenticazione);
`GET /integrations/google-business/callback` **non autenticato, sull'origine Railway**
(è l'URL da registrare su Google Cloud Console); `GET` stato mascherato — il refresh
token non esce mai dall'API; `PUT .../location`; `DELETE` (revoca e pulizia).
UI: `components/GoogleBusinessIntegrationCard.tsx` in `imp-recensioni`, sul modello di
`RevolutIntegrationCard`.

Env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URL`.

### B2 — Sincronizzazione e notifiche

`SCHEDULER_LOCK_GOOGLE_REVIEWS = 761008`, tick orario con `runSchedulerTickWithLock`
(i lock 761001–761007 sono presi). Polling e non Pub/Sub: 300 QPM sono abbondanti e le
notifiche di Google andrebbero comunque riconciliate con una lettura. Upsert per
`(tenant_id, google_review_name)`; le risposte già presenti su Google entrano come
`reply_source='imported'`.

Recensione nuova → `pushSendToRoles(tenantId, ['OWNER','MANAGER'], { category: 'review',
url: '/?view=RECENSIONI' })` (aggiungere `'review'` alla union in
`services/pushService.ts` e al filtro di `NotifichePage`), più
`socketService.broadcastToAll(tenantId, 'reviews:changed', {})`.
`POST /reviews/sync` manuale con esito `{imported, updated, skipped, failed}`, sul
modello di `POST /voice-calls/sync`. `invalid_grant` → connessione malata + una push
sola «Collegamento Google scaduto, ricollega».

### B3 — La pagina completa

`GET /reviews` con filtri (stelle, stato risposta) e paginazione; la lista dentro
`RecensioniPage` accanto al registro delle richieste: stelle, recensore, testo, chip di
stato (`pending` = da rispondere, `success` = pubblicata, `critical` = fallita),
«Sincronizza ora», aggiornamento via socket.

### B4 — Risposte AI e automazione

`services/aiReviewReplyService.ts` copiato da `services/aiReplyService.ts` (sentinella
`NON_SO` compresa): contesto = testo e stelle della recensione, identità del locale,
`ai_knowledge_entries`; risposta nella lingua della recensione; **cap validato in byte,
non in caratteri — il limite di Google è 4096 byte**. Telemetria `onUsage` →
`ai_token_usage` con feature `review_reply`.

Endpoint (`reviews:manage`): `POST /reviews/:id/ai-draft`, `PUT /reviews/:id/reply`
(pubblica su Google), `DELETE /reviews/:id/reply`.

Il livello scelto in Impostazioni governa il tick: `draft` → solo bozza;
`auto_positive` → 4–5 stelle passano a `PENDING`, 1–3 restano bozza; `auto_all` → tutte
`PENDING`; `off` → niente. **Le modalità automatiche non pubblicano mai subito**:
`publish_after = now() + 60 min`, e in quella finestra il titolare può correggere o
annullare dalla pagina. Mai in automatico con connessione malata, con `NON_SO`, o oltre
il cap. UI della bozza: `.ds-ai-frame` + `Wand2` + «Conferma e pubblica / Scarta», come
le proposte in Messaggi.

### B5 — Statistiche e allerta

`GET /reviews/stats`: media e volumi per mese (12 mesi), tasso di risposta,
distribuzione delle stelle — SQL puro su `google_reviews`. Allerta nel tick: media
30 giorni contro i 30 precedenti, calo ≥ 0,5 con almeno 3 recensioni recenti → push,
al massimo una ogni 7 giorni. Le recensioni da 1–2 stelle notificano già da sole (B2).

---

## 4. Insidie da ricordare

- **La v4 è legacy ma viva**: `accounts.locations.reviews` non è nella lista di
  dismissione (verificato 21/09/2026). Google però pota questa superficie — l'API Q&A è
  stata spenta nel novembre 2025 — quindi la dipendenza resta confinata in un file solo.
- **Campi nuovi del 2026** da leggere in modo difensivo: `ReviewReplyState` (stato di
  moderazione della nostra risposta), `ReviewMediaItem`, `PolicyViolation` (perché una
  risposta è stata rifiutata), `reviewReplyUrl`.
- **Il token appartiene a una persona, non al locale**: se quell'account perde il ruolo
  di gestore, l'integrazione muore in silenzio. Da qui il controllo di salute della
  connessione in B1.
- **Solo le location verificate** rispondono su reviews: le altre danno errore.
- `ReservationSource.GOOGLE` significa «prenotato dalla pagina pubblica», **non**
  recensioni: mai riusare quel nome.
- Le **Places API (New)** restituiscono al massimo 5 recensioni e non permettono di
  rispondere: non sono un'alternativa. Gli aggregatori di terze parti sono scraper.
- Regola imparata con l'incidente del 18–19/09 (vedi `services/reviewRequests.ts`): le
  query critiche si esportano come stringhe e un test le esegue contro Postgres vero.
  Un SQL a tipi ambigui passa typecheck e build e muore solo in produzione.

---

## 5. Come si riprende

1. Decidere il punto 2.3 (solo Frantoio o funzione da vendere).
2. Creare il progetto Cloud, configurare la schermata di consenso, **inviare il modulo
   di Basic API Access**. Da qui parte il cronometro: tutto il resto aspetta.
3. Quando la quota passa a 300, abilitare la `Google My Business API` — e se non
   compare, vedere la trappola in §2.2.
4. In parallelo avviare la verifica OAuth, se si è scelto di vendere la funzione.
5. Prova a mano con l'OAuth Playground (scope `business.manage`) su
   `mybusinessaccountmanagement.googleapis.com/v1/accounts`, poi su `/v4/.../reviews`:
   se rispondono, si può scrivere B1.
