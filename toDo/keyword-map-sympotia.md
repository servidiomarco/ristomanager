# Keyword map IT/EN — sito di lancio Sympotia

CRM e prenotazioni per la ristorazione. Mercati: Italia (primario), UE anglofona (secondario).
**Volumi misurati** con DataForSEO il 2026-08-21 (Google Ads + clickstream, Italia/italiano).
Costo totale della misurazione: **0,63 $**.

---

## Leggi prima questo: la versione precedente di questo documento era sbagliata

La prima stesura non aveva volumi e li sostituiva con una priorità ragionata:
*"se cinque concorrenti hanno una landing su «alternativa a TheFork», quel
termine converte — lo hanno misurato loro con i loro soldi"*.

**Il ragionamento era plausibile e il risultato è falso.** Misurato:

| Keyword raccomandata come prioritaria | Volume reale |
|---|---|
| alternativa a thefork | **nessun dato** |
| software prenotazioni ristorante senza commissioni | **nessun dato** |
| prenotazioni ristorante zero commissioni | **nessun dato** |
| caparra prenotazione ristorante | **nessun dato** |
| no show ristorante come evitarlo | **nessun dato** |
| prenotazioni ristorante whatsapp | **nessun dato** |
| integrazione passepartout menù prenotazioni | **nessun dato** |

Non "poco volume": **nessun dato**, su entrambi gli endpoint. Verificato con un
test di controllo (le stesse chiamate restituiscono 552 per `gestionale
ristorante` e 1528 per `thefork manager`, quindi la misura funziona).

**Perché il ragionamento falliva.** I concorrenti costruiscono quelle pagine
per *convertire* traffico che arriva da annunci, passaparola e confronti — non
perché qualcuno cerchi quelle frasi. Una landing esiste per chiudere, non
necessariamente per farsi trovare.

---

## Cosa cercano davvero i ristoratori italiani

| Keyword | Volume/mese | CPC | Concorrenza |
|---|---:|---:|---|
| thefork manager | **8.100** | 4,03 $ | bassa |
| octotable | **1.000** | 9,61 $ | bassa |
| gestionale ristorante | **720** | 13,81 $ | alta |
| prenotazioni ristorante | 590 | 1,07 $ | media |
| app prenotazioni ristorante | 590 | 1,87 $ | media |
| software gestionale ristorante | 260 | 11,65 $ | alta |
| software ristorazione | 260 | 8,83 $ | alta |
| gestione prenotazioni ristorante | 90 | 8,68 $ | alta |
| software ristorante | 70 | 13,58 $ | media |
| **passepartout menu** | **70** | **1,89 $** | **bassa** |
| software prenotazioni ristorante | 40 | 6,92 $ | alta |
| no show ristorante | 30 | — | **bassa** |
| crm ristorante / crm ristorazione | 30 + 30 | 7,42 $ | media |
| prenotazione tavoli online | 30 | 1,46 $ | media |
| software comande | 20 | 15,18 $ | media |

### Le tre cose che questi numeri dicono

**1. Il mercato si cerca per marca, non per categoria.** `thefork manager` da
solo (8.100) vale più di tutti i termini di categoria messi insieme. Il
ristoratore italiano non cerca "software prenotazioni senza commissioni":
cerca il nome di chi già conosce.

**2. La categoria è piccola e cara.** Tolte le marche altrui, restano circa
**2.000 ricerche al mese in tutta Italia**, con CPC fra 7 e 15 dollari e
concorrenza alta. Sono i numeri di una nicchia, non di un mercato di massa.

**3. La coda lunga che avevo immaginato non esiste.** Ogni frase specifica —
caparra, no-show, WhatsApp, commissioni — è sotto la soglia di rilevazione.

---

## La conseguenza scomoda

**La SEO non può essere il canale principale di acquisizione al lancio.**

Con ~2.000 ricerche mensili di categoria, posizionarsi primi su *tutto* — cosa
che non succede — porterebbe forse qualche centinaio di visite al mese, di cui
una frazione minima converte. Non è il motore di una crescita.

Questo non significa non fare SEO: significa non aspettarsi che sia lei a
portare i primi clienti. I canali che i numeri suggeriscono:

- **Passaparola e presenza diretta** nel settore (il CPC alto dice che gli
  inserzionisti pagano caro perché il cliente vale molto: un ristoratore resta
  per anni)
- **Google Ads mirati** sui pochi termini reali, sapendo che un click costa
  10-14 € e va valutato contro il valore di un cliente
- **Il canale rivenditori Passepartout**, che i numeri sotto suggeriscono

---

