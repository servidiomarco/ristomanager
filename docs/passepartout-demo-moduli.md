# Passepartout demo: moduli e integrazioni possibili

Il rivenditore ci ha dato una versione dimostrativa di Passepartout Menu con tutti i moduli aperti. L'8/10/2026 il suo tecnico l'ha installata sulla VM Windows di prova.

Questo documento raccoglie tre cose:
- com'è installata;
- quali moduli ha;
- cosa potremmo integrare con Sympotia.

La demo diventa anche **il posto delle prove di scrittura**. Al Vecchio Frantoio queste prove chiedevano il locale chiuso; qui no.

## Com'è installata

| Cosa | Valore |
|---|---|
| Macchina | VM Windows 11 **ARM** in Parallels, sul MacBook Air |
| Rete | Shared (NAT) di Parallels. Da fuori si entra con l'inoltro della porta 2222 del Mac alla 22 della VM |
| Database | SQL Server **2025**, istanza `SQLPASS`, database `PassepartoutMenu` |
| Passepartout | Menu server 2026C1 (12.3.1, hotfix 2026C1MR2608041601), Menu Client 6.1.0, Menu Point 12.3.0 |
| Servizi | «Passepartout Menu» e «Passepartout Menu Agent», porte 7600–7608 |
| Web Service | AdapterWS sulla **7606**, la stessa versione del Frantoio |
| Licenza | DIMOSTRATIVA, scade l'8/4/2027, 2 terminali, 0 terminali cloud |

**Su ARM serve SQL Server 2025.** SQL Server 2019 non si installa su Windows ARM: il driver di sistema RsFx (FILESTREAM) esiste solo per x64. La 2025 invece si installa senza rimedi.

**Dati di partenza.** Il database ha già un esercizio di esempio:

| Dato | Quanti |
|---|---|
| Sale | 4 |
| Tavoli | 20 |
| Articoli | 348 |
| Tipi di pagamento | 7 |
| Comande | 62 |
| Conti | 52 |
| Prenotazioni | 16 |
| Caparre | 1 |
| Clienti | 6 |
| Tessere fidelity | 5 |

**Dove si leggono i moduli.** Il file di licenza è cifrato. I moduli li scrive il server all'avvio nel suo log, alla riga «Moduli attivi» di `Logs\TraceServer\TraceServer<data>.log`.

## Moduli attivi (33)

| Area | Moduli |
|---|---|
| Base | Prodotto Menu, Ristorante, Retail, Sicurezza |
| Sala e ordini | Palmari Menu, Menu Point, Menu MySelf, Asporto, Varianti articolo |
| Prenotazioni | Planning prenotazioni ristorante, Prenotazioni Web, Portali prenotazione tavoli |
| Clienti | CRM, Fidelity Card, Gestione sospesi, Buoni pasto, SMS |
| Scambio dati | MessageBox Anagrafiche, MessageBox Documenti, MessageBox Mittente esterno, MessageBox Chiusura contabile, Import-Export |
| Gestione | Magazzino, Produzione DBP, Scadenzario, XML Fattura PA |
| Hardware | Interfacciamenti HW, Lettore biometrico, PCM base, PCM domotica |
| Altro | Intelligenza artificiale, Palmare Retail, Gestione matricole/Serial number |

## Cosa c'è già

In uso al Frantoio:
- prenotazioni in cassa;
- pianta e tavoli;
- import degli articoli;
- tavoli aperti;
- conti della cassa nel CRM;
- preconto e pagamento dal QR;
- comanda specchio.

Nel codice, ma non ancora acceso:
- sconto della cassa nel conto pagato dal QR, che aspetta l'agente nuovo sul PC;
- comanda viva, cioè le righe del CRM nella comanda del tavolo: fasi 1–2 fatte, la scheda si monta con la fase 4.

## Integrazioni possibili

### Valore alto

1. **Ordini dal QR che arrivano in cucina** (Menu MySelf, Palmari Menu).
   - Il cliente ordina dal menu QR di Sympotia; le righe entrano nella comanda del tavolo e vanno in produzione con `InviaProduzioneComanda`.
   - La comanda viva fa già la parte di scrittura.
   - Da chiarire col rivenditore, perché si sovrappone a MySelf.
2. **Asporto e delivery** (Asporto).
   - Gli ordini dal sito e quelli presi da Sofia al telefono diventano comande d'asporto in cassa: stampa in cucina e scontrino dalla cassa.
   - Si aggancia a `docs/piano-modulo-delivery.md`.
3. **Fidelity nel CRM** (Fidelity Card).
   - Tessera e punti nella scheda cliente; Sofia li conosce.
   - Campagne sui punti.
   - Anche il pagamento dal QR accumula punti.
4. **Chiusura di giornata automatica** (MessageBox Chiusura contabile).
   - Sympotia riceve la chiusura della cassa: incassi, IVA, tipi di pagamento.
   - Riscontro della chiusura e report senza ricostruire i conti uno per uno.
