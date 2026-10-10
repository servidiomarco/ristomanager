# Manuale operativo — Comande, Cucina, Passe

Aggiornato al 10 ottobre 2026. Vale per comande, cucina, passe e cassa come
sono in produzione, compresa la scrittura delle comande nella cassa
Passepartout (§6).

## Il giro in una frase

La sala **propone**, il passe **lancia**, la partita **cucina e spunta**, il
passe **chiama e serve**. Ogni passaggio ha il suo annulla: **torna in bozza**
prima del lancio, **annulla chiamata** finché nessun piatto è in lavorazione,
**annulla spunta** prima del servito, **riporta** dopo il servito.

```
sala                passe               cucina              passe
Invia  ────────►  Lancia  ────────►  spunta i piatti ──►  Chiama → Servita
  ▲                  │                     │                   │
  └ torna in bozza ◄─┘     annulla ◄───────┘     riporta ◄─────┘
      (se non lanciata)    (se non servita)      (entro 30′)
```

Chi vede cosa: **Comande** la usano i camerieri, **Cucina** è il monitor di
partita (una postazione = uno schermo), **Passe** è l'unico posto che vede
l'uscita intera attraverso tutte le partite, **Cassa** è il banco dove si
incassa e si chiude la giornata.

---

## 1 · Comande (il palmare del cameriere)

### La griglia dei tavoli

- Le tessere sono in ordine di numero, con le **sale in pista** sopra (Tutte,
  e una per sala col conteggio). Ogni tessera dice numero e pallino di stato,
  coperti, chi è al tavolo e la riga di stato: «134,00 € · 2ª in cucina»,
  «62,00 € · da incassare», l'ora per i prenotati, «libero».
- Gli stati usano le stesse parole delle pastiglie della comanda: *in bozza*,
  *al passe*, *in cucina*, *al bar*, *pronta*, *servita*.
- L'**imbuto** filtra per stato: conti da incassare, comande aperte, in
  arrivo, liberi.
- Una **comanda appesa** (rimasta aperta da un servizio passato) resta in
  griglia, in verde, con «appesa da ieri» (o da pranzo, o dalla data): toccarla
  la riprende nel suo servizio. Un tavolo con una comanda aperta non è mai
  «libero».
- I **tavoli uniti** sono una tessera sola («11+12», coperti sommati) e il
  tocco apre il tavolo giusto dell'unione.
- Sullo schermo largo Comande prende tutta la pagina: barra con ricerca
  tavolo, imbuto e pastiglia **Live** (ora e connessione), barra laterale
  ritirata nel bollo col marchio. Giorno e turno non si cambiano da qui:
  Comande lavora il servizio in corso.

### Aprire il tavolo

- Tocca il tavolo. Se c'è già una comanda aperta si riprende quella; se c'è un
  conto da incassare si apre il conto, e la comanda nuova parte solo da lì con
  un'azione esplicita.
- Sul telefono il tavolo prende tutto lo schermo: in cima la scheda del tavolo
  con la freccia indietro, la lente per cercare un piatto e il menu ⋮.
- In testa: **Tav. N**, i coperti, chi è al tavolo col totale («Senza
  prenotazione» per i walk-in). Se la comanda l'ha aperta un collega o la
  cassa, lo dice («Comanda di Luca», «dalla cassa»).
- I coperti arrivano dalla prenotazione (o dai posti del tavolo per i
  walk-in): correggili subito se il numero è cambiato, alimentano il conto.
- Se sul tavolo sta già lavorando un collega da un altro palmare, un banner lo
  dice per nome e da quanto («Ci sta lavorando anche Rosa · da 3′»). Non
  blocca niente: si continua a lavorare, ma nessuno batte gli stessi piatti
  senza sapere dell'altro.
- Aprire un tavolo e uscire senza battere niente non lascia una comanda
  vuota: si disfa da sola.

### Battere i piatti

- **Nella lista del palmare si batte dal «+»**. Il tocco sul nome non batte:
  apre e richiude il cassetto delle combinazioni già battute (vedi sotto).
  Sulla griglia dello schermo largo batte il tocco sulla scheda, con lo
  stepper − / + sotto il prezzo.
