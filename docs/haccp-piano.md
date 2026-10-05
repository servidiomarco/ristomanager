# Modulo HACCP completo — piano

Il registro HACCP di partenza (giugno 2026) copiava i fogli di carta del Vecchio Frantoio: cinque registri giornalieri, postazioni scritte nel codice, firma automatica di chi compila, stampa del giorno, avviso di temperatura fuori soglia e promemoria delle rilevazioni mancanti. Bastava a un locale; non a un secondo ristorante né a un ispettore scrupoloso. Questo documento raccoglie le lacune trovate il 05/10/2026, le decisioni e le quattro fasi che le chiudono.

## Perché, in breve

Il Reg. CE 852/2004 non elenca i registri da tenere: chiede procedure basate sui sette principi HACCP e registrazioni «adeguate» all'impresa. Quali registri servono lo decide il **manuale di autocontrollo del singolo locale**, e l'ASL sanziona la mancata applicazione delle procedure che il locale stesso si è dato (D.Lgs. 193/2007, art. 6: da 1.000 a 6.000 €). Ne seguono tre requisiti di fondo:

1. **Il modulo rispecchia il manuale del locale**: postazioni, soglie e frequenze si configurano per ristorante, non nel codice.
2. **Le registrazioni sono affidabili**: niente sovrascritture né cancellazioni senza traccia. Chi corregge lascia l'originale, chi e perché. L'ispettore diffida dei registri riscritti a posteriori.
3. **Ogni scostamento ha la sua azione correttiva** (5° principio HACCP), scritta e chiusa da qualcuno.

## Lacune del registro di partenza

| Lacuna | Dove |
|---|---|
| Postazioni, friggitrici e punti di pulizia del Frantoio fissi nel codice | `utils/haccp.ts`, `services/haccpApiService.ts` |
| Temperatura salvata sovrascrivendo la riga del giorno: il valore fuori soglia sparisce se corretto | `POST /haccp/temperatures` |
| Cancellazione libera per chiunque abbia fatto login | rotte `DELETE /haccp/*` senza permesso |
| Nessuna azione correttiva: la push parte, nessuno scrive cosa ha fatto | — |
| Una rilevazione al giorno per postazione, solo soglia massima (niente caldo) | vincolo UNIQUE(tenant, date, location) |
| Report di un giorno solo | `utils/printHaccpReport.ts` |
| Abbattimento senza temperature né orari: non dimostra la discesa | `haccp_production_logs` |
| Mancano: allergeni, rintracciabilità con fornitori, formazione, disinfestazione, Anisakis, cottura/caldo/scongelamento, olio con composti polari, taratura termometri, archivio documenti, etichette | — |

## Decisioni (05/10/2026)

- Una PR per fase, portata a CI verde; il merge lo fa il titolare.
- Si fa tutto, anche i **sensori di temperatura wireless** (fornitore non scelto: integrazione generica via webhook) e l'**AI sulle bolle** (chiave Anthropic rifiutata dal 17/09: si collauda con lo stub finché non viene rigenerata).
- L'HACCP resta nel prodotto base, non diventa un add-on.

## Modello delle registrazioni

- **Punti di controllo per ristorante** (`haccp_points`): registro (temperature, olio, pulizie; dalla Fase 2 anche termometri), nome, soglia minima e/o massima, rilevazioni al giorno (1–3), frequenza (giornaliera, settimanale, mensile, su richiesta), istruzioni. Un punto non si cancella: si archivia, così lo storico resta agganciato.
- **Le registrazioni non si cancellano**: si annullano con un motivo (`voided_at`, `void_reason`) e restano nel report come annullate.
- **Correzioni**: ogni creazione, modifica o annullamento scrive una riga in `haccp_changes` (prima/dopo, chi, quando, motivo). La tabella è in sola aggiunta: un trigger rifiuta gli UPDATE. Chi corregge la propria registrazione entro 15 minuti non deve motivare (è il refuso mentre si compila); dopo, o sulla registrazione di un altro, il motivo è obbligatorio.
- **Non conformità** (`haccp_nonconformities`): si aprono da sole quando un valore esce dalla soglia (temperatura, olio, merce respinta, processo fuori limite) o a mano. Si chiudono scrivendo l'azione correttiva. Il report le elenca con chi le ha chiuse.
- **Permessi**: `haccp:view` (vede registri e report), `haccp:record` (compila), `haccp:manage` (configura punti e limiti, archivio documenti, formazione). Concessi dalla migration a chi oggi vede l'HACCP (`dashboard:view`); `manage` a titolare, direzione e manager.

