# Nodo di sala — installazione e gestione

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
- Token del nodo: `tenants.sala_node_token` — si legge dal CRM (endpoint
  `/settings/webhook-info`, permesso `settings:full`).
- Rete: **prenotazione DHCP** per il PC (l'IP del record A non deve cambiare
  dopo un blackout — stessa raccomandazione mai attuata per le stampanti).

## Configurazione cloud (una volta)

1. In **Impostazioni → Sala & Cucina → Nodo di sala**: dominio
   (`sala.<slug>.sympotia.com`), IP LAN del PC, porta (443, o 8443 se la 443
   è occupata — l'URL la include da solo).
2. Bottone **emetti certificato**: il cloud crea il record A (DNS-only) su
   Cloudflare e ordina il certificato Let's Encrypt via DNS-01. Richiede in
   Railway gli env `CLOUDFLARE_API_TOKEN` (Zone.DNS:Edit su sympotia.com) e
   facoltativi `ACME_CONTACT_EMAIL`, `ACME_STAGING=1` per collaudo.
3. Accendere l'interruttore **Modalità ibrida** solo a nodo installato e
   online (la card mostra lo stato).

## Installazione sul PC Windows

`C:\ristomanager-agents\run-sala-node.cmd`:

```bat
@echo off
cd /d C:\ristomanager-agents\app
set SALA_NODE_TOKEN=<token dal CRM>
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
set SALA_NODE_TOKEN=<token dal CRM>
set SALA_NODE_STATE_DIR=C:\ristomanager-agents\sala-node-state
set PORT=8443
set JWT_SECRET=<lo stesso del cloud - gia' nelle credenziali del relay>
set JWT_REFRESH_SECRET=<idem>
node dist\server.js
```

Nota JWT: il nodo verifica i token dei client col segreto condiviso — gli
stessi due valori del cloud (Railway → variables). Senza, i palmari
riceverebbero 401 sul nodo.

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