- **Varianti**: il «+» batte subito anche un piatto con varianti facoltative;
  si scelgono dopo, dal foglio di riga, oppure prima col **tocco lungo** sul
  piatto. Il foglio si apre da solo solo dove serve per forza: piatti al peso
  e varianti obbligatorie (la cottura), con lo stepper per battere più pezzi
  in un colpo.
- **Varianti a scala**: nei gruppi a scelta multipla − e + muovono ogni
  variante su quattro gradini — «+ Nduja» (aggiunta, col sovrapprezzo),
  «Molta Nduja» (stesso addebito), «Senza Nduja» (tolta), «Poca Nduja»
  (gratis). Il bottone di conferma mostra il prezzo vivo del pezzo.
- **Al peso**: il foglio chiede i grammi, con i chip sul range del piatto;
  il prezzo è al kg.
- **«Aggiungi un altro»** nel foglio batte la riga com'è e azzera il foglio
  senza chiuderlo: due bistecche con peso e cottura diversi in un'apertura
  sola. «Aggiungi» batte e chiude.
- **Il cassetto delle combinazioni**: sotto il piatto battuto compaiono le sue
  righe («liscia», «+ Sale»…), ognuna col suo stepper e col chip della sua
  uscita. Il tocco su una riga apre il suo foglio; il chip la sposta in
  un'altra uscita.
- **Dividere una riga**: su una riga da 2 o più pezzi, scegliere nel foglio
  una quantità minore con varianti diverse divide la riga — «2× filetto, uno
  al sangue» senza ribattere niente.
- **Vino consigliato**: se il piatto ha vini abbinati, il foglio ha la scheda
  «Vino consigliato»; il «+» batte il calice direttamente nell'uscita Bar.
- **Foto**: la miniatura accanto al nome non batte: apre la foto a tutto
  schermo per mostrarla all'ospite. Un tocco ovunque chiude.

### Le uscite

- I piatti vanno nell'**uscita** corrente (1ª–6ª). Il numero proposto è
  quello dopo l'ultima già mandata. Al primo pezzo battuto, sulla riga del
  piatto compare l'uscita di destinazione («2ª uscita», «Bar»): un tocco lì la
  cambia.
- **Uscita Bar** (in testa) e **uscita Dolci** (in coda): i piatti delle
  categorie segnate «bar» o «dolci» ci vanno da soli, qualunque uscita sia
  selezionata. Partono all'invio, senza aspettare il passe e senza rubare il
  turno alle uscite di cucina.
- **Spostare**: una riga in bozza si sposta col **tocco lungo sulla riga** —
  si stacca con una vibrazione, si trascina sull'uscita di arrivo; rilasciata
  senza muoverla apre il selettore. L'uscita intera si sposta dalla maniglia
  ⇕ sul suo bordo (tocco = selettore, trascinata = sposta).
- **Eliminare un'uscita**: dal selettore della maniglia, «Elimina la 2ª
  uscita» toglie tutte le sue righe non inviate. Le righe già inviate restano
  e si stornano.
- **Ripetere un giro**: nella lettura «Tutto il tavolo» della comanda,
  «Ripeti tutto nella 2ª uscita» rimette in bozza, nell'uscita in
  composizione, i piatti già ordinati dal tavolo (ogni riga ha anche il suo
  tasto per ripeterla da sola). Controlla e invia.
- Varianti e note viaggiano sulla riga e la cucina le vede sempre.

### Inviare

- Il bottone in fondo dice cosa manda e quanto vale: «Invia 2ª uscita ·
  36,00 €». «Invia tutto» manda anche le bozze delle altre uscite.
- Dopo l'invio un piccolo volo sul bottone dice cosa è partito (piatto per la
  cucina, bottiglia per il bar, fetta di torta per i dolci) e si torna alla
  griglia tavoli. Le bozze delle altre uscite restano.