## Fase 1 — fondamenta ✅ (PR #828)

- Punti di controllo configurabili da **HACCP → Configura**, con il Frantoio migrato sui suoi punti attuali (lo storico si aggancia per nome).
- Fino a tre rilevazioni al giorno per postazione, soglia minima per il caldo.
- Correzioni con storico, annullamento con motivo al posto della cancellazione, permessi sulle rotte.
- Non conformità con azione correttiva obbligatoria, scheda dedicata con il contatore delle aperte.
- Pulizie con frequenza: il giorno mostra solo i punti dovuti.
- Report per periodo (giorno, mese, intervallo), con griglia mensile delle temperature, non conformità e correzioni.
- Aggiornamento in tempo reale fra i telefoni della cucina (`haccp:changed`).

## Fase 2 — registri di processo e rintracciabilità ✅

- **Processi** con temperature e orari veri, al posto di «range/durata»: abbattimento (positivo e negativo), bonifica anti-Anisakis (−20 °C per 24 h o −35 °C per 15 h), cottura al cuore, rinvenimento, mantenimento a caldo, scongelamento, sanificazione delle verdure, campioni testimone dei banchetti. Esito calcolato sui limiti del locale; fuori limite apre una non conformità.
- **Limiti del locale** (`haccp_settings`): cottura ≥ 75 °C, caldo ≥ 65 °C, abbattimento a +3 °C in 90 minuti, ecc., modificabili in Configura.
- **Olio**: composti polari (%) e temperatura della friggitrice; oltre il limite apre una non conformità.
- **Ricevimento merci** con fornitore (anagrafica della Lista della spesa), numero del documento di trasporto, scadenza, integrità dell'imballo, tipo di merce con la sua soglia.
- **Rintracciabilità**: ricerca per lotto, prodotto o fornitore fra ricevimenti e processi; **richiamo** come non conformità dedicata.
- **Taratura dei termometri** come registro con la sua frequenza.

## Fase 3 — persone, documenti, interventi, allergeni

- **Formazione**: attestati per persona (scheda del Personale) con scadenza, allegato e avviso 30 giorni prima.
- **Interventi esterni**: disinfestazione, ritiro dell'olio esausto (CONOE), manutenzioni, analisi dell'acqua e di laboratorio; con ditta, esito, rapporto allegato e prossima scadenza.
- **Archivio documenti**: manuale di autocontrollo, schede tecniche e di sicurezza dei detergenti, contratti, registrazione sanitaria, planimetria; con scadenza dove serve.
- **Libro allergeni** stampabile dai piatti del menu (14 allergeni del Reg. 1169/2011), con i piatti senza informazione segnalati.
- **Fascicolo per l'ispezione**: una stampa sola con documenti, formazione, registri del periodo e non conformità.
- Scadenze (attestati, interventi, documenti) nei promemoria di sistema.

## Fase 4 — etichette, sensori, AI

- **Etichette** di produzione e di prodotto aperto (prodotto, data, scadenza secondaria, lotto, allergeni, operatore) sulla stampante termica tramite l'agente di stampa; preset di prodotti con la loro durata.
- **Sensori di temperatura**: webhook generico con token per ristorante (formato documentato, adattabile a Monnit, Testo, Comark…), sensore → postazione; la rilevazione del giorno si compila da sola, lo scostamento prolungato apre una non conformità, il sensore muto avvisa.
- **AI sulle bolle**: foto del documento di trasporto → proposta di righe di ricevimento (fornitore, prodotti, lotti, scadenze) da confermare. L'AI propone, la persona conferma.

## Fuori da questo piano

- Generazione automatica del manuale di autocontrollo (resta un documento caricato in archivio).
- Firma elettronica qualificata delle registrazioni: la firma è l'utente autenticato con data e ora del server, più lo storico delle correzioni.

## Riferimenti

Reg. CE 852/2004 (art. 5, All. II), Reg. CE 178/2002 (artt. 18–19), D.Lgs. 193/2007 (art. 6), Reg. UE 1169/2011 e D.Lgs. 231/2017 (allergeni), Reg. UE 2021/382 (allergeni nell'autocontrollo, cultura della sicurezza), Reg. CE 853/2004 All. III Sez. VIII (Anisakis), Reg. CE 2073/2005 (criteri microbiologici), Reg. UE 2017/625 art. 15 (accesso ai sistemi informatici durante i controlli), Reg. UE 2017/2158 (acrilammide), Circolare Min. Sanità 1/1991 (composti polari 25%).
