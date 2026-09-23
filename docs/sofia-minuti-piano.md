# Minuti di Sofia inclusi nell'add-on voce — piano

L'add-on voce include un pacchetto di minuti di conversazione al mese. I minuti oltre il pacchetto si pagano a consumo, fino a un tetto di spesa scelto dal ristoratore. Questo documento raccoglie le decisioni, quello che è già in produzione (Fasi 1–2) e il piano delle Fasi 3–4, da riprendere più avanti.

## Decisioni (23/09/2026)

| Voce | Valore |
|---|---|
| Canone add-on voce | **49 €/mese** |
| Minuti inclusi | **250 al mese** |
| Minuto extra | **0,20 €** |
| Tetto extra (default) | **50 €/mese**, lo sceglie il ristoratore; 0 = nessun extra |
| Chiamate non conteggiate | sotto i **10 secondi** (riagganci, chiamate per errore) |
| Arrotondamento | per eccesso sul **totale del mese**, non chiamata per chiamata |
| Unità per il cliente | **minuti** (i minuti nel contratto, le prenotazioni prese da Sofia mostrate accanto) |
| Tetto raggiunto | Sofia **non resta muta**: risponde e rimanda al ristorante (Fase 4) |

I valori di listino stanno in `services/voicePlan.ts`. Un ristorante con un accordo diverso ha una riga in `voice_plans`, dove una colonna NULL vale il listino.

### Da dove vengono i numeri

- **Costo ElevenLabs**: ≈ 0,10 $/min (≈ 0,09 €) dopo il fix della cache LLM del 23/09. Prima era ≈ 0,19–0,24 €/min. Fonte: `voice_calls.cost_usd`, preso da `metadata.charging` di ElevenLabs.
- **Twilio** (numero e minuti in ingresso) **non è compreso** e va aggiunto al costo per minuto quando lo si conosce.
- **Consumi reali del Vecchio Frantoio**:

  | Mese | Minuti | Costo registrato |
  |---|---|---|
  | Luglio 2026 | 552 | 74 € |
  | Agosto 2026 | 1.010 | 193 € |
  | Settembre 2026 (al 23) | 236 | 56 € |

  Settembre è ≈ 300 minuti a fine mese. I costi di luglio e agosto sono quelli pre-fix: con il costo attuale agosto sarebbe ≈ 91 €.
- **Margine**: 250 minuti costano ≈ 23 €, quindi sui 49 € restano ≈ 26 € (54%). Un minuto extra costa ≈ 0,09 € e si vende a 0,20 € (≈ 55%). Il piano regge **solo** con il costo post-fix: va ricontrollato se ElevenLabs cambia prezzi o se si cambia LLM.

## Fase 1 — misurare ✅ (PR #712, in produzione dal 23/09)

- `voice_calls` salva, per ogni chiamata, `cost_credits`, `cost_usd`, `llm_cost_usd` e `platform_cost_usd`. Li scrivono il webhook post-call e `/voice-calls/sync`.
- Corretto un bug: la durata arriva in `metadata.call_duration_secs`, ma il post-call leggeva `call_duration_seconds`. Ad agosto la durata era salvata per 36 chiamate su 1.542.
- Storico recuperato con `scripts/backfill-voice-call-costs.mjs`: 2.343 chiamate, 1.891 minuti, 352 $.
- Consumi AI (sezione Sofia) e pannello Piattaforma mostrano minuti del mese, costo, ricavo stimato e margine.

## Fase 2 — piano per ristorante, card e avvisi ✅ (PR #716, in produzione dal 23/09)

- Tabella `voice_plans`, con eccezioni al listino e tetto extra, e tabella `voice_usage_alerts` per la dedup degli avvisi.
- Servizio `services/voiceUsage.ts`:
  - `getVoicePlan`, `mergeVoicePlan` per il piano effettivo;
  - `getVoiceMonthUsage`, che lavora sul mese nel fuso del ristorante;
  - `claimNewVoiceUsageAlerts` per gli avvisi.