- Cosa parte da solo dipende dalla modalità di lancio (vedi §4): la pastiglia
  dell'uscita dice sempre la verità — *in bozza*, *al passe*, *in cucina*,
  *al bar*, *pronta*, *servita* — e si aggiorna da sola.
- I piatti aggiunti a un'uscita già partita vanno in cucina subito all'invio,
  in qualunque modalità.
- Le righe non inviate restano sul palmare anche uscendo dal tavolo: al
  ritorno un avviso dice che sono una bozza e non sono in cucina. Se la rete
  è giù, l'invio lo dice («Linea giù: comanda non inviata») e si riprova.

### Battere i tempi dal palmare

Dove le uscite le chiama chi è al tavolo, non il passe:

- **Chiama** (sull'uscita *al passe*): la lancia in cucina dal palmare.
- **torna in bozza** (sull'uscita *al passe*): l'uscita torna in bozza, la
  cucina non la vede; si corregge e si rimanda.
- **annulla chiamata** (sull'uscita *in cucina*, finché nessun piatto è in
  lavorazione): l'uscita torna in coda come se non fosse mai partita, le card
  spariscono dai monitor e in partita esce il ticket «annullo chiamata». È il
  rimedio al tavolo sbagliato; quando un piatto è già in lavorazione si
  storna.

### Correggere

- **Storno** di una riga inviata, con motivazione obbligatoria (scelta fra
  «Errore di battitura», «Cliente ha cambiato idea», «Piatto non riuscito»,
  «Ingrediente finito», o scritta). La motivazione finisce nelle statistiche
  degli scarti: scrivila vera. Su una riga da 2 o più pezzi si sceglie quanti
  stornarne: la riga resta in cucina con la quantità scalata.
- **Sposta tavolo** (menu ⋮): comanda e conto passano su un altro tavolo,
  cucina compresa; le quote già pagate restano attaccate al conto.
- **Svuota le righe non inviate** (menu ⋮): via tutte le bozze.
- **Elimina la comanda** (menu ⋮): via la comanda intera, righe già in cucina
  comprese, finché non c'è un conto. Serve il permesso di storno e una
  motivazione, che resta nel registro attività; le card spariscono anche dai
  monitor. È per la comanda di prova o aperta per sbaglio.

### Quando l'uscita è pronta

Quando la cucina spunta l'ultima riga dell'uscita arriva da sola una
**notifica push** ai ruoli di sala («Tavolo 40 — cucina · 2ª uscita pronta»)
e il palmare suona con una vibrazione, anche se sei sulla griglia tavoli o su
un altro tavolo. Se poi il passe preme *Chiama*, l'avviso suona di nuovo e la
notifica si aggiorna invece di raddoppiare. Vai a ritirare.

La notifica si spegne per tutti quando l'uscita è servita, quando il cuoco
toglie la spunta «pronto» (si riaccende al nuovo pronto) e quando la comanda
viene chiusa o cancellata. Con le notifiche del telefono attive arriva anche
sullo smartwatch abbinato. Il suono si spegne per dispositivo dal menu ⋮
(«Avvisi sonori»).

### Il conto dal palmare

- **Conto** (in testa o nel menu ⋮) chiude la comanda e apre il conto del
  tavolo: dopo non si aggiungono piatti. Le righe non ancora inviate vengono
  scartate, e la conferma lo dice prima.
- **Chiusura a un tocco**: **Scontrino contanti** e **Scontrino POS** incassano
  l'importo pieno ed emettono lo scontrino in un gesto; **Preconto** lo stampa
  in sala; **Incassa con la cassa** apre il pannello completo (dividi, misto,
  sospeso, mancia) per chi ha il permesso di cassa. Se c'è una mancia, la
  chiusura chiede come è stata data (contanti, POS o Satispay).
- Scegliendo **Fattura**, il conto si chiude senza scontrino e l'emissione
  della fattura si apre subito, coi dati del cliente.
- **Sconto** (menu ⋮): a importo o in percentuale, con motivazione; resta a
  registro col nome di chi lo fa.

### Il menu ⋮ del tavolo

Conto · Sconto · Sposta tavolo · **Vista compatta** (righe fitte, 6–7 piatti
in vista; la scelta resta sul dispositivo) · Avvisi sonori · Svuota le righe
non inviate · Elimina la comanda. Col layout «a pagine» anche la vista delle
categorie: in lista o a bottoni da 3 o 4 per riga.

### Il layout «a pagine»

Per chi ha la memoria muscolare dell'app di cassa: si sceglie in Impostazioni
→ Profilo → «Comande sul palmare» e segue l'operatore su ogni palmare.

- Pagina delle categorie (con la ricerca in testa), dentro la categoria la
  lista dei piatti, freccia per tornare.
- Barra in basso fissa **Tavoli · Comanda · Menu**; la Comanda si apre a tutta
  pagina, col pallino se ci sono bozze da inviare. Sotto il pollice l'uscita
  in composizione e il bottone **Segue**, con a destra il totale da inviare.
- La griglia tavoli si sfoglia per sala, con le linguette in basso.
- Con le categorie a bottoni, le sezioni Cucina, Bar e Dolci sono divise; con
  l'uscita Bar in composizione Cucina e Dolci si attenuano (e viceversa coi
  Dolci), ma restano toccabili.

---

## 2 · Cucina (il monitor di partita)

### Impostare lo schermo

- Al primo avvio scegli la **partita** (Antipasti, Primi, Griglia…): resta
  impostata anche dopo un riavvio del tablet. Si cambia da *Cambia partita*.
  «Senza partita» mostra i piatti non assegnati ad alcuna postazione.
- In alto: il nome della partita, l'interruttore **In lavorazione /
  Consegnate**, la **lente** di ricerca, la pastiglia **Note del servizio**
  quando il turno ne ha (piatti prenotati, allergie) e la **campana**.
- La campana accende o spegne l'avviso sonoro della comanda nuova. È accesa
  di default, ma il browser suona solo dopo il primo tocco sullo schermo: la
  scelta della partita a inizio turno basta.

### Leggere lo schermo

- **Una colonna = una comanda.** In testa il tavolo, chi l'ha presa («di
  Luca»), l'ora di apertura e i coperti; sotto, appese al filo, le sue uscite:
  quella da lavorare distesa, le servite compresse e attenuate, quelle che
  devono ancora partire tratteggiate. Il ritmo del tavolo si legge su una
  colonna sola, come sul ticket di carta.
