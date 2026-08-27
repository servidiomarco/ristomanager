# Manuale operativo — Comande, Cucina, Passe

Aggiornato al 27 agosto 2026. Vale per il ciclo comande completo in produzione
(PR #285–#287 comprese: servita, annulla, riporta, fuoco a consumo, avvisi
sonori).

## Il giro in una frase

La sala **propone**, il passe **lancia**, la partita **cucina e spunta**, il
passe **chiama e serve**. Ogni passaggio ha il suo annulla: **richiama** prima
del lancio, **annulla spunta** prima del servito, **riporta** dopo il servito.

```
sala                passe               cucina              passe
Invia  ────────►  Lancia  ────────►  spunta i piatti ──►  Chiama → Servita
  ▲                  │                     │                   │
  └── richiama ◄─────┘     annulla ◄───────┘     riporta ◄─────┘
      (se non lanciata)    (se non servita)      (entro 30′)
```

Chi vede cosa: **Comande** la usano i camerieri, **Cucina** è il monitor di
partita (una postazione = uno schermo), **Passe** è l'unico posto che vede
l'uscita intera attraverso tutte le partite.

---

## 1 · Comande (il palmare del cameriere)

### Aprire e comporre

- Tocca il tavolo. Se c'è già una comanda aperta si riprende quella; se c'è un
  conto da incassare si apre il conto, e la comanda nuova parte solo da lì con
  un'azione esplicita.
- I coperti arrivano dalla prenotazione (o dai posti del tavolo per i walk-in):
  correggili subito se il numero è cambiato, alimentano il conto.
- I piatti si aggiungono all'**uscita** corrente (1ª, 2ª, 3ª…). Il numero di
  uscita proposto è quello dopo l'ultima già mandata. Varianti e note viaggiano
  sulla riga e la cucina le vede sempre.

### Inviare

- **Invia** propone le righe in bozza. Cosa parte da solo dipende dalla
  modalità di lancio configurata (vedi §4): il badge della colonna dice sempre
  la verità — *in bozza*, *al passe*, *in cucina*, *pronta*, *servita*.
- Il badge si aggiorna da solo mentre guardi la comanda: quando la cucina
  finisce vedrai *pronta* senza toccare niente.

### Correggere

- **richiama** (link sulla colonna, solo finché il badge dice *al passe*):
  l'uscita torna in bozza, si corregge e si rimanda. Se è già partita in
  cucina non si richiama più: si parla col passe.
- **Storno**: da riga inviata, con motivazione obbligatoria (minimo 3
  caratteri). La motivazione finisce nelle statistiche degli scarti: scrivila
  vera ("cliente ha cambiato idea", "errore di battitura"), non "xxx".
- Il trasferimento tavolo sposta l'intera comanda, cucina compresa.

### Quando l'uscita è pronta

Arriva una **notifica push** sul telefono: «Tavolo N — servizio, nª uscita
pronta al passe». La manda il passe col bottone *Chiama*. Vai a ritirare.

---

## 2 · Cucina (il monitor di partita)

### Impostare lo schermo

- Al primo avvio scegli la **partita** (Antipasti, Primi, Griglia…): resta
  impostata anche dopo un riavvio del tablet. Si cambia da *Cambia partita*.
  «Senza partita» mostra i piatti non assegnati ad alcuna postazione.
- La **campana** in alto accende/spegne l'avviso sonoro della comanda nuova.
  È accesa di default, ma il browser suona solo dopo il primo tocco sullo
  schermo: la scelta della partita a inizio turno basta.

### Leggere lo schermo

- Una **card = un'uscita di un tavolo** (solo le righe della tua partita).
  Timer in alto: verde fino a 5′, ambra fino a 10′, poi rosso.
- La striscia **allergie** rossa sulla card viene dalle note della
  prenotazione: leggila prima di partire.
- Il banner in alto riepiloga il servizio (piatti prenotati, allergie del
  turno): serve a inizio turno per attrezzarsi, non cambia in tempo reale.
- La striscia dei **totali** («5× tagliata · 3× orata») somma tutta la tua
  coda lanciata e non ancora pronta: è per chi mette in batteria le cotture.
- **In arrivo** (in basso, bordo tratteggiato): uscite lanciate che per la tua
  partita non devono ancora partire — è il lancio scaglionato, la Griglia
  parte prima dei Primi così arrivano al passe insieme. Il conto alla rovescia
  dice quanto manca; *inizia ora* forza la partenza se serve.

### Lavorare

- **Un tocco sulla riga** = quel piatto è pronto. Vale anche il salto diretto
  senza passare da "in preparazione": sui piatti veloci è normale.
- **Tocco sulla riga già spuntata** = annulla (il piatto torna in
  lavorazione). L'errore si corregge con lo stesso gesto, finché l'uscita non
  è stata servita.
- **Tutto pronto** chiude in un colpo le righe rimaste della card.
- Quando tutta l'uscita è pronta (anche le altre partite) la card resta con
  l'anello verde finché il passe non la serve; se aspetta le altre partite da
  più di 4′ il bordo **lampeggia**: il piatto sta morendo sotto la lampada, e
  il ritardo è di qualcun altro.
- Le righe **stornate** dalla sala spariscono da sole con la motivazione
  notificata; se lo schermo dice «riconnessione…» continua a lavorare ciò che
  vedi: al ritorno della rete la coda si riallinea da sola.

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

---

## 4 · Le modalità di lancio (Impostazioni → sala e cucina)

| Modalità | Comportamento | Quando usarla |
|---|---|---|
| **Tutto subito** | ogni uscita parte in cucina all'invio | senza passe attivo |
| **Prima uscita subito** | la 1ª parte da sola, le altre le lancia il passe | servizio normale col passe |
| **A consumo** | parte un'uscita alla volta: la successiva quando segni *Servita* la precedente | ritmo dettato dal tavolo; richiede disciplina sul bottone Servita |
| **Tutto dal passe** | niente parte da solo | banchetti, menù degustazione |

Nota su «A consumo»: all'invio parte la prima uscita solo se il tavolo non ha
già qualcosa in cucina; un dolce ordinato a fine pasto, a tavolo ormai
scarico, parte da solo. Il passe può comunque lanciare a mano in anticipo.

---

## 5 · Se qualcosa non torna

- **«riconnessione…» sull'header** — la rete balla. I monitor ricaricano la
  coda da soli al ritorno; nel dubbio, il ricarico periodico (60″ cucina, 20″
  passe) riallinea comunque.
- **La campana non suona** — tocca lo schermo una volta (il browser blocca
  l'audio finché non c'è un'interazione), poi verifica che l'icona sia la
  campana piena e non quella sbarrata.
- **Ho segnato pronto per errore** — tocca di nuovo la riga: torna in
  lavorazione. Se l'uscita era già stata servita, il passe la *riporta* da
  «Servite da poco».
- **Ho servito l'uscita sbagliata** — passe → «Servite da poco» → *riporta*,
  entro 30 minuti.
- **Un'uscita proposta non parte mai** — guarda la modalità di lancio (§4) e
  il blocco «In attesa di lancio» del passe: qualcuno deve premere *Lancia*.
- **La stampante di partita è muta** — il lancio e la stampa viaggiano
  insieme: se l'uscita è sul monitor, la stampa è stata accodata. Il problema
  è a valle (agente di stampa / stampante): vedi il playbook stampanti.
