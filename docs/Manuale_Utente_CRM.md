# Manuale Utente — CRM di RistoManager AI

**Gestione clienti, comunicazioni e relazioni**

Versione 1.1 · Ottobre 2026

---

## Indice

1. [Introduzione](#1-introduzione)
2. [Cos'è il CRM di RistoManager AI](#2-cosè-il-crm-di-ristomanager-ai)
3. [Accesso e permessi](#3-accesso-e-permessi)
4. [Il modulo Clienti (rubrica)](#4-il-modulo-clienti-rubrica)
5. [La scheda cliente in dettaglio](#5-la-scheda-cliente-in-dettaglio)
6. [Clienti VIP, preferenze e allergie](#6-clienti-vip-preferenze-e-allergie)
7. [Storico prenotazioni e banchetti](#7-storico-prenotazioni-e-banchetti)
8. [Gestione dei no-show](#8-gestione-dei-no-show)
9. [Rilevamento e unione dei duplicati](#9-rilevamento-e-unione-dei-duplicati)
10. [Il modulo Conversazioni](#10-il-modulo-conversazioni)
11. [Messaggi automatici e «La tua prenotazione»](#11-messaggi-automatici-e-la-tua-prenotazione)
12. [Collegamento con Prenotazioni e Banchetti](#12-collegamento-con-prenotazioni-e-banchetti)
13. [Flussi di lavoro consigliati](#13-flussi-di-lavoro-consigliati)
14. [Domande frequenti (FAQ)](#14-domande-frequenti-faq)
15. [Glossario](#15-glossario)

---

## 1. Introduzione

Questo manuale descrive le funzionalità del **CRM (Customer Relationship Management)** integrato in RistoManager AI, il gestionale del ristorante. È rivolto sia allo **staff operativo** (reception, sala) che usa il sistema ogni giorno, sia a **titolari e manager** che gestiscono la relazione con la clientela e le strategie commerciali.

Il manuale copre il CRM "esteso": non solo l'anagrafica dei clienti, ma anche le comunicazioni (chiamate gestite dall'agente vocale e messaggi) e il modo in cui i dati del cliente si collegano a prenotazioni e banchetti.

Dove utile, il testo distingue le informazioni pensate per l'**uso quotidiano operativo** da quelle di **gestione**.

---

## 2. Cos'è il CRM di RistoManager AI

Il CRM è l'insieme degli strumenti che permettono di **conoscere e gestire la clientela** del ristorante. Non è una sezione unica, ma un sistema di funzioni collegate tra loro:

- **Clienti** — la rubrica anagrafica, con dati di contatto, preferenze, allergie, stato VIP e storico delle visite. È il cuore del CRM.
- **Conversazioni** — il registro delle chiamate gestite dall'agente vocale e dei messaggi inviati, con la possibilità di ricontattare, prendere nota e creare prenotazioni.
- **Prenotazioni e Banchetti** — ogni prenotazione e ogni evento a banchetto è associato a un cliente, alimentando automaticamente il suo storico.
- **Messaggi automatici** — conferma, promemoria e il link «La tua prenotazione», da cui l'ospite conferma, cambia o annulla da solo (vedi §11).

L'obiettivo del CRM è duplice: da un lato **velocizzare il lavoro in sala** (riconoscere subito un cliente abituale, il suo tavolo preferito, le sue allergie), dall'altro **supportare le decisioni commerciali** (identificare i clienti VIP, monitorare i no-show, non perdere occasioni di ricontatto).

---

## 3. Accesso e permessi

L'accesso al CRM dipende dal **ruolo** assegnato al proprio account. Ogni ruolo dispone di un diverso livello di permessi.

Per il modulo **Clienti** esistono due livelli:

- **`customers:view`** — permette di consultare la rubrica e le schede cliente in sola lettura.
- **`customers:full`** — permette di consultare *e* modificare: creare nuovi clienti, modificarne i dati, eliminarli e unire i duplicati.

La tabella seguente riassume l'accesso al CRM per ruolo:

| Ruolo | Clienti (consulta) | Clienti (modifica) | Conversazioni |
|---|:---:|:---:|:---:|
| Titolare (Owner) | Sì | Sì | Sì |
| Direttore generale (General Manager) | Sì | Sì | Sì |
| Manager | Sì | Sì | Sì |
| Reception | Sì | Sì | Sì |
| Cameriere (Waiter) | Sì | No | No |
| Cucina (Kitchen) | No | No | No |

In pratica: la reception e i manager hanno il pieno controllo del CRM; i camerieri possono consultare le schede cliente (utile per allergie e preferenze) ma non modificarle; la cucina non accede alla rubrica.

Il modulo **Conversazioni** richiede il permesso `voice_calls:view`, disponibile per Titolare, Direttore generale, Manager e Reception.

> **Nota per l'amministratore.** I permessi si gestiscono dalla sezione **Utenti** e **Impostazioni → Ruoli**. Se un collaboratore non vede il menu "Clienti" o "Conversazioni", verificare il ruolo assegnato al suo account.

---

## 4. Il modulo Clienti (rubrica)

Il modulo **Clienti** si apre dal menu laterale, gruppo **Gestione → Clienti**. È la rubrica anagrafica del ristorante: l'elenco di tutte le persone che hanno prenotato, chiamato o partecipato a un evento.

### 4.1 Cercare un cliente

In alto è presente una **barra di ricerca**. Si può cercare per nome, numero di telefono o email: l'elenco si filtra man mano che si digita. È il modo più rapido per trovare la scheda di un cliente che sta chiamando o si presenta al ristorante.

La ricerca trova le parole **in qualsiasi ordine** e bastano le prime lettere: «Rossi Mar» trova «Mario Rossi». Il telefono si cerca per sole cifre, senza badare a spazi o al prefisso +39. In cima compaiono i clienti il cui nome comincia con quello che si è scritto. La stessa ricerca vale nei suggerimenti del form di prenotazione e nella ricerca globale: scrivendo il nome di un cliente già in rubrica lo si ritrova, invece di creare un doppione.

### 4.2 Aggiungere un nuovo cliente

Il pulsante **"+ Nuovo"** (o "Aggiungi alla rubrica") apre la scheda di inserimento. I campi disponibili sono:

- **Nome** *(obbligatorio)* — nome e cognome del cliente.
- **Telefono** *(obbligatorio)* — numero di contatto; è anche la chiave usata per riconoscere i duplicati.
- **Email** — indirizzo di posta elettronica.
- **Indirizzo, Città, CAP** — dati di residenza/recapito, utili per banchetti ed eventi.
- **Note** — annotazioni generiche libere.
- **Tavolo preferito** — il tavolo che il cliente predilige (vedi §6).
- **Note preferenze** — abitudini e gusti del cliente.
- **Allergie / note alimentari** — informazioni che vengono **precompilate in ogni nuova prenotazione** del cliente (vedi §6).
- **Cliente VIP** — spunta che evidenzia il cliente in sala e nelle prenotazioni.

Nome e telefono sono obbligatori: senza di essi il pulsante di salvataggio resta disattivato. Al salvataggio si sceglie **"Aggiungi alla rubrica"**.

### 4.3 Modificare o eliminare un cliente

Ogni riga dell'elenco offre le azioni di **modifica** (icona matita) ed **eliminazione** (icona cestino), disponibili solo con permesso `customers:full`.

Alla cancellazione compare una conferma. È importante sapere che **i banchetti collegati mantengono la loro storia** ma non risulteranno più associati al cliente eliminato: l'eliminazione non cancella gli eventi passati, scollega soltanto l'anagrafica.

---

## 5. La scheda cliente in dettaglio

Cliccando su un cliente si apre il **pannello di dettaglio**, che raccoglie in un'unica vista tutto ciò che il ristorante sa di quella persona:

- **Dati di contatto** — telefono, email, indirizzo, con icone dedicate.
- **Stato VIP** — evidenziato quando attivo.
- **Tavolo preferito** — se impostato.
- **Preferenze e note alimentari/allergie** — sempre visibili per un rapido riferimento in sala.
- **Storico prenotazioni** — l'elenco delle prenotazioni registrate, con data, orario, numero di ospiti e indicazione del turno (pranzo con l'icona del sole, cena con l'icona della luna). Un contatore mostra quante prenotazioni ha totalizzato il cliente.
- **Conteggio no-show** — quante volte il cliente non si è presentato (vedi §8).
- **Spesa** — quanto ha **speso** il cliente, le **visite con conto** e la spesa **media a coperto**. Contano i conti chiusi nel CRM delle sue prenotazioni e, nei locali con la cassa Passepartout e la lettura dei conti accesa (Impostazioni → Passepartout → «Conti della cassa nel CRM»), anche i tavoli chiusi solo in cassa. La striscia compare solo quando c'è almeno un conto.

Questa scheda è pensata per essere consultata **al volo**, ad esempio mentre si è al telefono con il cliente o mentre lo si accoglie all'ingresso.

---

## 6. Clienti VIP, preferenze e allergie

Queste tre funzioni trasformano la rubrica da semplice elenco a strumento di servizio personalizzato.

### 6.1 Clienti VIP

La spunta **"Cliente VIP"** contrassegna i clienti più importanti. Un cliente VIP viene **evidenziato nella prenotazione in sala**, così che lo staff possa riservargli un'attenzione particolare. È lo strumento più immediato per riconoscere gli habitué, i clienti di riguardo o chi merita un trattamento premium.

Quando un cliente VIP prenota, da qualunque canale (CRM, sito, Sofia, WhatsApp), **titolare e direzione ricevono un avviso a parte**: «Prenotazione VIP · Marco Rossi · 4 ospiti · sab 3 ott 20:30». Basta che uno lo legga perché si spenga per tutti; si spegne da solo anche se la prenotazione viene annullata o cancellata.

*Uso di gestione:* filtrare o rivedere periodicamente i clienti VIP aiuta a impostare azioni commerciali dedicate (inviti a eventi, offerte riservate).

### 6.2 Tavolo preferito

Il campo **"Tavolo preferito"** associa al cliente il tavolo che predilige. L'informazione compare nella scheda e supporta chi assegna i tavoli nel proporre sempre la stessa collocazione ai clienti abituali.

### 6.3 Allergie e note alimentari

Il campo **"Allergie / note alimentari"** è particolarmente potente: il suo contenuto viene **precompilato automaticamente in ogni nuova prenotazione** del cliente. In questo modo un'allergia registrata una volta segue il cliente in tutte le sue visite future, riducendo il rischio di errori in cucina e migliorando la sicurezza alimentare.

### 6.4 Note preferenze e note generiche

Le **"Note preferenze"** raccolgono gusti e abitudini (es. "preferisce il tavolo vicino alla finestra", "beve sempre lo stesso vino"), mentre le **Note** generiche servono per qualsiasi altra annotazione utile.

---

## 7. Storico prenotazioni e banchetti

Uno dei valori principali del CRM è la **memoria storica** del rapporto con ogni cliente.

- **Storico prenotazioni.** Ogni prenotazione associata al numero/nominativo del cliente confluisce nel suo storico, visibile nella scheda di dettaglio con data, ora, ospiti e turno. Non serve alcuna operazione manuale: l'associazione avviene tramite i dati anagrafici.
- **Banchetti ed eventi.** I banchetti collegati a un cliente ne compongono la storia degli eventi. Anche in caso di eliminazione dell'anagrafica, la storia dei banchetti resta conservata nel sistema.

Consultare lo storico consente di riconoscere la frequenza delle visite, valutare l'importanza commerciale del cliente e personalizzare l'accoglienza.

---

## 8. Gestione dei no-show

Il campo **conteggio no-show** tiene traccia di quante volte il cliente ha prenotato senza poi presentarsi. Il valore si aggiorna quando una prenotazione viene contrassegnata con lo stato **NO_SHOW**.

Questo indicatore è utile a più livelli:

- **Operativo** — la reception può valutare con più attenzione una nuova prenotazione di un cliente con molti no-show (ad esempio richiedendo una conferma o un acconto per gli eventi).
- **Gestione** — monitorare i no-show aiuta a ridurre le perdite dovute a tavoli riservati e rimasti vuoti, e a impostare politiche di conferma o caparra.

Il conteggio è un dato di supporto alla decisione: sta al ristorante stabilire le proprie regole su come trattare i clienti con storico di mancata presentazione.

---

## 9. Rilevamento e unione dei duplicati

Con il tempo può capitare che lo stesso cliente venga registrato più volte (ad esempio da canali diversi o con piccole differenze nel nome). Il CRM include un sistema di **rilevamento dei duplicati**.

### 9.1 Come funziona il rilevamento

Il sistema considera potenzialmente duplicati i clienti che **condividono le ultime 10 cifre del numero di telefono**. Quando vengono individuati, compare un **badge "Duplicati"** nel modulo Clienti, da cui si apre una finestra dedicata con i gruppi di record sospetti.

### 9.2 Unire i duplicati

Dalla finestra **"Clienti duplicati"** è possibile **unire** (merge) due record: il sistema consolida le informazioni in un'unica anagrafica, evitando schede frammentate e storici spezzati.

Esiste anche un controllo **in fase di salvataggio**: se si prova a salvare un cliente con un numero già presente, il sistema segnala il conflitto e propone di **unire** i due record oppure di **aprire** la scheda esistente. In fase di creazione (quando non c'è nulla da unire da parte del nuovo record) l'avviso offre semplicemente di aprire l'anagrafica già esistente.

> **Buona pratica.** Controllare periodicamente il badge "Duplicati" e consolidare i record mantiene la rubrica pulita e affidabile, con storici completi per ogni cliente.

---

## 10. Il modulo Conversazioni

Il modulo **Conversazioni** (menu **Servizio → Conversazioni**) raccoglie le **chiamate gestite dall'agente vocale** e i **messaggi inviati** ai clienti. È il canale del CRM dedicato alla comunicazione.

### 10.1 La lista delle conversazioni

La schermata principale mostra l'elenco delle chiamate, ciascuna con nome del cliente (o numero, se sconosciuto), data, ora e durata. Sono disponibili strumenti per organizzarle:

- **Ricerca** — per telefono, nome, riassunto o testo della trascrizione.
- **Filtri rapidi (chip)** — "Tutte", "Con prenotazione", "Da ricontattare", "Ricontattati".
- **Filtro per periodo** — intervallo di date da/a.
- **Sincronizza** — importa le chiamate più recenti dal servizio vocale. Al termine mostra un riepilogo (importate, numeri recuperati, saltate ed eventuali errori).

### 10.2 Il dettaglio di una conversazione

Aprendo una chiamata si accede al dettaglio, che include:

- **Data e durata** della chiamata.
- **Riassunto** generato della conversazione.
- **Trascrizione** completa (quando disponibile).
- **Audio** — pulsante "Carica audio" per ascoltare la registrazione.
- **Prenotazioni per questo numero** — le prenotazioni collegate al telefono del chiamante, con relativo stato ed eventuale indicazione "Collegata".
- **Messaggi inviati** — l'elenco dei messaggi inviati a quel numero.

Dall'intestazione del dettaglio si può inoltre:

- **Aprire l'anagrafica cliente** (icona rubrica) per passare direttamente alla scheda del cliente.
- **Chiamare** il numero con un tocco.

### 10.3 Follow-up: ricontattare i clienti

La sezione **Follow-up** è lo strumento operativo per non perdere occasioni. Ogni chiamata senza prenotazione collegata viene segnalata come **"Da ricontattare"**. Da qui si può:

- **Segnare come ricontattato** (o riportare a "da ricontattare"). Il sistema registra chi ha effettuato il ricontatto e quando.
- **Creare una prenotazione** direttamente dalla chiamata (pulsante "Crea prenotazione"), precompilando nome e telefono del chiamante.
- **Aggiungere note** utili per la prenotazione o per il seguito, salvandole sulla conversazione.

I filtri "Da ricontattare" e "Ricontattati" permettono di lavorare la lista in modo sistematico, come una piccola coda di lavoro commerciale.

---

## 11. Messaggi automatici e «La tua prenotazione»

Oltre alle conversazioni, il CRM scrive da solo all'ospite nei momenti chiave della prenotazione. I messaggi partono sui canali configurati per la fonte della prenotazione (di solito WhatsApp, con l'SMS se il numero non è su WhatsApp, più una copia via email) e, nella lingua dell'ospite, entrano nello **storico messaggi della prenotazione** (passo **Comunicazione** della scheda prenotazione), con lo stato In coda / Inviato / Consegnato / Fallito.

### 11.1 Conferma e avviso di modifica

- Alla **conferma** della prenotazione l'ospite riceve il messaggio di conferma; al rifiuto, la disdetta con l'invito a chiamare.
- Nella conferma WhatsApp, accanto a «Gestisci la prenotazione» (vedi §11.3), c'è il pulsante **«Come raggiungerci»**, che apre Google Maps sul locale. Compare se è compilato il campo **«Link Google Maps (Come raggiungerci)»** in Impostazioni → Ristorante → Identità e documenti legali (un link breve, `https://maps.app.goo.gl/…`).
- Se cambiano **ora o coperti** di una prenotazione già confermata, l'ospite riceve un **avviso di modifica**.

### 11.2 Promemoria automatico

Il promemoria si può mandare a mano dal passo **Comunicazione** della prenotazione, oppure lasciarlo partire da solo.

- **Dove si accende:** Impostazioni → Prenotazioni → **«Promemoria all'ospite»**. È spento finché il locale non lo accende.
- **Quando parte:** a scelta, **il giorno prima a un'ora fissa** (fra le 9 e le 20; di serie alle 11) oppure **un numero di ore prima** dell'arrivo (da 2 a 48). Non parte mai fra le 21 e le 9.
- **Chi lo riceve:** ogni prenotazione confermata, con lo stesso testo del promemoria manuale. Viene saltato chi ha prenotato o ricevuto la conferma da meno di 12 ore, chi ha già avuto il promemoria a mano e chi arriva entro un'ora. Se la prenotazione viene spostata a un altro giorno, il promemoria riparte per la data nuova.
- **Cosa vede lo staff:** sulla card della prenotazione compare la **campanella** del promemoria inviato e il messaggio entra nello storico. Se un invio non riesce, chi gestisce le prenotazioni riceve un avviso con i nomi degli ospiti da chiamare.

### 11.3 «La tua prenotazione»: l'ospite conferma, cambia o annulla

È la pagina personale dell'ospite, col marchio del locale, in italiano o in inglese. Ci arriva dal link **«Gestisci la prenotazione»** che compare nella conferma e nel promemoria (pulsante nell'email e nel WhatsApp, link nell'SMS).

- **Dove si accende:** Impostazioni → Prenotazioni → **«Gestione dall'ospite»**. È spenta finché il locale non la accende. Lì si sceglie anche **fino a quante ore prima** dell'arrivo l'ospite può cambiare o annullare (di serie 3, da 1 a 72); più tardi la pagina gli dice di chiamare.
- **Cosa vede l'ospite:** data, ora, persone e sala, e tre pulsanti:
  - **«Ci saremo»** — conferma che verrà;
  - **«Cambia giorno, ora o persone»** — sceglie un altro giorno (fino a 60 giorni avanti) e il numero di persone (fino a 20) e vede **solo gli orari dove un tavolo si trova da solo**: il suo, se va ancora bene, altrimenti uno libero con le stesse regole del sito e di Sofia (prima nella stessa sala). Dove servirebbe lo staff, o se le persone in più farebbero scattare la caparra, la pagina gli dice di chiamare;
  - **«Annulla la prenotazione»** — annulla, e il tavolo si libera.
- **Limiti:** con una caparra pagata si sposta l'orario ma non il numero di persone; una prenotazione legata a un banchetto non si sposta dal link; una richiesta ancora da confermare si può ritirare.
- **Caparra e annullo:** se mancano almeno 24 ore, l'avviso allo staff dice «caparra da rimborsare» e il rimborso si fa a mano dal pulsante di sempre (passo **Pagamenti** della prenotazione). Sotto le 24 ore la caparra resta al locale, e la pagina lo dice all'ospite prima che confermi l'annullo.

**Cosa vede lo staff.**

- La conferma dell'ospite compare sulla card della prenotazione: la **persona con la spunta**, in verde.
- Un cambio arriva come avviso **«Modificata dall'ospite»**, con il prima e il dopo; l'ospite riceve la conferma col nuovo orario e la card lo mostra come confermato.
- Un annullo arriva come avviso **«Annullata dall'ospite»** e compare sulla card.

**Mandare il link a mano.** Nel passo **Comunicazione** della prenotazione, **«Copia link ospite»** mette il link negli appunti: si incolla in una chat (per esempio quando l'ospite scrive per spostare la prenotazione) o si detta al telefono.

---

## 12. Collegamento con Prenotazioni e Banchetti

Il CRM non è un archivio isolato: i dati del cliente sono **intrecciati** con l'operatività quotidiana.

- **Dalla prenotazione al cliente.** Le allergie e le note alimentari registrate in anagrafica vengono precompilate nelle nuove prenotazioni; lo stato VIP evidenzia il cliente in sala; il tavolo preferito guida l'assegnazione.
- **Dalla conversazione alla prenotazione.** Una chiamata può diventare una prenotazione con un clic, e la prenotazione risultante compare tra quelle collegate al numero.
- **Dalla prenotazione allo storico.** Ogni prenotazione ed evento a banchetto alimenta lo storico del cliente, costruendo nel tempo il suo profilo.
- **No-show.** Le prenotazioni chiuse come NO_SHOW aggiornano il contatore nella scheda cliente.
- **Dall'ospite alla prenotazione.** Conferma, cambio o annullo fatti dall'ospite dal link «La tua prenotazione» aggiornano la prenotazione e la sua card, e arrivano allo staff come avviso (vedi §11.3).
- **Dal conto alla scheda.** I conti chiusi delle prenotazioni del cliente (e, con la cassa Passepartout, i tavoli chiusi solo in cassa) alimentano la sua spesa nella scheda (vedi §5).

Questa integrazione fa sì che ogni interazione — una telefonata, una prenotazione, un banchetto — arricchisca automaticamente la conoscenza del cliente, senza doppio inserimento manuale.

---

## 13. Flussi di lavoro consigliati

**Accoglienza di un cliente abituale (reception/sala).**
Cercare il cliente nella rubrica → aprire la scheda → verificare tavolo preferito, allergie e note → riconoscere l'eventuale stato VIP → procedere con l'accoglienza personalizzata.

**Registrazione di una nuova allergia (sala/cucina).**
Aprire la scheda del cliente → inserire l'informazione nel campo "Allergie / note alimentari" → salvare. L'informazione comparirà automaticamente nelle prenotazioni future.

**Lavorazione dei ricontatti (reception/commerciale).**
Aprire Conversazioni → filtro "Da ricontattare" → aprire ogni chiamata → ricontattare il cliente → creare la prenotazione o segnare come ricontattato → aggiungere note.

**Pulizia periodica della rubrica (manager).**
Aprire Clienti → controllare il badge "Duplicati" → aprire "Clienti duplicati" → unire i record → verificare la correttezza dello storico consolidato.

**Analisi della clientela (titolare/manager).**
Rivedere i clienti VIP e lo storico visite per impostare iniziative dedicate; monitorare i no-show per definire politiche di conferma o caparra.

**Attivare i messaggi automatici (titolare/manager).**
Impostazioni → Prenotazioni → «Promemoria all'ospite»: accendere e scegliere quando parte → «Gestione dall'ospite»: accendere e scegliere fino a quante ore prima l'ospite può cambiare o annullare → Impostazioni → Ristorante → Identità e documenti legali: inserire il link Google Maps, per il pulsante «Come raggiungerci».

**Ospite che vuole spostare la prenotazione via chat (reception).**
Aprire la prenotazione → passo Comunicazione → «Copia link ospite» → incollarlo nella chat: l'ospite sceglie da solo fra gli orari dove c'è posto, e lo staff riceve l'avviso «Modificata dall'ospite».

**Ospite che annulla dal link con una caparra pagata (reception).**
Arriva l'avviso «Annullata dall'ospite». Se dice «caparra da rimborsare», aprire la prenotazione → passo Pagamenti → rimborso. Sotto le 24 ore dall'arrivo la caparra resta al locale e non c'è niente da fare.

---

## 14. Domande frequenti (FAQ)

**Perché non riesco a modificare una scheda cliente?**
Probabilmente il tuo ruolo ha solo il permesso di consultazione (`customers:view`). La modifica richiede `customers:full`, disponibile per Reception, Manager, Direttore generale e Titolare.

**Ho eliminato un cliente per errore: ho perso i suoi banchetti?**
No. I banchetti collegati mantengono la loro storia; viene meno solo l'associazione con l'anagrafica. Puoi ricreare la scheda cliente.

**Perché vedo lo stesso cliente due volte?**
Potrebbe trattarsi di un duplicato (stesso numero di telefono). Usa il badge "Duplicati" e la funzione di unione per consolidarlo.

**Le allergie vanno reinserite a ogni prenotazione?**
No. Se le registri nel campo dedicato dell'anagrafica, vengono precompilate automaticamente nelle nuove prenotazioni.

**Non vedo il menu "Conversazioni".**
Il modulo richiede il permesso `voice_calls:view`. Verifica il tuo ruolo con l'amministratore.

**Cosa fa il pulsante "Sincronizza" in Conversazioni?**
Importa le chiamate più recenti gestite dall'agente vocale e mostra un riepilogo dell'importazione.

**Perché a un ospite non è arrivato il promemoria automatico?**
Il promemoria salta chi ha prenotato o ricevuto la conferma da meno di 12 ore, chi l'ha già avuto a mano e chi arriva entro un'ora, e non parte mai fra le 21 e le 9. Se invece l'invio è fallito, chi gestisce le prenotazioni ha ricevuto un avviso col nome dell'ospite. In ogni caso si può mandare a mano dal passo Comunicazione della prenotazione.

**Un ospite dice che dal link non riesce più ad annullare o cambiare.**
È oltre il limite di ore scelto in «Gestione dall'ospite» (di serie 3 ore prima dell'arrivo): la pagina gli dice di chiamare. Annulla o sposta la prenotazione tu, dal CRM.

**Perché l'ospite non trova l'orario che vuole nel cambio dal link?**
La pagina mostra solo gli orari dove un tavolo si trova da solo. Dove servirebbe lo staff (per esempio unire tavoli), o se le persone in più farebbero scattare la caparra, gli chiede di chiamare.

**Non vedo la spesa nella scheda del cliente.**
La striscia della spesa compare solo quando il cliente ha almeno un conto chiuso.

---

## 15. Glossario

**CRM** — Customer Relationship Management: l'insieme degli strumenti per gestire dati e relazioni con i clienti.

**Anagrafica / Rubrica** — l'archivio dei clienti registrati con i loro dati.

**VIP** — cliente contrassegnato come prioritario, evidenziato in sala e nelle prenotazioni.

**No-show** — prenotazione per cui il cliente non si è presentato.

**Duplicato** — due o più schede che si riferiscono allo stesso cliente (tipicamente con lo stesso numero di telefono).

**Merge (unione)** — operazione che consolida più schede duplicate in un'unica anagrafica.

**Follow-up** — attività di ricontatto di un cliente a seguito di una chiamata o richiesta.

**Trascrizione** — testo integrale di una chiamata gestita dall'agente vocale.

**Permesso** — autorizzazione associata a un ruolo che abilita determinate azioni (es. `customers:full`).

**Promemoria automatico** — il messaggio che ricorda all'ospite la prenotazione, mandato da solo il giorno prima o un numero di ore prima dell'arrivo.

**«La tua prenotazione»** — la pagina personale dell'ospite, aperta dal link «Gestisci la prenotazione», da cui conferma («Ci saremo»), cambia o annulla da solo.

**Caparra** — somma pagata online in anticipo per garantire il tavolo; si scala dal conto e, se l'ospite annulla per tempo, si rimborsa.

---

*Documento generato per RistoManager AI. Le funzionalità descritte fanno riferimento ai moduli Clienti, Conversazioni, ai messaggi automatici all'ospite e ai relativi collegamenti con Prenotazioni e Banchetti.*