- Sulla card dell'uscita ci sono solo le righe della tua partita. Il timer è
  verde fino a 5′, ambra fino a 10′, poi rosso.
- La striscia **allergie** rossa viene dalle note della prenotazione: leggila
  prima di partire.
- **Toccare la testata** apre la comanda per intero: tutte le uscite in
  ordine, con varianti, note e stato, e l'avviso allergie in testa.
- **Le altre partite della stessa uscita** stanno in piede di card: un
  pallino per partita (in coda / in lavorazione / pronta) col numero di
  piatti. La pasta sa quanto manca alla griglia prima di calare. Un tocco le
  apre in sola lettura.
- La pill rossa **«modificata»** si accende quando dopo il lancio una riga
  viene stornata, si aggiungono piatti, l'uscita viene riportata o il tavolo
  trasferito. Il tocco dice cosa è cambiato, chi e quando; **Ok** spegne
  l'avviso su tutti gli schermi. Suona come una comanda nuova.
- La **barra dei piatti** in alto somma la tua coda per piatto, pezzatura e
  variante («Bistecca» / «500 g · ben cotta»): nel blocco scuro quanti ne
  restano da cucinare, nel blocco oro quanti sono già sul fuoco. Il tocco
  apre «dove va questo piatto»: tavolo per tavolo, chiamati e in arrivo.
- **In arrivo** (bordo tratteggiato): uscite che per la tua partita non
  devono ancora partire. È il lancio scaglionato: la Griglia parte prima dei
  Primi così arrivano al passe insieme. Il conto alla rovescia dice quanto
  manca; *inizia ora* forza la partenza.
- I messaggi del canale **Cucina** della chat staff compaiono come striscia
  sul monitor: «finito il branzino» arriva senza aprire la chat.
