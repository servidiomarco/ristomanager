# Comanda viva in cassa — prove sulla cassa vera (fase 0)

Le comande prese nel CRM devono arrivare nella comanda in cassa del tavolo vero, e crescere con il servizio. Prima di scrivere il codice serve sapere come la cassa Passepartout risponde a operazioni che nessuno ha mai provato via web service:
- aggiungere righe a una comanda aperta;
- toglierle;
- mandarle in produzione per uscita;
- le varianti;
- cambiare tavolo;
- la chiusura dallo schermo della cassa.

Queste prove lo stabiliscono. Le fasi del piano sono in `~/.claude/plans/per-far-funzionare-il-snazzy-meteor.md`.

**Si fanno a locale chiuso.** Le prove scrivono comande in cassa e `invia` stampa davvero in cucina e al bar.

## Cosa dice lo schema (WSDL della cassa, 07/10/2026)

Letto da `http://<cassa>:7606/?singleWsdl` (83 operazioni).

- **Le operazioni sulle comande** sono `GetComanda`, `GetComandaTavolo`, `GetComandeGiorno`, `GetComandeCliente`, `PutComanda`, `InviaProduzioneComanda`, `ContoComanda` e `RiceviMessaggio`. Non esiste un'operazione per stornare o spostare: si passa da `PutComanda` o dai comandi di `RiceviMessaggio`.
- **`PMBRigaComanda`**, i campi in ordine:
  - `Articolo`, `CameriereLogin`, `CategoriaGenerico`, `CentroProduzione`, `Componenti`;
  - `DaCancellare`, `DataConsegna`, `DataInvio`, `DataRitiro`, `Descrizione`;
  - `IVA`, `IdGestionale`, `IsOfferto`, `IsPagato`, `PadreComposto`;
  - `Pezzi`, `PezziPrec`, `Posto`, `Prezzo`, `QuantitaUM`, `ResetPrezzo`;
  - `Stato`, `StatoEnum`, `StatoPrec`, `StatoPrecEnum`, `Tipo`, `TipoClient`, `TipoEnum`;
  - `Tool_EseguiInvio`, `Totale`, `Uscita`, `Varianti`.

  **Non c'è una nota per riga.** Le righe nostre si riconoscono dal loro `IdGestionale`.
- **`EnumStatoRigaComanda`**: Nuovo, InAttesa, InProduzione, Fatto, Cancellato, Preventivo.
- **`PMBRigaVariante`**: `Descrizione`, `IdGestionale`, `InAggiunta`, `Prezzo`, `QuantitaUM`, `RigaComanda`, `Variante`. `Variante` è il codice di un articolo di tipo Variante.
- **`ContrattoComanda`** eredita da `Contratto` (`IDDati`, `IsParziale`, `UltimaModifica`), che va scritto per primo. Seguono gli altri campi in ordine alfabetico, tra cui:
  - `CameriereLogin`, `Coperti`, `IdGestionale`, `Note`, `Righe`, `Sala`, `Tavolo`;
  - `Tool_RigaModificata`, `Tool_RigheInviate`;
  - `UltimaPortataChiamata`, `UltimaPortataInviata`.

  Un campo fuori posto la cassa lo ignora senza errore.
- **`EnumComandoComanda`** (via `RiceviMessaggio`, come il preconto): InviaTutto, InviaUscite, Consegna, ContoUnico, ContoUnicoNoInvio, InvioPassDelivery, Preconto, InviaElemento. `ComandoComanda` porta `Elementi` (righe) e `Uscite`.

## Lo strumento

`scripts/prova-comanda-viva.mjs` gira sul PC della cassa, lanciato da `scripts/prova-comanda-viva.ps1`:
- le credenziali le prende dal `.cmd` dell'agente, solo in memoria;
- il parser XML viene dal pacchetto installato;
- ogni comando rilegge la comanda e ne stampa le righe con id, uscita, stato, data di invio e varianti;
- tutto finisce in `prova-comanda-viva.log`, senza credenziali;
- la comanda di prova resta in `prova-comanda-viva.json`, così i passi si fanno uno alla volta.

`--prova` stampa solo l'XML, senza mandarlo. L'XML è controllato contro lo schema del WSDL (nomi e ordine dei campi).