- API:
  - `GET /voice-usage` (permesso `settings:view`);
  - `PUT /voice-usage/cap` (permesso `settings:full`, da 0 a 1.000 €);
  - `PATCH /admin/tenants/:id/voice-plan`.
- Card **«Minuti di Sofia»** in Impostazioni → AI: minuti del mese / inclusi, stima a fine mese, chiamate, prenotazioni prese da Sofia, extra, minuti al giorno, tetto modificabile.
- **Avvisi** dopo ogni chiamata all'80% e al 100% dei minuti inclusi e all'80% e al 100% del tetto. Vanno in push a titolare e direzione, e in email ai titolari se il mittente di piattaforma è configurato. Ogni soglia si manda una volta al mese; cambiando il tetto ripartono gli avvisi sul tetto.
- Pannello Piattaforma: piano del ristorante con editor inline, e consumi del mese calcolati sul suo piano.

In Fase 2 il tetto serve **solo** agli avvisi e al calcolo del ricavo stimato: non ferma niente e non si fattura niente.

---

## Fase 3 — fatturare gli extra su Stripe (da fare)

**Obiettivo:** a fine periodo Stripe fattura, insieme ai 49 €, i minuti oltre gli inclusi entro il tetto, senza calcoli a mano.

### Approccio proposto

1. **Contatore Stripe in centesimi, non in minuti.**
   - Si crea un Billing Meter `sofia_extra_cents`, collegato a un price metered da **0,01 € per unità**, con aggregazione `sum`.
   - Il server riporta i *centesimi di extra* già calcolati (minuti extra × prezzo del ristorante, tagliati al tetto).
   - Così prezzi su misura e tetto funzionano senza creare un price Stripe per ogni ristorante. Nella fattura compare come «Minuti extra Sofia».
2. **Item sulla subscription.** Quando l'add-on voce è attivo, la subscription ha sia `STRIPE_PRICE_VOICE` (49 €) sia il price metered: nuova env `STRIPE_PRICE_VOICE_EXTRA`. `updateSubscriptionAddons` in `services/billingService.ts` deve aggiungere e togliere i due item insieme. Il price metered **non** va nella mappa `priceToFeature`: non è una feature.
3. **Invio giornaliero, idempotente.**
   - Serve un job con lock di scheduler, come `SCHEDULER_LOCK_ELEVENLABS_QUOTA`, più una tabella `voice_usage_reports (tenant_id, period_start, reported_cents)`.
   - Per ogni ristorante con subscription: extra maturati nel periodo, meno quanto già riportato, uguale a un meter event con `identifier = tenant-periodo-giorno`. Stripe scarta i duplicati.
4. **Periodo di fatturazione.** Il ciclo della subscription Stripe può non coincidere col mese solare, mentre la Fase 2 ragiona a mese solare. Due strade:
   - (a) ancorare le subscription al 1° del mese (`billing_cycle_anchor`), più semplice e coerente con card e avvisi;
   - (b) calcolare i consumi sul `current_period` Stripe.

   **Proposta: (a).** Va deciso prima di scrivere codice.
5. **Chiusura del periodo:** un ultimo invio subito dopo la mezzanotte del 1°, prima che Stripe finalizzi la fattura. Stripe lascia circa un'ora di tempo di default: va verificato e, se serve, allungato con i giorni di grace degli invoice.
6. **Ristoranti senza billing** (grandfathered, come il Frantoio oggi): nessun invio, la card resta informativa.
7. **Visibilità:**
   - la card del ristoratore mostra «Extra di settembre: 12 € — in fattura con l'abbonamento»;
   - il pannello Piattaforma mostra riportato e maturato.

### Test
- Unità: calcolo degli extra con tetto e prezzo su misura, delta rispetto al già riportato.
- API: job con Stripe finto; il pattern esiste in `tests/api/billing.test.ts`. Idempotenza (due invii nello stesso giorno fanno un solo evento) e tenant senza subscription saltato.
- Prova end-to-end in Stripe test mode con una subscription vera.

### Da decidere prima
- Ancoraggio al mese solare (proposta) oppure periodo Stripe.
- Nome della riga in fattura e testo IVA. I prezzi del listino si intendono IVA esclusa?

