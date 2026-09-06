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
9. [Reportistica](#reportistica)
10. [Menu & Banchetti](#menu--banchetti)
11. [Menu digitale pubblico](#menu-digitale-pubblico)
12. [Comande, Cucina e Passe (gestionale di sala)](#comande-cucina-e-passe-gestionale-di-sala)
13. [Pagamenti, conto al tavolo e cassa](#pagamenti-conto-al-tavolo-e-cassa)
14. [Fiscalità: scontrino, fattura elettronica, proforma](#fiscalità-scontrino-fattura-elettronica-proforma)
15. [Integrazione cassa Passepartout](#integrazione-cassa-passepartout)
16. [Stampa termica e print agent](#stampa-termica-e-print-agent)
17. [Messaggi: WhatsApp e SMS](#messaggi-whatsapp-e-sms)
18. [Email](#email)
19. [Chat staff](#chat-staff)
20. [Notifiche](#notifiche)
21. [Clienti (CRM / rubrica)](#clienti-crm--rubrica)
22. [Attività / to-do](#attività--to-do)
23. [Personale (turni e presenze)](#personale-turni-e-presenze)
24. [Inventario](#inventario)
25. [Lista della spesa e fornitori](#lista-della-spesa-e-fornitori)
26. [HACCP](#haccp)
27. [Funzioni AI](#funzioni-ai)
28. [Impostazioni](#impostazioni)
29. [Utenti, ruoli e permessi](#utenti-ruoli-e-permessi)
30. [Privacy e GDPR](#privacy-e-gdpr)
31. [Piattaforma SaaS: multi-tenant, moduli e abbonamenti](#piattaforma-saas-multi-tenant-moduli-e-abbonamenti)
32. [Funzionalità trasversali](#funzionalità-trasversali)
33. [Integrazioni esterne](#integrazioni-esterne)
34. [Registro aggiornamenti](#registro-aggiornamenti)

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
- **Mappa a tutto schermo**: un tocco sull'icona in alto a sinistra della mappa e la sala occupa l'intero schermo (si esce con la stessa icona o con Esc).

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
- La verifica di disponibilità **controlla anche l'orario richiesto** contro la griglia degli orari prenotabili: se il cliente chiede un orario che quel giorno non esiste, Sofia lo sa subito e propone i **due orari più vicini** (non l'elenco completo recitato a voce).
- Quando promette una richiamata (gruppo grande, problema tecnico, prenotazione non trovata) **salva un promemoria strutturato**: nome, numero, motivo e dettagli compaiono in Chiamate come "Da richiamare" e parte una notifica push allo staff.
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

## Reportistica

L'analisi sul periodo, dove la Dashboard è il "adesso". L'accesso si governa col permesso dedicato dalla matrice ruoli (pagina Utenti); al lancio è ristretta agli account del titolare, che decide a chi aprirla. Periodo a scelta dal calendario e ogni numero confrontato col periodo precedente di pari durata.

- **Prenotazioni e canali**: coperti per giorno, per giorno della settimana e per ora di arrivo; tassi di no-show e cancellazione; da dove arrivano le prenotazioni (staff, WhatsApp, Sofia, pagina pubblica) e ripartizione per sala.
- **Incassi e cassa**: incassato per giorno di servizio diviso pranzo/cena, mix dei metodi di pagamento dal libro cassa (omaggi e sospesi mostrati ma fuori dal totale), scontrino medio, coperto medio, mance e differenze dei cassetti con le note di chiusura.
- **Cucina e piatti**: piatti più venduti ordinabili per quantità o ricavo, tempi medi e mediani per partita, scarti per motivo col valore. Con il modulo comande spento il blocco lo dichiara e il resto della pagina vive lo stesso.
- **Sofia e comunicazioni**: chiamate e minuti dell'agente vocale, percentuale convertita in prenotazione, casi da ricontrollare (phantom e gruppi grandi), esiti dei messaggi in uscita per canale.
- **Export**: csv per blocco (serie per giorno, metodi, top piatti) e un foglio di stampa unico con KPI e tabelle per la riunione o il commercialista.
- **Lettura AI**: lo stesso report narrativo della Dashboard, richiamabile dal fondo pagina.

---

## Menu & Banchetti

Due voci in sidebar: **Menu** (i piatti, organizzati in menu) e **Banchetti** (gli eventi).

**Menu multipli**
- La pagina Menu è divisa in menu: **Alla carta** (ciò che si batte in comanda e appare sul menu digitale QR), **Banchetti** (i piatti proponibili nella composizione degli eventi) e i **menu stagionali** creati dal ristoratore (es. Ferragosto, Pasqua), rinominabili ed eliminabili.
- **Ogni piatto appartiene a uno o più menu** tramite spunte nella sua scheda: lo stesso piatto può stare alla carta e nei banchetti senza doppioni in anagrafica.
- **Anche le categorie appartengono ai menu**: nella modale «Categorie» ogni categoria ha le spunte dei menu — spuntarne una mette (o toglie) tutti i suoi piatti da quel menu in un colpo, con indicatore parziale («3/12») quando i piatti sono divisi. I singoli piatti restano regolabili dopo, e i piatti nuovi di una categoria nascono nei menu della categoria.
- **Le categorie si creano, rinominano ed eliminano** dalla stessa modale: la rinomina sposta tutti i piatti sul nuovo nome (con avviso se contiene piatti sincronizzati dalla cassa, che al prossimo import torneranno alla categoria della cassa); si elimina solo una categoria vuota; una categoria appena creata è subito disponibile nella scheda del piatto, la cui tendina mostra le categorie vere del ristorante.
- I piatti nuovi (anche quelli importati dalla cassa) nascono in Alla carta; il menu pubblico, il palmare comande e la cassa mostrano solo i piatti di quel menu.

**Piatti**
- Anagrafica completa: categorie (Antipasti, Primi, Secondi, Contorni, Dolci, Bevande, Altro), nome, descrizione, prezzo, **aliquota IVA**, foto (con ridimensionamento automatico), **allergeni**, visibilità sul menu digitale. Viste griglia ed elenco.
- **Piatti e categorie accendibili e spegnibili con un interruttore**: un piatto spento resta in anagrafica ma sparisce dal palmare comande e dal menu digitale; una categoria spenta nasconde tutti i suoi piatti. Separato dallo stato che arriva dalla cassa ("spento in cassa").
- **Ordinamento libero**: frecce su/giù sui piatti (dentro la categoria) e sulle categorie (modale "Categorie"); l'ordine scelto vale in tutta l'app — gestione menu, palmare comande e menu digitale.
- **Gestione varianti** (modale "Varianti"): gruppi di opzioni — cotture, aggiunte — con minimo/massimo di scelte, riordino e interruttore; ogni opzione ha un sovrapprezzo **in euro o in percentuale** del prezzo battuto (anche sconto). Ogni gruppo può avere una **guida per sala e cucina** (espandibile dal foglio varianti) e ogni opzione una **nota breve** (es. la temperatura al cuore), mostrata anche sul monitor cucina. I gruppi importati dalla cassa restano suoi per opzioni e massimo, ma rinomina, obbligo, interruttore e ordine sono del ristoratore e sopravvivono agli import. I gruppi si agganciano ai piatti dalla scheda del piatto — anche quelli della cassa, a qualsiasi piatto, e il legame fatto a mano sopravvive agli import. Dall'editor del gruppo si aggancia anche **un'intera categoria** in un colpo (come la spunta di menu in modale Categorie): tutti i piatti della categoria prendono il gruppo, i piatti nuovi della categoria nascono col gruppo già agganciato, e la copertura parziale si legge nel conteggio («3 di 7»); ogni scheda piatto resta libera di sganciarsi dopo.
- **Piatti semplici e composti**: un composto (es. "Antipasto della casa") elenca i suoi ingredienti nella scheda; sul palmare sono pre-inclusi e si tolgono con un tocco ("Senza cipolla"), gratis o con lo sconto configurato per ingrediente. Il minimo/massimo dei gruppi è fatto rispettare anche dal server, non solo dalla UI.
- **Traduzione automatica del menu** in inglese, francese e tedesco (AI): i nomi delle specialità restano riconoscibili, si traducono solo le voci mancanti.
- Import e sincronizzazione dal catalogo della cassa Passepartout (per chi ha l'integrazione).

**Banchetti ed eventi**
- **Preventivi e Confermati**: ogni banchetto nasce come preventivo e si conferma con un'azione dello staff; la registrazione di un acconto propone la conferma. Le due liste sono separate, e i numeri di testata (eventi in arrivo, coperti, da incassare) contano solo i confermati.
- **Preventivo condivisibile**: ogni banchetto ha un link pubblico stabile (pagina senza login con menù per uscite, tariffe e totale, sempre aggiornata alle ultime modifiche) da inviare **su WhatsApp dal numero business del ristorante** (modello approvato da Meta; finché il modello non è attivo il canale si presenta «in attivazione») **o via email** (invio dal server con il pulsante «Apri il preventivo»). Le note operative interne non compaiono mai.
- Wizard a passi: evento e cliente → coperti e tariffa (prezzo adulti, bambini, sconto in € o %) → composizione del menù per uscite → tavoli assegnati → note operative (Portate, Servizio, Mise en place). La composizione pesca dal menu Banchetti, o da un menu stagionale a scelta.
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
- Griglia tavoli del servizio con stato comanda; catalogo piatti per categoria con ricerca; uso a una mano, su telefono la comanda vive in uno sheet dietro il totale. Aprendo un tavolo su telefono il pad prende tutto lo schermo (la barra dell'app si toglie di mezzo, in cima resta la scheda del tavolo con la freccia indietro); la ricerca piatti si apre dalla lente nella testata del tavolo, sul velo trasparente come la ricerca globale, e i risultati si aggiungono con un tocco senza perdere di vista la comanda.
- **Vista compatta a scelta dell'operatore** (menu ⋮ del tavolo): la lista piatti passa a righe fitte in una scheda unica — 6–7 piatti in vista invece di 3, bersagli sempre a 44px. La preferenza è personale e resta salvata sul dispositivo.
- **Uscite/portate**: ogni uscita è una card bordata con la sua pill del nome a cavallo del bordo (quella che si sta componendo in evidenza) e, quando è **in corso in cucina**, la card si accende — bordo pieno più spesso e fondo tinto. Finché una riga è in bozza si **sposta** su un'altra uscita — la singola riga dalla maniglia ⇅ in fondo alla riga, l'uscita intera dalla maniglia ⇕ a cavallo dell'angolo in alto a sinistra (due icone diverse apposta): un tocco apre il selettore, **tenuta e trascinata** porta la riga (o l'uscita) direttamente su quella di arrivo, con l'anteprima che segue il dito e il bersaglio evidenziato. Sulla riga in bozza restano **matita e maniglia**: la matita (o il tocco sul nome) apre il **foglio di riga** — quantità, varianti, variante libera ("senza sale, metà porzione…"), peso ed «elimina riga» in un posto solo; coperti ±1.
- **Varianti a scala d'intensità** (foglio varianti, gruppi a scelta multipla): i tasti − e + muovono ogni variante su quattro gradini — «+ Nduja» (aggiunta, col sovrapprezzo), «Molta Nduja» (abbondante, stesso addebito dell'aggiunta), «Senza Nduja» (tolta, in sconto), «Poca Nduja» (gratis). Molta/Poca si accordano al nome («Molto/Poco Prosciutto»). Niente varianti-doppione a listino; etichetta e prezzo viaggiano identici su comanda, monitor cucina, preconto e scontrino. Le scelte singole (cotture) restano chip.
- Le righe restano sul palmare finché non si preme **Invia** (una sola trasmissione, robusta anche con rete instabile); le righe non inviate **sopravvivono all'uscita dal tavolo** come bozza locale, e al ritorno un avviso dichiara che non sono in cucina.
- **Il cameriere batte i tempi**: sull'uscita proposta il bottone **Chiama** la lancia in cucina dal palmare — per le sale dove le uscite le chiama chi è al tavolo, non il passe. "Torna in bozza" annulla una proposta, e l'uscita si rimanda anche dopo.
- **Chiusura a un tocco** sul conto del tavolo: **Scontrino contanti** e **Scontrino POS** incassano l'importo pieno ed emettono il documento in un gesto; **Preconto** stampa in sala; "Incassa con la cassa" apre il pannello completo (dividi, misto, sospeso, mancia) per chi ha il permesso di cassa.
- Scegliendo **Fattura** alla chiusura, il conto chiude senza scontrino e **l'emissione si apre subito**, precompilata col cliente della visita e i suoi dati di fatturazione.
- Azioni: **storno riga inviata** con motivazione obbligatoria, richiama in bozza, **trasferimento su altro tavolo**, sconto (importo o percentuale con motivazione), segnalazioni "Piatto non riuscito" / "Ingrediente finito", chiusura comanda con apertura conto.

**Cucina (KDS)**
- Coda comande **per partita** (es. Pizzeria, Primi…), con avanzamento riga Inviato → In preparazione → Pronto, note del piatto, colonna "In arrivo", filtro turno. Ogni monitor si sottoscrive alla propria partita.
- L'instradamento verso le partite segue la **mappa categorie→partita** (Impostazioni → Sala & Cucina), ma il **singolo piatto può avere la sua partita** dalla scheda in Menu ("Partita di cucina"): le patatine restano nei Contorni sull'orderpad e escono agli Antipasti. L'assegnazione sul piatto vince sulla categoria, sopravvive agli import dalla cassa e vale solo per le battute successive — le comande già lanciate non si spostano.
- **Modifiche dopo il lancio in evidenza**: storno di una riga inviata, piatti aggiunti a un'uscita già lanciata, "riporta" e trasferimento di tavolo accendono sulla card la pill rossa **"modificata"** — il tocco mostra cosa è cambiato, chi e quando (con la motivazione dello storno); **Ok** spegne l'avviso su tutti gli schermi. Suona come una comanda nuova.
- **Le altre partite della stessa uscita** in piede di card: un pallino colorato per partita (in coda / in lavorazione / pronta) con nome e numero di piatti — la pasta sa quanto manca alla griglia prima di calare. Un tocco espande le loro righe in sola lettura; mai mischiate con le proprie, che si toccano per segnare pronto.
- **Consegnate**: accanto a "In lavorazione" c'è l'archivio del servito, **raggruppato per comanda** — una card per tavolo con le sue uscite in ordine e la comanda **intera**: i piatti della propria partita in chiaro, quelli delle altre attenuati col nome della partita — la risposta a "il 12 dice che manca il piatto: l'abbiamo mandato?". Sola consultazione: la card lascia il monitor solo al servito, mai al pronto; segnarla servita da un monitor la chiude su tutti.
- I messaggi del canale **Cucina** della chat staff compaiono come **striscia sul monitor** (con la campana delle comande): "finito il branzino" arriva senza aprire la chat.

**Passe (expediter)**
- Vista di sincronia delle uscite: **Chiama** un'uscita quando la sala è pronta, ricalcola i tempi di partenza, quattro modalità di lancio (tutte automatiche, solo la prima, a consumo — la successiva parte quando la precedente è servita —, manuale).
- **Il passe si può spegnere** (Impostazioni → Sala e cucina → Passe) nei ristoranti senza expediter. I **tempi restano alla sala**: il cameriere chiama le uscite col «Chiama» sulla comanda. Sulla **card pronta per intero** del monitor cucina compaiono due icone: la **campanella** avvisa la sala che l'uscita è al passe (un annuncio nel canale sala della chat staff — «Tavolo 40 · 2ª uscita pronta al ritiro» — con badge e notifica push, senza toccare lo stato), la **spunta** la segna servita (la card lascia il monitor e finisce in Consegnate).
- Metriche di servizio: attesa media al passe e al ritiro, delta di sincronia tra partite, scarti.

**Cassa (banco del cassiere)**
- Modulo dedicato sotto Servizio: **coda dei conti del servizio** con contatore tavoli, tavolo attivo con comanda, cliente della visita, incasso e chiusura fiscale in un'unica vista.
- **Sessione di cassa** per servizio: fondo iniziale, movimenti, contato a fine turno con differenza e nota obbligatoria; transazioni del servizio consultabili.
- Pannello di incasso completo: più metodi sullo stesso conto (contanti, POS, Satispay, buoni pasto, gift card, sospeso, omaggio), resto calcolato, mancia, dividi conto, QR pay-at-table, scelta del documento (scontrino / proforma / fattura).
- **Correggi conto**: se il cliente contesta una portata mai ricevuta, dal pagamento si apre l'elenco righe e si storna quella sbagliata con motivazione — il totale si riallinea da solo, anche a comanda già chiusa.
- Ruolo dedicato **CASSA** e permessi `cash:*`; "Apri in Comande" porta al tavolo per lavorare uscite e lanci.

**Regole di dominio**
- La **giornata di servizio** inizia alle 5:00 e il turno cambia alle 17:00: la cena che finisce all'una di notte resta del giorno giusto.
- Comanda (cosa si prepara) e conto (cosa si paga) sono collegati ma distinti; ogni evento arriva in tempo reale a sala, cucina e passe con consegna garantita anche dopo un riavvio.

---

## Pagamenti, conto al tavolo e cassa

> **Una regola sola**: la **Cassa è il banco** (si incassa lì, durante il servizio), **Pagamenti è il libro** (si rilegge lì, anche a distanza di giorni). Il vecchio tab "Conti aperti" di Pagamenti è stato ritirato: incassare e chiudere i conti si fa solo dalla pagina Cassa, e le due pagine si rimandano a vicenda — il report di chiusura segnala i conti ancora da incassare con un collegamento alla Cassa, il cassetto chiuso rimanda alla chiusura del giorno in Pagamenti.

**Conto del tavolo (dalla Cassa)**
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

**Chiusura di cassa (tab "Chiusura" in Pagamenti)**
- Report giornaliero per **metodo di pagamento** (Contanti, Online, Satispay, Buoni pasto, Gift card, Omaggio, Sospeso) e per **documento** (Scontrino, Fattura, Proforma, Senza documento), più mance, acconti maturati e ammanchi. Filtro per turno; storni esclusi dai totali. Consultabile per qualunque data passata col datepicker della barra in alto.
- Se sul giorno restano conti con un residuo, il report li conta e li rimanda alla Cassa ("Apri la Cassa"); il KPI **Residuo conti** in testa alla pagina dice quanto manca all'appello.
- Un tocco su un conto chiuso apre la sua **scheda** nel pannello, con lo **scontrino elettronico**: emetti su un conto senza documento, riprova un'emissione fallita, annulla, passa a fattura.

---

## Fiscalità: scontrino, fattura elettronica, proforma

- **Scontrino elettronico** (documento commerciale) emesso via provider (Openapi.com) direttamente dal conto; se la trasmissione fallisce **il servizio non si ferma**: il conto si chiude comunque e il documento si ritenta dopo.
- **Scontrino digitale per l'ospite**: appena il documento è confermato, l'esito di chiusura (e la scheda del conto) mostra un **QR** — il cliente lo inquadra e ha lo scontrino sul telefono, su una pagina pubblica salvabile e stampabile, senza login. Accanto, **"Stampa copia"** manda la copia di cortesia (non fiscale, con lo stesso QR) alla stampante termica.
- **Esiti in tempo reale dal provider**: se l'Agenzia scarta una fattura anche giorni dopo l'invio, il webhook la segna in errore sul conto (col motivo) e si riemette da lì; sul binario classico dello scontrino il numero documento arriva via callback e compare da solo. Consegna e deposito nel cassetto fiscale restano esiti validi, senza rumore.
- **Lotteria degli scontrini**: con l'emissione via provider, il codice del cliente si inserisce nel dialog di chiusura (o al retry, se lo porge dopo) e viaggia nel documento commerciale.
- **Fattura elettronica SDI** dal conto: dati di fatturazione presi dalla scheda cliente (denominazione, P.IVA, CF, codice SDI, PEC), XML FatturaPA generato e trasmesso.
- **Emissione diretta dal registratore in sala** (`rt-local`): per chi ha un RT Epson, il CRM emette lo scontrino attraverso il registratore — la chiusura del conto lo fa stampare dall'RT e il numero torna da solo sul conto, con copia digitale via QR e registro allineati. Niente credenziali AdE, niente provider cloud. L'annullo resta sull'RT.
- **Scontrino di cassa**: per chi emette dal registratore telematico (periodo ponte o cassa fisica), la chiusura del conto registra il documento come "emesso in cassa" col numero dell'RT — chiusura di cassa e registro Fiscalità quadrano col registratore, e il numero si può riportare anche a posteriori dal conto.
- **Proforma** quando lo scontrino non è previsto; annullo del documento fiscale come atto separato (il conto non si tocca).
- **Nota di credito (TD04)**: una fattura trasmessa a SDI non si annulla — si storna dalla scheda del conto con "Nota di credito" (doppio tap di conferma). Storno totale: stesso importo e stesso cessionario, numero dalla stessa numerazione annuale, riferimento alla fattura stornata. A storno fatto la fattura risulta annullata, la nota resta a registro per sempre, e il conto torna libero di emettere scontrino o fattura corretta.
- Configurazione: dati esercente, provider, **mappa aliquote IVA** (l'aliquota vive sul piatto; riepilogo IVA per aliquota anche sul preconto stampato), numerazione fatture per anno.
- **Vista Fiscalità** (gruppo Gestione; di default la vede **solo il titolare** — permesso dedicato "Registro e report fiscali", concedibile agli altri ruoli dalla matrice permessi in Utenti): il **registro dei documenti per periodo** — scontrini, fatture, note di credito, proforma — con totali di periodo (documentato, per tipo, annullati/errori), filtri a chip, elenco per giorno e scheda di dettaglio per documento (righe con aliquota, pagamenti, riferimenti, link alla copia digitale). Tre esportazioni per il commercialista: **CSV registro documenti** (completo sul periodo, apribile in Excel), **CSV corrispettivi per aliquota IVA** (imponibile/imposta/lordo per giorno e aliquota, con sconti fuori riparto e nota sugli scontrini emessi dall'RT di cassa), e **stampa A4** del riepilogo di periodo con serie numerica delle fatture e riepilogo IVA.

---

## Integrazione cassa Passepartout

Per i ristoranti con cassa **Passepartout Menù** (modulo dedicato):

- **Import del menu** dal catalogo articoli della cassa, varianti comprese. Le voci disattivate in cassa (articoli e categorie "muti", tenuti lì solo per lo storico) non entrano nel menu del CRM; se erano già state importate, il sync le rimuove.
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
- **Le email HTML si vedono come il mittente le ha impaginate** (immagini, bottoni, colori), isolate in modo sicuro senza esecuzione di script; nelle email solo testo link e indirizzi diventano cliccabili e i link lunghi si spezzano invece di uscire dalla card.
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
- **Ristorante** — orari settimanali per turno con passo slot e slot disattivabili; chiusure programmate (giornata o singolo turno, con motivo); sale chiuse e tavoli nascosti programmati; **promemoria** ricorrenti (destinatari per ruolo, frequenza); modulo **Sala & Cucina** (partite, mappatura categorie→partita, monitor o stampante, stampanti di rete, profili di setup salvabili, registratori telematici); **documenti legali e identità pubblica** (nome pubblico, tagline, telefono, indirizzo, link Maps, **logo caricabile** in due varianti, normale e per tema scuro — compare sulla pagina di prenotazione online e in testa all'app, scambiato col tema come nelle email —, ragione sociale, P.IVA, contatti privacy/DPO, fornitori e tempi di conservazione).
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
| 2026-09-06 | Comande, Cucina e Passe | La griglia tavoli segna le comande aperte con una chiamata sola a /orders/open invece di una sonda sui primi 60 tavoli: con più di 60 tavoli la comanda aperta a fondo lista spariva dalla griglia a ogni riavvio dell'app (e la bozza non inviata sembrava persa — era lì, bastava riaprire il tavolo). |
| 2026-09-05 | Comande, Cucina e Passe | Le varianti firmate passano dalla scala ±5 a ripetizioni (n×prezzo) a una scala d'intensità a 4 gradini con le parole in comanda: «+ Nduja» (addebito), «Molta Nduja» (stesso addebito), «Senza Nduja» (sconto), «Poca Nduja» (gratis); Molta/Poca accordate al nome. Le righe già battute conservano etichette e prezzi di allora. |
| 2026-09-05 | Comande, Cucina e Passe | Riga in bozza ridotta a matita + maniglia: quantità come prefisso («2×»), la matita (o il tocco sul nome) apre il foglio di riga con quantità, varianti, nota ed «elimina riga» in un posto solo; via lo stepper e il cestino dalla riga, il nome del piatto resta intero. |
| 2026-09-05 | Menu & Banchetti | I gruppi di varianti si agganciano anche a un'intera categoria di piatti, dall'editor del gruppo: la spunta applica in blocco (con copertura parziale «3 di 7»), i piatti nuovi della categoria nascono col gruppo, la scheda piatto resta libera di sganciarsi. |
| 2026-09-05 | Comande, Cucina e Passe | Card delle uscite ridisegnate: bordo su tutte, pill del nome a cavallo del bordo in alto al centro, card accesa (bordo spesso + fondo tinto) quando l'uscita è in cucina; torna lo spostamento della singola riga (⇅ in fondo alla riga) accanto a quello dell'uscita intera (maniglia ⇕ a cavallo dell'angolo in alto a sinistra, icona diversa apposta). |
| 2026-09-05 | Comande, Cucina e Passe | Comanda più leggibile dal collaudo al telefono: via la maniglia ⇅ dalla singola riga (doppiava quella di testata — lo spostamento è per uscita intera, da «sposta» o trascinando la ⇅ in testata) e bersaglio di «sposta» allargato ben oltre il testo. |
| 2026-09-05 | Comande, Cucina e Passe | Spostamento fra uscite anche col trascinamento: il bottone di spostamento fa da maniglia (tocco = selettore, trascinato = drag) per la riga singola e per l'uscita intera; anteprima che segue il dito, bersaglio evidenziato, uscite già partite escluse, autoscroll ai bordi. |
| 2026-09-05 | Comande, Cucina e Passe | Partita di cucina assegnabile al singolo piatto dalla scheda in Menu: vince sulla mappa per categoria senza toccare dove il piatto compare sull'orderpad (le patatine nei Contorni a menu, in uscita agli Antipasti); sopravvive agli import dalla cassa. |
| 2026-09-05 | Comande, Cucina e Passe | I piatti in bozza si spostano fra le uscite: la singola riga (bottone sulla riga) o l'uscita intera («sposta» in testata), con selettore delle sei uscite. Vale per le bozze locali e per quelle sul server; un'uscita già partita prima si riporta in bozza. |
| 2026-09-05 | Menu, Comande, Cucina e Cassa | I piatti al peso hanno range e punto di partenza propri, impostati in scheda («da/a/parte da», in grammi): il foglio di battuta genera i chip sul range del piatto e lo stepper parte e si ferma lì — un filetto non parte da 500 g come una bistecca. Campi vuoti = default (300–1000, parte da 500). |
| 2026-09-05 | Cassa | Pagamento online al tavolo (QR/link) mentre la cassa è aperta: il residuo si aggiorna in tempo reale e un lampeggio con suono e vibrazione segnala l'incasso appena avviene, senza fissare il numero. |
| 2026-09-05 | Fiscalità | Driver rt-local: lo scontrino si emette dal CRM attraverso il registratore Epson in sala (numero, copia digitale e registro allineati), senza credenziali AdE né provider cloud. |
| 2026-09-05 | Fiscalità · Pagamenti | Lookup P.IVA nel dialog fattura (denominazione, sede, SDI, PEC dai registri camerali con una lente accanto al campo) e campo codice lotteria alla chiusura con scontrino via provider. Regole scontrino parlante e lotteria nella checklist pilota. |
| 2026-09-04 | Fiscalità · Pagamenti | Documento "Cassa" alla chiusura conto: lo scontrino battuto sull'RT si registra col suo numero (anche a posteriori) e appare come "scontrino di cassa" in chiusura e nel registro. Checklist della serata pilota comande in docs/serata-pilota-comande.md. |
| 2026-09-04 | Menu, Comande, Cucina e Cassa | Vendita al peso: un solo articolo («Bistecca») con «vendita al peso» nella scheda piatto e prezzo al kg, al posto degli articoli per grammatura. Alla battuta il foglio chiede i grammi (chip 300–1000 g + regolazione fine, prezzo vivo), ogni pezzo è una riga col suo peso; la cucina corregge il peso reale dal monitor dopo la pesata (tocco sulla pill dei grammi) e il conto si ricalcola, con traccia nel registro attività. |
| 2026-09-04 | Fiscalità | Webhook esiti dal provider (fattura scartata → errore col motivo, numero scontrino backfillato), doppio binario scontrino commutabile per il go-live e traslitterazione dei caratteri non ammessi dall'AdE. |
| 2026-09-04 | Comande, Cucina e Passe | La chiamata di un'uscita si può annullare («annulla chiamata» sulla comanda, quiet accanto allo stato): l'uscita torna in coda come se il fuoco non fosse mai partito e le card spariscono subito dai monitor. Solo finché la cucina non ha iniziato: alla prima riga in preparazione l'annullo rifiuta — da lì si storna. |
| 2026-09-04 | Menu & Banchetti | Note sulle varianti: ogni gruppo ha una guida per sala e cucina (es. i gradi di cottura spiegati, espandibile dal foglio varianti con l'icona info) e ogni opzione una nota breve (es. "48–52°C al cuore") che compare accanto al nome sul foglio e sulla riga del monitor cucina. Modificabili dall'editor del gruppo, anche sui gruppi importati dalla cassa. |
| 2026-09-03 | Reportistica | Nuova pagina Reportistica: quattro blocchi — prenotazioni e canali, incassi e cassa, cucina e piatti, Sofia e comunicazioni — su periodo a scelta con confronto automatico col periodo precedente, export csv, foglio di stampa e lettura AI. Al lancio è ristretta agli account del titolare; l'apertura agli altri passa dal permesso dedicato nella matrice ruoli. |
| 2026-09-03 | Fiscalità | Nuova vista Fiscalità: registro documenti per periodo con totali e filtri, dettaglio per documento, CSV registro e corrispettivi per aliquota, stampa A4 del riepilogo. Visibile di default al solo titolare (permesso dedicato, concedibile per ruolo). |
| 2026-09-03 | Agente vocale "Sofia" | Fix dall'analisi di 2.125 chiamate estive: la verifica di disponibilità valida anche l'orario richiesto e propone i due slot adiacenti invece della lista completa; nuovo tool che salva i promemoria di richiamata (badge "Da richiamare" in Chiamate + push allo staff, funziona anche a prenotazioni sospese); la sospensione viene riletta al cliente col suo messaggio invece di "problema tecnico"; watchdog orario sulla quota ElevenLabs con push all'80% e al 95%; i cognomi con particella non vengono più troncati nei saluti e nelle conferme; "Ferragosto" è una data valida; l'agente conosce data e ora correnti in ora italiana. |
| 2026-09-03 | Menu & Banchetti | La pagina pubblica del preventivo porta il logo del ristorante in testa e i dettagli completi nel footer (nome, tagline, indirizzo con link alla mappa, telefono, WhatsApp, sito). |
| 2026-09-03 | Menu & Banchetti | Gestione varianti completa: modale "Varianti" (gruppi con min/max, riordino, interruttore, sovrapprezzi in € o in % del prezzo battuto), aggancio dei gruppi dalla scheda del piatto (anche quelli della cassa, con legami manuali che sopravvivono agli import), piatti semplici/composti con ingredienti togliibili ("Senza X", sconto configurabile). Il foglio varianti del palmare mostra gli ingredienti pre-inclusi e vale anche in Cassa, che prima le ignorava; min/max fatti rispettare dal server; i palmari aggiornano il catalogo in tempo reale. |
| 2026-09-03 | Menu & Banchetti | L'invio WhatsApp del preventivo parte dal numero business del ristorante (modello Meta approvato) invece che dal telefono dell'operatore; finché il modello non è attivo il canale si dichiara «in attivazione». |
| 2026-09-03 | Menu & Banchetti | Preventivo condivisibile: link pubblico stabile del banchetto (menù, tariffe e totale, senza note interne) con invio su WhatsApp precompilato o via email dal server. |
| 2026-09-03 | Comande, Cucina e Passe | La barra dei piatti raggruppati in Cucina conta tutto ciò che resta da fare nei suoi due tempi: «5× Tagliata (2)» — il numero pieno è il totale ancora da cucinare (uscite non chiamate comprese, anche di comande fuori schermo), il tondo ambra pulsante è la quota già in lavorazione. Il tocco sul chip apre «dove va questo piatto»: tavoli e uscite, divisi fra in lavorazione e in arrivo. La pill delle note (label breve «Note») resta fissa a destra. |
| 2026-09-03 | Comande, Cucina e Passe | La barra del riepilogo servizio in Cucina sparisce: se il turno ha note strutturate (piatti prenotati, allergie) una pill «Note del servizio» col conteggio si integra a destra nella barra dei piatti raggruppati, staccata da un bordo leggero; il tocco apre il dettaglio in un modal. Senza note né coda, la barra non c'è. |
| 2026-09-03 | Comande, Cucina e Passe | In Cucina la testata globale dell'app sparisce (niente date picker, turno, ricerca globale, campana e «+»): la topbar del monitor apre col nome della partita e il toggle a icone (pentola = in lavorazione, spunta = consegnate), al centro data e pill dell'ora in tinta verde col punto pulsante, a destra ricerca, avviso sonoro e Cambia partita. |
| 2026-09-03 | Comande, Cucina e Passe | Nel piede della card dell'uscita chiamata i pallini delle altre partite pulsano ambra finché non hanno tutto pronto (prima restavano neutri fino a «in preparazione»). |
| 2026-09-02 | Comande, Cucina e Passe | Il monitor cucina mostra una colonna per comanda, in stile itinerario: filo a sinistra e una card per uscita appesa al filo, con la testata (tavolo, operatore, ora di apertura) come prima card; pallino pulsante ambra sull'uscita in lavorazione (distesa con le azioni), verde fermo su pronta/servita (compressa con l'ora), neutro sulle future in fantasma tratteggiato («fra N′», «in coda»). |
| 2026-09-02 | Comande, Cucina e Passe | L'aggancio categoria→partita ignora le maiuscole («Primi» e «PRIMI» sono la stessa cucina) e le Impostazioni Sala & Cucina segnalano le categorie senza partita, i cui piatti non compaiono su nessun monitor. |
| 2026-09-02 | Comande, Cucina e Passe | Il tocco su una riga in bozza riapre il foglio varianti precompilato: si leggono per intero le varianti troncate in lista e si correggono prima dell'invio («Aggiorna»); combinazioni identiche si fondono. |
| 2026-09-02 | Comande, Cucina e Passe | Varianti col verso e le ripetizioni, alla Passepartout: tasti − e + per variante («+ prosciutto», «++ prosciutto», «−− prosciutto»); il + addebita n volte il prezzo della variante, il − sconta. Prefisso e prezzo viaggiano su comanda, monitor, preconto e scontrino. |
| 2026-09-02 | Comande, Cucina e Passe | Aprire un tavolo e uscire senza battere nulla non lascia più la comanda vuota: si disfa da sola e il tavolo torna com'era (con una bozza nel carrello resta viva). |
| 2026-09-02 | Menu & Banchetti | Categorie con crud completo dalla modale «Categorie»: creazione (anche vuote), rinomina che sposta i piatti (con avviso per i piatti della cassa), eliminazione delle categorie vuote; la tendina categoria della scheda piatto mostra le categorie vere del ristorante. |
| 2026-09-02 | Comande, Cucina e Passe | La storia della comanda si apre accanto alla lista (la lista scivola a sinistra), non più in un velo: timeline su binario verticale con pallini per famiglia, ora in evidenza e ingressi scaglionati. |
| 2026-09-02 | Menu & Banchetti | Le categorie appartengono ai menu: spunte per categoria nella modale «Categorie» che applicano in blocco a tutti i piatti (con indicatore parziale), e i piatti nuovi della categoria nascono nei menu della categoria. |
| 2026-09-02 | Comande, Cucina e Passe | Toccando una comanda nelle Consegnate si apre la sua storia: apertura (con l'operatore), chiamata/in lavorazione/pronta/servita di ogni uscita (con sincronia fra partite e minuti sotto la lampada) e le revisioni con autore. |
| 2026-09-02 | Comande, Cucina e Passe | Lente di ricerca sul monitor cucina: filtra In lavorazione e Consegnate per tavolo, cliente, piatto (anche delle altre partite) e operatore. |
| 2026-09-02 | Comande, Cucina e Passe | Le Consegnate mostrano la comanda intera: piatti della propria partita in chiaro, quelli delle altre attenuati col nome della partita. |
| 2026-09-02 | Comande, Cucina e Passe | I piatti aggiunti a un'uscita già lanciata partono subito all'invio, in qualunque modalità di lancio; sulla comanda le righe rimaste in coda dentro un'uscita partita sono marcate «in coda» con un Chiama dedicato. |
| 2026-09-02 | Menu & Banchetti | Menu multipli: Alla carta, Banchetti e menu stagionali (Ferragosto, Pasqua…), con appartenenza dei piatti a spunte nella scheda; comande, cassa e menu digitale seguono Alla carta, la composizione banchetti pesca dal menu Banchetti o da uno stagionale. |
| 2026-09-02 | Menu & Banchetti | Banchetti in voce di sidebar propria, divisi in Preventivi e Confermati: un evento nasce preventivo, si conferma con un'azione e la registrazione di un acconto propone la conferma; i KPI contano solo i confermati. |
| 2026-09-02 | Comande, Cucina e Passe | Le card del monitor cucina dicono chi ha preso la comanda («di Luca»); sul palmare la comanda aperta da un altro operatore (o dalla cassa) lo dichiara in testa («Comanda di Luca» / «Comanda dalla cassa»). |
| 2026-09-02 | Comande, Cucina e Passe | Consegnate raggruppate per comanda (una card per tavolo con le sue uscite e gli orari); i monitor rileggono la coda al rientro in primo piano — l'uscita servita altrove non resta a schermo sui tablet sospesi. |
| 2026-09-02 | Email | Nei corpi email testuali link e indirizzi email sono cliccabili (si aprono in nuova scheda), sia in Messaggi che nella timeline della prenotazione. |
| 2026-09-02 | Email | Le email HTML in arrivo si mostrano impaginate come le ha fatte il mittente (in un riquadro isolato, senza script); i testi semplici spezzano i link lunghi invece di sforare dalla card. |
| 2026-09-02 | Comande, Cucina e Passe | Vista compatta della lista piatti a scelta dell'operatore (menu ⋮ del tavolo): righe fitte in scheda unica, 6–7 piatti in vista, preferenza salvata sul dispositivo. |
| 2026-09-01 | Comande, Cucina e Passe | «Stampa copia» dice l'esito addosso al bottone: rotellina durante l'invio, spunta verde «Copia in stampa», errore scritto lì sotto — nell'esito di chiusura del palmare e della cassa. |
| 2026-09-01 | Comande, Cucina e Passe | Tavolo aperto a tutto schermo sul palmare: la barra dell'app sparisce e in cima resta la scheda del tavolo; la ricerca piatti sta nella lente della testata e si apre sul velo trasparente della ricerca globale, coi risultati che si aggiungono al tocco. |
| 2026-09-01 | Menu & Banchetti | Piatti e categorie con interruttore acceso/spento e ordinamento libero (frecce e modale "Categorie"); scelte rispettate da palmare comande e menu digitale. |
| 2026-09-01 | Comande, Cucina e Passe | Campanella del monitor cucina ridefinita: avvisa la sala che l'uscita è pronta (annuncio nel canale sala, con push) invece di chiamare l'uscita successiva — i tempi del servizio restano ai camerieri. |
| 2026-09-01 | Comande, Cucina e Passe | Col toggle Passe spento le icone stanno sulle card del monitor cucina, non sulla comanda, che torna com'era. |
| 2026-09-01 | Integrazione cassa Passepartout | L'import del menu salta le voci disattivate in cassa (articoli e categorie tenuti per lo storico) e rimuove quelle importate in passato, se mai usate nel CRM. |
| 2026-09-01 | Comande, Cucina e Passe | Toggle "Passe" in Impostazioni → Sala e cucina: spento, la pagina Passe sparisce e i verbi chiama/servito passano alla cucina — i tempi si battono senza expediter. |
| 2026-09-01 | Prenotazioni | Mappa tavoli a tutto schermo: icona "ingrandisci" in alto a sinistra della mappa, uscita con la stessa icona o con Esc. |
| 2026-09-01 | Comande, Cucina e Passe | KDS: piede di card con lo stato delle altre partite della stessa uscita (pallini + espansione in sola lettura) e schermo "Consegnate" con le uscite servite del servizio. |
| 2026-09-01 | Fiscalità | Nota di credito TD04 dalla scheda del conto: storna una fattura inviata a SDI (storno totale, stessa numerazione, riferimento alla fattura); il conto torna libero di riemettere scontrino o fattura corretta. |
| 2026-09-01 | Fiscalità | Scontrino digitale: QR sull'esito di chiusura e sulla scheda del conto (pagina pubblica per l'ospite, senza login) + copia di cortesia sulla termica; il numero del documento Openapi ora è salvato e mostrato. |
| 2026-09-01 | Pagamenti, conto al tavolo e cassa | Nel report di chiusura un tocco sul conto apre la sua scheda con lo scontrino elettronico (emetti/riprova/annulla) — l'azione era rimasta orfana col ritiro del tab "Conti aperti". |
| 2026-09-01 | Pagamenti, conto al tavolo e cassa | Riordino Cassa/Pagamenti: ritirato il tab "Conti aperti" (si incassa solo dalla Cassa), il tab "Cassa" si chiama "Chiusura", e le due pagine si rimandano a vicenda (conti da incassare → Cassa; cassetto chiuso → chiusura del giorno). |
| 2026-09-01 | Comande, Cucina e Passe | Le griglie tavoli di Comande e Cassa mostrano i tavoli uniti come una tessera sola («11+12», coperti sommati); il tocco apre il tavolo giusto dell'unione. |
| 2026-09-01 | Comande, Cucina e Passe | Nuovo modulo Cassa (coda conti, sessione, incasso, correggi conto); in Comande: chiusura a un tocco (scontrino contanti/POS, preconto), bottone Chiama per le uscite, bozza locale delle righe non inviate, fattura con emissione immediata. |
| 2026-08-30 | Funzionalità trasversali | Al rientro nell'app, se è stata deployata una versione nuova compare un avviso con "Ricarica" — la PWA sospesa non resta più sul codice vecchio. |
| 2026-08-30 | Impostazioni | Logo in due varianti (normale + tema scuro): l'app scambia l'immagine col tema invece della piastra bianca; per il Frantoio precaricato l'artwork bianco storico. |
| 2026-08-29 | Impostazioni | Upload del logo del ristorante nell'identità pubblica; compare sulla pagina di prenotazione online (per il Frantoio precaricato il logo storico). |
| 2026-08-29 | Agente vocale "Sofia" | Modifica/cancellazione: se il numero del chiamante non corrisponde, Sofia ritrova la prenotazione per nome e data (accenti inclusi) o dal numero dettato. |
| 2026-08-29 | Prenotazioni | Nella riga dei totali della mappa: sezioni "liberi" (fondo verde) e "occupati" (fondo rosso) per la sala mostrata. |
| 2026-08-29 | Comande, Cucina e Passe | Revisioni comanda: le modifiche dopo il lancio accendono la pill rossa "modificata" sul KDS, con dettaglio (cosa/chi/quando) e ack condiviso. |
| 2026-08-29 | Funzionalità trasversali | Switcher mobile delle comunicazioni a sole icone, nell'ordine Chiamate · Messaggi · Email · Chat staff. |
| 2026-08-29 | Tutte | Prima stesura del documento: censimento completo delle funzionalità esistenti. |
