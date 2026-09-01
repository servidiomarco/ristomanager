# Nodo di sala — installazione e gestione

Il nodo di sala è il processo LAN della modalità ibrida: relay Socket.IO +
cache di lettura per comande/cucina/passe. Vive accanto agli altri due agenti
del ristorante (print agent, agente Passepartout) sul PC Windows di sala.
Architettura e razionale: `docs/brainstorming-installazione-ibrida.md` nel
repo marketing (sez. 3–7); questa cartella è la tappa 3.

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
