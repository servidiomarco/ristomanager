# Fatturazione e chiusura conto — brainstorm

*24 agosto 2026 — aggiornato con le decisioni strutturali (v. §6)*

> **Stato attuale (dal codice).** Esiste già `TableBill` con split (quota uguale, importo fisso, acconto come credito), pay-at-table via QR con gateway Revolut/SumUp, e chiusura con `POST /bills/:id/close` che accetta un unico importo contanti (`cash_settled_cents`) + mancia. Se pagato + contanti < totale → `SETTLED_PARTIAL` con tag `[shortfall]` nelle note. `items` JSONB è riservato ma inutilizzato ("Fase 2 Passepartout"), anche se ora il modulo comande è in-house. Nessun documento fiscale: niente scontrino elettronico, niente fattura.

## 1. Il buco più grosso oggi: il pagamento misto

Oggi il modello conosce solo due "metodi": gli split pagati online e un forfait contanti alla chiusura. Ma la realtà al tavolo è: *"80 € col POS, 40 € in contanti, 30 € con buoni pasto"*. Proposta: sostituire il forfait `cash_settled_cents` con una tabella di **movimenti di incasso**:

```
bill_payments (
  id, table_bill_id, tenant_id,
  method,          -- 'CONTANTI' | 'POS_FISICO' | 'LINK_ONLINE' | 'SATISPAY'
                   -- | 'BUONO_PASTO' | 'GIFT_CARD' | 'SOSPESO' | 'OMAGGIO'
  amount_cents, tip_cents,
  recorded_by_user_id, recorded_at,
  meta jsonb       -- es. circuito buoni (Edenred/Pellegrini), n. buoni, rif. POS
)
```

Vantaggi immediati:

- La chiusura diventa "aggiungi incassi finché il residuo è 0", identica per qualsiasi mix. Gli split online confermati dal gateway diventano semplicemente righe con `method='LINK_ONLINE'` (**deciso**: vista unica — v. §6).
- Il tag `[shortfall]` nelle note sparisce: il residuo è un dato, non una stringa da parsare.
- La **chiusura di cassa giornaliera** (oggi impossibile per metodo) diventa una `GROUP BY method` — contanti in cassetto vs POS vs online vs buoni. È il report che il ristoratore vuole davvero a fine serata.
- I buoni pasto meritano attenzione: spesso valore nominale ≠ incassato (commissioni circuito), e non danno resto. `meta` può tenere nominale vs incassato.

Casi particolari da modellare come metodi, non come hack:

- **Omaggio/offerto** — il conto chiude a zero fiscale ma vuoi tracciare chi ha offerto e perché (autorizzazione: permesso dedicato, non `payments:full` generico).
- **Sospeso** (conto del cliente abituale) — qui c'è l'aggancio CRM: un ledger per cliente, saldabile in blocco. Vedi punto 4.

## 2. Fatturazione: il tema fiscale italiano

"Fatturazione" in Italia al ristorante significa due documenti distinti, e il flusso di chiusura deve chiedere **quale**:

### a) Documento commerciale (scontrino elettronico) — il default

- **Registratore Telematico fisico** (Epson FP-81II, Custom, RCH): quasi tutti espongono un'API HTTP/XML sulla LAN (es. Epson ePOS fiscal). Il CRM manda le righe, l'RT stampa e trasmette all'AdE. Strada classica ma vincola a stampante in LAN — nota: esiste già un "print agent" nello stack locale (`test-locale.sh`), potrebbe fare da ponte.
- **Soluzione software certificata / provider cloud** (A-Cube, Openapi, Fatture in Cloud): documento commerciale via API senza RT, alternativa ufficiale agli RT (art. 24 D.Lgs. 1/2024, specifiche tecniche nel Provvedimento AdE n. 111204/2025). Più pulito per un SaaS multitenant (che è nel piano), perché non dipende dall'hardware di ogni ristorante.

**Deciso: si implementano entrambe le strade**, con scelta per-tenant (pattern già usato per il gateway di pagamento in `/settings/payments/provider`): un ristorante con RT in sala usa la stampante fisica, uno nuovo parte direttamente cloud. Serve quindi un'astrazione `FiscalProvider` con due driver (`rt-local` via print agent, `cloud` via API provider) dietro un'interfaccia comune — il resto del flusso di chiusura non deve sapere quale dei due c'è dietro.