Sul PC i due file vanno in `C:\ristomanager-agents\prove-comanda-viva\`. Si lanciano così:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ristomanager-agents\prove-comanda-viva\prova-comanda-viva.ps1 <comando> [argomenti]
```

## I passi

Si usa il tavolo 88 TETTOIA, che non è disegnato in pianta (`--tavolo`/`--sala` per cambiarlo).

| # | Comando | Cosa guardare |
|---|---|---|
| 0 | `articoli tagliatelle`, `articoli birra`, `articoli variante` | Scegliere un piatto di cucina (C1), una bevanda del bar (B1) e un codice variante (V1) ammesso per C1 |
| 1 | `crea C1 B1` (i numeri stampati da `articoli`) | Comanda nuova con C1 in uscita 1 e B1 in uscita 2: niente stampato, stato delle righe, prezzo preso dal listino |
| 2a | `aggiungi C1 --uscita 1` | Modo «tutte» (tutte le righe più la nuova): aggiunge o sostituisce? gli `IdGestionale` di prima restano? |
| 2b | `aggiungi B1 --uscita 2 --modo parziale` | Solo la riga nuova con `IsParziale`: le righe di prima restano? |
| 2c | `aggiungi C1 --uscita 2 --modo nuove` | Solo la riga nuova, con il numero della comanda e senza `IsParziale`: aggiunge senza toccare le altre? Così il CRM non riscrive mai le righe del palmare |
| 3 | `variante C1 V1 senza cipolla --modo parziale` | Variante a codice e variante libera: come compaiono in cassa? |
| 4 | `invia 1` | Solo l'uscita 1 in produzione: foglietto sulla stampante di cucina giusta, con variante e testo libero? B1 resta non inviata? |
| 5a | `togli <idRiga non inviata> --modo parziale` | La riga sparisce? Prova anche `--modo tutte` |
| 5b | `togli <idRiga inviata> --modo nuove` | Riga già mandata: diventa «Cancellato»? Esce un foglietto di storno in cucina? |
| 5c | `pezzi <idRiga> 2 --modo nuove` | La quantità di una riga già scritta cambia sul posto, con lo stesso numero di riga? |
| 6 | `sposta 87` | La comanda passa al tavolo 87, con le stesse righe? |
| 7 | `aggiungi B1 --uscita 2 --modo nuove --stato InProduzione` su una comanda con righe mai inviate, poi chiusura **dallo schermo della cassa** | Alla chiusura la cassa manda in produzione le righe mai inviate? Cosa chiede al cassiere? Rispetta lo stato «già mandata» scritto dal CRM? |
| 8 | Aprire un tavolo dal palmare Passepartout con una riga, poi `adotta --tavolo N` e `aggiungi C1 --modo nuove`; poi il palmare rientra nel tavolo, il CRM scrive (`aggiungi B1 --uscita 2 --modo nuove`) e il palmare salva una riga sua | Le righe del CRM si aggiungono alla comanda del palmare senza toccare le sue? Il salvataggio del palmare cancella quelle scritte dal CRM mentre era dentro? |
| 9 | `chiudi` | Proforma pagata ESTERNO, tavolo libero. Da fare dopo ogni prova che lascia una comanda aperta |

Il log di ogni passo serve per la tabella qui sotto. Le risposte dubbie si guardano anche in `pmbLog` sul PC, in sola lettura.

## Esiti

Due giri di prove, a locale chiuso:
- **07/10/2026 sera, senza nessuno in sala:** comanda 78556 sul tavolo 88 TETTOIA (passi 1, 2, 3, 5a, 5c, 6, 9).
- **08/10/2026 mattina, con qualcuno in cucina, alla cassa e al palmare:**
  - comanda 78557 sul tavolo 88 (passi 4, 5b, 7), chiusa col conto proforma 82611;
  - comanda 78560 aperta dal palmare sul tavolo «80-» TETTOIA (passo 8), chiusa col conto proforma 82612.

Gli invii in produzione si leggono nel database della cassa (`Comanda.numeroInvii`, `dataUltimoInvio`, `ultimaPortataInviata`), in sola lettura. Il campo `DataInvio` delle righe nel web service è solo il momento della scrittura. In cassa il nome del tavolo è quello di `Tavolo.numero`, anche con segni: il tavolo 80 è «80-».

