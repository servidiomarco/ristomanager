# Sympotia come centralino: il telefono dentro il CRM

> Piano approvato il 10/10/2026. **Stato:** Fase 1 («chi chiama» per le chiamate di Sofia) fatta il 10/10 — `services/liveCalls.ts`, `components/phone/CallBanner.tsx`, `GET /phone/live`, eventi `phoneCall:started|ended`. Fase 0 fatta il 10/10 col client Twilio nel browser, senza comprare numeri: esiti in fondo alla Fase 0. Le fasi 2–7 partono da qui.

## Contesto

**Oggi**
- Sofia risponde sul numero Twilio **0985 010032**. Twilio passa la chiamata direttamente a ElevenLabs (`voice_url = api.us.elevenlabs.io/twilio/inbound_call`): il nostro codice non tocca la voce, vede solo i webhook di Sofia.
- Il fisso del locale **0985 876578** squilla sui telefoni del Frantoio. Il personale attiva **a mano** la deviazione su Sofia quando sa di non poter rispondere.
- Le chiamate prese dal personale non passano da Sympotia: niente nome, niente storico, niente chiamate perse.
- In nessun punto si passa la chiamata a una persona: `transfer_to_number` è null e la regola per orario del vecchio piano Vonage non è mai stata costruita.

**Dati di produzione (ultimi 30 giorni)**
- Sofia ha preso 330 chiamate (circa 11 al giorno, picchi venerdì e sabato e dalle 17 alle 19).
- 249 su 330 (75%) venivano da numeri già in rubrica.
- Prenotazioni: 408 inserite a mano dal personale, quasi tutte dal fisso, e 166 da Sofia.
- Twilio fattura le chiamate in arrivo circa 0,01 $/min.

**Obiettivo**
- Ogni chiamata di prenotazione passa da Sympotia e squilla con nome e scheda del cliente: nel CRM (PC/tablet), sul cordless e sugli smartphone del personale.
- Il ristoratore decide per fascia oraria chi risponde per primo (il locale o Sofia).

**Decisione del 10/10.** Si parte col **0985 010032 come numero dedicato alle prenotazioni**. Il fisso resta com'è per tutto il resto. Dopo qualche mese di uso si decide, sui numeri, se deviare o portare anche il fisso.

## Architettura

```
Cliente ─▶ 0985 010032 «numero prenotazioni» (Twilio)
        ─▶ POST /webhook/t/:token/voice/inbound   (Sympotia, firma X-Twilio-Signature)
            1. findCustomerByPhone → riga phone_calls → socket «phone:ringing» con la scheda
            2. regola della fascia oraria → TwiML:
               a) Prima il locale: <Dial timeout=N action=/voice/after-dial>
                     <Client> dispositivi CRM  <Sip> cordless  <Number> cellulari (facoltativo)
                  nessuna risposta → Sofia (register-call ElevenLabs) o segreteria
               b) Prima Sofia: register-call → Sofia; il tool «passa_al_locale» reindirizza
                  la chiamata Twilio via REST verso lo stesso <Dial>
               c) Solo locale: <Dial> → segreteria e chiamata persa
            3. status callback → phone_calls aggiornata → socket «phone:updated»

Fisso 0985 876578 ─(deviazione manuale come oggi, ma verso il numero PONTE)─▶ Twilio «ponte»
        ─▶ stesso webhook, regola fissa «subito Sofia» (in sala non squilla di nuovo),
           con la chiamata nel registro e il banner «Sofia sta parlando con …»

voice_fallback_url di entrambi = URL ElevenLabs di oggi: se Sympotia non risponde, prende Sofia.
```

**Perché il numero ponte.** Twilio non dice se una chiamata arriva deviata dal fisso: `forwarded_from` coincide col numero chiamato. Senza ponte, col «Prima il locale» attivo, una chiamata deviata perché nessuno può rispondere farebbe squillare di nuovo la sala prima di arrivare a Sofia.