**Scontrino cartaceo con la soluzione cloud** (verificato ago 2026): con la soluzione software e pagamento elettronico il documento commerciale può essere emesso, trasmesso e conservato **solo in digitale** (email/QR), senza stampa. Il cliente ha però **sempre diritto alla copia cartacea gratuita su richiesta** — quindi anche il tenant "cloud" deve poter stampare su una comune stampante non fiscale (il print agent copre anche questo). Attenzione inoltre: dal 1° gennaio 2026 è in vigore l'**obbligo di collegamento tra POS e sistema di certificazione dei corrispettivi** (RT o software certificato — Legge di Bilancio 2025): il metodo `POS_FISICO` di `bill_payments` non è solo un dato di cassa, prima o poi dovrà dialogare con lo strato fiscale.

### b) Fattura elettronica (SDI)

Quando il cliente la chiede al posto dello scontrino. Serve raccogliere P.IVA/CF + codice destinatario o PEC (e qui il CRM brilla: se il cliente è in anagrafica, i dati fiscali sono già lì). Generazione XML FatturaPA e invio via provider (Aruba, Fatture in Cloud, A-Cube). Costruirsi l'accreditamento SDI in proprio non ha senso.

### Implicazioni sul modello dati

- Il documento fiscale è un'entità propria: `fiscal_documents (bill_id, tipo scontrino|fattura, stato PENDING|SENT|CONFIRMED|FAILED, provider_ref, xml/payload, totali per aliquota)`. Deve sopravvivere a retry — la trasmissione può fallire e il conto deve comunque chiudersi operativamente (tavolo libero) con il fiscale in coda.
- **IVA per riga**: le voci del conto devono portare l'aliquota (somministrazione 10%, asporto/vendita 10/22%, coperto 10%). Oggi `TableBillItem` non ha l'aliquota — va aggiunta, ed è il momento giusto perché il conto nascerà dalle comande (punto 3).
- **Fattura su split**: caso reale frequente — tavolo misto dove l'azienda paga la sua quota *con fattura* e il resto va a scontrino. Se il documento fiscale aggancia lo split invece del bill intero, il caso viene gratis.
- Le **mance** vanno tenute fuori dall'imponibile del documento (e godono di tassazione agevolata per il personale) — già separate in `tip_cents`, bene così.

## 3. Il flusso di chiusura ideale (unendo comande + conto)

Ora che le comande sono in-house, `items` non deve più aspettare Passepartout:

1. **Genera conto dalla comanda** — le righe (con prezzi snapshot e modificatori, già congelati) popolano `items` con aliquota IVA. Il totale non è più battuto a mano.
2. **Preconto** — stampa/QR non fiscale col dettaglio, mentre il tavolo è `DEPARTING`. Già coerente con lo stato "in uscita" esistente.
3. **Incassi** — il cameriere registra i movimenti (contanti con calcolo resto, POS, buoni…) e/o i clienti pagano via QR; il residuo scende in tempo reale via socket (infrastruttura già pronta).
4. **Documento fiscale** — scelta scontrino/fattura (anche per split), invio, gestione fallimento in coda.
5. **`CLOSED`** → tavolo libero, broadcast `bill:closed` (già esistente).

Manca oggi anche la **riapertura** del conto chiuso per errore: c'è solo `void`. Con i movimenti di incasso tracciati, riaprire = riportare a `OPEN` mantenendo i movimenti (con audit), invece di annullare e ribattere tutto.

## 4. L'angolo CRM (il differenziante vero)

- **Storico spesa per cliente**: bill → reservation → customer. Spend totale, scontrino medio, frequenza — alimenta segmentazione e marketing già in uso.
- **Conto azienda**: clienti corporate con "sospeso" strutturato e **fattura riepilogativa mensile** — per pranzi di lavoro ricorrenti è oro, e nessun POS puro lo fa bene.
- **Caparre**: già gestite come credito nel conto — con la fattura serve deciderne il trattamento fiscale (la caparra confirmatoria non è imponibile finché non diventa corrispettivo).

## 5. Ordine di lavoro proposto