- **Bar e Dolci non passano dai monitor di cucina**: li lavorano il banco e
  le stampe. Compaiono solo sul monitor di una partita a cui le loro righe
  sono assegnate (per esempio Bar o Pasticceria).

### Lavorare

- **Un tocco sulla riga** = quel piatto è pronto. Vale anche il salto diretto
  senza passare da "in preparazione": sui piatti veloci è normale.
- **Tocco sulla riga già spuntata** = annulla (il piatto torna in
  lavorazione). L'errore si corregge con lo stesso gesto, finché l'uscita non
  è stata servita.
- **Tutto pronto** chiude in un colpo le righe rimaste della card.
- **Peso**: sui piatti al peso la pastiglia ambra col peso si tocca per
  correggerlo dopo la pesata.
- Il **tocco lungo** su una riga accende il suo piatto nella barra in alto.
- Quando tutta l'uscita è pronta (anche le altre partite) la card resta con
  l'anello verde finché il passe non la serve. Se la tua parte aspetta le
  altre partite da più di 4′ la card **lampeggia** («pronto · attende le altre
  partite»): il piatto sta morendo sotto la lampada, e il ritardo è di
  qualcun altro.
- Le righe **stornate** dalla sala spariscono da sole con la motivazione. Se
  la rete cade continua a lavorare ciò che vedi: al ritorno la coda si
  riallinea da sola.

### Consegnate

- L'interruttore in alto passa alle **Consegnate**: le uscite servite del
  servizio, una card per tavolo con la comanda intera (i tuoi piatti in
  chiaro, quelli delle altre partite attenuati). Risponde a «il 12 dice che
  manca il piatto: l'abbiamo mandato?».
- Il tocco su una comanda apre la sua **storia**: apertura, chiamata, in
  lavorazione, pronta e servita di ogni uscita, con la sincronia fra partite
  e i minuti sotto la lampada.
- La **lente** cerca per tavolo, cliente, piatto (anche delle altre partite)
  e operatore, sia in lavorazione sia nelle consegnate.

### Partite senza monitor

Per i centri che lavorano solo di carta (stampante sì, monitor no) c'è il
**pronto auto** sulla partita, in Impostazioni → Sala & Cucina: le righe si
segnano pronte da sole al lancio, così l'uscita non resta bloccata ad
aspettare un «pronto» che nessuno può premere. La comanda esce comunque
dalla stampante.

---

## 3 · Passe (chi coordina le uscite)

### Le due domande

Lo schermo è diviso su due blocchi, che rispondono a due domande diverse:

- **In corso** — cosa sta uscendo. Una riga per uscita, con un **pallino per
  partita**: `●` pronta, `○` in corso, `2/3` a metà, `—` non coinvolta.
- **In attesa di lancio** — cosa devo far partire. Sono le proposte della
  sala. Una proposta ferma da più di 5′ diventa rossa: un tavolo che non
  mangia, e nessun altro se ne accorge.

### Le azioni

| Bottone | Quando appare | Cosa fa |
|---|---|---|
| **Lancia** | proposta in attesa | manda l'uscita in cucina (parte il lancio scaglionato e le stampe di partita) |
| **ri-lancia** | uscita in corso non pronta | ricalcola i tempi di partenza da adesso: la partita è andata in tilt |
| **Chiama** | uscita tutta pronta | notifica push ai camerieri: venite a ritirare |
| **Servita** | uscita tutta pronta | l'uscita lascia il passe: sparisce da qui e dai monitor di partita |
| **riporta** | in «Servite da poco» | il ripensamento del Servita: l'uscita torna pronta al passe |

- **Servita è parte del flusso, non un optional**: finché non la tocchi
  l'uscita resta sullo schermo, la statistica del ritiro non si misura, e in
  modalità «A consumo» la successiva non parte.
- **Servite da poco** (in fondo): le uscite servite negli ultimi 30 minuti.
  Da lì si *riporta* un Servita toccato per errore. Attenzione: se il servito
  aveva fatto partire l'uscita successiva (fuoco a consumo), quella non si
  richiama — le stampe sono già in partita.
