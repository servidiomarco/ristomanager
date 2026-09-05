# Serata pilota — comande native nel CRM, scontrini dall'RT di cassa

*Aggiornato al 4 settembre 2026. La procedura operativa per la prima serata
(e per il periodo ponte che segue): le comande girano nel CRM — palmare,
cucina, passe, conto, incassi — e il documento fiscale continua a uscire dal
registratore telematico della cassa, finché Openapi o un concorrente non
apre in produzione il binario e-receipts (a quel punto: vedi
[go-live-fiscale](go-live-fiscale.md)). Manuali di riferimento:
[manuale comande/cucina/passe](manuale-operativo-comande-cucina-passe.md),
[regole di flusso cassa](cassa-plan.md).*

## Obiettivo e perimetro

- Comande native CRM su un gruppo di tavoli pilota (o tutta la sala, a
  scelta della serata). La cassa Passepartout resta accesa e operativa.
- Lo scontrino lo batte SEMPRE il cassiere sull'RT, come oggi. Nel CRM la
  chiusura del conto si fa col documento **"Cassa"**, riportando il numero
  scontrino: così il conto risulta documentato e il riscontro serale
  CRM ↔ registratore quadra riga per riga.
- Niente credenziali AdE, niente provider cloud: le impostazioni fiscali del
  tenant restano con provider **none** per tutta la fase ponte.

## La settimana prima (una volta sola)

- [ ] Impostazioni → Sala & Cucina: modulo comande attivo; partite censite
      (antipasti, primi, bar, ...) con la loro stampante; **"Stampa prova"**
      su OGNI termica di partita.
- [ ] Agente di stampa **online** (pallino verde in Sala & Cucina). Se è
      spento: riavviare il Raspberry/PC in sala prima del servizio, non
      durante.
- [ ] Modalità di lancio decisa (stampa in partita vs solo monitor): se una
      stampante di partita è inaffidabile, meglio deciderlo ORA — il lancio
      di un'uscita NON parte se la stampa fallisce.
- [ ] Menu allineato: i piatti importati dalla cassa (`pp:articolo:*`) sono
      già utilizzabili nelle comande native; verificare stazione e prezzo
      dei piatti che si vendono di più.
- [ ] Conto al tavolo attivo (Impostazioni → Conto al tavolo) e instradamento
      del preconto sulla termica giusta.
- [ ] Utenti e permessi: camerieri con presa comande, cassiere col ruolo
      CASSA; login provati SUI PALMARI, non solo al desktop.
- [ ] Palmari carichi, sulla WiFi di sala, con l'app aperta sul CRM.

## Le regole della serata (da stampare e appendere in cassa)

**Cameriere**
1. Comanda sul palmare CRM: tavolo → piatti → uscite → lancio. La cucina
   riceve stampa e monitor come da manuale.
2. Variazioni e storni dal palmare (il passe vede tutto). NON usare la cassa
   per le comande dei tavoli pilota.
3. Preconto dalla termica quando il tavolo lo chiede.

**Cassiere**
1. Il cliente paga: registra i movimenti nel CRM (contanti/POS/…, il resto
   lo calcola il CRM).
2. **Batti lo scontrino sull'RT** come sempre, dall'importo del preconto.
3. Nel CRM chiudi il conto con documento **"Cassa"** e riporta il **numero
   scontrino** dal tagliando dell'RT. (La scelta resta memorizzata: dalla
   seconda chiusura è già selezionata.)
4. Fattura invece dello scontrino: chip "Fattura" — il conto si chiude e la
   fattura si emette dal conto coi dati del cliente (durante il ponte, se il
   provider è spento, la fattura si fa come oggi dal gestionale/commercialista).
5. **Scontrino parlante** (col codice fiscale): il CF va inserito **sulla
   cassa PRIMA di battere** — a scontrino emesso non si aggiunge. Il CF è
   spesso già in anagrafica cliente nel CRM: leggilo da lì. In alternativa
   proponi la fattura, che è il documento giusto per aziende e professionisti.
6. **Lotteria degli scontrini**: durante il ponte il codice del cliente si
   inserisce sull'RT (come oggi). Ricorda: lotteria e parlante si escludono
   — o il codice lotteria o il codice fiscale, mai entrambi.

**Per tutti — le due trappole**
- ⚠️ **NON toccare "Importa dal gestionale"** nel dettaglio prenotazione:
  riporta il conto sul binario Passepartout e la chiusura cambia
  comportamento. Per la pilota le comande nascono SOLO dal palmare.
- ⚠️ Lo scontrino di un tavolo pilota si batte UNA volta sola sull'RT: il
  CRM non emette niente (provider spento), quindi nessun rischio di doppio
  documento — ma il doppio battuto in cassa sì, ed è un annullo da fare sul
  registratore.

## Se qualcosa si rompe

| Problema | Cosa fare |
|---|---|
| Stampante di partita giù | La cucina lavora dal monitor di partita; la stampante si sistema fra un'uscita e l'altra. |
| Palmare giù | Comanda da un altro palmare o dal desktop; il conto non si perde. |
| CRM irraggiungibile | Rollback = tornare alla cassa Passepartout com'è sempre stato. I tavoli già aperti nel CRM si chiudono quando torna su (i movimenti offline si mettono in coda). |
| Conto chiuso senza numero scontrino | Dal conto (o da Pagamenti → Chiusura): bottone **"Scontrino di cassa"**, si inserisce il numero a posteriori. |
| Scontrino battuto ma conto chiuso "Proforma" per sbaglio | Stesso bottone: la registrazione supera la proforma da sola. |

## Fine serata — il riscontro (10 minuti)

1. **Pagamenti → Chiusura** nel CRM: totali per metodo + elenco conti, ognuno
   con la pill "scontrino di cassa" e il suo numero.
2. **Chiusura giornaliera dell'RT**: il totale corrispettivi del registratore
   deve combaciare con la somma dei conti pilota (più l'eventuale battuto
   fuori pilota).
3. Ogni conto **"senza documento"** è una dimenticanza: numero dal rotolo
   dell'RT → "Scontrino di cassa" a posteriori. Zero righe scoperte prima di
   spegnere le luci.
4. Vista **Fiscalità**: il periodo mostra i documenti del giorno ("scontrino
   di cassa" nel registro); il CSV del registro è l'elenco da conservare
   accanto alla chiusura RT.

**Criteri di successo**: zero conti persi o doppi; delta CRM ↔ RT = 0; lo
staff chiude i tavoli senza chiedere aiuto entro fine serata.

## Dopo la pilota

- Estendere a tutta la sala quando lo staff è fluido (di solito 2–3 servizi).
- L'RT resta il punto di emissione per tutto il ponte. Quando il binario
  e-receipts apre in produzione: si accende il provider nelle impostazioni
  fiscali, il chip di default della chiusura torna "Scontrino", e l'RT si
  dismette col tecnico ([go-live-fiscale](go-live-fiscale.md), passi 3–6).
- La disdetta Passepartout si valuta SOLO dopo settimane di riscontri a zero
  delta — la cassa accesa non costa errori, la fretta sì.