1. **`bill_payments` multi-metodo + chiusura di cassa giornaliera** — solo codice interno, valore immediato, prerequisito di tutto il resto. ✅ *Implementata (24 ago 2026): tabella `table_bill_payments` (migration `1787650000000_libro-cassa-incassi.js`, con backfill), endpoint `POST /bills/:id/payments`, storno soft-void, chiusura multi-metodo retrocompatibile, `GET /reports/cash-closure`, dialog di chiusura multi-metodo e sezione Cassa nella pagina Pagamenti. Test in `tests/api/orders-cassa-incassi.test.ts`.*
2. **Conto dalle comande + IVA per riga + preconto** — sblocca il fiscale. ✅ *Completata (24 ago 2026): conto dalle comande e preconto esistevano già; aggiunta l'IVA per riga — `vat_rate` su `dishes` (default 10, selettore nel menù) e snapshot su `order_items` alla battitura (migration `1787700000000_iva-per-riga.js`), coperto/servizio al 10%, scomposizione per aliquota (`vat_breakdown`, scorporo IVA inclusa con sconti ripartiti) sulla bill view e nel payload del preconto. Test in `tests/api/orders-iva-riga.test.ts`.*
3. **Documento commerciale** dietro l'astrazione `FiscalProvider`, partendo dal driver cloud (nessun hardware richiesto) e aggiungendo il driver RT via print agent subito dopo. 🚧 *Prototipo implementato (24 ago 2026): tabella `fiscal_documents` (migration `1787750000000`), driver in `services/fiscalService.ts` (Openapi `POST /IT-e-receipts` sandbox + mock per i test), emissione automatica non bloccante alla chiusura dei conti CLOSED, retry/annullo via `POST /bills/:id/fiscal-docs[/:fid/void]`, config per-tenant in `GET/PUT /settings/fiscal` (token piattaforma in env `OPENAPI_INVOICE_TOKEN`). Mapping metodi→campi documento e codici natura N* da validare col commercialista. Test in `tests/api/orders-fiscale.test.ts`. **Verificato live in sandbox (24 ago 2026)**: configurazione `IT-configurations` con `e_receipts` (P.IVA test 88806881905, store+cassa con provisioning mTLS asincrono ~1 min), chiusura multi-metodo dal CRM → scontrino emesso e annullato via `/IT-e-receipts`; la prova ha scovato e fatto correggere un race emissione automatica vs manuale (claim atomico su attempts). UI (24 ago 2026): card "Scontrino" nel dettaglio del conto chiuso (stato, emetti/riprova, annullo con conferma a due tap), badge nella vista Chiusi (solo gli stati che chiedono attenzione: errore, in emissione, senza scontrino), card "Scontrino elettronico" in Impostazioni → Pagamenti (provider + P.IVA, avviso token mancante). Verificata visivamente su stack locale.*
4. **Fattura elettronica** su bill e su split, dati fiscali in anagrafica cliente. ✅ *Implementata (26 ago 2026): builder FatturaPA FPR12 in `services/fiscalService.ts` (righe per aliquota dallo scorporo IVA, prezzi al netto, riepiloghi che quadrano per costruzione), `POST /bills/:id/invoices` su conto CLOSED o su quota PAID, numerazione annuale per tenant sotto lock (`invoice_counters` — le guardie girano PRIMA della numerazione: niente buchi), regola "un solo binario fiscale" (scontrino vivo blocca la fattura e viceversa, incluso lo skip dell'emissione automatica), `customers.billing` in rubrica con UI, dialog "Emetti fattura" sul conto con picker cliente, dati cedente in Impostazioni. Annullo fattura volutamente bloccato: serve la nota di credito TD04 (fase successiva). Verificata live in sandbox: XML accettato dal provider (fattura 1/2026). Test in `tests/api/orders-fatture.test.ts`. Per il commercialista: natura N2.2 su IVA zero, mixed scontrino-parziale + fattura-quota non supportato.*
5. **Conti azienda / riepilogativa mensile**.

## 6. Decisioni prese (24 ago 2026)

1. **Fiscale: entrambe le strade, scelta per-tenant.** RT fisico *e* provider cloud, dietro un'unica astrazione `FiscalProvider` configurata nelle impostazioni del tenant (stesso pattern del provider di pagamento Revolut/SumUp). Motivazione: un cliente può preferire la stampante fisica che già possiede, un altro partire cloud senza hardware. Con la soluzione cloud lo scontrino cartaceo non è più obbligatorio (consegna digitale), ma resta dovuto gratuitamente su richiesta del cliente — quindi la stampa non fiscale va comunque supportata.
2. **`bill_payments` come vista unica degli incassi.** Gli split restano la macchina a stati del claim pay-at-table; ogni pagamento confermato dal gateway genera anche la riga in `bill_payments` (`method='LINK_ONLINE'`, con riferimento allo split). `bill_payments` è il libro cassa: chiusura giornaliera, report e residuo si calcolano solo da lì.
