# Sympotia come centralino: il telefono dentro il CRM

> Piano approvato il 10/10/2026. **Stato:** Fase 1 («chi chiama» per le chiamate di Sofia) fatta il 10/10 — `services/liveCalls.ts`, `components/phone/CallBanner.tsx`, `GET /phone/live`, eventi `phoneCall:started|ended`. Fase 0 da fare: serve un numero Twilio di prova (costo e acquisto da confermare). Le fasi 2–7 partono da qui.

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

**Perché register-call e non l'integrazione nativa.** Con register-call teniamo noi la chiamata Twilio e possiamo far squillare, passare la chiamata e registrare tutto.
- Si perde il trasferimento nativo di ElevenLabs, che oggi non usiamo: lo sostituiamo con un nostro reindirizzamento via REST.
- Va impostato l'audio μ-law 8000 sull'agente.
- Le variabili per Sofia le calcoliamo noi e le passiamo in `conversation_initiation_client_data`, perché non è garantito che ElevenLabs chiami il webhook di init.

## Fasi

### Fase 0: verifiche, senza toccare la produzione
- **Prove su un numero Twilio di prova**, che può diventare poi il ponte:
  - webhook → register-call → Sofia risponde in μ-law;
  - le variabili dinamiche arrivano a Sofia;
  - il post-call porta il `twilio_call_sid` passato come variabile;
  - Twilio Client squilla nel browser;
  - una chiamata in corso con Sofia si può reindirizzare al `<Dial>`.
- **Prova del cordless SIP sul Twilio SIP Domain:** registrazione dietro il doppio NAT USG → EdgeRouter → NeXXt, e se il display mostra il nome (Twilio limita il campo From).
- **Costi da verificare:** canone mensile di un numero geografico italiano, chiamate verso i cellulari, client nel browser (circa 0,004 $/min).
- **Col Frantoio:** dove è pubblicato oggi il fisso (Google, TripAdvisor, TheFork, sito, menu QR, insegna, biglietti) e chi ha uno smartphone di servizio.

### Fase 1: «chi chiama» per le chiamate di Sofia, senza toccare la linea (S, una PR)
- In `handleElevenLabsInitConversation` (server.ts, circa 1700 su main), dopo il lookup già presente, si emette `phone:live` con la scheda. Il CRM mostra «Sofia sta parlando con Mario Rossi».
- Il post-call chiude il banner con l'esito: prenotazione creata oppure «da richiamare».
- Nuovo endpoint per la scheda del chiamante: nome, VIP, allergie (`dietary_notes`), no-show (`noShowSubquery`), prossime prenotazioni (`findActiveReservationsByPhone`), visite e ultima visita. Visite e ultima visita oggi si calcolano solo nel client, in `CustomerList.tsx`: vanno calcolate sul server.
- Il banner globale `components/phone/CallBanner.tsx` si monta nella radice di `App.tsx`, accanto a `AppVersionBanner`, e usa la suoneria di `utils/chime.ts`.
- Eventi nuovi in `DOMAIN_EVENTS` (`services/eventRegistry.ts`) come `transient`.

### Fase 2: Sympotia davanti ai numeri, comportamento invariato (M)
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

### Fase 3: softphone nel CRM (L, 2–3 PR)
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

### Fase 5: lancio del numero prenotazioni (quando 3 e 4 squillano davvero in sala)
- **«Telefono pubblico»** (`legal_config.public_phone`) impostato sul 010032. Conferme, promemoria ed email usano già `identity.phone` («Per modifiche o imprevisti chiamaci al …», server.ts circa 26600 e 27120–27400), quindi ogni prenotazione insegna il numero nuovo. Da verificare che il fallback `IDENTITY_FALLBACK.phone` non lo sovrascriva.
- **Prompt di Sofia** (`docs/elevenlabs-agent-prompt.md` circa 206 e 266): i rimandi al locale citano il fisso. Si aggiornano col solito script, dry-run prima.
- **Google Business:** il 010032 come numero principale e il fisso come aggiuntivo. Poi sito, menu QR e TheFork/TripAdvisor (lo fa il locale, con una lista da spuntare).
- **Personale:** quando non può rispondere, devia il fisso sul **ponte** e non più sul 010032. Sulle chiamate del 010032 usa invece «Sofia risponde adesso».
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