---

## Fase 4 — stop al tetto (da fare)

**Obiettivo:** raggiunto il tetto degli extra (o esauriti gli inclusi con tetto 0), Sofia non prende altre prenotazioni ma **risponde sempre**. Ad agosto 2026, con la quota ElevenLabs esaurita, **175 chiamate sono cadute nel silenzio**: è lo scenario da non ripetere.

### Approccio proposto

1. **Nel webhook `init-conversation`** (`handleElevenLabsInitConversation` in `server.ts`):
   - si calcola lo stato con `getVoicePlan` e `getVoiceMonthUsage`;
   - se `extra lordi ≥ tetto`, oppure `tetto = 0` e `minuti ≥ inclusi`, la chiamata entra in **modalità sospensione**;
   - si riusa il meccanismo delle prenotazioni sospese (`computeVoiceSuspensionState`, `booking_status_message` e override del `first_message`), con un messaggio dedicato: «In questo momento non posso prendere prenotazioni al telefono. Chiami il ristorante al numero …», dove il numero è `public_phone` dall'identità del locale.
   - La query deve restare veloce, perché il webhook sta sul percorso della risposta: 3 query indicizzate su `(tenant_id, created_at)`, eventualmente con una piccola cache per tenant di 60 secondi.
2. **Costo delle chiamate in pausa:** pochi secondi ciascuna. Sotto i 10 secondi non si contano; sopra si contano ma non si fatturano oltre il tetto. Va bene così.
3. **Card del ristoratore:** stato «Sofia in pausa: tetto raggiunto» ben visibile, con il campo del tetto evidenziato. Alzando il tetto Sofia riparte dalla chiamata successiva, senza deploy né azioni manuali.
4. **Avvisi:** l'avviso `cap_100` esiste già. Il testo va aggiornato in «Sofia è in pausa: alza il tetto per riattivarla». Si può aggiungere una push anche alla piattaforma.
5. **Margine di sicurezza (da valutare):** fermarsi leggermente prima del tetto, per esempio a 1 minuto dal tetto, così la chiamata in corso non lo sfora. In alternativa si accetta un piccolo sforamento non fatturato.
6. **Più avanti (non in Fase 4):** trasferire la chiamata direttamente al numero del ristorante (tool `transfer_to_number` di ElevenLabs o instradamento Twilio), invece del messaggio. Va verificato con ElevenLabs e Twilio.

### Test
- API: `init-conversation` con consumi sopra il tetto, dove la risposta contiene il messaggio di pausa e `booking_status_message` valorizzato. Poi tetto alzato, e la chiamata successiva è normale.
- Tetto 0 con inclusi esauriti: pausa.
- Prova reale con una chiamata e un piano su misura con 1 minuto incluso e tetto 0, dal pannello Piattaforma.

### Da decidere prima
- Testo esatto del messaggio di pausa, e se dire il numero del ristorante o solo gli orari.
- Margine di sicurezza sì/no.

---

## Dove guardare nel codice

| Cosa | Dove |
|---|---|
| Listino e regole di conteggio | `services/voicePlan.ts` |
| Piano effettivo, consumi del mese, avvisi | `services/voiceUsage.ts` |
| Salvataggio costo e durata | `handleElevenLabsPostCall` e `/voice-calls/sync` in `server.ts`; `recordVoiceCall` / `extractVoiceCallCost` in `services/elevenlabsService.ts` |
| Endpoint | `/voice-usage`, `/voice-usage/cap`, `/admin/tenants/:id/voice-plan`, `/ai-usage/elevenlabs` |
| Card del ristoratore | `components/VoiceUsageCard.tsx` (Impostazioni → AI) |
| Vista piattaforma | `components/PlatformPanel.tsx`, `components/MonitoringPage.tsx` |
| Stripe | `services/billingService.ts` (`updateSubscriptionAddons`, `priceToFeature`) |
| Test | `tests/api/voce-costo-chiamate.test.ts`, `tests/api/voce-piano-minuti.test.ts` |