| # | Esito | Note |
|---|---|---|
| 1 | Riuscito | Prezzi presi dal listino quando non si manda `Prezzo`. Uscite rispettate, righe «Nuovo», nessun invio. Con `Coperti` 0 la cassa mette 1 coperto e una riga «Coperti» da 0 pezzi |
| 2a | Riuscito | Modo «tutte»: le righe rimandate con il loro `IdGestionale` restano com'erano (stessi numeri, nessun doppione) e la nuova prende un numero suo |
| 2b | Ignorato | Modo «parziale» (`IDDati` più `IsParziale`): nessuna riga aggiunta, risposta senza id, nessun errore e niente nel log della cassa |
| 2c | **Riuscito** | Modo «nuove»: `IdGestionale` della comanda e **solo la riga nuova**, senza `IsParziale`. Aggiunta, e le righe non mandate restano intatte, varianti comprese. Il CRM può scrivere solo le sue righe |
| 3 | Riuscito | `Varianti` accettate: a codice (`Variante`, la descrizione la completa la cassa) e a testo libero (solo `Descrizione`). Se escono sul foglietto: da vedere al passo 4. Rimandando una riga senza `Varianti`, le sue varianti restano |
| 4 | **Riuscito** | `InviaProduzioneComanda` con `uscite=[1]`: al monitor della cucina arriva solo l'uscita 1, con la variante a codice («+ SCAMORZA AFF») e quella libera («- senza cipolla»). Al bar niente. Le righe dell'uscita 1 passano «InProduzione», la birra in uscita 2 resta «InAttesa». Nel database un invio (`numeroInvii` 1, `ultimaPortataInviata` 1) |
| 5a | Riuscito | `DaCancellare` su una riga mai inviata: la riga sparisce. Funziona anche mandando solo quella riga |
| 5b | **Riuscito** | `DaCancellare` su una riga già mandata, scrivendo solo quella: la riga resta in comanda come «Cancellato» e la cucina la vede subito come storno («-1 Tagliatelle Silana», con le sue varianti), **senza un nuovo invio**. Alla chiusura la riga stornata non entra nel conto. Un secondo `invia` della stessa uscita non serve: non è stato provato perché rischia di rimandare le altre righe |
| 5c | Riuscito | `Pezzi` su una riga già scritta, mandando solo quella: la quantità cambia sul posto, stesso numero, totale ricalcolato |
| 6 | Ignorato | `Tavolo` diverso sulla stessa comanda: resta sul tavolo di prima, senza errore |
| 7 | **Riuscito** (demo, 08/10 sera) | **`StatoEnum` ignorato:** la riga scritta come «InProduzione» nasce «Nuovo», quindi il CRM non può segnare una riga «mandata» senza mandarla. **Chiusura dallo schermo della cassa** (provata sulla demo, che non ha il registratore): la cassa manda in produzione le righe del CRM mai mandate, senza chiedere niente, poi segna tutto «Fatto» e chiude. Anche un «Invia» premuto in cassa per una riga sua manda le righe del CRM non ancora partite. La chiusura proforma via `ContoComanda` senza invio (conto 82611, Frantoio) invece non manda niente |
| 8 | **Riuscito** | Sulla comanda aperta dal palmare (coperto e acqua), il modo «nuove» aggiunge la tagliatella del CRM senza toccare le righe del palmare, e il palmare la vede. Con il palmare **dentro il tavolo** il CRM scrive lo stesso (birra), e quando il palmare salva un'altra acqua la birra del CRM resta: il palmare aggiunge, non riscrive la comanda |
| 9 | Riuscito | `ContoComanda` proforma ESTERNO senza invio: conto 82610 pagato, 52 €, nessun invio in produzione |

## Cosa decidono

- **Aggiungere** (2c, 8): il giro della fase 2 scrive solo le righe del CRM, con l'`IdGestionale` della comanda e senza `IsParziale` (modo «nuove»). Non riscrive mai le righe del palmare o della cassa, e non c'è da aspettare che il palmare esca dal tavolo.
- **Riconoscere le righe nostre** (1, 2): l'`IdGestionale` di riga restituito dopo la scrittura, da salvare in `passepartout_righe_vive`. La risposta di `PutComanda` è la comanda intera con tutte le righe e i loro id: la riga nuova è quella con un id che prima non c'era, perché la riga non porta una chiave nostra.
- **Quantità e storni** (5a, 5b, 5c):
  - una quantità più bassa si scrive come `Pezzi` sulla stessa riga;
  - uno storno si scrive come `DaCancellare`, sia su una riga non mandata (sparisce) sia su una mandata (diventa «Cancellato» e la cucina vede lo storno);
  - non serve il ripiego dell'avviso alla cassa.
