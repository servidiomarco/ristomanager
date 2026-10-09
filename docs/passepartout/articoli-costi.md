# Passepartout: costi, distinte base e documenti dei fornitori

Nota per il food cost (Fase 0 del piano dell'08/10/2026). `wsdl.xml` è il contratto completo dell'AdapterWS. È stato scaricato dalla cassa il 06/10/2026 e l'indirizzo di rete è stato sostituito con `HOST-CASSA`.

## Cosa la cassa espone e il CRM oggi non legge

`GetArticoli` restituisce `ContrattoArticolo` con 88 campi. `getArticoliMenu()` (`services/passepartoutService.ts`) ne tiene solo id, codice, descrizione, prezzo, IVA, stato, tipo, categoria e varianti. Per il food cost contano questi:

| Campo | Tipo | Cosa contiene |
|---|---|---|
| `CostoUltimo` | decimal | ultimo costo d'acquisto dell'articolo |
| `IsDBA`, `Componenti` | bool, `PMBComponenteDB[]` | distinta base: `CodiceComponente`, `Quantita`, `UM`, `Ordine` |
| `Fornitori` | `PMBFornitoreArticolo[]` | `PrezzoBase`, `Sconto`, `UM`, `LottoRiordino`, `GiorniRiordino`, ragione sociale, P.IVA e codice fiscale del fornitore |
| `TipoEnum` | `EnumTipoArticolo` | fra gli altri `MateriaPrima` e `Composto` |
| `UM1`…`UM4`, `UM2Fc`…`UM4Fc`, `QtaConfezione` | | unità di misura e fattori di conversione |
| `Magazzini`, `ScortaMinima`, `ScortaMassima` | | magazzini e scorte |

Altre operazioni di sola lettura, mai chiamate finora:

- **`GetDisponibilitaArticoli(codiciArticolo[], magazzino)`** restituisce `PMBDisponibilitaArticolo`. Contiene esistenza, carichi, scarichi, inventario, ordinato al fornitore e `CostoUltimo` per magazzino.
- **`GetDocumentiRangeDate(daData, aData, tipi[])`** restituisce i documenti di tipo `BollaFornitore`, `FatturaFornitore`, `OrdineFornitore`, `Inventario`, `CaricoLavorazione`/`ScaricoLavorazione`. Le righe sono `PMBRigaDocumento` con `Prezzo`, `Quantita`, `Sconto`, `CostoUltimo`, `CostoMP`, `Lotto`, `Scadenza` e `IdPadreDBA`.
- `GetMagazzini`, `GetFornitori`, `GetFornitoriVariati`, `GetListini`, `GetArticolo(codice)`.

Fra le opzioni di import (`OpzioniArticoliRetail`) compaiono `ImportCostoUltimo` e `NonImportareComponentiDB`. Fanno pensare che i costi e le distinte possano arrivare in Passepartout Menu da Mexal, il gestionale contabile.

## La verifica (sola lettura)

```bash
node scripts/passepartout-conta-costi.mjs --cmd C:\ristomanager-agents\run-passepartout-agent.cmd   # agente installato a mano
node scripts/passepartout-conta-costi.mjs --nodo C:\Sympotia\Cassa\nodo.json                      # installatore
```

Lo script chiama solo `GetArticoli` e rifiuta qualunque altra operazione che non sia `Get…`. Stampa conteggi ed esempi:

- articoli per tipo;
- articoli con `CostoUltimo`;
- articoli con distinta base;
- articoli con prezzi dei fornitori;
- materie prime.

Va lanciato prima sulla demo della VM e poi sul PC della cassa, sempre con l'ok del titolare.

**Come leggere l'esito:**

- **Se costi e distinte sono compilati**, il food cost può importarli: le materie prime diventano ingredienti con `external_ref` `pp:articolo:<id>` e storico con fonte `PASSEPARTOUT`, e le componenti dei piatti già abbinati diventano righe di scheda proposte.
- **Se non sono compilati**, Passepartout serve solo per le vendite per articolo (Fase 3) e i prezzi arrivano dalle fatture.

## Esito del 09/10/2026

- **Demo del rivenditore (VM):** 348 articoli (344 semplici, 3 varianti, 1 coperto). Solo 2 hanno un costo d'acquisto, nessuno ha distinta base o prezzi dei fornitori, e non ci sono materie prime. È il catalogo di vendita e basta, come ci si aspetta da una demo.
- **Vecchio Frantoio:** 442 articoli (332 semplici, 107 varianti, più acconto, modificatore e coperto). Solo 4 vini hanno un costo d'acquisto; nessuno ha distinta base o prezzi dei fornitori, e non ci sono materie prime.

**Decisione:** niente import da Passepartout (il passo 1b del piano). Il locale non tiene il magazzino in cassa, quindi i costi arrivano a mano e poi dalle fatture (Fase 2). Passepartout serve al food cost solo per le vendite per articolo (Fase 3).
