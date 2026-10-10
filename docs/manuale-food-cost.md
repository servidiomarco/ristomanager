# Manuale operativo — Food cost

Aggiornato al 10 ottobre 2026. Quanto costa ogni piatto e quanto resta al
ristorante, per la carta di tutti i giorni e per i banchetti.

## Il conto in una frase

Il **costo** di un piatto è la somma dei suoi ingredienti, alle quantità della
scheda tecnica e ai prezzi del magazzino, diviso per le porzioni della
ricetta. Il **food cost** è quel costo sul prezzo di carta **senza IVA** (l'IVA
non è un ricavo del ristorante); il **margine** è il prezzo senza IVA meno il
costo.

```
prezzi ingredienti ──► scheda tecnica ──► costo a porzione ──► food cost % · margine
   (con la resa)        (quantità nette)                        (sul prezzo senza IVA)
```

Chi lo vede: la voce **Food cost** sta in Gestione, per chi ha il permesso
(di serie titolare, direzione e manager). È un modulo che si accende per
ristorante.

---

## 1 · Da dove partire

1. **Impostazioni** (quarta scheda della pagina): il food cost obiettivo, l'IVA
   dei banchetti e il costo del menu bambini (§6).
2. **Ingredienti**: i prezzi dei prodotti che si usano di più, con la resa
   (§2).
3. **Schede tecniche**: una per piatto. Le **bozze con l'AI** fanno il grosso
   del lavoro, poi si rivedono una per una (§3, §4).
4. **Semilavorati**: ragù, fondi, impasti, prima dei piatti che li usano (§5).
5. **Controllo**: i filtri «Senza scheda», «Incompleti» e «Sopra target» dei
   piatti, «Senza prezzo» degli ingredienti (§7).

---

## 2 · Ingredienti

- Gli ingredienti **sono i prodotti del magazzino**: lo stesso elenco, niente
  doppioni. Un ingrediente nuovo creato qui o da una scheda («Crea «nome»»)
  finisce anche nel magazzino, area cucina.
- **Prezzo IVA esclusa**, al kg, al litro o al pezzo. Prezzo, unità e resa si
  correggono direttamente sulla riga.
- **Resa**: la parte che resta dopo scarto e cottura. Il branzino intero
  rende circa il 48% di filetto: nelle schede si scrive il netto (100 g di
  filetto) e il conto paga il lordo da comprare (208 g di pesce intero).
  Senza resa vale 100%.
- **Storico prezzi**: ogni cambio di prezzo resta registrato, con chi l'ha
  fatto e quando.
- Accanto a ogni ingrediente c'è in quante schede compare («in 3 schede», «in
  nessuna scheda»). Un prodotto che sta in una scheda non si cancella dal
  magazzino finché non lo si toglie dalla scheda.

---

## 3 · La scheda tecnica del piatto

Si apre toccando il piatto nella pagina Food cost, oppure da **Scheda
tecnica** nella scheda del piatto in Menu.

- **Ingredienti** con le **quantità nette** (g, ml o pezzi): quello che va
  davvero nel piatto. «Cerca o crea un ingrediente» trova quelli del
  magazzino o ne crea uno nuovo.
- **Porzioni della ricetta**: la teglia di lasagne da 8 si scrive per intero e
  porzioni 8; il costo si divide da solo.
- Il costo si aggiorna mentre si scrive. In testa: **costo a porzione**, **food
  cost %**, **margine** e **prezzo per stare al target** (il prezzo di carta
  che porterebbe il piatto al food cost obiettivo).
- **Prezzo mancante**: si scrive direttamente sulla riga dell'ingrediente
  («Salva prezzo»), e va nel magazzino. Finché manca, la scheda dice «Senza
  prezzo: …» e il costo è per difetto.
- **Costo a mano**: per i piatti comprati fatti (acqua, vino in bottiglia,
  dolci) niente ingredienti, basta il costo per porzione, IVA esclusa.
- **Piatti al peso**: la scheda vale per un kg venduto, come il prezzo.
- **Salva**: niente diventa scheda finché non si salva.

---

## 4 · Le bozze con l'AI

### Su una scheda vuota

- **«Bozza con l'AI»** propone ingredienti e grammature nette partendo da nome,
  descrizione e categoria del piatto. Usa gli ingredienti che il ristorante
  ha già e le sue schede come esempio. Per un semilavorato propone anche
  quanto rende la ricetta.
- Le righe proposte sono segnate dalla bacchetta. Un ingrediente che il
  magazzino non ha è segnato «nuovo» e resta una proposta finché non lo si
  crea con un tocco («Crea») o non se ne sceglie uno simile.
