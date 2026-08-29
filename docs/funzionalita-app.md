# Sympotia (RistoManager) — Catalogo completo delle funzionalità

> **Scopo di questo documento.** È la fonte unica e aggiornata di *che cosa fa l'app*, sezione per sezione.
> Serve a due usi: (1) creare le sezioni e i contenuti del **sito marketing**, (2) scrivere il **manuale utente**.
> Descrive le funzionalità dal punto di vista di chi usa il prodotto, non l'architettura tecnica (per quella: `CLAUDE.md` e gli altri file in `docs/`).
>
> **Regola di aggiornamento (vincolante).** Ogni modifica o nuova funzionalità dell'app va riportata qui, nella sezione giusta, **nella stessa PR che la introduce**, e va aggiunta una riga al [Registro aggiornamenti](#registro-aggiornamenti) in fondo. Un documento non aggiornato produce pagine marketing e manuali sbagliati.

---

## Indice

1. [Che cos'è](#che-cosè)
2. [Panoramica dei moduli](#panoramica-dei-moduli)
3. [Prenotazioni](#prenotazioni)
4. [Prenotazione online (pagina pubblica /prenota)](#prenotazione-online-pagina-pubblica-prenota)
5. [Agente vocale "Sofia"](#agente-vocale-sofia)
6. [Reception e accoglienza](#reception-e-accoglienza)
7. [Sale & Tavoli (planimetria)](#sale--tavoli-planimetria)
8. [Dashboard](#dashboard)
9. [Menu & Banchetti](#menu--banchetti)
10. [Menu digitale pubblico](#menu-digitale-pubblico)
11. [Comande, Cucina e Passe (gestionale di sala)](#comande-cucina-e-passe-gestionale-di-sala)
12. [Pagamenti, conto al tavolo e cassa](#pagamenti-conto-al-tavolo-e-cassa)
13. [Fiscalità: scontrino, fattura elettronica, proforma](#fiscalità-scontrino-fattura-elettronica-proforma)
14. [Integrazione cassa Passepartout](#integrazione-cassa-passepartout)
15. [Stampa termica e print agent](#stampa-termica-e-print-agent)
16. [Messaggi: WhatsApp e SMS](#messaggi-whatsapp-e-sms)
17. [Email](#email)
18. [Chat staff](#chat-staff)
19. [Notifiche](#notifiche)
20. [Clienti (CRM / rubrica)](#clienti-crm--rubrica)
21. [Attività / to-do](#attività--to-do)
22. [Personale (turni e presenze)](#personale-turni-e-presenze)
23. [Inventario](#inventario)
24. [Lista della spesa e fornitori](#lista-della-spesa-e-fornitori)
25. [HACCP](#haccp)
26. [Funzioni AI](#funzioni-ai)
27. [Impostazioni](#impostazioni)
28. [Utenti, ruoli e permessi](#utenti-ruoli-e-permessi)
29. [Privacy e GDPR](#privacy-e-gdpr)
30. [Piattaforma SaaS: multi-tenant, moduli e abbonamenti](#piattaforma-saas-multi-tenant-moduli-e-abbonamenti)
31. [Funzionalità trasversali](#funzionalità-trasversali)
32. [Integrazioni esterne](#integrazioni-esterne)
33. [Registro aggiornamenti](#registro-aggiornamenti)

---

## Che cos'è

Sympotia è un **gestionale completo per ristoranti in tempo reale**: prenotazioni, sala, accoglienza, comande e cucina, pagamenti, magazzino, HACCP, personale e tutte le comunicazioni con i clienti (telefono con agente vocale AI, WhatsApp, SMS, email, prenotazione dal sito) in un'unica applicazione. È in produzione in un ristorante reale (Vecchio Frantoio) ed è progettato per l'uso **durante il servizio**, da telefono, tablet e desktop.

Tre superfici distinte:

- **Il gestionale (CRM)** — l'app per lo staff, con permessi per ruolo, aggiornamenti live su tutti i dispositivi, tema chiaro/scuro, funzionamento anche offline (le modifiche si mettono in coda e partono al ritorno della rete).
- **Le pagine pubbliche per i clienti** — prenotazione online, menu digitale da QR, pagamento del conto al tavolo dal telefono, informativa privacy. Nessun login richiesto.
- **La piattaforma** — livello SaaS multi-ristorante: ogni ristorante (tenant) ha i propri dati isolati a livello di database, il proprio branding, i propri moduli attivi e il proprio abbonamento.

Punti distintivi da usare nel marketing:

- **Tutto in tempo reale**: ogni schermo dello staff si aggiorna da solo (Socket.IO); una prenotazione presa al telefono compare subito in sala, un piatto segnato pronto in cucina compare subito al passe.
- **AI che propone, mai che decide**: le risposte suggerite, le proposte di prenotazione da WhatsApp e i suggerimenti di assegnazione tavolo richiedono sempre la conferma di una persona. L'unica eccezione è l'agente vocale, che prenota ma marca sempre la prenotazione "da rivedere".
- **Canali di comunicazione con fallback automatico**: conferme e promemoria partono su WhatsApp, SMS o email secondo l'ordine scelto dal ristoratore per ogni fonte di prenotazione, con scalata automatica al canale successivo se il primo fallisce.
- **Pensato per il servizio**: interfaccia a target minimi 44px, testi ridotti all'essenziale, mai maiuscole urlate, uso a una mano sul palmare comande, registri HACCP compilabili davanti alla cella frigo.

---

## Panoramica dei moduli

Navigazione a gruppi (sidebar desktop, bottom bar + sheet "Altro" su mobile):

| Gruppo | Sezioni |
|---|---|
| — | Dashboard |
| Servizio | Prenotazioni · Reception · Sale & Tavoli · Menu & Banchetti · Comande · Cucina · Passe |
| Comunicazioni | Chiamate · Messaggi · Email · Chat staff · Notifiche |
| Operazioni | Attività · Inventario · Lista della Spesa · HACCP |
| Gestione | Pagamenti · Clienti · Personale · Utenti |
| Sistema | Impostazioni · (Piattaforma, Consumi AI, Development, Roadmap — solo amministrazione) |

Le voci compaiono solo se l'utente ha il permesso corrispondente **e** se il modulo è incluso nel piano del ristorante (vedi [Piattaforma SaaS](#piattaforma-saas-multi-tenant-moduli-e-abbonamenti)).

---

## Prenotazioni

La sezione centrale del CRM: elenco, mappa tavoli e scheda prenotazione in un'unica vista.

**Elenco e ricerca**
- Navigatore data + turno (Pranzo / Cena / Tutti) condiviso con tutta l'app.
- Ricerca testuale con **dettatura vocale**.
- Filtri combinabili: sala, stato pagamento, stato arrivo, fascia ospiti, con allergeni, con note, senza tavolo, fonte/canale di prenotazione.
- Ordinamento per orario, nome, ospiti o data di creazione; contatori di sintesi; sezione Annullate separata.
- Ogni riga mostra badge di canale (web, agente vocale, WhatsApp, telefono, inserita da operatore), stato conferma con timestamp, promemoria inviato, stato pagamento, chip note con icona e chip intolleranze, evidenza **cliente VIP** e avviso **cliente in blacklist**.

**Stati della prenotazione (modello unico in tutta l'app)**
- Stati persistiti: Da confermare, Confermata, Arrivato, Liberata, No show, Annullata, Rifiutata.
- Stati derivati dall'orologio, che avanzano da soli durante il servizio: **In arrivo** (da 20 minuti prima dell'orario) e **In uscita** (oltre la durata attesa). Stesso colore e stessa etichetta in lista, reception, mappa tavoli e dashboard.
- Azioni: estendi il tavolo di 30 minuti, rimanda di 15, forza manualmente uno stato.

**Scheda prenotazione (3 passi)**
1. **Dettagli** — cliente (nome, telefono, email), coperti, data e slot orario, turno, sala/tavolo, durata, tipo (Prenotazione / Walk-in / Banchetto), note rapide a chip configurabili, intolleranze a chip, consensi privacy e marketing. Controlli automatici anti-duplicato, avviso blacklist, ripristino bozza non salvata.
2. **Pagamenti** — richiesta acconto con link di pagamento (inviato via SMS, WhatsApp o email), revoca link, rimborso; apertura e gestione del conto al tavolo (vedi [Pagamenti](#pagamenti-conto-al-tavolo-e-cassa)).
3. **Comunicazione** — invio conferma o promemoria sul canale scelto, email personalizzata, storico messaggi con stati In coda / Inviato / Consegnato / Fallito.

**Automatismi**
- Alla conferma parte automaticamente il messaggio al cliente sui canali configurati; al rifiuto parte la disdetta con invito a chiamare.
- Se cambiano ora o coperti di una prenotazione già confermata, il cliente riceve un **avviso di modifica**.
- Rilevazione conflitti sul tavolo (considera anche le comande aperte) e blocco dei tavoli in sale chiuse.
- Ogni prenotazione con telefono **aggiorna automaticamente la rubrica clienti**.
- Prenotazione senza tavolo → l'AI **suggerisce un'assegnazione** secondo le regole scritte dal ristoratore; lo staff conferma o ignora.
- Annullamenti e nuove prenotazioni web generano una notifica push ai responsabili.

**Mappa tavoli integrata**
- Stato tavoli per sala con misuratore di occupazione, assegnazione con un tocco, **unione e divisione tavoli**, tavoli nascosti per turno, auto-assegnazione.
- **Riga dei totali del servizio** sopra la mappa: coperti, prenotazioni, senza tavolo, **tavoli liberi** (su fondo verde) e **occupati** (su fondo rosso) della sala mostrata, percentuale di occupazione.

**Stampa**
- Stampa della lista prenotazioni del servizio, raggruppata per orario o per tavolo, con filtro sala/turno e inclusione dei banchetti del giorno.

---

## Prenotazione online (pagina pubblica /prenota)

Pagina di prenotazione self-service, leggerissima (un solo file statico, si apre all'istante anche su reti lente), personalizzata col **branding del ristorante** (nome, tagline, logo, colore, indirizzo con link Google Maps, telefono cliccabile). Bilingue **italiano/inglese** con cambio lingua istantaneo. Ottimizzata SEO (titolo col nome del locale, Open Graph, dati strutturati Restaurant).

**Percorso del cliente (2 passi)**
1. **Tavolo** — coperti (con "di cui bambini": prepariamo seggiolone e mezze porzioni), data da striscia settimanale o calendario mensile con **semaforo di disponibilità** (libero / quasi pieno / chiuso, col motivo di chiusura), scelta della **sala preferita**, turno Pranzo/Cena e slot orario.
2. **Dati** — nome, telefono o email (ne basta uno), **allergie e intolleranze** a chip, note libere, consenso privacy obbligatorio.

**Conferma automatica o richiesta**
- Se c'è posto nella sala scelta, la prenotazione si **conferma da sola** con tavolo già assegnato: il cliente vede subito "Prenotazione confermata".
- Se la sala è oltre la soglia di occupazione impostata (o non c'è tavolo), diventa una **richiesta** che lo staff conferma a mano: "Vi ricontattiamo a breve".
- In entrambi i casi il cliente riceve subito un messaggio di riscontro (WhatsApp / SMS / email secondo la configurazione) e lo staff una notifica push.

**Caparra automatica**
- Sopra una soglia di coperti configurabile (default 9), la pagina mostra in tempo reale l'importo della caparra (default €10 a persona) e le condizioni (si scala dal conto, rimborso integrale se si annulla con almeno 24 ore di anticipo — caparra confirmatoria art. 1385 c.c.).
- Al termine il cliente riceve il **link di pagamento** (Revolut o SumUp): finché la caparra non è pagata il tavolo non è garantito. I link non pagati **scadono da soli** dopo un numero di ore configurabile.

**Controlli e protezioni**
- Blocchi per data/turno decisi dall'operatore ("le prenotazioni web sono chiuse per questa data, chiamateci").
- Antispam (honeypot invisibile + limite di richieste per IP), protezione anti doppio-invio (un secondo invio identico entro 30 minuti non crea doppioni).
- Numeri in **blacklist**: bloccati con messaggio neutro, oppure accettati con avviso allo staff (a scelta del ristoratore).
- Se il canale è spento, la pagina mostra una cortese schermata di manutenzione.

---

## Agente vocale "Sofia"

Agente conversazionale AI (ElevenLabs) che **risponde al telefono del ristorante** e gestisce le prenotazioni a voce, in italiano.

**Cosa sa fare al telefono**
- Riconosce il cliente dal numero e lo saluta per nome; il **messaggio iniziale è personalizzabile** dal ristoratore.
- Verifica la disponibilità reale (stessa griglia orari e stesse regole del CRM), **crea, modifica e cancella** prenotazioni.
- Per modificare o cancellare ritrova la prenotazione dal **numero del chiamante**; se non corrisponde (si chiama da un altro telefono), la cerca per **nome e data**, accenti inclusi, o accetta il numero dettato a voce.
- Applica le regole di casa: date bloccate, soglia gruppi grandi oltre la quale passa la chiamata a un operatore (default 8), caparra automatica (annuncia importo e condizioni con i numeri veri delle Impostazioni), eventuale secondo giro sullo stesso tavolo se abilitato.
- Ogni prenotazione presa da Sofia nasce marcata **"da rivedere"**: lo staff la vede evidenziata e la valida.

**Controllo operativo**
- Interruttore on/off, sospensione immediata ("richiamare dopo le ..."), **sospensioni programmate** per data/turno/fascia oraria, giorni gestiti solo da operatore.

**Sezione Chiamate nel CRM**
- Elenco chiamate con schede Tutte / Da ricontattare / Ricontattati / Con prenotazione.
- Per ogni chiamata: **riassunto AI, trascrizione completa, registrazione audio** riascoltabile, durata, esito.
- Azioni: richiama, segna ricontattato, **crea prenotazione dalla chiamata** (dati precompilati), apri scheda cliente, storico messaggi verso quel numero.
- Badge "da ricontattare" sempre visibile nel menu.

---

## Reception e accoglienza

Postazione "alla porta" per la gestione degli arrivi.

- Due modalità: **Lista** e **Mappa** della sala.
- Prenotazioni raggruppate per momento: Alla porta, In attesa, In ritardo, Più tardi, Arrivati, No-show, Senza tavolo. Filtri per turno e sala.
- **Swipe per il check-in**: si scorre la riga per segnare "Arrivato".
- Percorso completo del tavolo: Arrivato → In uscita → Libera tavolo; no-show, rimetti in attesa, rimuovi tavolo.
- **Assegnazione tavolo guidata**: il selettore etichetta ogni tavolo come Adatto / Piccolo / Grande / Occupato / Attuale, e permette lo **scambio di tavolo tra due prenotazioni** con conferma.
- **Walk-in** in due tocchi (nome, coperti, telefono, note), apribile da qualunque pagina col "+" globale.
- Timeline degli arrivi con azioni rapide.

---

## Sale & Tavoli (planimetria)

Editor della piantina e stato della sala in tempo reale.

- Disegno sale e tavoli: forme diverse, trascinamento con mouse **e touch**, rotazione, rinomina, numero coperti, blocco posizione, rilevazione sovrapposizioni.
- **Unione tavoli** per il turno (e divisione), con le unioni visibili identiche su ogni schermo dell'app.
- **Tavoli nascosti per turno** e **chiusura di una sala per turno** (o estesa), programmabili anche in anticipo dalle Impostazioni.
- Legenda colori coerente con gli stati delle prenotazioni; ogni cambiamento si propaga live a tutti i dispositivi.

---

## Dashboard

Il colpo d'occhio del "adesso", sempre sulla giornata corrente.

- Riquadri live: **In arrivo, In sala, In uscita, Tavoli liberi** (contati come sulla mappa: unioni e tavoli nascosti inclusi).
- KPI di giornata: prenotazioni, ospiti, tavoli, banchetti, divisi Pranzo / Cena / Giornata; indicatore di affluenza da Calmo a Sold out.
- **Da confermare**: le richieste in sospeso si confermano o rifiutano direttamente da qui (con blocco se la caparra non è stata pagata, forzabile).
- Attività di oggi, lista della spesa e **prodotti sotto scorta** con azioni rapide e collegamenti alle sezioni.
- **Chi è in turno oggi** (sala, cucina, reception).
- **Report AI di andamento**: una lettura in italiano dell'andamento degli ultimi 30 giorni, generata su richiesta.

---

## Menu & Banchetti

**Piatti alla carta**
- Anagrafica completa: categorie (Antipasti, Primi, Secondi, Contorni, Dolci, Bevande, Altro), nome, descrizione, prezzo, **aliquota IVA**, foto (con ridimensionamento automatico), **allergeni**, visibilità sul menu digitale. Viste griglia ed elenco.
- **Traduzione automatica del menu** in inglese, francese e tedesco (AI): i nomi delle specialità restano riconoscibili, si traducono solo le voci mancanti.
- Import e sincronizzazione dal catalogo della cassa Passepartout (per chi ha l'integrazione).

**Banchetti ed eventi**
- Wizard a passi: evento e cliente → coperti e tariffa (prezzo adulti, bambini, sconto in € o %) → composizione del menù per uscite → tavoli assegnati → note operative (Portate, Servizio, Mise en place).
- **Registro pagamenti del banchetto**: acconti e saldo per contanti/carta/bonifico, stato Saldato / Parziale / Non pagato. Prezzi e pagamenti visibili solo ai ruoli autorizzati.
- Calendario eventi e filtri temporali (questa settimana, questo mese, più avanti, passati).
- **Promemoria automatici in cucina a 72, 48 e 24 ore** dall'evento, a priorità crescente, che si spostano da soli se la data cambia.
- Stampa della scheda evento; colore identificativo per evento visibile su tutte le superfici.

---

## Menu digitale pubblico

- Menu consultabile dal cliente **inquadrando un QR al tavolo**, senza app da installare.
- Multilingua (usa le traduzioni del menu), con foto, descrizioni, prezzi e allergeni.
- Si attiva/disattiva con un interruttore; il QR si genera dalla pagina Menu.

---

## Comande, Cucina e Passe (gestionale di sala)

Modulo completo per presa comanda, produzione e coordinamento delle uscite. Si attiva dalle Impostazioni.

**Comande (palmare cameriere)**
- Griglia tavoli del servizio con stato comanda; catalogo piatti per categoria con ricerca; uso a una mano, su telefono la comanda vive in uno sheet dietro il totale.
- **Uscite/portate**: ogni riga si assegna a un'uscita; varianti libere per riga ("senza sale, metà porzione…"), quantità, coperti ±1.
- Le righe restano sul palmare finché non si preme **Invia** (una sola trasmissione, robusta anche con rete instabile).
- Azioni: **storno riga inviata** con motivazione obbligatoria, richiama in bozza, **trasferimento su altro tavolo**, sconto (importo o percentuale con motivazione), segnalazioni "Piatto non riuscito" / "Ingrediente finito", chiusura comanda con apertura conto.

**Cucina (KDS)**
- Coda comande **per partita** (es. Pizzeria, Primi…), con avanzamento riga Inviato → In preparazione → Pronto, note del piatto, colonna "In arrivo", filtro turno. Ogni monitor si sottoscrive alla propria partita.
- **Modifiche dopo il lancio in evidenza**: storno di una riga inviata, piatti aggiunti a un'uscita già lanciata, "riporta" e trasferimento di tavolo accendono sulla card la pill rossa **"modificata"** — il tocco mostra cosa è cambiato, chi e quando (con la motivazione dello storno); **Ok** spegne l'avviso su tutti gli schermi. Suona come una comanda nuova.
- I messaggi del canale **Cucina** della chat staff compaiono come **striscia sul monitor** (con la campana delle comande): "finito il branzino" arriva senza aprire la chat.

**Passe (expediter)**
- Vista di sincronia delle uscite: **Chiama** un'uscita quando la sala è pronta, ricalcola i tempi di partenza, quattro modalità di lancio (tutte automatiche, solo la prima, a consumo — la successiva parte quando la precedente è servita —, manuale).
- Metriche di servizio: attesa media al passe e al ritiro, delta di sincronia tra partite, scarti.

**Regole di dominio**
- La **giornata di servizio** inizia alle 5:00 e il turno cambia alle 17:00: la cena che finisce all'una di notte resta del giorno giusto.
- Comanda (cosa si prepara) e conto (cosa si paga) sono collegati ma distinti; ogni evento arriva in tempo reale a sala, cucina e passe con consegna garantita anche dopo un riavvio.

---

## Pagamenti, conto al tavolo e cassa

**Conti aperti**
- Elenco dei conti del servizio (più eventuali conti mai chiusi di servizi precedenti), ricerca, totali live: Da incassare, Incassato, Residuo.
- **Scheda conto**: righe, sconti, coperto; Da pagare / Già pagato / Incassato dai clienti / Da rimborsare; mancia; incassi dello staff (contanti/POS) registrati anche a conto aperto; chiusura in cassa; annullo con storno morbido (tutto resta a registro).
- Gli **acconti/caparre già pagati si scalano da soli** dal conto del tavolo.

**Conto al tavolo per l'ospite (pay-at-table)**
- Il cameriere stampa un **QR**; l'ospite paga dal telefono, senza app e senza login.
- **Dividi il conto**: quota uguale, importo libero o **per riga** ("io ho preso solo l'antipasto"), con etichetta facoltativa del pagante.
- Gestione sicura della concorrenza: due ospiti non possono pagare la stessa quota; le quote abbandonate si liberano da sole e un controllo periodico recupera anche i pagamenti il cui esito si fosse perso.
- Pagina bilingue IT/EN, aggiornata ogni 5 secondi.

**Link di pagamento (caparre e acconti)**
- Creazione link dall'app (gateway **Revolut** o **SumUp**, anche uno per le caparre e uno per il conto), invio via SMS / WhatsApp / email, revoca, **rimborso**, riconciliazione manuale.
- Filtri In attesa / Pagati / Falliti / Scaduti; **scadenza automatica** dei link non pagati con eventuale disdetta automatica della prenotazione e messaggio al cliente.
- Alla ricezione del pagamento il cliente riceve la conferma e lo stato si aggiorna ovunque in tempo reale.

**Chiusura di cassa**
- Report giornaliero per **metodo di pagamento** (Contanti, Online, Satispay, Buoni pasto, Gift card, Omaggio, Sospeso) e per **documento** (Scontrino, Fattura, Proforma, Senza documento), più mance, acconti maturati e ammanchi. Filtro per turno; storni esclusi dai totali.

---

## Fiscalità: scontrino, fattura elettronica, proforma

- **Scontrino elettronico** (documento commerciale) emesso via provider (Openapi.com) direttamente dal conto; se la trasmissione fallisce **il servizio non si ferma**: il conto si chiude comunque e il documento si ritenta dopo.
- **Fattura elettronica SDI** dal conto: dati di fatturazione presi dalla scheda cliente (denominazione, P.IVA, CF, codice SDI, PEC), XML FatturaPA generato e trasmesso.
- **Proforma** quando lo scontrino non è previsto; annullo del documento fiscale come atto separato (il conto non si tocca).
- Configurazione: dati esercente, provider, **mappa aliquote IVA** (l'aliquota vive sul piatto; riepilogo IVA per aliquota anche sul preconto stampato), numerazione fatture per anno.

---

## Integrazione cassa Passepartout

Per i ristoranti con cassa **Passepartout Menù** (modulo dedicato):

- **Import del menu** dal catalogo articoli della cassa, varianti comprese.
- Anteprima della comanda attiva su un tavolo della cassa e **importazione del conto** nel CRM.
- **Chiusura del conto in cassa dal CRM**: scontrino e saldo partono verso il gestionale; ritentabile se la cassa era irraggiungibile.
- Collegamento sicuro cloud↔ristorante tramite un piccolo agente installato sulla LAN (nessuna porta aperta verso l'esterno), con stato di connessione visibile.

---

## Stampa termica e print agent

- **Stampanti termiche di rete** censite dalle Impostazioni (nome, IP, porta); un **agente di stampa** sulla rete del ristorante ritira i lavori dal cloud — aggiungere una stampante diventa effettivo in pochi secondi, e lo stato online/offline dell'agente è visibile in Impostazioni.
- Si stampano: **comande per partita** (ognuna sulla propria stampante), **preconti** (con acconto già versato, residuo vero e riepilogo IVA), **QR del conto al tavolo**; instradamento per funzione configurabile.
- Tentativi automatici in caso di errore; una stampante inceppata non blocca le altre stampe.
- Dal browser si stampano inoltre: lista prenotazioni, inventario, lista della spesa, report HACCP, scheda banchetto.

---

## Messaggi: WhatsApp e SMS

**Inbox unificata**
- Conversazioni WhatsApp e SMS in un'unica vista a due pannelli, raggruppate per numero; filtri Tutti / Da rispondere / Prenotazioni; allegati (foto, documenti); letto/non letto.
- **Risposta manuale o suggerita dall'AI**: il suggerimento si legge, si corregge e si invia con un tocco — l'AI non invia mai nulla da sola, e sa dire "non lo so" invece di inventare.
- **Crea prenotazione dalla conversazione** (con collegamento bidirezionale conversazione↔prenotazione) e badge dello stato prenotazione nel thread.

**Messaggi automatici al cliente**
- Conferma, promemoria, avviso di modifica, disdetta, richiesta e conferma caparra, link del conto: partono da **template WhatsApp approvati** (anche in inglese per gli ospiti stranieri — mai messaggi ibridi) con **fallback automatico a SMS** se il destinatario non è raggiungibile su WhatsApp.
- **Ordine dei canali configurabile per fonte** di prenotazione (es. web: WhatsApp → SMS + copia email; telefono: solo SMS), con scalata automatica al canale successivo in caso di errore.

**Prenotazioni via WhatsApp**
- Un messaggio come "15/12 20:00 4 Marco Rossi" (o in linguaggio naturale, interpretato dall'agente AI) diventa una **proposta di prenotazione** che lo staff conferma con un tocco.

---

## Email

- **Invio**: conferme, disdette, richieste caparra ed email libere (oggetto + corpo) con template HTML brandizzato del ristorante, via SMTP proprio o Resend.
- **Ricezione**: le risposte dei clienti entrano nell'app (via webhook Resend o direttamente dalla casella IMAP del ristorante, es. Aruba/Gmail) e vengono **agganciate al thread giusto**.
- Inbox email a due pannelli con schede Tutte / Risposte dei clienti, allegati, ricerca, composizione e risposta in thread.
- Chi può leggere le prenotazioni può leggere i thread email di quei clienti.

---

## Chat staff

- **Canali per reparto** (Generale, Sala, Cucina, Reception, Manager, Direttore, Titolare) con membership automatica in base al ruolo, più **messaggi diretti** tra colleghi.
- Testo e **foto**, menzioni, contatori non letti, notifiche push mirate, collegamento di un messaggio a una prenotazione o a un tavolo.
- **Messaggi rapidi** a un tocco configurabili ("Piatto finito", "Serve un runner"…).
- I messaggi si eliminano da soli dopo 90 giorni: è traffico di servizio, non un archivio.

---

## Notifiche

- **Campanella** con contatore e pannello rapido + pagina completa con filtri per categoria (Prenotazioni, Messaggi, Chiamate, Email, Pagamenti, Sistema).
- Ogni notifica è **persistente** (si ritrova anche se il browser era chiuso) e porta dritti all'entità: prenotazione, conversazione, thread.
- **Notifiche push** sul telefono (PWA) per gli eventi importanti: nuova prenotazione web, richiesta da confermare, annullamento, pagamento ricevuto, sotto scorta, messaggio in chat.
- **Badge sull'icona dell'app** con il totale delle cose da attenzionare, aggiornato anche ad app chiusa.

---

## Clienti (CRM / rubrica)

- Rubrica con **indice alfabetico**, ricerca e scheda cliente completa: contatti, indirizzo, **dati di fatturazione** (denominazione, P.IVA, CF, codice SDI, PEC), preferenze di servizio (tavolo preferito, note), **allergie e note alimentari**, lingua dell'ospite.
- Flag **VIP** (evidenzia la prenotazione in sala) e **Blacklist** con motivo (blocca web e agente vocale, avvisa in sala), consenso **marketing** con data.
- **Storico prenotazioni e banchetti** del cliente.
- **Alimentazione automatica**: ogni prenotazione con telefono — da qualunque canale — crea o aggiorna la scheda; la lingua rilevata dal canale si memorizza e le comunicazioni successive partono nella lingua giusta.
- **Unione duplicati** guidata (rileva i clienti con lo stesso numero e fonde le schede ricollegando lo storico).
- Azioni rapide **Chiama** e **WhatsApp**; apertura scheda direttamente da una chiamata o da una conversazione.
- **Audience marketing**: esportazione dei soli clienti con consenso marketing e recapito valido (disponibile solo in modalità legale avanzata).

---

## Attività / to-do

- Liste Da fare / Oggi / Scadute / Mie / Fatte, con priorità (Alta/Media/Bassa), categoria/ambito (Generale, Prenotazione, Evento, Inventario, Manutenzione, Staff…), scadenze e **assegnazione a una persona o a un intero ruolo** (si assegna a pari grado o subordinati, mai verso l'alto).
- Selezione multipla per completare o riaprire in blocco; aggiunta rapida dalla Dashboard.
- **Attività generate dagli automatismi**: promemoria banchetti (72/48/24h) e **promemoria pane** (alle 20:00 conta i coperti di domani e crea il to-do con la quantità).

---

## Personale (turni e presenze)

- Anagrafica dipendenti: reparto (Sala/Cucina), ruolo, contratto, Fisso/Extra, attivo/disattivo.
- **Griglia turni settimanale** Lun–Dom: Pranzo, Cena, Pranzo e cena, Tutto il giorno, Riposo; inserimento massivo della settimana.
- **Assenze**: malattia, permesso, riposo, per giornata intera o singolo turno.
- **Chi è presente oggi** per turno (incrocio automatico di turni e assenze), mostrato anche in Dashboard.

---

## Inventario

- Prodotti con categoria, unità di misura, quantità e **soglia di scorta**; **aree di conservazione** (celle, ripiani — Cucina / Sala / Bar) con quantità distribuite per area.
- Movimenti di carico, scarico, rettifica e trasferimento.
- **Avviso automatico sotto scorta** (push ai responsabili e alla cucina) e riquadro in Dashboard.
- Categorie e aree riordinabili; stampa dell'inventario con distribuzione per area.

---

## Lista della spesa e fornitori

- Aggiunta rapida, quantità e unità, raggruppamento per **fornitore** e per categoria (Cucina / Bar / Altro), spunta degli acquistati con annulla ("Undo").
- **Selezione multipla**: elimina, **stampa** o **condividi** (WhatsApp ecc. via condivisione di sistema) solo gli articoli scelti.
- **Anagrafica fornitori** (nome, telefono, note, categorie servite).
- Sincronizzata in tempo reale tra tutti i telefoni dello staff; ogni voce ricorda chi l'ha aggiunta.

---

## HACCP

Registro digitale a norma, compilabile dal telefono (campi grandi, pensati per l'uso davanti alla cella frigo). Cinque registri, ognuno con contatore di completamento del giorno:

1. **Temperature** frigoriferi e congelatori — postazioni predefinite, range atteso, evidenza scostamenti.
2. **Oli di frittura** — Filtrato / Sostituito / Utilizzabile.
3. **Pulizie** attrezzature e superfici — punti di pulizia predefiniti.
4. **Ricevimento merci** — prodotto, lotto, temperatura, Accettato/Respinto, note.
5. **Abbattimento / produzione** — prodotto, lotto interno, temperature, durata.

Ogni riga registra **automaticamente chi ha compilato e quando**. Consultazione per giorno e **stampa del report** per i controlli.

---

## Funzioni AI

Tutte le funzioni AI girano sul server (nessuna chiave nel browser) e seguono una regola unica: **l'AI propone, una persona conferma**.

| Funzione | Cosa fa |
|---|---|
| Agente vocale Sofia | Risponde al telefono e prenota (unica AI che scrive, sempre con revisione dello staff) |
| Agente WhatsApp | Interpreta i messaggi dei clienti e propone crea/modifica/cancella prenotazione da confermare con un tocco |
| Risposte suggerite | Propone la risposta a un messaggio, basandosi sulla conversazione, sulla prenotazione collegata e sulle **regole della casa** scritte dal ristoratore (base di conoscenza) |
| Suggerimento tavoli | Propone l'assegnazione o l'unione tavoli per le prenotazioni senza tavolo, secondo un prompt scritto dal ristoratore |
| Traduzioni menu | Traduce il menu in inglese, francese e tedesco |
| Report Dashboard | Spiega in italiano l'andamento del periodo (i numeri li calcola il database, l'AI li racconta) |

**Consumi AI**: pagina di monitoraggio (riservata) con generazioni, token e **costi in euro** per funzione, più i crediti dell'agente vocale.

---

## Impostazioni

Pagina unica a blocchi, con chip-àncora per saltare alla sezione. Blocchi e contenuti:

- **Profilo** — pagina di partenza dopo il login; notifiche push del dispositivo.
- **Ristorante** — orari settimanali per turno con passo slot e slot disattivabili; chiusure programmate (giornata o singolo turno, con motivo); sale chiuse e tavoli nascosti programmati; **promemoria** ricorrenti (destinatari per ruolo, frequenza); modulo **Sala & Cucina** (partite, mappatura categorie→partita, monitor o stampante, stampanti di rete, profili di setup salvabili, registratori telematici); **documenti legali e identità pubblica** (nome pubblico, tagline, telefono, indirizzo, link Maps, ragione sociale, P.IVA, contatti privacy/DPO, fornitori e tempi di conservazione).
- **Prenotazioni** — interruttore prenotazioni web; blocchi per data/turno; **limiti di occupazione per sala** (la soglia della conferma automatica); **canali di risposta per fonte** (ordine e fallback email/WhatsApp/SMS); note rapide e intolleranze a chip (riordinabili); **caparra automatica** (soglia coperti, € a persona); **blacklist** per fonte (blocca o avvisa).
- **Pagamenti** — gateway Revolut e SumUp (anche uno per flusso), conto al tavolo on/off, scadenza automatica dei link.
- **Fiscalità** — dati esercente, provider scontrino, mappa e aliquote IVA.
- **Comunicazioni** — SMTP/Resend (invio), IMAP (ricezione), libreria **media** per gli allegati, messaggi rapidi della chat staff.
- **AI** — agente vocale (messaggio iniziale, soglia gruppi, sospensioni, doppio turno), risposte AI ai messaggi + base di conoscenza, prompt logica tavoli.
- **Amministrazione** — gestione utenti, matrice permessi, log attività.

**Onboarding**: al primo accesso di un nuovo ristorante, un wizard guida in 4 passi (dati del ristorante → sale e tavoli → orari → menu) prima di entrare nel gestionale.

---

## Utenti, ruoli e permessi

- **6 ruoli operativi**: Proprietario, General Manager, Manager, Reception, Cameriere, Cucina (più l'Admin di piattaforma, esterno ai ristoranti).
- **~35 permessi granulari** (vista/modifica per ogni area; per le comande: prendere, stornare, monitor di partita, lancio uscite) applicati **sia sull'interfaccia sia sulle API**: senza permesso la voce di menu sparisce e l'endpoint rifiuta.
- **Matrice permessi personalizzabile** per ristorante dalla UI (checkbox per ruolo), effettiva immediatamente.
- Account: creazione/disattivazione utenti (solo Proprietario), cambio profilo, email e password self-service, **recupero password** via link monouso; il cambio password disconnette tutte le altre sessioni.
- Sessioni con token a scadenza e rinnovo trasparente; avviso 5 minuti prima della scadenza.
- **Log attività** completo: chi ha fatto cosa, quando, su quale risorsa, con esito — filtrabile per utente, azione, risorsa e periodo.

---

## Privacy e GDPR

- **Informativa privacy pubblica generata automaticamente** dai dati inseriti nelle Impostazioni (titolare, finalità, basi giuridiche, conservazione, diritti, Garante), con pagina dedicata linkata dal form di prenotazione.
- **Allergie come dato particolare (art. 9)**: la compilazione volontaria nel form registra il consenso con timestamp; consensi privacy e marketing tracciati e non distruttivi.
- Tempi di conservazione configurabili (dati cliente, registrazioni chiamate, marketing); caparra con richiamo all'art. 1385 c.c.; modalità legale "semplice" o "avanzata" (la seconda abilita i flussi marketing).

---

## Piattaforma SaaS: multi-tenant, moduli e abbonamenti

- **Ogni ristorante è un tenant isolato a livello di database** (Row Level Security): dati, branding, impostazioni, permessi e integrazioni separati. Pagine pubbliche per **slug** (`/prenota/nome-ristorante`) o **dominio personalizzato**.
- **Moduli vendibili (add-on)**: Agente vocale (`voice`), WhatsApp (`whatsapp`), Prenotazioni web (`web_booking`), Conto al tavolo (`pay_at_table`), integrazione Passepartout (`passepartout`). L'email è canale base. Un modulo non incluso nel piano non compare nemmeno al Proprietario.
- **Doppio livello di controllo**: il modulo va *venduto* (entitlement) e poi *acceso* dal ristoratore (interruttore operativo). Tutti i default sono prudenti (spento).
- **Billing con Stripe**: abbonamento per tenant con add-on, checkout e portale clienti; lo stato dell'abbonamento accende/spegne i moduli da solo (webhook). Quadro MRR e stato clienti per l'amministrazione.
- **Pannello Piattaforma** (solo admin): creazione nuovo ristorante in un click (con owner e password temporanea mostrata una sola volta), sospensione/riattivazione (la sospensione spegne anche login e pagine pubbliche), accensione moduli, **impersonificazione** dell'owner per assistenza (sessione breve, tracciata e con banner visibile).
- **Onboarding self-service** del nuovo ristorante col wizard in 4 passi.

---

## Funzionalità trasversali

- **Tempo reale ovunque**: ~70 tipi di eventi live; ogni schermo si aggiorna da solo su tutti i dispositivi.
- **Offline-first**: le modifiche fatte senza rete si mettono in coda e partono al ritorno della connessione, con avviso; indicatore di connessione sempre visibile.
- **PWA mobile**: installabile sul telefono, bottom bar con **"+" globale** (Prenotazione, Walk-in, Banchetto, Piatto, Spesa, Attività, Prodotto, Cliente…), sheet "Altro", interfacce diverse per telefono e desktop (sheet vs pannelli affiancati), gesti touch (swipe check-in, drag della planimetria), target minimi 44px.
- **Tema chiaro/scuro** con memoria della scelta e rispetto delle preferenze di sistema.
- **Command palette (⌘K)**: ricerca globale istantanea su prenotazioni e clienti.
- **Barra globale data + turno** condivisa da tutte le viste di servizio.
- **Interruttori rapidi di canale**: prenotazioni web e agente vocale si spengono/accendono al volo dalla barra.
- **Multilingua verso il cliente**: la lingua dell'ospite viene rilevata e ricordata; conferme, template WhatsApp, email e pagine pubbliche seguono la sua lingua (IT/EN; menu anche FR/DE).
- **Robustezza**: aggiornamento app segnalato con banner; errori isolati per scheda (un crash non butta giù l'app); protezione anti doppio-invio su tutte le operazioni delicate.
- **Fuso orario**: tutte le date e ore sono Europe/Rome, indipendentemente dal dispositivo.

---

## Integrazioni esterne

| Servizio | A cosa serve |
|---|---|
| ElevenLabs (+ numero Vonage) | Agente vocale Sofia al telefono |
| Anthropic Claude | Tutte le funzioni AI testuali (risposte, agente WhatsApp, report, traduzioni, suggerimento tavoli) |
| Meta WhatsApp Cloud API / Twilio | WhatsApp (template approvati) e SMS, con fallback automatico |
| Resend / SMTP / IMAP | Invio e ricezione email con la casella del ristorante |
| Revolut Merchant / SumUp | Pagamenti online: caparre, acconti, conto al tavolo |
| Openapi.com | Scontrino elettronico e fattura elettronica (SDI) |
| Passepartout Menù | Cassa: import menu, import conti, chiusura fiscale (via agente LAN) |
| Stampanti termiche ESC/POS | Comande, preconti, QR (via print agent sulla LAN) |
| Stripe | Abbonamenti SaaS dei ristoranti (lato piattaforma) |
| Web Push (VAPID) | Notifiche push e badge sull'icona dell'app |

---

## Registro aggiornamenti

> Ogni PR che cambia una funzionalità visibile aggiunge una riga qui (data, sezione toccata, cosa è cambiato in una frase). Le righe più recenti in alto.

| Data | Sezione | Modifica |
|---|---|---|
| 2026-08-29 | Agente vocale "Sofia" | Modifica/cancellazione: se il numero del chiamante non corrisponde, Sofia ritrova la prenotazione per nome e data (accenti inclusi) o dal numero dettato. |
| 2026-08-29 | Prenotazioni | Nella riga dei totali della mappa: sezioni "liberi" (fondo verde) e "occupati" (fondo rosso) per la sala mostrata. |
| 2026-08-29 | Comande, Cucina e Passe | Revisioni comanda: le modifiche dopo il lancio accendono la pill rossa "modificata" sul KDS, con dettaglio (cosa/chi/quando) e ack condiviso. |
| 2026-08-29 | Funzionalità trasversali | Switcher mobile delle comunicazioni a sole icone, nell'ordine Chiamate · Messaggi · Email · Chat staff. |
| 2026-08-29 | Tutte | Prima stesura del documento: censimento completo delle funzionalità esistenti. |
