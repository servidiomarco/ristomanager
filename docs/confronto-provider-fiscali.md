# Confronto provider fiscali — documento commerciale e fattura elettronica

*24 agosto 2026 — istruttoria per le fasi 3–4 del piano fatturazione
([fatturazione-chiusura-conto-brainstorm](fatturazione-chiusura-conto-brainstorm.md)).
Prezzi e condizioni vanno riverificati a ridosso della firma: cambiano spesso.*

## Cosa ci serve

Dal piano (decisioni §6): un'astrazione `FiscalProvider` con due driver — `cloud`
(API provider, nessun hardware) e `rt-local` (stampante RT via print agent) —
scelta per-tenant. Il driver cloud deve coprire:

1. **Documento commerciale** (scontrino): emissione dal conto alla chiusura,
   con i totali per aliquota già pronti (`vat_breakdown`), annulli e resi,
   consegna digitale (email/QR) + PDF stampabile su termica non fiscale.
2. **Fattura elettronica** via SDI su conto intero o su split (XML FatturaPA).
3. **Multi-tenant**: una configurazione per ristorante, onboarding via API —
   siamo un SaaS, non un singolo esercente.

## I due binari normativi (contesto 2026)

- **Documento commerciale online** — la procedura web dell'AdE su "Fatture e
  Corrispettivi", automatizzabile via API dai cosiddetti *velocizzatori*.
  Richiede le credenziali AdE di un soggetto delegato (l'esercente o un
  intermediario con delega). È il binario su cui operano OGGI i servizi
  scontrino di Openapi e A-Cube.
- **Soluzione software certificata** — l'alternativa ufficiale agli RT
  (art. 24 D.Lgs. 1/2024, specifiche nel provv. AdE n. 111204/2025,
  architettura PEM/PEL, certificazione da enti accreditati — l'elenco AdE
  degli erogatori/certificatori è pubblico e aggiornato). Niente credenziali
  delegate: il software È il punto di emissione. I provider ci stanno
  migrando (Openapi annuncia il nuovo servizio "E-Receipts" con prezzi più
  bassi; A-Cube dichiara conformità PEM/PEL).
- Dal 1° gennaio 2026 vige l'**obbligo di collegamento POS ↔ strumento di
  certificazione** (L. Bilancio 2025): nel medio periodo il metodo
  `POS_FISICO` del libro cassa dovrà dialogare con questo strato.

## Confronto

| | **Openapi** | **A-Cube** | **Fatture in Cloud** |
|---|---|---|---|
| Documento commerciale via API | ✅ `POST /IT-receipts` (articoli, aliquote, resi/annulli nel payload) | ✅ API REST JSON (documento, annullo, reso) | ❌ non è il suo mestiere: i "corrispettivi" sono registrazioni contabili, non trasmissione AdE (da confermare) |
| Binario oggi | Documento commerciale online (velocizzatore, serve delega + credenziali AdE del delegato; salvano solo il fingerprint) | Documento commerciale online con delega; dichiara conformità soluzione certificata (PEM/PEL) per il 2026 | — |
| Fattura elettronica SDI | ✅ stessa console/API (prodotto SDI dedicato) | ✅ prodotto e-invoicing Italia + estero | ✅ core del prodotto, API matura (OAuth, SDK) |
| Lotteria degli scontrini | ✅ (campo `lottery_code`) | non verificato | — |
| PDF / consegna digitale | ✅ PDF via GET | ✅ PDF personalizzabile (logo/colori), invio email con template | — |
| Multi-tenant / SaaS | ✅ esplicito: una configurazione per esercente, credenziali delegato riusabili; oltre 10 configurazioni +1 €/config | ✅ dashboard per P.IVA, webhook per comportamenti per azienda; contratto annuale su prodotti/volumi/entità legali | ⚠️ modello per-esercente: ogni ristorante dovrebbe avere una licenza Fatture in Cloud propria (OAuth per account) |
| Prezzi scontrino | Pubblici: 0,019 €+IVA a consumo; abbonamento da 0,009 € (1M call/anno) a 0,017 € (5k/anno); nuovo E-Receipts annunciato da 0,0034 €/richiesta | Non pubblici: preventivo annuale; fasce riportate da terzi (~30–40 €/mese per 50–200 doc) da verificare | n/d |
| Sandbox | ✅ console con ambiente test | ✅ sandbox gratuita con dashboard | ✅ |
| Extra rilevanti | Callback/webhook eventi; un solo fornitore per scontrino+SDI | Integrazione nativa Stripe (fiscalizzazione automatica del pagamento); conservazione | Ecosistema gestionale completo (TeamSystem) che l'esercente può già usare |

