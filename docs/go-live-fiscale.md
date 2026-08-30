# Go-live fiscale Openapi — runbook

*30 agosto 2026. Ordine reale delle operazioni per passare scontrino e
fattura da sandbox a produzione. Il codice è pronto e collaudato (PR
claude/fiscale-openapi): tutto quello che segue è configurazione. Finché non
si esegue il passo 5, in produzione non cambia NULLA — il default del driver
è la sandbox e il provider del tenant è `none`.*

## 1. Console Openapi (account awmrac@gmail.com) — solo umano

1. Attivare il servizio **Invoice** in produzione: contratto/credito
   (e-receipts a consumo; verificare listino a ridosso della firma).
2. Generare il **token di produzione** con gli scope su
   `invoice.openapi.com`: `POST/GET/DELETE IT-e-receipts`,
   `POST/GET IT-invoices`, `POST IT-invoices_validate`,
   `GET/POST/PATCH IT-configurations`.
3. (Per il lookup P.IVA) aggiungere gli scope **Imprese** —
   `GET base`, `GET pec` su `imprese.openapi.it` — allo stesso token o a uno
   dedicato. Nota: vale anche subito in sandbox (`test.imprese.openapi.it`)
   per collaudare la lente nel dialog fattura.

## 2. IT-configuration di produzione — umano + commercialista

`POST /IT-configurations` (o da console) con:
- `fiscal_id`: la P.IVA VERA del ristorante;
- `e_receipts: true`, `customer_invoice: true`;
- indirizzo del locale, store e cassa reali (non "VECCHIO FRANTOIO TEST");
- le credenziali AdE del delegato per il canale scontrino (in sandbox erano
  simulate — qui servono quelle vere: esercente o intermediario con delega).

Col commercialista, PRIMA della prima emissione vera (annotato anche nel
codice): codici natura per IVA zero (oggi N2/N2.2 di default), trattamento
fiscale dell'omaggio (oggi sconto globale), regime (RF01 di default).

## 3. Webhook esiti — un comando

Registrare l'URL di produzione nella IT-configuration:

```bash
OPENAPI_INVOICE_BASE_URL=https://invoice.openapi.com \
OPENAPI_INVOICE_TOKEN=<token-prod> \
OPENAPI_COLLAUDO_FISCAL_ID=<piva-vera> \
node scripts/collaudo-fiscale.mjs webhook https://ristomanager-production.up.railway.app/webhook/t/<webhook_token>/openapi-fiscale
```

(Nota: lo script rifiuta le base URL non-sandbox per gli altri comandi; il
comando `webhook` è l'eccezione prevista. Il `<webhook_token>` del tenant è
in Impostazioni → GET `/settings/webhook-info`, voce `openapi_fiscale`.)

## 4. Variabili d'ambiente su Railway (servizio `ristomanager`)

```bash
railway variables --set OPENAPI_INVOICE_BASE_URL=https://invoice.openapi.com \
                  --set OPENAPI_INVOICE_TOKEN=<token-prod> \
                  --set OPENAPI_COMPANY_BASE_URL=https://imprese.openapi.it \
                  --set OPENAPI_COMPANY_TOKEN=<token-con-scope-imprese>
```

Il deploy riparte da solo. Senza il passo 5 il fiscale resta comunque spento.

## 5. Accensione per-tenant (l'interruttore vero)

Da Impostazioni → Fiscalità nel CRM (o `PUT /settings/fiscal`):
- provider: `openapi`;
- P.IVA vera, dati cedente (denominazione, sede, regime);
- mappa aliquote IVA verificata col commercialista.

Da questo momento ogni chiusura conto con "Scontrino" emette DAVVERO.

## 6. Collaudo di produzione (prima serata)

- Un conto piccolo vero → scontrino → verificarlo su Fatture e Corrispettivi.
- L'annullo dello stesso scontrino (atto fiscale reale, va bene su un
  importo piccolo).
- Una fattura B2C a se stessi → controllare l'esito webhook (deve arrivare
  DELIVERED/cassetto sul documento).
- Stampa della copia sulla termica di sala (layout mai visto su carta) e QR
  copia digitale dal telefono di un cliente.
- Codice lotteria su uno scontrino con pagamento elettronico.

## Cosa resta volutamente fuori

- **Nota di credito (TD04)**: l'annullo di una fattura inviata è bloccato
  con messaggio chiaro; si implementa alla prima necessità reale.
- **Ciclo passivo**: piano in [ciclo-passivo-piano](ciclo-passivo-piano.md),
  parte solo dopo la decisione sull'indirizzo telematico.
- **Obbligo POS ↔ strumento di emissione** (L. Bilancio 2025, in vigore dal
  2026): verificare con Openapi come lo coprono sul binario e-receipts;
  il metodo `POS_FISICO` del libro cassa è il punto di aggancio futuro.
