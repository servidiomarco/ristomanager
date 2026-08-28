# Piano SEO — Sympotia

Redatto il 2026-08-21. Tutti i numeri sono **misurati** con DataForSEO
(Italia/italiano), non stimati. Spesa complessiva della ricerca: **0,71 $**.

---

## 1. Diagnosi

### La SEO di categoria è un gioco piccolo e caro

Tolte le marche altrui, l'intera categoria vale **~2.000 ricerche/mese in
Italia**, con CPC fra 7 e 16 $ e concorrenza alta.

| Termine | Vol./mese | CPC |
|---|---:|---:|
| gestionale ristorante | 720 | 13,81 $ |
| **gestionale per ristorante** | **720** | **16,50 $** |
| prenotazioni ristorante | 720 | 1,57 $ |
| app prenotazioni ristorante | 590 | 2,82 $ |
| prenotazioni ristorante online | 590 | 1,47 $ |
| software gestionale ristorante | 260 | 14,18 $ |
| software ristorazione | 260 | 8,83 $ |

Anche vincendo tutto — cosa che non succede — si parla di poche centinaia di
visite al mese. **Non è il motore di crescita del lancio**, e va detto prima di
spenderci sopra sei mesi.

Il CPC alto dice però un'altra cosa: gli inserzionisti pagano 14 $ a click
perché un ristoratore, una volta acquisito, resta per anni. Il valore c'è; è il
volume che manca.

### Il mercato si cerca per marca

`thefork manager` fa **8.100** ricerche/mese. Da solo vale quattro volte tutti
i termini di categoria messi insieme. `octotable` ne fa 1.000.

Chi cerca non sa che esiste una categoria: cerca il nome che ha sentito.

### La scoperta che cambia il piano

**Octotable non prende traffico organico dalle sue pagine di prodotto.**
Guardando su cosa posiziona davvero:

| Keyword | Vol./mese | Loro posizione |
|---|---:|---:|
| trattoria vicino a me | 110.000 | 76 |
| felice a testaccio roma | 40.500 | 8 |
| ristorante felice roma | 40.500 | 6 |
| ce stamo a pensà | 33.100 | 48 |
| ristorante felice a testaccio | 22.200 | 6 |
| antica pesa | 14.800 | 67 |

Sono **nomi di ristoranti**, non termini di software. Octotable ospita la
pagina di prenotazione di ogni cliente, e quelle pagine si posizionano sul nome
del ristorante. Il loro traffico organico non viene dal marketing: viene dal
prodotto.

**Un solo ristorante cliente vale, in volume di ricerca, più di tutta la
categoria software italiana.** "Felice a Testaccio" fa 40.500 ricerche al mese;
"gestionale ristorante" ne fa 720.

---

## 2. Strategia

### Il perno: SEO guidata dal prodotto, non dal marketing

Ogni ristorante cliente ha già una pagina pubblica di prenotazione
(`/prenota`). **Quella pagina è l'asset SEO**, non il sito di Sympotia.

Il ragionamento in tre passaggi:

1. Il ristoratore cerca il suo stesso nome per vedere come appare online
2. I suoi clienti cercano il nome del ristorante per prenotare
3. Chi possiede quella pagina intercetta entrambi — e appare accanto a TheFork

Questo trasforma l'acquisizione in un ciclo: ogni cliente nuovo aggiunge una
superficie che si posiziona da sola, senza scrivere contenuti.

**È anche difendibile.** Un concorrente può copiare una landing in un giorno;
non può copiare cento pagine di prenotazione che appartengono a cento
ristoranti.

### Il secondario: tre porte d'ingresso economiche

Trovate dallo strumento, non dall'intuito — la prima versione della keyword map
le aveva sbagliate tutte.

**a) L'agenda di carta** — ~320 ricerche/mese, CPC sotto 1 $

`agenda prenotazioni ristorante` (140) · `agenda per prenotazioni ristorante`
(140) · `agenda prenotazioni ristorante 2026` (40) · `libro prenotazioni
ristorante` (40)

La prima pagina di Google è occupata da **agende di carta**: Amazon, Buffetti,
Trovaprezzi, tipografie. Solo due software, in settima e ottava posizione, su
siti deboli.

Google non ha ancora deciso che l'intento sia software. Una pagina fatta bene
entra in quinta o sesta posizione senza combattere — e intercetta il
ristoratore che sta ancora sulla carta e ha appena iniziato a guardarsi
intorno. È il cliente più facile da convertire: non ha un contratto da
rompere.

**b) Il gratis** — ~200 ricerche/mese

`software gestionale ristorante gratis` (70) · `gestionale ristorante gratis`
(20) · `gestione prenotazioni ristorante free` (50) · `app gestione
prenotazioni ristorante gratis` (40)

Intento a basso budget, ma è l'imbuto di ingresso. Va gestito con onestà: una
pagina che spiega cosa si può fare senza pagare e dove finisce il gratis,
senza fingere di essere gratuito.

**c) Passepartout** — 70 ricerche/mese, CPC 1,89 $, **concorrenza zero**

`passepartout menu`. Nessuno dei dieci concorrenti censiti si posiziona lì. Chi
cerca ha già quel gestionale e sta valutando cosa gli si attacca sopra:
l'integrazione esiste ed è in produzione.

### Cosa NON fare

| Cosa | Perché |
|---|---|
| Programma di contenuti ampio | Il mercato non ha volume per sostenerlo. |
| Pagine su "senza commissioni", "alternativa a TheFork", "caparra", "WhatsApp" | **Nessun dato** su tutte. Sono argomenti di vendita, non chiavi di ricerca. |
| Aprire l'inglese al lancio | `opentable alternative` fa 50/mese nel Regno Unito. Il resto: nessun dato. |
| Inseguire `gestionale ristorante` subito | 720 ricerche ma concorrenza alta e CPC 14 $: obiettivo a 12 mesi, non pagina di lancio. |