**Il ponte non si compra su Twilio (verificato il 10/10).** Per l'Italia Twilio vende solo cellulari (45 $/mese) e numeri verdi (27 $/mese più 0,46 $/min in arrivo); i fissi 0985 non sono più in vendita, e il 010032 è di luglio. Strade da decidere prima della Fase 3, cioè quando il 010032 squillerà in sala:
- un numero 0985 di un operatore VoIP italiano, inoltrato via SIP al SIP Domain Twilio (pochi euro al mese, da verificare);
- chiedere a Twilio un fisso tramite il supporto;
- niente ponte: chi devia il fisso accende anche «Sofia risponde adesso» nel CRM.

**Perché register-call e non l'integrazione nativa.** Con register-call teniamo noi la chiamata Twilio e possiamo far squillare, passare la chiamata e registrare tutto.
- Si perde il trasferimento nativo di ElevenLabs, che oggi non usiamo: lo sostituiamo con un nostro reindirizzamento via REST.
- Va impostato l'audio μ-law 8000 sull'agente.
- Le variabili per Sofia le calcoliamo noi e le passiamo in `conversation_initiation_client_data`, perché non è garantito che ElevenLabs chiami il webhook di init.

## Fasi

### Fase 0: verifiche, senza toccare la produzione
- **Prove col client Twilio nel browser** (TwiML App, circa 0,004 $/min, nessun numero da comprare). L'unica prova che non sostituisce, la chiamata vera dalla rete telefonica, si fa alla fine sul 010032 a locale chiuso:
  - webhook → register-call → Sofia risponde in μ-law;
  - le variabili dinamiche arrivano a Sofia;
  - il post-call porta il `twilio_call_sid` passato come variabile;
  - Twilio Client squilla nel browser;
  - una chiamata in corso con Sofia si può reindirizzare al `<Dial>`.
- **Prova del cordless SIP sul Twilio SIP Domain:** registrazione dietro il doppio NAT USG → EdgeRouter → NeXXt, e se il display mostra il nome (Twilio limita il campo From).
- **Costi Twilio:** chiamate in arrivo su numeri italiani 0,01 $/min, client nel browser circa 0,004 $/min; da verificare le chiamate verso i cellulari.
- **Col Frantoio:** dove è pubblicato oggi il fisso (Google, TripAdvisor, TheFork, sito, menu QR, insegna, biglietti) e chi ha uno smartphone di servizio.

