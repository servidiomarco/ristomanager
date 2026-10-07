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
| 5b | `togli <idRiga inviata>` | Riga già mandata: diventa «Cancellato»? Esce un foglietto di storno in cucina? |
| 6 | `sposta 87` | La comanda passa al tavolo 87, con le stesse righe? |
| 7 | `crea C1 B1` su un tavolo libero, poi chiusura **dallo schermo della cassa** | Alla chiusura la cassa manda in produzione le righe mai inviate? Cosa chiede al cassiere? |
| 8 | Aprire un tavolo dal palmare o dalla cassa con una riga, poi `adotta --tavolo N` e `aggiungi C1 --modo parziale` | Le righe del CRM si aggiungono alla comanda del palmare senza toccare le sue? |
| 9 | `chiudi` | Proforma pagata ESTERNO, tavolo libero. Da fare dopo ogni prova che lascia una comanda aperta |

Il log di ogni passo serve per la tabella qui sotto. Le risposte dubbie si guardano anche in `pmbLog` sul PC, in sola lettura.

## Esiti

Da riempire durante le prove.

| # | Esito | Note |
|---|---|---|
| 1 | | |
| 2a | | |
| 2b | | |
| 3 | | |
| 4 | | |
| 5a | | |
| 5b | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |

## Cosa decidono

- **Aggiungere** (2a/2b): con quale modo il giro della fase 2 scrive le righe nuove.
- **Riconoscere le righe nostre** (1, 2): l'`IdGestionale` di riga dopo la scrittura, da salvare in `passepartout_righe_vive`.
- **Varianti** (3, 4): campo `Varianti` (strutturato o testo libero) oppure tutto nella descrizione, come fa oggi la comanda specchio.
- **Stampa in cucina dalla cassa** (4): `InviaProduzioneComanda` per uscita, oppure `RiceviMessaggio` InviaUscite/InviaElemento.
- **Storni** (5): `DaCancellare` via PutComanda, oppure il ripiego (avviso alla cassa, storno a mano).
- **Cambio tavolo** (6): via PutComanda, oppure il ripiego («sposta il tavolo in cassa»).
- **Stampa dal CRM** (7): se la chiusura dalla cassa ristampa, l'opzione «stampa: il CRM» deve segnare le righe come inviate senza stampa, oppure va sconsigliata.
- **Tavolo già aperto** (8): conferma della scelta dell'utente: un tavolo, una comanda.