---

## 3. Piano operativo

### Fase 1 — Fondamenta (settimane 1-4)

**Obiettivo: non perdere ciò che c'è già.**

1. **301 dai domini ristomanager** verso i nuovi. Prima del lancio, non dopo:
   l'autorità accumulata non si recupera a posteriori. *(già in roadmap, #10)*
2. **Le pagine `/prenota` devono essere indicizzabili.** Da verificare oggi:
   `robots.txt`, meta `noindex`, `<title>` che contenga il **nome del
   ristorante** (non "Prenota — Sympotia"), dati strutturati `Restaurant` +
   `AcceptsReservations`, URL leggibile per ristorante.
   **È il punto singolo più importante del piano.** Se quelle pagine non sono
   indicizzabili, tutta la strategia principale non esiste.
3. **Sitemap che elenca ogni pagina di prenotazione**, rigenerata quando entra
   un cliente nuovo.

### Fase 2 — Le tre porte (settimane 4-10)

Cinque pagine, non venti. Un sito con cinque pagine scritte bene posiziona
meglio di uno con venti mediocri.

| Pagina | Termine primario | Vol. |
|---|---|---:|
| `/agenda-prenotazioni` | agenda prenotazioni ristorante | 320 |
| `/integrazioni/passepartout` | passepartout menu | 70 |
| `/gratis` | software gestionale ristorante gratis | 200 |
| `/prenotazioni` | app/prenotazioni ristorante online | 590 |
| `/blog/no-show-ristorante` | no show ristorante | 30 |

La pagina no-show ha volume basso ma è l'unica che può guadagnare link da sola:
va scritta con l'art. 1385 e un modello di condizioni copiabile. Le condizioni
sono già scritte e riviste — è metà lavoro fatto.

### Fase 3 — Categoria (mesi 3-12)

Solo dopo che le fasi 1-2 producono. Obiettivo `gestionale ristorante` /
`gestionale per ristorante` (720 + 720). Serve sostanza — confronti veri,
dati, casi d'uso — non una landing.

### Fase 4 — Marca

Quando esistono clienti che parlano: `sympotia` oggi fa zero, e va bene così.
La marca si costruisce fuori dalla SEO e poi si raccoglie dentro.

---

## 4. Misurazione con DataForSEO

Lo strumento costa quanto un caffè: la disciplina è usarlo con una domanda
precisa, non "guardare i dati".

| Cosa | Endpoint | Costo | Cadenza |
|---|---|---:|---|
| Posizioni nostre | `dataforseo_labs/.../ranked_keywords` | 0,012 $ | mensile |
| Volumi del set | `keywords_data/google_ads/search_volume` | 0,09 $ | trimestrale |
| Prima pagina sui 5 termini | `serp/google/organic/live/regular` | 0,002 $/query | mensile |
| Cosa posiziona un concorrente | `dataforseo_labs/.../ranked_keywords` | 0,012 $ | semestrale |
| Nuove idee | `dataforseo_labs/.../keyword_suggestions` | 0,012 $ | semestrale |

**Costo annuo stimato: sotto i 5 $.** Il deposito minimo da 50 $ non serve
finché si resta su questo ritmo.

**Una regola imparata sul campo.** La prima misurazione dava `n/d` ovunque e
sembrava un guasto dell'API. Era invece la risposta giusta: quelle keyword non
hanno domanda. L'ho scoperto solo mettendo nella stessa chiamata due keyword di
cui conoscevo già il volume. **Ogni misura futura includa due termini di
controllo noti**, o si rischia di concludere l'opposto di ciò che i dati dicono.

Script pronti: `scratchpad/volumi.mjs`. Credenziali su Railway
(`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`).

---

## 5. Aspettative, dichiarate prima di iniziare

| Traguardo | Quando | Metrica |
|---|---|---|
| Pagine `/prenota` indicizzate | mese 1 | numero di pagine in indice |
| Prima pagina su `agenda prenotazioni ristorante` | mese 3-4 | posizione |
| Prima pagina su `passepartout menu` | mese 2-3 | posizione |
| Un cliente arrivato da ricerca organica | mese 4-6 | attribuzione |
| `gestionale ristorante` in prima pagina | mese 12+ | posizione |

**Il traffico organico dal sito di marketing resterà a due cifre mensili per
mesi.** È normale e previsto: il volume totale non consente altro. Se qualcuno
si aspetta migliaia di visite, l'aspettativa va corretta ora, non al terzo mese.

Il numero da guardare non è il traffico: è **quante pagine di prenotazione
sono indicizzate e in che posizione stanno sul nome del loro ristorante**.

---

## 6. Cosa mi farebbe cambiare piano

- **Se le pagine `/prenota` non fossero indicizzabili** e non si potesse
  rimediare: cade il perno, e il piano si riduce alle tre porte — con
  aspettative molto più basse.
- **Se il nome Sympotia non passasse l'EUTM** (roadmap #7): tutto il lavoro
  sul dominio va rifatto. **Non scrivere una riga prima di quel via libera.**
- **Se `agenda prenotazioni ristorante` si rivelasse intento solo cartaceo**
  (misurabile dopo tre mesi guardando la frequenza di rimbalzo): si abbandona
  quella porta e si sposta lo sforzo sul cluster gratis.
- **Se arrivasse trazione da un canale non-SEO** — rivenditori Passepartout,
  passaparola: quello diventa il canale principale e questo piano scende a
  supporto. I numeri già oggi suggeriscono che potrebbe succedere.