5. **Clienti condivisi** (MessageBox Anagrafiche, CRM).
   - La prenotazione arriva in cassa legata a un cliente vero, non solo a un nome.
   - I clienti inseriti in cassa con i dati di fatturazione arrivano nel CRM.
6. **Dati per la fattura dal telefono** (XML Fattura PA).
   - Il cliente inserisce partita IVA e codice SDI nella pagina di pagamento, e la cassa emette la fattura.
   - Vedi `docs/fatturazione-chiusura-conto-brainstorm.md`.

### Valore medio

7. **Piatti esauriti in tempo reale** (Magazzino, Varianti articolo).
   - Un piatto finito in cassa sparisce dal menu QR e Sofia lo sa.
   - Le varianti compaiono nel menu QR.
8. **Conti sospesi** (Gestione sospesi). Il credito aperto del cliente si vede nel CRM, con un link per pagarlo online.
9. **Banchetti nello scadenzario** (Scadenzario). Caparre e saldi degli eventi del CRM entrano fra le scadenze della cassa.
10. **Presenze del personale** (Lettore biometrico). Le timbrature arrivano nel CRM per turni e ore.
11. **Lotti e food cost** (Produzione DBP). Dalle produzioni si ricavano i lotti per l'HACCP e il costo per piatto nei report.

### Da valutare o da evitare

- **Prenotazioni Web e Portali prenotazione tavoli.**
  - Sono canali concorrenti, con il rischio di doppie fonti.
  - Se però la cassa accetta prenotazioni dai «portali», Sympotia potrebbe entrare come portale: sarebbe un canale ufficiale.
- **Intelligenza artificiale.** Nel database c'è `ConfigurazioneChatBot`, quindi la cassa ha un suo chatbot. Va capito cosa fa, per posizionare Sofia.
- **SMS.** Noi usiamo WhatsApp: basta evitare promemoria doppi.
- **Nulla da integrare per ora:** Retail, Palmare Retail, Matricole, Import-Export, Interfacciamenti HW, Sicurezza.
- **Da capire cosa siano:** PCM base e PCM domotica.

## Licenze da chiarire col rivenditore

- **MessageBox Mittente esterno.** È probabilmente il modulo che permette a un programma esterno, cioè a noi, di mandare messaggi alla cassa. Il preconto dal QR passa da lì (`RiceviMessaggio`).
- **Licenza minima per ogni ristorante.** Va chiarito quale serve a un ristorante per usare Sympotia: Web Service, Mittente esterno e gli altri moduli che toccheremo.

## La demo collegata al CRM

La demo si collega al ristorante **«Demo Integrazione Passepartout»** (id 4), che in produzione ha già Passepartout attivo. Il collegamento usa l'installatore, come farebbe un ristorante nuovo, quindi è anche la prova dell'installatore su Windows. Su ARM il Node x64 e WinSW x64 girano in emulazione.

1. **Utente del Web Service.** Nella demo serve un utente per l'AdapterWS. Lo crea o lo indica il tecnico; la password non passa dalla chat.
2. **Codice di abbinamento.** Nel CRM, entrati nel ristorante 4: Impostazioni → Passepartout → «Collega il PC della cassa», poi copiare il comando.
3. **Installazione.** Nella VM, PowerShell da amministratore: si incolla il comando e si inseriscono utente e password del Web Service.
4. **Verifica.** Nella sezione deve comparire «PC collegato». Poi si lancia la verifica guidata e si importano pianta e articoli.

**Mai usare il codice del Vecchio Frantoio sulla VM.** Abbinare un PC ruota il token e stacca l'agente vero.

## Prove di scrittura da spostare sulla demo

Le prove che al Frantoio aspettavano il locale chiuso si fanno qui.

| Prova | Stato al Frantoio | Cosa vedere sulla demo |
|---|---|---|
| Caparra vera con `PutCaparra` (fase 3b) | Ferma: risposta vuota, nessuna caparra creata | Con la caparra d'esempio nel database si vede quali campi servono |
| Chiusura col conto fiscale dopo il preconto («ChiudiEStampa») | Riuscita una volta dal vivo | Ripeterla con più righe e con lo sconto della cassa |
| Comanda viva, passo 7: chiusura dallo schermo della cassa con righe mai mandate | Non fatta: chiedeva lo scontrino fiscale | La demo non ha la stampante fiscale: vedere cosa chiede la cassa e se rimanda in produzione |
| Comanda specchio in modo «fiscale» (fase 4) | Non fatta | Scontrino dalla cassa per un conto del CRM |
| Asporto, fidelity, anagrafiche | Mai provate | Prima si leggono le operazioni del Web Service (`?singleWsdl`), poi si prova una scrittura per volta |

**Limite della demo:** non ha una stampante fiscale. Le prove fiscali mostrano cosa fa e cosa chiede la cassa, ma non lo scontrino vero. Per quello resta il Frantoio, a locale chiuso.