## Lettura

- **Openapi** è il candidato naturale per il **prototipo del driver `cloud`**:
  prezzi pubblici e bassi, modello multi-merchant esplicito (una config per
  tenant), scontrino e SDI sotto la stessa console, sandbox subito. Contro:
  è un "velocizzatore" — serve la delega AdE per ogni esercente (pratica da
  incorporare nell'onboarding tenant) — e il servizio è in transizione verso
  E-Receipts a gennaio: da chiarire la migrazione.
- **A-Cube** è il candidato più "prodotto": PDF brandizzati, email, Stripe,
  conservazione, posizionamento esplicito sulla soluzione certificata
  PEM/PEL. Contro: prezzi solo a preventivo (per un SaaS il costo unitario
  conta) e contratto annuale per entità legali — da negoziare in ottica
  rivenditore.
- **Fatture in Cloud** non è un driver fiscale white-label: è il gestionale
  dell'esercente. Ha senso solo come *integrazione* (spingere le fatture del
  CRM nella contabilità di chi già lo usa), non come motore di emissione.
  Scartato per le fasi 3–4.

## Raccomandazione

1. Prototipare il driver `cloud` su **Openapi** in sandbox (scontrino da
   `vat_breakdown` + annullo/reso), chiedendo nel frattempo: roadmap
   E-Receipts (certificato?), gestione delega per i tenant, SLA.
2. In parallelo chiedere **preventivo ad A-Cube** con lo scenario SaaS
   multi-ristorante; se il costo unitario regge, è l'alternativa con meno
   lavoro nostro (PDF, email, conservazione già fatti).
3. Decidere il fornitore SDI **dopo** il prototipo scontrino: entrambi lo
   offrono, e tenerli sotto lo stesso contratto semplifica.
4. L'interfaccia `FiscalProvider` resta neutra: la delega/credenziali sono
   configurazione del tenant, mai hardcoded sul provider.

## Fonti

- Openapi — [prodotto Scontrini Elettronici](https://openapi.com/products/electronic-receipt-italy) · [perché l'integrazione API](https://openapi.com/blog/tax-receipt-api) · [cosa cambia nel 2026](https://openapi.com/blog/electronic-receipt-what-changes-in-2026) · [docs/FAQ console](https://console.openapi.com/apis/invoice/documentation)
- A-Cube — [API Corrispettivi Elettronici](https://www.acubeapi.com/prodotti/api-corrispettivi-elettronici) · [modelli operativi 2026](https://www.acubeapi.com/blog/api-per-invio-corrispettivi-all-agenzia-delle-entrate-nel-2026-modelli-operativi-e-soluzioni-api) · [e-invoicing Italia](https://www.acubeapi.com/prodotti/api-e-invoicing-italia)
- Agenzia delle Entrate — [Soluzioni software](https://www.agenziaentrate.gov.it/portale/it/soluzioni-software) · [enti certificatori](https://www.agenziaentrate.gov.it/portale/it/enti-certificatori) · [specifiche tecniche invio corrispettivi](https://www.agenziaentrate.gov.it/portale/specifiche-tecniche-allegati-invio-corrispettivi-soluzione-software)
- Fatture in Cloud — [portale sviluppatori](https://developers.fattureincloud.it/)
