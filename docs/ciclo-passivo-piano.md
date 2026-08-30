# Ciclo passivo — fatture fornitori nel CRM (piano)

*30 agosto 2026 — seguito delle fasi fiscali (scontrino + fattura attiva via
Openapi, collaudate in sandbox; webhook esiti attivo). Questo è un piano, non
un impegno: le stime si rivedono a ridosso di ogni fase.*

## Obiettivo

Le fatture elettroniche dei **fornitori** del ristorante arrivano via SDI
direttamente nel CRM e diventano lavoro utile: anagrafica fornitore
aggiornata, spesa tracciata per categoria, e — dove ha senso — **carico di
magazzino** proposto sull'inventario esistente. Oggi quelle fatture finiscono
solo dal commercialista; il ristoratore non ne ricava nulla di operativo.

## Cosa offre già Openapi (verificato sull'OAS, 30/08/2026)

- La IT-configuration ha il flag **`supplier_invoice`** (nella nostra config
  sandbox è `false`: va acceso) e l'evento webhook **`supplier-invoice`**
  nelle `api_configurations` — stesso sistema di callback già usato per gli
  esiti (endpoint nostro: `/webhook/t/:token/openapi-fiscale`, da estendere o
  affiancare con `/openapi-passivo`).
- `GET /IT-invoices` con `direction: incoming` restituisce le fatture
  ricevute già **parsate in JSON** (linee, riepiloghi IVA, cedente): non
  serve interpretare l'XML FatturaPA a mano.
- Attivare la ricezione sposta l'**indirizzo telematico** del ristorante su
  Openapi (registrazione del codice destinatario presso AdE): da quel momento
  le fatture passive arrivano lì e non più al canale precedente
  (commercialista/altro software). È LA decisione onerosa del progetto — va
  presa col ristoratore e col commercialista, e ha senso solo se il CRM dà
  abbastanza valore in cambio. In alternativa si valuta l'import periodico
  senza cambio di indirizzo (cassetto fiscale via `IT-invoices_import`), che
  però è pull manuale, non push.

## Architettura proposta

Riuso dei pezzi esistenti: webhook per tenant, `suppliers`,
`inventory_products` / `inventory_movements` (i movimenti hanno già `reason`;
si aggiunge `purchase`), socket per gli aggiornamenti live.

1. **Tabella nuova `supplier_invoices`** (tenant_id, provider_ref univoco,
   fornitore {P.IVA, denominazione}, data, totale, imponibile/imposta,
   payload JSON delle linee, stato: `NEW` → `REVIEWED` → `BOOKED` |
   `IGNORED`). Nessun obbligo contabile qui: è uno strato operativo, la
   contabilità resta del commercialista.
2. **Ingresso**: webhook `supplier-invoice` → upsert per `provider_ref`
   (idempotente come il webhook esiti) → broadcast socket → badge "nuove
   fatture" in UI.
3. **Anagrafica**: match fornitore per P.IVA (colonna `vat_number` da
   aggiungere a `suppliers`); se manca si propone la creazione con la
   denominazione della fattura.
4. **Carico magazzino assistito, non automatico**: le descrizioni di riga dei
   fornitori sono sporche ("CART. 6X1,5LT ACQ NAT") — il match con
   `inventory_products` è un suggerimento con memoria per fornitore
   (riga → prodotto scelto l'ultima volta), mai un carico silenzioso.
   Confermando, si scrivono `inventory_movements` con `reason='purchase'` e
   riferimento alla fattura.
5. **UI**: nuova sezione nella vista Inventario/Spesa (le componenti
   `Inventory.tsx` e `spesa/` esistono già): elenco fatture in arrivo, dettaglio
   con le righe, azioni "registra carico" / "ignora".

## Fasi e stime

| Fase | Contenuto | Stima |
|---|---|---|
| P1 | Tabella + webhook ingresso + elenco in sola lettura in UI | 1–2 giorni |
| P2 | Anagrafica fornitori (P.IVA) + totali spesa per fornitore/mese | 1 giorno |
| P3 | Carico magazzino assistito con memoria dei match | 2–3 giorni |
| P4 | (eventuale) import dal cassetto senza cambio indirizzo telematico | da istruire |

## Prerequisiti e rischi

- **Decisione indirizzo telematico** (vedi sopra): senza quella, solo P4 ha
  senso. Da discutere con ristoratore + commercialista PRIMA di P1.
- Costo per fattura ricevuta sul contratto Openapi: da verificare a listino.
- La sandbox non ha fatture passive di esempio note: il collaudo di P1
  potrebbe richiedere l'invio di una fattura di prova *verso* la P.IVA di
  test dalla sandbox stessa (fattibile: `POST /IT-invoices` con cessionario =
  la nostra config) — da provare come primo passo di P1.