- Se un'uscita in corso mostra l'allarme rosso «manca [partita] · N′ sotto la
  lampada», una partita ha finito da troppo e le altre no: è il momento di
  urlare — o di ri-lanciare.
- La **campana** suona quando un'uscita diventa pronta. Stesso comportamento
  del monitor cucina: on/off per schermo, primo tocco sblocca l'audio.
- **Statistiche**: delta di sincronia fra la prima e l'ultima riga pronta
  (mediano, non solo medio: una comanda dimenticata sposta la media, non la
  mediana), attesa al passe (proposta → lancio), attesa al ritiro (pronta →
  servita), tempi per partita, scarti con motivazione.

### Senza passe

Nei ristoranti senza expediter il passe si spegne (Impostazioni → Sala &
Cucina → Passe): la pagina Passe sparisce e i tempi restano alla sala, che
chiama le uscite col *Chiama* del palmare. Sulla card pronta per intero del
monitor cucina compaiono due icone:

- la **campanella** («Avvisa la sala») annuncia nel canale sala della chat
  staff che l'uscita è pronta al ritiro, con notifica push, senza cambiare lo
  stato;
- la **spunta** («Segna l'uscita servita») la chiude: lascia il monitor e va
  nelle Consegnate.

---

## 4 · Modalità di lancio e stampe (Impostazioni → Sala & Cucina)

| Modalità | Comportamento | Quando usarla |
|---|---|---|
| **Tutto subito** | ogni uscita parte in cucina all'invio | senza passe attivo |
| **Prima uscita subito** | la 1ª parte da sola, le altre le lancia il passe | servizio normale col passe |
| **A consumo** | parte un'uscita alla volta: la successiva quando segni *Servita* la precedente | ritmo dettato dal tavolo; richiede disciplina sul bottone Servita |
| **Tutto dal passe** | niente parte da solo | banchetti, menù degustazione |

- Nota su «A consumo»: all'invio parte la prima uscita solo se il tavolo non
  ha già qualcosa in cucina; un dolce ordinato a fine pasto, a tavolo ormai
  scarico, parte da solo. Il passe può comunque lanciare a mano in anticipo.
- In tutte le modalità le uscite **Bar** e **Dolci** partono all'invio, e i
  piatti aggiunti a un'uscita già partita vanno subito in cucina.
- **Dove va un piatto**: lo decide la mappa categoria → partita, ma il
  singolo piatto può avere la sua partita dalla scheda in Menu («Partita di
  cucina»): le patatine restano nei Contorni sul palmare ed escono agli
  Antipasti. Le categorie senza partita sono segnalate in Sala & Cucina:
  assegnale, o i loro piatti non arrivano ai monitor delle partite.

### Le stampe di partita

- Il lancio e la stampa viaggiano insieme: ogni uscita lanciata esce sulla
  stampante della sua partita.
- I piatti aggiunti a un'uscita già partita escono col banner **«AGGIUNTA»**.
  Lo storno di una riga già in cucina e l'annullo chiamata stampano un ticket
  dedicato, con le righe barrate («-- 1 x Acqua ----»).
- Il **cicalino** (campanella sulla stampante, in Sala & Cucina) fa suonare la
  stampante a ogni lavoro: la cucina sente la comanda anche senza guardare.
- **Stampa copia** (nell'esito della chiusura) dice l'esito sul bottone:
  rotellina, poi «Copia in stampa» o l'errore.

---

## 5 · Cassa (il banco)

La pagina **Cassa**, sotto Servizio, è il banco di chi incassa (ruolo Cassa o
chi ha i permessi di cassa).

- **Coda dei conti** del servizio (da incassare, rimasti aperti): da lì si
  apre il tavolo con la sua comanda, il cliente della visita e l'incasso.
  **Apri in Comande** porta al tavolo per lavorare uscite e lanci.
- **Incasso**: più metodi sullo stesso conto (contanti, POS, Satispay, buoni
  pasto, gift card, sospeso, omaggio), resto calcolato, mancia col suo metodo
  (quella in contanti entra nei contanti attesi del cassetto). **Dividi
  conto** in parti uguali, per importo o per piatti: i piatti già pagati,
  anche da un ospite col QR, restano segnati e non si ripropongono.
- **QR al tavolo**: l'ospite inquadra e paga la sua parte; il conto resta
  aperto finché il residuo non scende a zero.
- **Sconto sul conto** anche all'incasso, a importo o in percentuale; non si
  scende mai sotto il già incassato.
- **Correggi**: se il cliente contesta una portata mai ricevuta, si storna la
  riga con la motivazione e il totale si riallinea, anche a comanda chiusa.
- **Documento alla chiusura**: scontrino, proforma o fattura. Con la proforma
  scontrino e fattura restano emettibili dal conto, anche nei giorni dopo.
- **Fondo e chiusura**: a inizio servizio si dichiara il fondo, durante si
  registrano i movimenti, a fine turno si conta il cassetto: la differenza
  con l'atteso richiede una nota. La chiusura del cassetto è riservata alla
  direzione; la chiusura del giorno sta in Pagamenti.

---

## 6 · Con la cassa Passepartout

Vale solo nei locali con la cassa Passepartout e la scheda **«Comande del CRM
in cassa»** accesa (Impostazioni → Passepartout). Servono le comande accese, i
tavoli del CRM abbinati a quelli della cassa, il tipo di pagamento in cassa e
l'agente del PC della cassa aggiornato: la scheda dice cosa manca.

### Il principio

La comanda presa nel CRM nasce e cresce nella **comanda in cassa del tavolo
vero**, con varianti, aggiunte e storni. Se il tavolo è già aperto in cassa,
le righe del CRM si aggiungono alla stessa comanda. Il giro di sala, cucina e
passe resta quello dei §1–§4.

### Sul palmare

- **Il tavolo aperto dalla cassa** (serve anche «Tavoli aperti in cassa»
  acceso): un tavolo aperto dalla cassa o dal palmare Passepartout, che nel
  CRM non ha ancora una comanda, sta fra le comande aperte col totale della
  cassa («17,50 € · in cassa»), non fra i tavoli liberi. Aprendolo, il
  riquadro «Dalla cassa» mostra subito quello che c'è già; quello che mandi
  dal CRM si aggiunge alla stessa comanda in cassa. Sui tavoli uniti si apre
  quello che ha la comanda in cassa.
- **Il riquadro «Dalla cassa»**: in coda alla comanda del CRM c'è quello che
  sul tavolo hanno battuto la cassa o il palmare Passepartout, col totale del
  tavolo in cassa («Tavolo in cassa 42,00 €»). È in sola lettura — quelle
  righe si correggono in cassa — e non passa dal monitor di cucina del CRM,
  perché in cucina le manda la cassa. Si aggiorna da solo entro qualche
  secondo; se la cassa non risponde, il riquadro lo dice.
- **Non tenere aperto in cassa un tavolo che riceve comande dal CRM**:
  salvando, la cassa perderebbe le sue modifiche, e finché resta aperto i
  piatti del CRM su quel tavolo aspettano.

### Chi stampa in cucina e al bar

| Scelta | Cosa succede |
|---|---|
| **La cassa** | Le uscite lanciate nel CRM le manda in produzione la cassa, alle sue stampanti. Le stampanti di partita del CRM non stampano questi tavoli; i monitor di cucina restano. Se dopo qualche secondo i piatti non sono partiti, il CRM chiede alla cassa: se risponde li manda lei (anche quando è lenta o ha il tavolo aperto), se non risponde stampa il CRM. Così non escono doppioni. |
| **Il CRM** (solo col conto del CRM) | Stampano le stampanti di partita del CRM. In cassa **non premere «Invia» e non chiudere dallo schermo** questi tavoli: manderebbe in produzione le righe del CRM una seconda volta. Il tavolo lo chiude il pagamento nel CRM. |

### Chi fa il conto

| Scelta | Cosa succede |
|---|---|
| **La cassa** | Il conto è la comanda in cassa, con le righe battute in cassa, il coperto della cassa al suo prezzo e lo sconto della cassa. Si paga in cassa, dal QR del tavolo o dal CRM, che lo prende dalla cassa. Chiudendo il tavolo in cassa, l'ordine si chiude da solo anche nel CRM. |
| **Il CRM** | Il conto nasce dalle righe del CRM, col coperto e gli sconti del CRM. Pagato nel CRM o dal QR, chiude la comanda in cassa col tipo di pagamento esterno e lo scontrino lo fa la cassa. Gli sconti del CRM vanno sul conto in cassa: righe a prezzo pieno, totale e scontrino scontati. Se sul tavolo c'è qualcosa battuto in cassa o dal palmare Passepartout, il conto lo fa comunque la cassa (e lo sconto si fa lì). |

### Col nodo di sala

Con il nodo di sala e «Servizio completo sul nodo» acceso, le comande in cassa
le scrive il nodo, anche a internet caduta; senza nodo le scrive il cloud.

---

## 7 · Se qualcosa non torna

- **«riconnessione…» in alto** — la rete balla. I monitor ricaricano la coda
  da soli al ritorno; nel dubbio, il ricarico periodico (60″ cucina, 20″
  passe) riallinea comunque.
- **«dati fermi alle 21:40 — cloud non raggiungibile»** — col nodo di sala lo
  schermo lavora sulla copia del nodo perché il cloud non risponde. Si
  continua a lavorare; l'ora dice quando è arrivata l'ultima copia buona.
- **La campana non suona** — tocca lo schermo una volta (il browser blocca
  l'audio finché non c'è un'interazione), poi verifica che l'icona sia la
  campana piena e non quella sbarrata. Sul palmare controlla «Avvisi sonori»
  nel menu ⋮.
- **Ho segnato pronto per errore** — tocca di nuovo la riga: torna in
  lavorazione. Se l'uscita era già stata servita, il passe la *riporta* da
  «Servite da poco».
- **Ho servito l'uscita sbagliata** — passe → «Servite da poco» → *riporta*,
  entro 30 minuti.
- **Ho chiamato l'uscita sul tavolo sbagliato** — *annulla chiamata*
  sull'uscita, finché nessun piatto è in lavorazione; dopo si storna.
- **Un'uscita proposta non parte mai** — guarda la modalità di lancio (§4) e
  il blocco «In attesa di lancio» del passe: qualcuno deve premere *Lancia*
  (o *Chiama* sul palmare, se il passe è spento).
- **Un piatto non compare su nessun monitor** — la sua categoria non ha una
  partita (Impostazioni → Sala & Cucina la segnala), oppure è un piatto Bar o
  Dolci, che i monitor di cucina non mostrano.
- **L'uscita è pronta in cucina ma resta bloccata** — una partita lavora solo
  di carta e nessuno può premere «pronto»: accendi il *pronto auto* su
  quella partita (§2).
- **«Comanda eliminata da un altro dispositivo»** — un collega ha eliminato la
  comanda mentre componevi: le righe non inviate restano sul palmare e
  ripartono con Invia, su una comanda nuova.
- **La stampante di partita è muta** — il lancio e la stampa viaggiano
  insieme: se l'uscita è sul monitor, la stampa è stata accodata. Il problema
  è a valle (agente di stampa / stampante): vedi il playbook stampanti. Con la
  cassa Passepartout e «Chi stampa: la cassa», i tavoli del CRM li stampa la
  cassa alle sue stampanti, non quelle di partita del CRM (§6).
- **Con la cassa Passepartout, i piatti del CRM non arrivano in cassa** — il
  tavolo è probabilmente aperto sullo schermo della cassa: finché resta aperto
  lì, i piatti del CRM su quel tavolo aspettano. Esci dal tavolo in cassa.
- **Il riquadro «Dalla cassa» dice che la cassa non risponde** — la cassa o il
  PC della cassa sono spenti o fuori rete. Con «Chi stampa: la cassa» i piatti
  li stampa il CRM, quindi il servizio va avanti; la «Verifica della cassa»
  in Impostazioni → Passepartout dice cosa sistemare.