- **Varianti** (3, 4): nel campo `Varianti`, strutturato: a codice quando la variante del CRM ha un articolo variante in cassa, a testo libero altrimenti. Arrivano al monitor della cucina. Una riga già scritta si rimanda senza `Varianti`, che restano.
- **Stampa in cucina dalla cassa** (4): `InviaProduzioneComanda` con le sole uscite lanciate. Le uscite dopo restano «InAttesa».
- **Cambio tavolo** (6): ripiego. Un ordine già scritto in cassa si sposta in cassa, e il CRM rifiuta lo spostamento con «sposta il tavolo in cassa».
- **Stampa dal CRM** (7): una riga non si può segnare «mandata» senza mandarla, e la cassa manda in produzione le righe del CRM mai partite sia alla chiusura dallo schermo sia a ogni «Invia» premuto in cassa. Quindi **«stampa: il CRM» si può scegliere solo con «conto: il CRM»**, che chiude con `ContoComanda` senza invio, e la scheda lo impedisce, non solo lo segnala. Con «stampa: la cassa» il comportamento della cassa è quello giusto: il CRM non stampa i suoi foglietti e fa mandare le uscite dalla cassa.
- **Tavolo già aperto** (8): confermata la scelta dell'utente: un tavolo, una comanda. Il CRM aggiunge le sue righe alla comanda del palmare.

## Collaudo della fase 2 sulla demo (08/10/2026 sera)

Sulla demo Passepartout del rivenditore (VM di prova, Menu 2026C1), collegata al ristorante «Demo Integrazione Passepartout» con l'installatore. Agente `5717733`, stampa e conto «la cassa». Ordini presi nel CRM con «Entra».