**Esiti della Fase 0 (10/10, una chiamata di prova di 61 s, agente di prova poi cancellato):**
- `register-call` → Sofia risponde con l'agente in μ-law 8000 in entrambe le direzioni: ha capito la domanda e ha risposto.
- Le variabili passate in `conversation_initiation_client_data` arrivano: «Ciao Giulia…», e il numero letto da `caller_id_spelled`.
- Il post-call porta `metadata.phone_call.call_sid` uguale al CallSid Twilio anche con register-call. Non serve una variabile apposta per collegare `voice_calls` a `phone_calls`. `external_number` è il `from_number` passato a register-call.
- Il `<Client>` squilla nel browser (token HS256 firmato con una API key). Con `timeout="12"` l'esito «no-answer» arriva dopo circa 17 s: il timeout parte quando lo squillo è avviato, quindi N va scelto tenendone conto.
- Una chiamata in corso con Sofia si reindirizza via REST (`Calls/{sid}` con nuovo TwiML) verso il `<Dial>` della sala. ElevenLabs chiude la conversazione e manda il post-call dopo circa 3 s, mentre la chiamata continua con lo staff.
- La chiave ElevenLabs di produzione non ha `webhooks_write`. Per le prove serve un webhook creato a mano dal pannello (Sviluppatori › Webhooks) puntato al tunnel, e un agente di prova con `workspace_overrides.webhooks.post_call_webhook_id` verso quello. Altrimenti il post-call va al webhook di produzione e scrive in `voice_calls`.
- Restano da provare il cordless SIP (serve l'hardware) e una chiamata vera dalla rete telefonica sul 010032, al collaudo a locale chiuso.

### Fase 1: «chi chiama» per le chiamate di Sofia, senza toccare la linea (S, una PR)
- In `handleElevenLabsInitConversation` (server.ts, circa 1700 su main), dopo il lookup già presente, si emette `phone:live` con la scheda. Il CRM mostra «Sofia sta parlando con Mario Rossi».
- Il post-call chiude il banner con l'esito: prenotazione creata oppure «da richiamare».
- Nuovo endpoint per la scheda del chiamante: nome, VIP, allergie (`dietary_notes`), no-show (`noShowSubquery`), prossime prenotazioni (`findActiveReservationsByPhone`), visite e ultima visita. Visite e ultima visita oggi si calcolano solo nel client, in `CustomerList.tsx`: vanno calcolate sul server.
- Il banner globale `components/phone/CallBanner.tsx` si monta nella radice di `App.tsx`, accanto a `AppVersionBanner`, e usa la suoneria di `utils/chime.ts`.
- Eventi nuovi in `DOMAIN_EVENTS` (`services/eventRegistry.ts`) come `transient`.

### Fase 2: Sympotia davanti ai numeri, comportamento invariato (M)

**Fatto il 10/10 (codice; la linea si collega con `scripts/telefono-linea.mjs`, lanciato dall'utente):**
- **Tabella `phone_calls`** con RLS. `phone_lines` e le regole per fascia oraria slittano alla Fase 3, quando ci saranno dispositivi da far squillare: in Fase 2 la regola è una sola, `solo_sofia`.
- **Webhook firmati:** `/webhook/t/:token/voice/inbound` registra la chiamata, apre il banner e aggancia Sofia con register-call (`services/phoneRouting.ts`). `/voice/status` chiude la riga.
- **Refactor:** `buildSofiaInitData` è estratto dal webhook di init ed è usato da entrambi.
- **Chiamate perse:** se Sofia non è raggiungibile, o è agganciata ma senza post-call dopo 3 minuti («Sofia muta», il caso di agosto), il chiamante sente un messaggio di cortesia. Poi parte `recordMissedPhoneCall`: riga provvisoria in `voice_calls` (`twilio:<CallSid>`, Da ricontattare), push «Chiamata persa» e banner chiuso. Un post-call in ritardo riaggancia la conversazione e chiude la riga provvisoria.
- **Al posto del passaggio automatico a «Solo locale»:** non c'è ancora un locale da far squillare, quindi c'è il messaggio di cortesia con la chiamata da ricontattare. Il guardiano della quota ElevenLabs (`startElevenLabsQuotaWatchdog`) oggi non funziona: `/user/subscription` risponde 401 perché la chiave non ha `user_read`.
- **Registro:** la pagina arriva in Fase 3. Le chiamate perse si vedono già in Chiamate.

**Piano originale:**
- **Migrazioni con RLS** come `voice_calls`:
  - `phone_lines`: tenant, e164, sid Twilio, ruolo `prenotazioni` | `ponte` | (più avanti) `fisso`, agente ElevenLabs, regole JSON, timeout di squillo;
  - `phone_calls`: call_sid, linea, chiamante, customer_id, direzione, stato (squilla / risposta / persa / Sofia / segreteria), chi ha risposto, orari, durata, `voice_call_id`, nota.
- **`services/phoneService.ts`** decide la regola e scrive il TwiML. La linea ponte ha sempre «subito Sofia».
- **Webhook Twilio** su `/webhook/t/:token/voice/{inbound,after-dial,status}`, col tenant risolto da `resolveWebhookTenantOr404` e la firma verificata.
- **Refactor:** si estrae da init-conversation un `buildSofiaInitData(tenantId, phone)`, usato sia dal webhook di ElevenLabs sia da register-call.
- **Post-call:** collega `voice_calls` a `phone_calls` tramite la variabile `twilio_call_sid`.
- **Registro «Telefono»:** tutte le chiamate, divise per linea, come scheda di `ConversazioniPage.tsx`.
- **Messa in linea:** uno script, lanciato dall'utente, cambia il `voice_url` del 010032 e del ponte verso Sympotia e mette quello di ElevenLabs come fallback. La modalità iniziale è «Solo Sofia», cioè come oggi. Per tornare indietro basta rimettere il `voice_url` di prima.
- **Credito ElevenLabs esaurito** (ad agosto 175 chiamate mute): quando `startElevenLabsQuotaWatchdog` segnala la quota finita, la linea prenotazioni passa da sola a «Solo locale».

### Fase 3 ridotta: prima il cellulare (fatta il 10/10)
In attesa di softphone e cordless, prima di Sofia squilla il cellulare del locale. La regola sta in Impostazioni › AI › «Chi risponde al telefono» (`app_settings.phone_routing`: `solo_sofia` | `prima_cellulare`, fino a 3 cellulari, 5–60 secondi). Il giro:
1. `<Dial answerOnBridge callerId=010032 action=after-dial><Number url=whisper?p=…>`;
2. l'annuncio «Chiamata per … da <nome o numero>. Premi 1»;
3. `whisper-ok` col tasto 1 → `phone_calls.status = answered`, `answered_by = cellulare:+39…`;
4. `after-dial` → Sofia se nessuno ha preso la chiamata.

Il banner ha la fase (`stage`: ringing / sofia / staff, evento `phoneCall:updated`).

**10/10, prima prova vera:** con «Prima il cellulare» acceso sono arrivate due chiamate di un cliente vero (15:07 e 15:09). Il cellulare risultava aver risposto dopo 7 s e ha ricevuto l'annuncio, ma nessun 1. La chiamata del cliente si è chiusa nello stesso istante del cellulare, dopo 22 s e dopo 8 s, e Sofia non è entrata. Non si sa ancora se il cliente abbia riattaccato stanco dello squillo o se Twilio chiuda la chiamata alla fine dell'annuncio: serve la prova con due telefoni. L'utente ha rimesso «Solo Sofia». Correzioni:
- niente Sofia se chi chiama ha già riattaccato;
- chi riattacca durante lo squillo finisce in Da ricontattare;
- annuncio corto e Gather a 6 s. Costo: circa 0,045 $/min verso cellulari italiani da numero EEA. Da provare: il passaggio del numero del cliente come caller ID.

### Fase 3: softphone nel CRM

**Fatta il 10/10 (una PR):**
- **Dispositivi:** tabella `phone_devices` (chiave del browser, utente, `last_seen_at`).
  - Rotte `GET/POST /phone/devices`, `DELETE /phone/devices/:id` e `POST /phone/token`: JWT del Voice SDK, identità `t<tenant>d<id>`, 1 ora, rinnovato su `tokenWillExpire`.
  - In uscita solo la TwiML App `sympotia-softphone`.
- **Modalità `prima_locale`** (sostituisce `prima_cellulare`, letta ancora):
  - un solo `<Dial>` con i `<Client>` dei dispositivi visti negli ultimi 7 giorni (con i parametri `parentCallSid` e `caller` per il banner) e i `<Number>` con l'annuncio;
  - `client-answered` (statusCallback «answered» del `<Client>`) segna `answered_by = utente:<id>` e manda `phoneCall:updated` col nome.
- **«Richiama»:**
  - `/webhook/twilio/voice/client-call`, senza token nel path: il tenant viene dall'identità firmata;
  - escono solo i numeri `+39`, col numero del locale (l'ultimo `to_number` in arrivo);
  - righe `direction = outbound`, `routing = richiamata`.
- **Client** (`services/softphone.ts`):
  - Voice SDK 2.18.4 in un chunk a parte, con import dinamico;
  - Rispondi/Rifiuta, muto, riaggancia e Nuova prenotazione nella card «chi chiama»;
  - interruttore «Questo dispositivo squilla» in Impostazioni › AI;
  - «Chiama»/«Richiama» in Chiamate passano dal CRM se il telefono è acceso.
- **Messa in linea:** `scripts/telefono-softphone.mjs --apply`, lanciato dall'utente, crea API key e TwiML App e imposta su Railway `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (da stdin) e `TWILIO_TWIML_APP_SID`. Fatto il 10/10 alle 18:49.
- **Prima prova, 10/10 alle 18:52, col solo cellulare:**
  - con «Rifiuta» la chiamata è passata a Sofia: `DialCallStatus = busy`, `CallStatus = ringing`;
  - lasciando squillare il CRM per 15 s, la chiamata si è chiusa invece di passare a Sofia. Twilio ha mandato ad `after-dial` `CallStatus = no-answer` (con `answerOnBridge` la chiamata del cliente risulta «no-answer» finché non viene collegata, come dice il changelog TwiML del 2020-12-09) e `after-dial` l'ha letto come cliente andato via. La status callback «no-answer» è arrivata nello stesso istante.
  - **Correzione:** il `<Dial>` dello squillo non usa più `answerOnBridge`: Twilio risponde subito e fa sentire lo squillo italiano (`ringTone="it"`), come nella prova della Fase 0, in cui dopo il «no-answer» Sofia ha preso la chiamata. `after-dial` considera chiusa la chiamata solo con `completed`, `canceled` o `failed`. Lo squillo resta a carico del chiamante come una chiamata risposta: sono i secondi di attesa.
- **Completata il 10/10 (seconda PR):**
  - **fasce orarie** nella stessa riga `app_settings.phone_routing` (`slots`: giorni 1–7, dalle–alle, anche oltre mezzanotte, al massimo 8) e **interruttore rapido** (`override`: modo e scadenza; 1 ora, 2 ore o «fino a stanotte» = le 4). Chi risponde adesso lo decide `effectivePhoneMode` in `utils/phoneSchedule.ts`, condiviso fra server (inbound) e CRM (pastiglia in testata, `GET/PUT /phone/mode`, evento `phoneRouting:changed`);
  - **registro** in Chiamate › Registro (`GET /phone/calls`, filtri all/missed/staff/sofia/outbound, ricerca, pagine da 50);
  - **nota a fine chiamata** (`phone_calls.note`, `PUT /phone/calls/:id|CallSid/note`): la card «chi chiama» mostra l'ultima nota dello stesso numero (`card.last_note`);
  - **prenotazione collegata** (`phone_calls.reservation_id`): esplicita da «Nuova prenotazione» nella card o nel registro (`POST /phone/calls/:ref/reservation`), automatica in `POST /reservations` per una chiamata presa dal locale o in uscita con lo stesso numero negli ultimi 45 minuti. Per Sofia vale `voice_calls.reservation_id`.

**Piano originale:**
- **Twilio Voice JS SDK** (`@twilio/voice-sdk`), con TwiML App e API key in nuove variabili `TWILIO_API_KEY_*` e `TWILIO_TWIML_APP_SID`.
- **`POST /phone/token`:** identità `t{tenant}_u{user}_d{device}`. Il token si rilascia solo ai dispositivi con «Questo dispositivo squilla» attivo.
- **Banner in arrivo**, con la scheda della Fase 1:
  - pulsanti Rispondi, Rifiuta, Passa a Sofia;
  - in chiamata: muto, attesa, chiudi, «Nuova prenotazione» già compilata (si riusa il prefill `onCreateReservation` di ConversazioniPage) e collegata a `phone_call_id`, apri il cliente;
  - a fine chiamata: una nota che resta sul cliente.
- **Squillo simultaneo** su tutti i `<Client>`: risponde il primo, gli altri vedono «ha risposto Giulia».
- **Impostazioni › Telefono:**
  - regole per fascia oraria (Prima il locale per N secondi poi Sofia / Prima Sofia / Solo locale), sullo stesso modello di `voice_bookings_suspension_schedule`;
  - interruttore rapido «Sofia risponde adesso», che torna da solo alla regola a fine servizio.
- **Chiamate perse:** badge, push ai responsabili (`pushService.sendToRoles`) e «Richiama» dal CRM, che compare al cliente dal 010032, lo stesso numero che ha chiamato.
- **Audio:** cuffia o vivavoce USB alla postazione. Il browser vuole un gesto dell'utente prima di suonare, quindi a inizio turno serve un clic su «Attiva telefono».

### Fase 4: cordless e smartphone (M più hardware)
- **Cordless:** una base DECT IP (per esempio Yealink W70B o Gigaset N670 IP PRO, circa 150–250 €) registrata sul SIP Domain Twilio del tenant, e `<Sip>` nel `<Dial>`. Se il display non può mostrare il nome, mostra il numero e il nome resta nel CRM.
- **Smartphone, subito:**
  - la PWA col Voice SDK squilla quando l'app è aperta;
  - Web Push «Chiamata da Mario Rossi» e «Persa da …».
- **Smartphone, a scelta per chi deve squillare sempre:** `<Number>` verso il cellulare con un annuncio («Chiamata da Mario Rossi, premi 1»). Costa al minuto verso i cellulari.
- **Smartphone, più avanti:** un'app nativa (Capacitor più Twilio Voice SDK, CallKit e ConnectionService) per lo squillo a schermo bloccato. È un progetto a sé.

**Fatto il 10/10 (software, una PR):**
- **Dominio SIP** `sympotia-<account>.sip.twilio.com` con registrazione SIP, preparato da `scripts/telefono-sip.mjs --apply` (lo lancia l'utente): Credential List «sympotia-cordless» collegata per registrarsi e per chiamare, variabili `TWILIO_SIP_DOMAIN` e `TWILIO_SIP_CREDENTIAL_LIST_SID` su Railway.
- **Linee cordless** (`phone_sip_lines`, RLS): Impostazioni › AI › «Chi risponde al telefono» › Cordless. Il server crea la credenziale `t<tenant>c<id>` con una password di 20 caratteri, la mostra una volta sola e non la conserva; togliere la linea cancella la credenziale su Twilio. Al massimo 5.
- **Squillo:** `<Sip>` nello stesso `<Dial>` di CRM e cellulari, con `statusCallback` «answered» su `client-answered` (`answered_by = cordless:<id>`). Il `callerId` del `<Dial>` resta il numero del locale (serve ai cellulari): nome e numero del cliente vanno al display in `Remote-Party-ID`.
- **In uscita:** il dominio chiama `/webhook/twilio/voice/sip-call`; stesso percorso del «Chiama» dal CRM (`dialOutFromLocale`), riga `outbound` nel registro, durata da `client-status`.
- **Numeri chiamabili** (CRM e cordless): solo fissi `+390…` e cellulari `+393…`. Restano fuori estero, numeri a pagamento e numeri brevi, compresi 112, 113 e 118: per le emergenze resta il fisso.
- **Smartphone:** il CRM aperto nel telefono (anche come app installata) squilla con «Questo dispositivo squilla», come sul PC. Per lo squillo con l'app chiusa restano il cellulare con «premi 1» o, più avanti, l'app nativa.

**Da provare (prima di comprare la base):** un'app SIP sul telefono o sul Mac (per esempio Linphone o Zoiper) con i dati della linea mostrati nel CRM:
1. si registra (dietro il doppio NAT USG → EdgeRouter → NeXXt, TLS sulla 5061);
2. con «Prima il locale» squilla insieme al CRM, e mostra il nome se l'app legge `Remote-Party-ID`;
3. chiama un cellulare italiano e chi risponde vede il numero del locale.

**Configurazione della base (Yealink W70B, simile su Gigaset N670):** account SIP con Server = dominio, porta 5061, trasporto TLS, Outbound Proxy = `sip.frankfurt.twilio.com`, utente e password del CRM, scadenza della registrazione 600 s; in «Caller ID Source» scegliere RPID (o PAI/RPID) per avere il nome del cliente.

### Fase 5: lancio del numero prenotazioni (quando 3 e 4 squillano davvero in sala)
- **«Telefono pubblico»** (`legal_config.public_phone`) impostato sul 010032. Conferme, promemoria ed email usano già `identity.phone` («Per modifiche o imprevisti chiamaci al …», server.ts circa 26600 e 27120–27400), quindi ogni prenotazione insegna il numero nuovo. Da verificare che il fallback `IDENTITY_FALLBACK.phone` non lo sovrascriva.
- **Prompt di Sofia** (`docs/elevenlabs-agent-prompt.md` circa 206 e 266): i rimandi al locale citano il fisso. Si aggiornano col solito script, dry-run prima.
- **Google Business:** il 010032 come numero principale e il fisso come aggiuntivo. Poi sito, menu QR e TheFork/TripAdvisor (lo fa il locale, con una lista da spuntare).
- **Personale:** quando non può rispondere, devia il fisso sul **ponte** (se c'è, vedi sopra) e non più sul 010032. Sulle chiamate del 010032 usa invece «Sofia risponde adesso».
- **Contratto:** il numero è nell'account Twilio di Sympotia, quindi va scritto che il locale può portarselo via se se ne va.

### Fase 6: Sofia passa la chiamata (S/M)
- Un nuovo tool server `passa_al_locale`:
  - reindirizza la chiamata Twilio con `calls(sid).update`;
  - il CRM squilla col riassunto di Sofia («tavolo per 12, sabato»);
  - se nessuno risponde, torna a Sofia oppure lascia una richiamata (riusa `save_callback_request`).
- Nel prompt: quando usarlo (il cliente chiede una persona, gruppo grande, domanda fuori ambito), solo se la fascia lo permette (variabile `transfer_available`).
- Sul ponte non si usa: se il fisso è deviato, in sala non c'è nessuno.

### Fase 7: valutazione dopo 2–3 mesi
- **Indicatore:** quota delle prenotazioni del personale (`MANUAL`, oggi circa 400 al mese) collegate a una chiamata del 010032, contro quelle senza chiamata, cioè fisso o di persona. A fianco, le chiamate del ponte.
- **Se il fisso porta ancora molte prenotazioni:** deviazione permanente del fisso sul 010032 (ruolo `fisso` in `phone_lines`, codice già pronto) oppure portabilità del 0985 876578 su Twilio (documenti e PIN, fino a 6 settimane, attenzione se il numero è legato al contratto internet).
- **Per gli altri locali** valgono le stesse due modalità: numero dedicato oppure fisso deviato o portato.

## Rischi e decisioni aperte
- **Internet del locale giù:** CRM e cordless non squillano, il `<Dial>` va in timeout e prende Sofia o il cellulare.
- **Sympotia giù:** scatta il `voice_fallback_url` e risponde Sofia come oggi.
- **Due telefoni in sala durante la transizione:** il fisso sui vecchi apparecchi, il 010032 su CRM, cordless e smartphone.
- **Registrazione delle chiamate:** spenta (GDPR). Eventualmente in una fase a parte, con informativa.
- **Multi-tenant:** un numero e un agente per tenant in `phone_lines`, in linea con `docs/provisioning-nuovo-cliente.md` (branch `feat/saas-provisioning-tenant`).
- **Commerciale:** nuovo entitlement `phone` in `TENANT_FEATURES` (`services/entitlements.ts`), oppure dentro l'add-on voce.

## File principali
- **Da modificare:**
  - `server.ts`: `handleElevenLabsInitConversation`, `handleElevenLabsPostCall`, `resolveWebhookTenantOr404`, route `/voice-calls`, identità pubblica
  - `services/elevenlabsService.ts`: `findCustomerByPhone`, `findActiveReservationsByPhone`, `recordVoiceCall`
  - `services/socketService.ts`, `services/eventRegistry.ts`, `services/pushService.ts`
  - `utils/phone.ts`: `normalizeItalianPhone`
  - `App.tsx`: radice accanto ad `AppVersionBanner`
  - `components/ConversazioniPage.tsx`
  - `services/entitlements.ts`
  - `docs/elevenlabs-agent-prompt.md`
- **Nuovi:**
  - `services/phoneService.ts`, `services/phoneClient.ts` (Voice SDK)
  - `components/phone/CallBanner.tsx`, `components/phone/PhoneSettingsCard.tsx`
  - migrazioni di `phone_lines` e `phone_calls`, con `phone_call_id` sulle prenotazioni
  - `tests/api/phone-*.test.ts`

## Verifica
- **Test API:**
  - firma Twilio;
  - regola per linea e fascia → TwiML atteso (il ponte va sempre a Sofia);
  - status callback → `phone_calls`;
  - scheda del chiamante con RLS rigida (il job CI RLS, da guardare per nome);
  - event registry.
- **Prova end-to-end sul numero di prova**, con lo stack locale isolato su porte proprie:
  - una chiamata dal cellulare fa comparire il banner;
  - si risponde nel browser e la chiamata finisce nel registro;
  - senza risposta prende Sofia;
  - `passa_al_locale` funziona;
  - una chiamata al ponte va subito a Sofia, con il banner.
- **Collaudo al Frantoio a locale chiuso** prima di cambiare il `voice_url` del 010032 di produzione. Per tornare indietro si rimette il `voice_url` di ElevenLabs.
