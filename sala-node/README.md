# Nodo di sala — installazione e gestione

> Il collaudo a linea staccata, da fare a locale chiuso prima della prima
> serata con «Servizio completo sul nodo»: [docs/collaudo-nodo-linea-giu.md](../docs/collaudo-nodo-linea-giu.md).

Il nodo di sala vive sul PC Windows del ristorante, accanto a print agent e
agente Passepartout. Due generazioni:

- **Tappa 3 (questa cartella)**: relay Socket.IO + cache di lettura —
  letture e realtime dalla LAN, scritture sempre al cloud.
- **Tappa 4 (il full-server)**: LO STESSO `server.ts` del cloud, avviato con
  `SERVER_PROFILE=service-node` e un Postgres locale — si bootstrappa dal
  cloud (snapshot + cursore), resta in replica bidirezionale, e con
  l'interruttore «Servizio completo sul nodo» prende l'autorità delle
  battiture di sala. Sostituisce il relay sulla STESSA porta: i client non
  si accorgono del cambio. Installazione: sezione «Tappa 4» in fondo.

Architettura e razionale: `docs/brainstorming-installazione-ibrida.md` nel
repo marketing (sez. 3–7).

## Prerequisiti

- Checkout del repo in `C:\ristomanager-agents\app` (già presente per gli
  altri agenti; update = `git pull` + riavvio dell'attività).
- Node.js ≥ 20 (lo stesso usato dagli altri agenti).
- Token del nodo: `tenants.sala_node_token` — si legge dal DB (psql sul
  database di produzione). Dal 25/09 il CRM non lo mostra più: apre snapshot
  e upstream del tenant, è un segreto di macchina come le env di Railway.
- Segreto JWT: dalla firma ES256 (sezione «Firma ES256» in fondo) il nodo
  del full-server NON ne ha bisogno: verifica i token con le chiavi pubbliche
  che riceve dal cloud. `JWT_SECRET` nel `.cmd` serve solo finché la
  transizione non è al passo 3.
- Rete: **prenotazione DHCP** per il PC (l'IP del record A non deve cambiare
  dopo un blackout — stessa raccomandazione mai attuata per le stampanti).

## Configurazione cloud (una volta)

1. In **Impostazioni → Sala & Cucina → Nodo di sala**, da una sessione di
   piattaforma («Entra» dal pannello: dal 25/09, audit H-05, il gestore non
   può cambiarlo): dominio `sala.<nome>.sympotia.com` (una sola etichetta,
   unica fra i ristoranti, non derivata dallo slug — il Frantoio è
   `sala.vecchiofrantoio.sympotia.com`). Il gestore imposta IP LAN del PC
   (solo 10/8, 172.16/12, 192.168/16 o 100.64/10) e porta (443, o 8443 se la
   443 è occupata — l'URL la include da solo).
2. Bottone **aggiorna DNS** (anche il gestore): crea o ripunta il record A
   (DNS-only) su Cloudflare verso l'IP LAN salvato. Da rifare se il PC cambia
   IP. Al massimo 5 volte al minuto per ristorante (il limite API di
   Cloudflare è dell'intero account). Il gestore ripunta solo un dominio
   `sala.<nome>.<zona>` o quello di cui ha già il certificato: un nome di
   altra forma lo riallinea la piattaforma.
3. Bottone **emetti certificato** (solo piattaforma): ordina il certificato
   Let's Encrypt via DNS-01; se quello salvato vale oltre 30 giorni si
   rifiuta (il rinnovo parte da solo). Richiede in Railway gli env
   `CLOUDFLARE_API_TOKEN` (Zone.DNS:Edit su sympotia.com) e facoltativi
   `SALA_NODE_ZONE` (default `sympotia.com`), `ACME_CONTACT_EMAIL`,
   `ACME_STAGING=1` per collaudo.
4. Accendere l'interruttore **Modalità ibrida** solo a nodo installato e
   online (la card mostra lo stato).

## Installazione sul PC Windows

`C:\ristomanager-agents\run-sala-node.cmd`:

```bat
@echo off
cd /d C:\ristomanager-agents\app
set SALA_NODE_TOKEN=<token dal DB>
set JWT_SECRET=<lo stesso del cloud - Railway, variables>
set CLOUD_URL=https://ristomanager-production.up.railway.app
node --loader ts-node/esm sala-node\index.ts
```

Attività pianificata (PowerShell amministratore) — identica agli altri agenti:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\ristomanager-agents\run-sala-node.cmd"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask "RistoManager Sala Node" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest
Start-ScheduledTask "RistoManager Sala Node"
```

Firewall: regola inbound TCP sulla porta scelta (443/8443), profilo rete
privata. SYSTEM può bindare la 443; se è occupata (IIS?) usare 8443 e
scriverla in card.

## Verifiche

1. `curl http://localhost:8080/healthz` (o https sul dominio) →
   `{ ok: true, cloud_link: true, ... }`.
2. Dal palmare: `https://sala.<slug>.sympotia.com/healthz`.
3. La card Impostazioni mostra "nodo online" e i dispositivi collegati.
4. Prova outage: staccare la WAN dal router → KDS e Passe restano vivi con
   il banner «dati fermi alle HH:MM»; al ritorno il log del nodo dice
   `cache svuotata, sala:resync inviato` e gli schermi si riallineano.

## Guasti noti

- **Chrome blocca le chiamate al nodo («provisional headers», richiesta
  senza risposta)**: è il Local Network Access — un sito pubblico che parla
  con un IP di LAN richiede il permesso dell'utente. Sul dispositivo:
  lucchetto → Impostazioni sito → «Accesso alla rete locale» → Consenti per
  app.sympotia.com, poi ricaricare. Va fatto UNA volta per dispositivo
  (Android/Chrome uguale; Safari/iOS oggi non applica il blocco). Per i
  Chrome più vecchi il nodo risponde già Access-Control-Allow-Private-Network.

- **Router con protezione DNS-rebinding**: il record A pubblico risponde un
  IP privato e alcuni router lo filtrano. Sintomo: il dominio non risolve
  dalla LAN ma `nslookup` da fuori funziona. Fix: whitelist di
  `sympotia.com` nel rebind-guard del router. Ripiego documentato nel
  brainstorming: Tailscale su nodo e dispositivi.
- **Nodo che non parte durante un outage**: usa l'ultima copia di
  credenziali in `sala-node/state/credentials.json`; se il file manca (prima
  installazione) il nodo resta in retry finché il cloud non torna.
- **Certificato scaduto**: il rinnovo è automatico (sotto i 30 giorni, giro
  giornaliero lato cloud); il nodo lo scarica entro 12h. La scadenza è in
  card e in `/healthz` (`cert_expires_at`).
- **"nodo offline" in card ma processo attivo**: come per il print agent,
  guardare nei log Railway `[sala-node] nodo connesso/disconnesso`; se non
  ci sono tentativi, sul PC il processo non gira (l'auto-reconnect è
  infinito: se girasse si ricollegherebbe da solo).
- **`[bootstrap] tentativo fallito … pg_statistic` ogni minuto** (versioni
  fino a 61188b6, con PostgreSQL 18 sul PC): la query che porta le sequenze
  nello spazio del nodo moriva, e le sequenze restavano sotto il miliardo.
  Corretto il 06/10; dopo l'aggiornamento il log dice `[bootstrap]
  sequenze nello spazio del nodo: N`. Il PC del Frantoio ha PostgreSQL 18,
  il cloud 17: la CI fa girare i test del nodo anche sulla 18.


## Tappa 4 — il full-server al posto del relay

Prerequisiti in più rispetto alla tappa 3:

1. **PostgreSQL per Windows** (≥ 15) sul PC, con l'utente `postgres`
   SUPERUSER (serve a `session_replication_role` nel carico dello snapshot
   e nell'applier della replica). Installer ufficiale EDB, servizio
   automatico, password annotata. Poi il database:

   ```
   "C:\Program Files\PostgreSQL\17\bin\psql" -U postgres -c "CREATE DATABASE ristonodo"
   ```

2. Dipendenze del server nel checkout (una volta, con la linea su):

   ```bat
   cd /d C:\ristomanager-agents\app
   git pull
   npm ci
   npm run build:server
   ```

`C:\ristomanager-agents\run-sala-node4.cmd` (ASCII PURO, come sempre):

```bat
@echo off
cd /d C:\ristomanager-agents\app
set SERVER_PROFILE=service-node
set DATABASE_URL=postgresql://postgres:<password>@localhost:5432/ristonodo
set SALA_NODE_CLOUD_URL=https://ristomanager-production.up.railway.app
set SALA_NODE_TOKEN=<token dal DB>
set SALA_NODE_STATE_DIR=C:\ristomanager-agents\sala-node-state
set PORT=8443
node dist\server.js
```

Nota JWT: il nodo verifica i token dei client con le chiavi PUBBLICHE ES256
che scarica da `/sala-node/credentials` (e tiene in
`SALA_NODE_STATE_DIR\sala-node-jwt-keys.json` per ripartire a linea giù).
Nessun segreto JWT sul PC; `JWT_REFRESH_SECRET` non è mai servito: login e
refresh vanno sempre al cloud. Durante la transizione (sotto) si può avere
ancora `set JWT_SECRET=...` nel `.cmd` per i token HS256 in circolazione.

Lo scambio (fuori servizio):

```powershell
Stop-ScheduledTask "RistoManager Sala Node"
Disable-ScheduledTask "RistoManager Sala Node"
$action = New-ScheduledTaskAction -Execute "C:\ristomanager-agents\run-sala-node4.cmd"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask "RistoManager Sala Node 4" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest
Start-ScheduledTask "RistoManager Sala Node 4"
```

La regola firewall della porta resta quella della tappa 3. Il TLS se lo
carica da solo (certificato dal cloud, cache in SALA_NODE_STATE_DIR: un
riavvio a linea giù riparte in HTTPS comunque).

### Verifiche tappa 4

1. Il log del nodo, in ordine: migrazioni ok → `🔒 TLS del nodo attivo` →
   `[bootstrap] ✅ proiezioni caricate, cursore 'cloud' a N` →
   `[replica] uplink connesso al cloud`.
2. `https://sala.<slug>.sympotia.com:8443/health` dal palmare → 200.
3. Card Impostazioni: «nodo online»; la riga «Servizio completo sul nodo»
   dice «pronto: repliche allineate» entro qualche secondo.
4. Interruttore autorità ON → comanda di prova dal palmare → compare anche
   sul back-office (fuori LAN) entro pochi secondi.
5. Prova outage FUORI servizio: WAN giù → si batte una comanda → i monitor
   LAN la vedono; WAN su → entro pochi secondi compare anche sul cloud e la
   card torna «repliche allineate».

### Tornare indietro

Interruttore autorità OFF dalla card (aspetta il drenaggio), poi
`Stop-ScheduledTask "RistoManager Sala Node 4"` e riattivare la task della
tappa 3. Il downgrade è il failover: senza nodo i client tornano al cloud
da soli (circuito + probe).


### Occhi sul nodo (indurimento post-collaudo 23/09)

- **Log su file**: tutto lo stdout del full-server finisce anche in
  `SALA_NODE_STATE_DIR\sala-node.log` (rotazione a 5MB → `.old`). La task
  SYSTEM è headless: quel file è l'unico posto dove leggere.
- **Handshake respinti**: il bridge cloud logga ogni rifiuto con la ragione
  (`[sala-node] handshake respinto (…)`), cercarli nei log Railway.
- **Allarme uplink**: se un nodo con l'ibrido acceso tace oltre 5 minuti,
  OWNER e GENERAL_MANAGER ricevono una push («Nodo di sala non si fa
  vivo»); al rientro, la push di sollievo. Il silenzio di 90 minuti del
  23/09 non può più passare inosservato.
- **Guasti noti in più**: da un client, `curl` che passa e browser con
  `ERR_ADDRESS_UNREACHABLE` = permesso «Rete locale» negato all'app
  (macOS) oppure DNS sicuro/DoH del browser o «DNS privato» (Android) che
  scarta il record A privato del nodo — disattivarli per i dispositivi di
  sala. Il flip dei flag ora arriva anche ai client attaccati al socket
  del nodo (envelope rigiocati), niente più reload a mano.


### Stampe dal nodo (fase stampe, 24/09)

Con l'autorità in sala le comande nascono sul nodo e i loro ticket stanno
nella SUA coda print_jobs: l'agente di stampa deve pollare ANCHE il nodo.
In `run-print-agent.cmd` aggiungere:

```bat
set NODE_URL=https://sala.<slug>.sympotia.com:8443
```

e riavviare la task «RistoManager Print Agent». L'agente conferma ogni job
alla fonte che gliel'ha dato (cloud o nodo); la config arriva dal cloud con
ripiego sul nodo — a linea giù le stampe delle comande battute al buio
ESCONO comunque. Il nodo riconosce il token dell'agente grazie alla riga
`tenants` (nello snapshot per i nodi nuovi; sincronizzata a ogni avvio per
quelli già installati). Il **token legacy** dell'agente (env
`PRINT_AGENT_TOKEN` del cloud, tenant 1) il nodo lo eredita da solo via
`/sala-node/credentials`: dai nodi nuovi NON serve più copiarlo a mano nel
`.cmd` (sul PC del Frantoio, installato prima di questo fix, la riga
copiata a mano resta e non dà fastidio).


## Firma ES256 (fase A1, ottobre 2026)

Prima di riaccendere «Servizio completo sul nodo» il nodo non deve più
conservare `JWT_SECRET` (audit H-05): con quel segreto chiunque legga il
`.cmd` si conia un token di qualunque tenant. Il cloud firma ora gli access
token con una chiave EC P-256 privata che resta su Railway; il nodo riceve
solo le pubbliche. La transizione si fa da variabili di Railway, senza deploy:

0. **Aggiornare il nodo sul PC** con una build che contiene questa fase
   (cerca nel log `[node-tls] chiavi JWT`: senza chiave sul cloud la riga
   non compare ancora, ed è normale). Il relay della tappa 3
   (`sala-node\index.ts`) NON capisce ES256: deve essere già spento.
1. **Pubblicare la chiave.** Generarla sul Mac:

   ```bash
   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
   ```

   e incollarla (tutte le righe) in `JWT_ES256_PRIVATE_KEY`
   su Railway. Il cloud continua a firmare HS256 ma consegna la pubblica:
   entro 10 minuti (o subito, riavviando il nodo) il log del nodo dice
   `[node-tls] chiavi JWT dal cloud: <kid>`.
2. **Firmare ES256**: `JWT_SIGN_ES256=1` su Railway. I token nuovi escono
   ES256 (intestazione con `kid`), quelli HS256 già emessi valgono fino alla
   scadenza (6 ore). Verifica: un palmare appena loggato lavora sul nodo.
3. **Almeno 6 ore dopo**: `JWT_HS256_ACCEPT=0` su Railway; togliere
   `JWT_SECRET` dal `.cmd` del nodo e riavviarlo; **ruotare `JWT_SECRET`** su
   Railway (è stato sul PC). Le sessioni non cadono: i refresh token usano
   `JWT_REFRESH_SECRET`, che non è mai uscito dal cloud.

Rotazione futura della chiave: la pubblica uscente
(`openssl pkey -pubout` sulla vecchia privata) va in
`JWT_ES256_PREVIOUS_PUBLIC_KEY` per almeno 6 ore, poi si toglie.

Tornare indietro: togliere `JWT_SIGN_ES256` (si torna a firmare HS256); al
passo 3 già fatto, rimettere anche `JWT_HS256_ACCEPT` e il segreto nel
`.cmd`.


## Accesso a linea giù e configurazione allineata (fase A2)

- **Proroga degli accessi.** Login e refresh vivono nel cloud. A linea giù
  (uplink muto da `SALA_NODE_UPLINK_DOWN_AFTER_MS`, 30 s di default) il nodo
  accetta un access token SCADUTO da meno di `SALA_NODE_OFFLINE_GRACE_HOURS`
  (12 di default), del suo tenant, di un utente attivo nella copia locale.
  Oltre risponde 401 `session_expired_offline` e l'app mostra «Accesso
  scaduto senza linea» finché la linea non torna. I client rinnovano il
  token a metà vita (3 ore), quindi un guasto comincia sempre con almeno
  3 ore di token buono.
- **Un solo ristorante.** Il nodo rifiuta i token di un tenant diverso dal
  suo (quello del cursore di replica), e prima del bootstrap rifiuta tutto.
- **Configurazione allineata.** Ogni 2 minuti (`SALA_NODE_CONFIG_SYNC_MS`),
  e subito quando il cloud annuncia una modifica di menu, sale o personale,
  il nodo chiede `POST /sala-node/config` con le impronte delle tabelle di
  configurazione e applica solo quelle cambiate (la rubrica clienti ogni
  15 minuti). Nel log: `[config] allineate dal cloud: dishes, users`. Gli
  hash delle password non scendono mai.
- **PIN di sala.** Chi ha impostato il PIN (profilo, nel cloud) entra sul
  nodo a linea giù con `POST /auth/pin-login` (nome dall'elenco di
  `GET /auth/pin-users` + PIN). Il nodo conia la sessione con una chiave
  SUA (`SALA_NODE_STATE_DIR\sala-node-session-key.pem`, generata alla
  prima accensione, mai inviata al cloud): kid `node-…`, valida
  `SALA_NODE_PIN_SESSION_HOURS` (12), solo permessi di servizio, nessun
  refresh. 5 PIN sbagliati bloccano l'utente 5 minuti. Il cloud non
  riconosce quei token: a linea tornata l'app chiede il login normale.
  Gli hash dei PIN scendono al nodo con la configurazione (le password no).

## Occhi sul nodo: ritardi, isola, versione (fase A3)

- **I tre numeri** li calcola il nodo, l'unico che li sa anche a linea giù:
  ritardo cloud→nodo (secondi dall'ultimo giro riuscito col cloud),
  ritardo nodo→cloud (età della più vecchia battitura locale che il cloud
  non ha) e battiture in attesa. Il punto fino a cui il cloud ha applicato
  il log del nodo sta in `replication_cursor` (stream `node_acked`), così
  sopravvive a un riavvio a linea giù.
- **Dove si vedono**: nel battito `node:stats` (ogni 15 s,
  `SALA_NODE_STATS_INTERVAL_MS`) fino alla card del cloud, riga
  «Sincronizzazione»; e in LAN su `GET /sala-node/local-status` (solo sul
  nodo, con un token qualunque del locale), che usano la pastiglia Live
  («dalle 21:47») e la card quando il cloud non risponde.
- **Versione**: `BUILD_SHA` se impostata, altrimenti lo SHA di Railway,
  altrimenti `dist/build-info.json`, altrimenti `dev`. Sul PC conviene
  mettere `set BUILD_SHA=<sha del commit>` nel `.cmd` finché il pacchetto
  della fase A4 non la scrive da sé: la card la confronta con quella del
  cloud e la mostra in giallo se diversa.

## Un servizio solo: il supervisore (fase A4)

Al posto delle tre attività pianificate e dei tre `.cmd` (nodo, stampa,
Passepartout) c'è UN servizio di sistema che lancia
`sala-node/supervisor.mjs`. Il supervisore tiene in vita i tre processi
(riavvio con attesa crescente fino a 1 minuto), scrive i log a rotazione in
`logs\` (5 MB × 3 per processo), impedisce che ne partano due copie e
installa le versioni nuove da solo.

### Fase 0: il PC, prima del software

Sono i guasti che nessun programma risolve:

- Risparmio energia: **mai** sospensione né ibernazione (incidente del 17/09).
- Windows Update: orario di attività 10:00–02:00, oppure riavvii solo
  manuali. Un riavvio a metà servizio spegne nodo, stampe e Passepartout.
- BIOS: «riaccendi al ritorno della corrente» (Restore on AC power loss).
- Un UPS per PC, switch e registratore telematico.
- IP fisso o prenotazione DHCP per il PC (il record DNS punta lì).

### Il pacchetto

Lo costruisce la CI a ogni push su main (fase A4b): nella run, fra gli
artefatti, `sympotia-nodo-<sha>` contiene lo zip pronto per `inbox\`
(tenuto 30 giorni). La distribuzione automatica dal cloud al PC non c'è
ancora: servirebbe un token GitHub su Railway.

A mano, sul Mac, dal repo: `npm run package:node -- --zip` costruisce
`build/nodo/sympotia-nodo-<sha>.zip`, una cartella autosufficiente con
server, agente di stampa, agente Passepartout compilato, `node_modules` di
produzione e la versione in `build-info.json`. Sul PC serve solo Node ≥ 20.

### Il pacchetto leggero dell'agente della cassa

Per i ristoranti che hanno solo la cassa Passepartout, senza nodo:
`npm run package:agent -- --zip` costruisce `build/agente/sympotia-agente-<sha>.zip`
con `passepartout-agent.js` (un solo file con le dipendenze dentro, niente
`node_modules`), `supervisor.mjs` e `build-info.json` (con `contenuto_sha256`,
l'impronta di agente e supervisore). La CI lo costruisce a ogni push su main
(artefatto `sympotia-agente-<sha>`) e lo carica nel canale **pilota** del
cloud con `POST /admin/agent-releases`. Lo fa col segreto GitHub
`AGENT_RELEASE_TOKEN`, lo stesso valore della variabile su Railway, che apre
solo quel caricamento; senza, il caricamento si salta. Dal pannello Piattaforma, tab Salute, lo si
promuove a **stabile**. Il PC lo chiede con `GET /pp-agent/aggiornamento?ho=<sha>`
e lo scarica da `GET /pp-agent/rilascio/<sha>`, col token dell'agente
(`Authorization: Bearer`).

### Supervisore in «modo agente» (solo cassa, senza nodo)

Con `"modo": "agente"` in `nodo.json` il supervisore non vuole né database
né token del nodo e tiene in vita un figlio solo, l'agente della cassa (dal
pacchetto leggero, o da `dist/scripts/` di quello del nodo). Il servizio si
chiama `sympotia-cassa` (WinSW), `com.sympotia.cassa` (launchd),
`sympotia-cassa.service` (systemd).

```json
{
  "modo": "agente",
  "cloud_url": "https://ristomanager-production.up.railway.app",
  "update_window": { "from": "04:00", "to": "10:00" },
  "passepartout_agent": {
    "env": {
      "PP_AGENT_TOKEN": "<token dell'agente, dall'abbinamento col codice>",
      "PASSEPARTOUT_WS_URL": "http://192.168.1.10:7606/AdapterWS",
      "PASSEPARTOUT_WS_USER": "…",
      "PASSEPARTOUT_WS_PASSWORD": "…"
    }
  }
}
```

- L'agente scrive ogni 10 s `state/agente.json`: `ok` (collegato al cloud),
  `in_corso` (chiamate della cassa in corso), `versione`.
- Ogni ora il supervisore chiede al cloud se per il canale del ristorante c'è
  una versione diversa. Lo zip si scarica in `inbox\` solo se lo sha256 torna
  con quello annunciato.
- Si installa nella finestra, e solo se l'agente non dichiara chiamate in corso.
  La nuova è sana quando scrive di essere collegata entro 3 minuti; se no,
  torna la precedente e lo zip va in `inbox\rejected\`. Quella versione non
  si riscarica: si aspetta la successiva.
- `"aggiornamenti": "manuali"` spegne lo scaricamento; `inbox\` funziona
  comunque a mano.

### L'installatore (`scripts/installa-cassa.ps1`)

Il server lo serve su `GET /installa/cassa.ps1`, con dentro il proprio
indirizzo. Dalla sezione Passepartout, «Collega il PC della cassa» dà la riga
da incollare in PowerShell come amministratore:

```powershell
$env:SYMPOTIA_CODICE='XXXX-XXXX'; irm https://<server>/installa/cassa.ps1 | iex
```

Passi:
1. Controlla amministratore, Windows 10+/Server 2016+ a 64 bit, 500 MB liberi
   e che `sympotia-cassa` non ci sia già.
2. Trova la cassa: `http://<localhost o IP del PC>:7606/?wsdl`, oppure chiede
   l'indirizzo (o `SYMPOTIA_CASSA_URL`).
3. Prova utente e password con `GetVersioneGestionale` **prima** di abbinare,
   così un tentativo sbagliato non consuma il codice.
4. Abbina (`/pp-agent/abbina`) e scarica, con sha256 fissati o annunciati:
   - Node 22 portatile;
   - WinSW 2.12;
   - l'agente del canale del ristorante.
5. Scrive `C:\Sympotia\Cassa\nodo.json` in modo agente, con permessi solo per
   Administrators e SYSTEM (per SID).
6. Installa e avvia il servizio, e propone di disattivare le attività
   pianificate che lanciavano l'agente a mano.
7. Aspetta fino a 2 minuti che l'agente scriva di essere collegato.

Disinstallare: `$env:SYMPOTIA_AZIONE='disinstalla'` e la stessa riga. Ferma e
rimuove il servizio e scollega il PC (`POST /pp-agent/scollega`, col suo token).

Col nodo di sala (Frantoio): `SYMPOTIA_NODO_URL` aggiunge `PP_AGENT_NODE_URL`.

Serve almeno un rilascio dell'agente nel cloud, cioè `AGENT_RELEASE_TOKEN`
impostato su Railway e su GitHub. Va provato su una VM Windows (vedi sotto),
mai sul PC di produzione del Frantoio.

### Prova su una VM Windows, con la cassa finta

Serve una VM Windows 10 o 11 (Parallels va bene). Prima di cominciare, fai
un'istantanea pulita.

`scripts/cassa-finta.ps1` risponde come l'AdapterWS alle chiamate di:
- installatore;
- verifica della cassa;
- import di tavoli e menu;
- prova di scrittura.

Dati che usa:
- **Versione:** 2026C1.
- **Tipi di pagamento:** Contanti, POS, ESTERNO (Varie1).
- **Sale:** DENTRO con 6 tavoli, FUORI con 3, più un ingombro.
- **Articoli:** 8.
- **Prenotazioni:** tenute in memoria.
- **Comande e conti:** nessuno.

Le altre operazioni rispondono con un errore SOAP. Non va mai lanciata sul PC
di un ristorante.

1. **Ristorante di prova.** Dal pannello Piattaforma crea un ristorante con
   «cassa passepartout» accesa. Mai il codice di un ristorante vero: abbinare
   un PC ruota il token e stacca l'agente che c'è.
2. **Cassa finta.** Nella VM apri PowerShell come amministratore, in una
   finestra sua:
   ```powershell
   irm https://<server>/installa/cassa-finta.ps1 | iex
   ```
   - Ascolta sulla porta 7606, con utente e password `prova` / `prova`.
   - Ogni chiamata compare nella finestra; le password no.
   - Se sulla VM c'è un Passepartout vero, la 7606 è sua. In quel caso
     imposta `$env:CASSA_FINTA_PORTA='7607'` prima della riga, e
     all'installatore `$env:SYMPOTIA_CASSA_URL='http://localhost:7607/AdapterWS'`.
3. **Codice.** Nel ristorante di prova apri Impostazioni → Passepartout →
   «Collega il PC della cassa» e copia la riga.
4. **Installatore.** In una seconda finestra PowerShell come amministratore
   incolla la riga. Conferma la cassa trovata su localhost e inserisci
   `prova` / `prova`.
5. **Cosa aspettarsi:**
   - `Get-Service sympotia-cassa` dice `Running`;
   - in `C:\Sympotia\Cassa\` ci sono `nodo.json`, `versions\` e `logs\`;
   - la sezione mostra il PC collegato con l'agente del canale.
6. **Verifica della cassa.**
   - La versione è 2026C1.
   - Scegli ESTERNO come tipo di pagamento e conferma che in cassa è
     elettronico.
   - Importa la pianta (6 + 3 tavoli) e abbina i tavoli.
   - Importa il menu (8 articoli).
   - Fai la prenotazione di prova su un tavolo abbinato. Nella finestra
     della cassa finta compaiono la scrittura e l'annullamento («Mancata»).
7. **Tenuta.**
   - Riavvia la VM: il servizio riparte e il PC si ricollega da solo.
   - Chiudi la cassa finta: la verifica dice che la cassa non risponde,
     mentre il PC resta collegato al cloud.
   - Riaprila: la verifica torna verde. Le prenotazioni in memoria si
     perdono.
8. **Disinstallazione.**
   ```powershell
   $env:SYMPOTIA_AZIONE='disinstalla'; irm https://<server>/installa/cassa.ps1 | iex
   ```
   Il servizio sparisce e la sezione mostra il PC scollegato. Poi torna
   all'istantanea per ripetere da capo.

**Aggiornamenti dal cloud.** Si provano quando nel canale c'è un rilascio più
nuovo di quello installato:
- metti il ristorante di prova su «pilota»;
- in `nodo.json` scrivi `"update_window": { "from": "00:00", "to": "24:00" }`;
- lancia `Restart-Service sympotia-cassa`.

Entro un paio di minuti, nei log del supervisore compaiono «scaricato» e poi
l'installazione.

**Errore «Impossibile creare un canale sicuro SSL/TLS».** Su un Windows
vecchio `irm` può fallire così. Lancia prima
`[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` nella stessa finestra.

### Prima installazione (fuori servizio)

1. Cartella `C:\ProgramData\Sympotia\nodo\` (leggibile solo da SYSTEM e
   Administrators). Dentro: `versions\<sha>\` = il pacchetto scompattato, e
   `supervisor.mjs` copiato da `versions\<sha>\sala-node\`.
2. `nodo.json` nella stessa cartella. È l'unico posto con dei segreti:

   ```json
   {
     "cloud_url": "https://ristomanager-production.up.railway.app",
     "node_token": "<tenants.sala_node_token>",
     "database_url": "postgresql://postgres:<password>@localhost:5432/ristonodo",
     "port": 8443,
     "print_agent": {
       "enabled": true,
       "api_url": "https://prenotazioni.vecchiofrantoio.com",
       "token": "<PRINT_AGENT_TOKEN>",
       "node_url": "https://sala.<slug>.sympotia.com:8443",
       "env": { "RT_FISCAL_HOST": "192.168.1.201", "RT_FISCAL_REPARTI": "22=1,10=2" }
     },
     "passepartout_agent": {
       "enabled": true,
       "env": {
         "PASSEPARTOUT_WS_URL": "http://192.168.1.10:7606/AdapterWS",
         "PASSEPARTOUT_WS_USER": "…", "PASSEPARTOUT_WS_PASSWORD": "…",
         "PP_AGENT_SERVER_URL": "https://prenotazioni.vecchiofrantoio.com",
         "PP_AGENT_TOKEN": "…"
       }
     },
     "update_window": { "from": "04:00", "to": "10:00" }
   }
   ```

   Durante la transizione ES256 (sopra) si può aggiungere
   `"node_env": { "JWT_SECRET": "…" }`; finita la transizione si toglie.
3. `node supervisor.mjs check` (controlla configurazione e versione), poi
   `node supervisor.mjs install` e i passi che stampa: su Windows serve
   WinSW-x64.exe rinominato `sympotia-nodo.exe` accanto all'XML.
4. Disattivare (non cancellare) le tre attività pianificate vecchie, poi
   `sympotia-nodo.exe start`. Tornare indietro = `sympotia-nodo.exe stop` e
   riattivare le attività.

Prima di riavviare a mano: `logs\supervisor.log` dice cosa è partito, con
quale versione e perché un processo è ripartito.

### Aggiornare

Si appoggia lo zip (o la cartella) in `inbox\`. Il supervisore lo installa:

- solo nella finestra `update_window` (ora di Roma, 04:00–10:00 di default);
- solo senza comande aperte né conti aperti nelle ultime 12 ore (lo chiede
  al nodo su `/sala-node/maintenance-check`, che risponde solo da
  127.0.0.1);
- se la versione nuova non risponde a `/ready` entro 3 minuti torna da solo
  a quella di prima (`current.txt` / `previous.txt`) e sposta il pacchetto
  in `inbox\rejected\`; se va bene finisce in `inbox\done\`.

Restano le ultime tre versioni in `versions\`. Il supervisore stesso non si
aggiorna da solo: se cambia, si ricopia `supervisor.mjs` e si riavvia il
servizio.

## Il conto sul nodo (fase B3)

Con «Servizio completo sul nodo» acceso, oltre alle comande nascono sul nodo
anche conti, incassi, sconti, storni, chiusure, preconto, scontrino sul
registratore (`rt-local`, job nella coda del nodo: l'agente di stampa con
`NODE_URL` lo stampa) e sessione di cassa. Tutto risale al cloud con id da
un miliardo in su.

- **Il recinto del cloud** rifiuta (409 `authority_on_node`) ogni battitura
  di servizio finché l'interruttore è acceso, anche a nodo muto: non c'è
  più ripiego automatico sul cloud per comande e conti. Col PC morto si
  spegne l'interruttore con `force`: `POST /sala-node/authority
  {"enabled": false, "force": true}` da una sessione con settings:full (la
  card non ha ancora il bottone: si possono perdere le battiture non
  replicate).
- **Cancelli dell'accensione**: provider fiscale `rt-local` (o nessuno), e
  nessun pagamento col QR in corso (`fiscal_needs_cloud`,
  `qr_payments_live`).
- **Pagamento col QR dal nodo** (fase B3b): l'ospite parla col cloud, che
  chiede la quota al nodo (`node:rpc` `pay:claim`/`pay:release` sul canale
  /sala-node), crea l'ordine col gateway (le credenziali restano nel cloud)
  e manda giù la richiesta di pagamento. A pagamento concluso il nodo segna
  la quota pagata, salda e (con `rt-local`) chiude il conto e fa lo
  scontrino. Nodo irraggiungibile dal cloud: `pay_unavailable_on_node`,
  l'ospite legge «paga in cassa». Una quota senza ordine scaduta da 10
  minuti la libera il nodo da solo. In isola il preconto esce senza QR: un
  conto nato sul nodo a linea giù il cloud non lo conosce ancora.
- **Caparre**: le richieste di pagamento scendono al nodo
  (`paymentRequest:changed`), che accredita la caparra pagata sul conto
  aperto della prenotazione.
- **Restano al cloud**: fattura elettronica e nota di credito (SDI), rimborso
  di una quota o di una caparra accreditata (a servizio chiuso: con
  l'interruttore acceso rispondono 409 `refund_needs_cloud_authority`). La
  chiusura su Passepartout dal nodo è arrivata con la fase B5 (sotto).


## L'app dal nodo e la coda dei palmari (fase B4)

Con «Servizio completo sul nodo» acceso il client legge dal nodo, oltre a
comande, conti e cassa, tutto quello con cui apre la sala: `/tables`,
`/rooms`, `/dishes`, `/menus`, `/banquet-menus`, `/table-merges`,
`/table-hidden`, `/room-closed`, `/takeaway/orders` e `/reservations?from=`
fino a 55 giorni indietro (il nodo ne tiene 60; l'archivio con `to=` resta
una lettura del cloud). Un ricaricamento a linea caduta riapre la sala com'è.
Nodo muto → stesso circuito di sempre: un tentativo sul cloud e probe ogni
30 s. Il probe ora parte da solo a circuito aperto (prima lo innescava solo
una lettura instradata: con l'app ferma il dispositivo restava sul cloud a
nodo tornato), e un socket che si ricollega al nodo richiude il circuito
subito.

- **Il 409 del recinto è leggibile**: `buildApiError` mostra `message`
  quando `error` è un codice, e il recinto dice «Nodo di sala non
  raggiungibile da qui: niente registrato».
- **La coda offline** (`services/offlineQueue.ts`) tiene l'URL del cloud e
  decide la destinazione al replay (`routeWriteUrl`): una voce nata a nodo
  spento parte verso il nodo se nel frattempo l'autorità è in sala. Si
  accoda su errore di rete e sul 409 `authority_on_node`; 401, 502–504 e
  quel 409 non chiudono la voce, fermano il giro.
- **Cosa NON va in coda**: comande, conti, incassi, chiusure. La comanda
  vuole una risposta viva (una comanda in cucina venti minuti dopo, quando
  il cameriere l'ha già gridata, è un doppio), l'incasso e la chiusura
  vogliono l'RT. Il palmare tiene il carrello con le chiavi per riga e
  l'Invia si ripete senza doppi.
- **Il doppio ack del piano non c'è**, di proposito: una copia sul palmare
  delle battiture accettate dal nodo servirebbe solo se il disco del PC
  morisse a linea giù, e rigiocarla altrove ristamperebbe in cucina piatti
  già serviti (o rifarebbe scontrini). Contro quel guasto: UPS, memoria
  dell'RT, e la riga «Sincronizzazione» della card che dice quante
  battiture il cloud non ha ancora.

## Passepartout dal nodo e chiusura in cassa durevole (fase B5)

L'agente Passepartout si collega al cloud E al nodo (`PP_AGENT_NODE_URL`),
come l'agente di stampa con le sue due fonti. Ogni server chiama l'agente per
i conti che possiede: con «Servizio completo sul nodo» acceso import della
comanda (`POST /tables/:id/bill` con `source=passepartout`) e chiusura in
cassa avvengono sul nodo, anche a linea caduta.

- **Il token dell'agente sul nodo** lo passa il supervisore
  (`passepartout_agent.env.PP_AGENT_TOKEN` → `PASSEPARTOUT_AGENT_TOKEN` del
  nodo). Dal cloud NON arriva: il token del nodo non deve valere anche come
  agente. Senza supervisore (vecchi `.cmd`): aggiungere
  `set PASSEPARTOUT_AGENT_TOKEN=…` al nodo e `set PP_AGENT_NODE_URL=https://sala.<slug>.sympotia.com:8443`
  all'agente. Il supervisore usa di default l'indirizzo dell'agente di
  stampa (`passepartout_agent.node_url` per cambiarlo).
- **Il token dell'agente verso il cloud** è quello del ristorante:
  `SELECT passepartout_agent_token FROM tenants WHERE id = <ristorante>`
  (lo genera la migrazione, per tutti). Il ristorante 1 può continuare a
  usare il token storico `PASSEPARTOUT_AGENT_TOKEN` di Railway. Agenti di
  ristoranti diversi convivono: ognuno scalza solo il proprio.
- **Tipo pagamento e documento** si impostano in Impostazioni → Passepartout
  (per il ristorante 1 `PASSEPARTOUT_TIPO_PAGAMENTO` /
  `PASSEPARTOUT_TIPO_DOCUMENTO` restano il ripiego) e arrivano al nodo con
  le credenziali, una sola fonte (il cloud). Sul disco del nodo (`sala-node-agenti.json`, insieme
  al token legacy dell'agente di stampa): un nodo riavviato a linea giù li
  ha ancora. Prima il token legacy viveva solo in memoria, e un riavvio a
  linea giù lasciava l'agente di stampa a 401.
- **Chiusura durevole**: la chiusura del conto scrive nella stessa
  transazione una riga `fiscal_documents` PENDING (provider `passepartout`).
  - Riuscita → CONFIRMED col numero dell'RT.
  - Agente spento → resta PENDING, lo spazzino (ogni minuto) riparte
    appena l'agente si ricollega.
  - Errore dopo che la richiesta è arrivata all'agente → con un agente
    che dichiara `chiudi-riprendi` resta PENDING e si riprova con attese
    di 1, 2, 4, 8, 15 minuti (massimo 6 tentativi, 12 ore); il nuovo
    tentativo porta `riprendi` e l'agente guarda prima in
    `GetContiGiorno`: se il conto della comanda c'è già, niente nuovo
    `ContoComanda` (niente secondo scontrino), solo il saldo del sospeso.
  - Con un agente vecchio (senza `chiudi-riprendi`) → FAILED subito: la
    card mostra l'errore e «Chiudi in cassa». È il comportamento di prima.
  - L'agente fa una chiusura alla volta per comanda.
- **Aggiornare l'agente insieme al nodo**: finché l'agente sul PC è quello
  vecchio, le chiusure fallite tornano a mano come prima.

## L'accoglienza sul nodo (tappa C)

La prenotazione è del cloud, ma due sue colonne sono del servizio:
`table_id` e `arrival_status` (`RESERVATION_SERVICE_COLUMNS` in
`services/replicaApply.ts`).

- **Il comando di servizio**: `PATCH /reservations/:id/service` scrive solo
  quelle due colonne, con le regole del `PUT` per un tavolo nuovo (del
  ristorante, sala aperta salvo banchetti, nessun conflitto nella finestra).
  Va nel log come `reservation:service-updated` (autorità `service`). Lo
  scambio tavoli (`POST /reservations/:id/swap-table`) e il walk-in
  (`POST /reservations/walk-in`, arrivato e confermato, adesso) sono
  battiture di servizio come le comande: con l'interruttore acceso nascono
  sul nodo e il cloud risponde 409. Permesso: `reservations:full` oppure
  `floorplan:update_status` — gli stessi ruoli di prima, più la sessione
  del PIN di sala.
- **Replica per colonne**:
  - `reservation:updated` (ora autorità `cloud`) porta la riga del cloud.
    Sul nodo, con l'autorità in sala, si applica tutto tranne tavolo e
    arrivo; se la prenotazione è annullata o rifiutata, il tavolo si
    libera anche lì.
  - `reservation:service-updated` porta solo le due colonne, in tutti e due
    i versi.
  - Sul cloud gli eventi di autorità `cloud` arrivati dal nodo si
    registrano ma non si applicano, e le prenotazioni si aggiornano sul
    posto (prima: cancella e reinserisci, che sul cloud si sarebbe portato
    via i conti a cascata).
- **Il `PUT` del cloud**, con l'autorità in sala, lascia tavolo e arrivo
  come sono (la copia del client può essere vecchia) e salta i controlli
  sul tavolo. Il client manda tavolo e arrivo col comando di servizio: la
  reception sempre; il modulo di modifica e la pianta col `PUT` per il
  resto più il comando se tavolo o arrivo cambiano.
- **Il recinto rovescio**: sul nodo, le scritture su `/reservations` che non
  sono di servizio rispondono 409 `cloud_authority`.
- **Tutto nel log**: ogni modifica del cloud a una prenotazione ora va nel
  log (`logReservationChanged`): conferma dopo la caparra, rifiuto per
  caparra scaduta, esito dei messaggi di conferma, promemoria, lingua,
  rinomina a cascata dalla rubrica, anonimizzazione, conferma del
  suggerimento di tavolo (questa come evento di servizio). Prima erano
  solo broadcast, e il nodo non li vedeva.
- **Rubrica**: un walk-in nato sul nodo apre la scheda cliente quando arriva
  al cloud (il nodo ha solo una copia della rubrica).
