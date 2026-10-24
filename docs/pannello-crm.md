# CRM della piattaforma (pannello Piattaforma)

Il pannello del PLATFORM_ADMIN è il CRM con cui Sympotia segue i suoi clienti: dal lead al ristorante abbonato, fino al
rinnovo o alla disdetta. Introdotto il 24/10/2026.

## Schede

| Scheda | Cosa c'è | Componente |
|---|---|---|
| Panoramica | MRR, clienti, prove, lead, canone medio, pipeline pesata, nuovi e disdette del mese; promemoria di oggi, clienti da seguire, imbuto, scadenze, ultime attività | `PlatformCrmOverview.tsx` |
| Clienti | lista con ricerca, filtri, ordinamento, tag, import/export CSV; scheda accanto (a schermo intero su telefono) | `PlatformCrmAccounts.tsx`, `PlatformCrmAccountDetail.tsx` |
| Pipeline | opportunità in colonne per fase | `PlatformCrmPipeline.tsx` |
| Promemoria | in ritardo, oggi, 7 giorni, più avanti, fatti | `PlatformCrmTasks.tsx` |
| Supporto, Salute | come prima | `PlatformSupportTab.tsx`, `PlatformHealthTab.tsx` |

La card del ristorante di prima (moduli, permessi riservati, piano di Sofia, billing, «Entra», sospensione) e il modale
di provisioning stanno in `PlatformTenantAdmin.tsx`; la scheda li mostra nella sezione «Ristorante».

## Dati

Cinque tabelle (migrazione `1792848768440_crm-piattaforma.js`): `crm_accounts`, `crm_contacts`, `crm_activities`,
`crm_tasks`, `crm_deals`. `tenant_id` è il ristorante di casa di chi scrive (come `platform_incidents` e il dev board),
così le tabelle restano negli invarianti RLS; le rotte leggono di piattaforma e non filtrano su `tenant_id`.

- **Una scheda per ristorante.** `crm_accounts.customer_tenant_id` è UNIQUE. Alla prima lettura (`GET /accounts` o
  `/overview`) ogni tenant senza scheda la riceve, con la fase dal billing (trialing → in prova, canceled → disdetto,
  altrimenti cliente) e `internal` acceso se lo slug inizia con `demo`.
- **Fasi dal billing.** Per i tenant con `billing_status`, la stessa lettura porta avanti la fase quando Stripe la
  smentisce (active/past_due/unpaid → cliente; trialing → in prova solo da una fase di vendita; canceled → disdetto da
  cliente o prova), una volta per cambio, con una riga «sistema» in cronologia.
- **Interni.** Demo e locali di prova restano visibili (filtro «Demo e interni») ma fuori da MRR, imbuto, conteggi e
  «da seguire».
- **Cronologia.** In `crm_activities` solo ciò che si scrive nel CRM, più i cambi registrati dal server (`sistema`:
  fasi, opportunità chiuse, promemoria fatti, collegamento al ristorante). Supporto, avvisi e creazione del ristorante
  si leggono dalle loro tabelle all'apertura della scheda.
- **Canone.** `mrr_cents` della riga è quello Stripe (subscription viva, annuale diviso 12, zero in prova) se c'è,
  altrimenti `expected_mrr_cents` per i soli clienti (`mrr_source = 'accordo'`). La lista delle subscription si legge
  al massimo ogni 5 minuti; senza `STRIPE_SECRET_KEY` vale solo il canone scritto.

## Salute

Da 100 si tolgono punti per i segnali che di solito precedono una disdetta; i motivi si mostrano in chiaro.

| Segnale | Punti |
|---|---|
| nessun accesso mai / da più di 14 giorni / da più di 7 | −45 / −40 / −20 |
| nessuna prenotazione in 30 giorni | −20 |
| prenotazioni dimezzate rispetto ai 30 giorni prima (con almeno 10 prima) | −15 |
| avvisi aperti (stampa, fiscale, Sofia, nodo) | −10 l'uno, max −20 |
| richieste di supporto urgenti aperte | −10 l'una, max −20 |
| più di 2 richieste aperte (senza urgenti) | −5 |
| pagamento scaduto / abbonamento disdetto / ristorante sospeso | −30 / −40 / −50 |

Sano da 70, da seguire da 40, a rischio sotto. Gli accessi dell'admin di piattaforma (che ha casa in un ristorante)
non contano. Le soglie sono un primo taglio, da tarare sui dati veri.

## Collegamento al ristorante

- Dalla scheda di un lead, «Crea il ristorante» apre il provisioning già compilato; `POST /admin/tenants` accetta
  `crm_account_id` e lega il ristorante alla scheda (risposta: `crm_link`). Un aggancio non riuscito non annulla il
  provisioning.
- «Collega» lega una scheda a un ristorante esistente (`POST /admin/crm/accounts/:id/link`). Se il ristorante aveva già
  la sua scheda automatica, vuota, quella si cancella; se ci si era già lavorato sopra, 409.
- Una scheda legata non si cancella (409): a fine rapporto la fase è «disdetto».

## Rotte

Tutte sotto `/admin/crm`, dietro `platformAdminAuth` (JWT PLATFORM_ADMIN o `PLATFORM_ADMIN_TOKEN`):
`GET /overview`, `GET|POST /accounts`, `POST /accounts/import`, `GET|PATCH|DELETE /accounts/:id`,
`POST /accounts/:id/link`, `POST /accounts/:id/contacts`, `PATCH|DELETE /contacts/:id`,
`POST /accounts/:id/activities`, `DELETE /activities/:id`, `GET|POST /tasks`, `PATCH|DELETE /tasks/:id`,
`GET /deals`, `POST /accounts/:id/deals`, `PATCH|DELETE /deals/:id`. Test: `tests/api/pannello-crm.test.ts`.

## Possibili passi successivi (non decisi)

- Push all'admin la mattina per i promemoria di oggi.
- Invio di email ai referenti dal CRM (oggi si apre il client di posta e si registra a mano).
- Storico del MRR per mese (oggi solo il valore attuale) e coorti di disdetta.
- Soglie della salute tarate sui primi mesi di dati reali.