- Per i prodotti comprati finiti (acqua, vino) l'AI non propone righe e
  suggerisce il costo a mano.
- I costi li calcola sempre il programma, mai l'AI. Si controlla, si corregge
  e si salva.

### Per tutto il menu

- Nella pagina Food cost, **«Bozze con l'AI per N piatti»** prepara in
  sottofondo una bozza per ogni piatto attivo senza scheda (vini e bar
  esclusi). L'avanzamento si vede in pagina («Preparo le bozze… 12 di 40»).
- Le bozze si trovano col filtro **«Bozze AI»** e sono segnate «bozza da
  rivedere». Aprendo il piatto la scheda è già riempita: si corregge e si
  salva, oppure si **scarta**.
- Finché non sono salvate le bozze **non contano** in nessun costo, colore o
  banchetto.

---

## 5 · Semilavorati

- Ragù, fondi, impasti: ricette che entrano in altre ricette. Si creano dalla
  scheda **Semilavorati** («Nuovo semilavorato»), con i loro ingredienti e
  **quanto rende** la ricetta (per esempio 3 kg di ragù).
- Nelle schede dei piatti si usano come un ingrediente qualunque. Il loro
  costo al kg segue i prezzi dei loro ingredienti: un rincaro della carne
  arriva fino al piatto da solo.
- Il programma impedisce le ricette che finirebbero per contenere sé stesse
  («Questa ricetta finirebbe per contenere sé stessa»).

---

## 6 · Impostazioni (regole del calcolo)

| Voce | Di serie | A cosa serve |
|---|---|---|
| **Food cost obiettivo** | 30% | sopra questa soglia il piatto si colora; dà il «prezzo per stare al target» |
| **IVA dei banchetti** | 10% | per togliere l'IVA dal prezzo a persona del banchetto |
| **Costo menu bambini** | 50% | il costo del menu bambini rispetto a quello di un adulto |

---

## 7 · La pagina Food cost

- **Piatti**: per ogni piatto costo, food cost % e margine. Il food cost è
  **verde** entro il target, **ambra** fino a 5 punti sopra, **rosso** oltre.
  Filtri: «Senza scheda», «Incompleti» (mancano prezzi), «Sopra target»,
  «Bozze AI».
- **Ingredienti**: prezzo, unità e resa modificabili in riga; filtro «Senza
  prezzo».
- **Semilavorati** e **Impostazioni**.
- **Nel Menu**, la scheda del piatto mostra costo, food cost e margine, e apre
  la scheda tecnica.

---

## 8 · Nel banchetto

- Nei passi **«Coperti e tariffa»** e **«Composizione menù»** del banchetto il
  tasto **Mostra food cost** apre il riquadro Food cost. Parte sempre chiuso,
  perché tariffa e menù si concordano spesso col cliente davanti; lo stesso
  tasto lo richiude.
- Il riquadro dà **costo per coperto** (e per bambino), **margine per coperto e
  totale**, food cost sul prezzo senza IVA e sconto compreso, e il **prezzo a
  persona per stare al target**.
- Nelle uscite si sceglie la **porzione** di ogni piatto (1, ¾, ½, ⅓, ¼): gli
  assaggi condivisi degli antipasti misti non sono porzioni intere.
- I piatti senza scheda sono segnalati («Senza scheda, non contati: …») e non
  entrano nel costo; quelli con prezzi mancanti pure («Con qualche prezzo
  mancante: …»).
- Costi e margini **non compaiono mai** nel preventivo stampato né in quello
  condiviso col cliente.

---

## 9 · Se qualcosa non torna

- **Il food cost di un piatto è troppo basso** — guarda se la scheda dice
  «Senza prezzo»: un ingrediente senza prezzo conta zero e il costo è per
  difetto. Oppure le porzioni della ricetta sono troppe.
- **Il food cost è troppo alto** — controlla la resa (un 10% al posto di 100%
  decuplica il costo) e l'unità del prezzo (al kg o al pezzo).
- **Un piatto non ha numeri** — non ha scheda (filtro «Senza scheda»), oppure
  ha solo una bozza AI non ancora salvata.
- **Non riesco a cancellare un prodotto dal magazzino** — sta in una scheda:
  toglilo prima dalla scheda.
- **Il banchetto non mostra il costo** — il riquadro parte chiuso: «Mostra food
  cost». Se il menù è vuoto, componilo prima.
- **Non vedo la voce Food cost** — serve il modulo acceso per il ristorante e
  il permesso; di serie ce l'hanno titolare, direzione e manager.