| Prova | Esito |
|---|---|
| Ordine su un tavolo libero (SOTTO 3) | Comanda nuova 1410 con la nota `sympotia-ordine:336`, righe del CRM e coperti, nessun invio |
| Ordine su un tavolo con una comanda vecchia aperta (SOTTO 2, comanda 1405 in stato 0 dei dati d'esempio) | Il giro prova ad aggiungere alla comanda trovata e Passepartout va in errore interno: `NullReferenceException` in `PagamentoFBO.IsCancellabile`, lo stesso della chiusura dopo un preconto al Frantoio. L'ordine resta in attesa e ritenta |
| Spostamento nel CRM di quell'ordine, non ancora in cassa, su SOTTO 3 | Permesso; la comanda nasce sul tavolo nuovo |
| Riga aggiunta in cassa (tisana) e «Invia» dalla cassa | La cassa manda in produzione anche tutte le righe del CRM non ancora partite. Nel CRM la tisana non si vede: arriva con la fase 5 (righe della cassa nel pad) e nel conto con la fase 4 |
| Riga nuova e storno dal CRM | In cassa arrivano solo la riga nuova e lo storno («Cancellato»); le altre righe non si toccano |
| Tavolo aperto nel Menu Client mentre il CRM scrive | Al salvataggio la cassa avvisa che un altro utente ha modificato la comanda e che le modifiche della cassa non salvate andranno perse. Il palmare Passepartout invece aggiungeva senza perdere niente (passo 8) |
| Chiusura del conto dallo schermo della cassa (passo 7) | La pasta del CRM mai mandata parte in produzione alla chiusura (il monitor della cucina suona), poi tutte le righe diventano «Fatto» e la comanda si chiude. Conto 204 da 20,90 €: lo storno è rispettato |
| L'ordine nel CRM dopo la chiusura in cassa | Resta aperto: il CRM non si accorge che la cassa ha chiuso la comanda |

**Cosa aggiunge al piano:**
- **Fase 3:** con «stampa: la cassa» il CRM non stampa i suoi foglietti e fa mandare le uscite dalla cassa. «Stampa: il CRM» si può scegliere solo con «conto: il CRM».
- **Fase 4:** quando la cassa chiude la comanda di un ordine del CRM, l'ordine si chiude col conto della cassa (righe della cassa comprese, come la tisana).
- **Scheda e istruzioni per il personale:**
  - non tenere aperto in cassa un tavolo che riceve ordini dal CRM;
  - una comanda rimasta aperta in cassa su un tavolo blocca le righe del CRM su quel tavolo finché non si chiude o si sposta l'ordine.

## Prove sulla demo del 09/10/2026, per la fase 4

Comande di prova 1415, 1416 e 1417 sui tavoli SOPRA 8, 10 e 11, scritte via Web Service.

| Prova | Esito |
|---|---|
| Comanda nuova con `Coperti` 2 e nessuna riga coperto | **Ignorato**: la cassa segna 1 coperto e non aggiunge la sua riga. Dipende dalla configurazione della sala |
| `Coperti` cambiato su una comanda già aperta, o i `Pezzi` della riga coperto | **Ignorato**, sia prima sia dopo l'invio in produzione |
| Riga coperto (`TipoEnum` Coperto, articolo del coperto) **senza `Prezzo`** | **Riuscito**: la cassa la prezza col suo listino (2 × 2,00 € nella demo) e segna i coperti giusti |
| Modifiche e `ContoComanda` su una comanda mai mandata in produzione (stato 0) | Errore interno `NullReferenceException` in `PagamentoFBO.IsCancellabile`. Spiega la comanda vecchia del tavolo SOTTO 2. Al Frantoio invece funziona |
| `ContoComanda` sulla demo, con qualunque tipo di pagamento e documento | Sempre «errore interno»: sulla demo la chiusura via Web Service non si può provare. Il sospetto è il tipo di pagamento «3DSECURE» legato a un provider non configurato. Le comande di prova restano da chiudere dal Menu Client |

**Cosa decide:** con «conto: la cassa» (scelta dell'utente del 09/10: il coperto lo decide la cassa) il CRM scrive la riga coperto con i coperti e senza prezzo. Un cambio dei coperti dopo la prima scrittura può non arrivare in cassa: lì si corregge in cassa.


## Doppia stampa sulla demo, 09/10/2026 mattina

L'ordine 338 del CRM sul tavolo 1 (comanda 1418) è arrivato due volte in cucina. Il tavolo era aperto nel Menu Client.

| Ora (UTC) | Cosa è successo |
|---|---|
| 06:43 | Il CRM lancia l'uscita 1. La scrittura in cassa resta ferma dietro al tavolo aperto: l'agente rinuncia dopo 20 s («This operation was aborted») |
| dopo 45 s | Il ripiego vede l'errore e stampa dal CRM. Le righe diventano `stampata_crm` |
| 06:54 | La scrittura arriva in cassa, con le righe non mandate |
| 07:08 | La cassa le manda in cucina (al suo «Invia» o alla chiusura del tavolo nel Menu Client): seconda stampa |

Prove fatte subito dopo sulla comanda di prova 1421 (SOPRA 11):

| Prova | Esito |
|---|---|
| `PutComanda` su una riga non mandata con `StatoEnum` InProduzione o Fatto, con o senza `StatoPrecEnum` | **Rifiutato**: errore 500 senza testo, la riga resta «Nuovo». La cassa non accetta righe segnate «già mandate» |
| `InviaProduzioneComanda` di un'uscita già mandata | Le righe non ripartono, ma la cassa conta un invio in più (`numeroInvii`). Le righe delle uscite dopo passano da «Nuovo» a «InAttesa» |
| Stato delle righe nel database della cassa | 7 = Nuovo, 0 = InAttesa, 1 = InProduzione. `invioProduzione` si riempie già alla scrittura e non dice se la riga è partita |

**Cosa decide:**
- **Prima di stampare, il ripiego chiede alla cassa.** Le righe che la cassa ha già mandato si segnano come mandate. Le altre, se la cassa risponde, le manda lei: le righe già in cassa al prossimo giro o al suo «Invia», e la scrittura in sospeso quando passa. Il CRM stampa solo se la cassa non risponde, oppure per righe che in cassa non arriveranno: scrittura rifiutata, ordine fermo, tavolo non più abbinato.
- **L'agente non rimanda un'uscita le cui righe sono già tutte partite.** Risulta comunque mandata.
- **Resta un caso senza rimedio.** Se la cassa non risponde il CRM stampa, e quando la cassa torna le righe ci arrivano non mandate: il primo «Invia» della cassa le ristampa.