## Le tre keyword che valgono davvero, e perché

### `passepartout menu` — 70/mese, CPC 1,89 $, concorrenza **bassa**

Il numero più interessante dell'intera misurazione. Volume reale, costo per
click sette volte più basso dei termini di categoria, e **nessuna concorrenza**.

Chi cerca così è un ristoratore che **ha già Passepartout** e sta cercando
informazioni. È esattamente il cliente per cui l'integrazione è stata
costruita, ed è già in produzione al Vecchio Frantoio. Nessuno dei dieci
concorrenti italiani censiti si posiziona lì.

→ Pagina `/integrazioni/passepartout`, scritta per chi quel software ce l'ha
già: cosa si collega, cosa no, il fatto che il conto arriva dalla comanda vera.

### `no show ristorante` — 30/mese, concorrenza **bassa**

Piccolo ma reale, e la concorrenza è bassa nonostante l'ecosistema di articoli
esistente. È il problema che il prodotto risolve con la caparra automatica.

→ Pagina `/blog/no-show-ristorante`, che include il pezzo sull'art. 1385 e un
modello di condizioni copiabile. Il contenuto è già scritto per metà: le
condizioni sulla pagina prenotazioni esistono e sono state riviste.

### `gestionale ristorante` — 720/mese, CPC 13,81 $, concorrenza alta

Il termine di categoria più grosso. Caro e presidiato, ma è dove sta la
domanda. Non si vince in tre mesi: va trattato come obiettivo a dodici mesi,
con contenuto di sostanza, non come pagina di lancio.

---

## Mappa keyword → pagina

```
/                                 marca + "gestionale ristorante" come termine secondario
/integrazioni/passepartout        ⭐ passepartout menu              [LA PRIMA DA FARE]
/blog/no-show-ristorante          ⭐ no show ristorante             [LA SECONDA]
/prenotazioni                     app/gestione prenotazioni ristorante, prenotazione tavoli online
/comande                          software comande, comande ristorante app
/prezzi                           gestionale ristorante prezzi (volume nullo ma serve comunque)
/confronto                        thefork manager, octotable — vedi la nota qui sotto
```

**Sulla pagina di confronto.** `thefork manager` (8.100) e `octotable` (1.000)
sono le uniche fonti di traffico consistenti, e sono marche altrui.
Posizionarcisi è legittimo ma va fatto con onestà: TheFork è un marketplace con
23 milioni di utenti che porta clienti **nuovi**, Sympotia trattiene quelli che
hai **già**. Sono prodotti diversi. Un confronto che finge il contrario si
smonta alla prima domanda e brucia la fiducia proprio dove serviva.

---

## Inglese: rimandare

| Keyword | Volume (UK) |
|---|---:|
| opentable alternative | 50 |
| restaurant crm software | 10 (CPC **50,39 $**) |
| tutte le altre provate | nessun dato |

Numeri ancora più magri, con un CPC che segnala una guerra pubblicitaria fra
operatori americani finanziati. **Non aprire l'inglese al lancio.**

---

## Cosa NON fare, ora con le prove

| Termine | Volume | Verdetto |
|---|---:|---|
| alternativa a thefork | nessun dato | Nessuno la cerca. Nessuna pagina. |
| software prenotazioni ristorante senza commissioni | nessun dato | Il perno di vendita della categoria **non è una keyword**. Va nel messaggio, non nella SEO. |
| caparra prenotazione ristorante | nessun dato | Il tema vive dentro `no show ristorante`, non da solo. |
| prenotazioni ristorante whatsapp | nessun dato | Funzionalità da mostrare, non da posizionare. |

---

## Metodo, per chi rifarà la misura

Endpoint usati, tutti su Italia/italiano:

- `keywords_data/google_ads/search_volume/live` — 0,09 $ a richiesta, fino a
  1000 keyword, dà volume + CPC + concorrenza
- `keywords_data/clickstream_data/dataforseo_search_volume/live` — 0,18 $,
  disaggrega le varianti che Google Ads fonde

**Il test di controllo è la parte da non saltare.** La prima tornata dava
`n/d` ovunque e sembrava un guasto. Rimettendo nella stessa chiamata due
keyword di cui conoscevo il volume, i numeri sono usciti: la misura
funzionava, erano le keyword a non avere domanda. Senza quel controllo avrei
concluso il contrario.

Lo script sta in `scratchpad/volumi.mjs`; credenziali su Railway
(`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`).

**Da rimisurare** dopo il lancio e ogni sei mesi: i volumi si spostano, e
`no show ristorante` è un tema in crescita in Italia.
