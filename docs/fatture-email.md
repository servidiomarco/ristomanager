# Fatture fornitori via email: la configurazione

Ogni locale ha un indirizzo suo, per esempio
`vecchiofrantoio-7k2p9q4m1x0a@fatture.sympotia.com`. Si legge in
Inventario → ⋮ → Fatture fornitori, nel riquadro «Ricevi per email». Le email
inoltrate lì con l'XML, il p7m o lo zip delle fatture entrano da sole fra le
fatture da controllare. Il codice è in `services/fattureEmail.ts`.

L'indirizzo compare solo quando la piattaforma riceve email. Va configurata una
volta sola, per tutti i locali.

## 1. Il dominio di ricezione su Resend

Si usa un sottodominio (`fatture.sympotia.com`) perché le caselle di
`sympotia.com` restano dove sono. Resend riceve solo se il suo MX è quello con
la priorità più bassa del dominio, e su un sottodominio nuovo non ci sono
altri record.

1. Su Resend, nell'account di Sympotia: **Domains → Add domain** → `fatture.sympotia.com`.
2. Copia nel DNS di `sympotia.com` i record che Resend mostra, con i valori
   presi da Resend e non da questa pagina:
   - quelli di verifica del dominio (TXT DKIM e quelli che chiede);
   - nella sezione **Receiving**, il record **MX** sul nome `fatture`, con
     priorità 10. Il valore è del tipo `receive…rmta.net` o
     `inbound-smtp.<regione>.amazonaws.com`.
3. Premi **«I've added the record»** e aspetta che il record di ricezione
   risulti *verified*.

## 2. Il webhook

1. Su Resend: **Webhooks → Add Webhook**.
2. URL: `https://ristomanager-production.up.railway.app/webhook/fatture-email`.
3. Evento: **`email.received`**.
4. Copia il **signing secret**, che comincia con `whsec_`.

## 3. La chiave API

Su Resend: **API Keys → Create API Key** con accesso completo. Serve a
scaricare gli allegati delle email ricevute: una chiave «solo invio» non
basta.

## 4. Le variabili su Railway

Servizio `ristomanager`, ambiente production:

| Variabile | Valore |
|---|---|
| `FATTURE_EMAIL_DOMAIN` | `fatture.sympotia.com` |
| `RESEND_FATTURE_API_KEY` | la chiave del passo 3 (`re_…`) |
| `RESEND_FATTURE_WEBHOOK_SECRET` | il segreto del passo 2 (`whsec_…`) |

Railway rifà il deploy da solo. Senza una delle tre l'indirizzo non compare e
il webhook risponde 503.

## 5. La prova

1. Apri Fatture fornitori: in alto c'è «Ricevi per email» con l'indirizzo.
2. Da una casella qualsiasi manda all'indirizzo un'email con l'XML di una
   fattura in allegato.
3. Entro qualche secondo la fattura è fra quelle da controllare, con l'icona
   della busta. In «Ultime email» c'è l'esito di ogni allegato, e chi vede le
   fatture riceve la notifica.

Se non arriva:
- la riga in «Ultime email» non c'è → il webhook non è partito: controlla su
  Resend il log del webhook (consegne e risposte);
- la riga c'è con un motivo («È un PDF, serve l'XML», «Metadati dello SDI») →
  l'email è arrivata, ma l'allegato non è una fattura.

## 6. Chi inoltra

- **Il commercialista**: dal suo programma imposta l'inoltro automatico delle
  fatture ricevute dal locale (la sua P.IVA) all'indirizzo. Va bene anche
  l'inoltro della casella: il nostro indirizzo si riconosce anche quando non
  è nel campo «A» (lo legge da `received_for` del webhook).
- **I fornitori**: possono mettere l'indirizzo in copia quando mandano la
  fattura di cortesia con l'XML.

Chi conosce l'indirizzo può mandare fatture «da controllare». Se finisce in
mano sbagliata, «Cambia indirizzo» ne crea uno nuovo e il vecchio smette
subito di funzionare.

## Il carico automatico

Nel dettaglio di una fattura, accanto a «Carica in magazzino», c'è «Le
prossime di questo fornitore caricale da sole». Se è spuntata, le prossime
fatture di quel fornitore (riconosciuto dalla P.IVA) arrivate per email si
caricano da sole, nelle celle usate questa volta, ma solo se tutte le righe
sono già note dalla memoria. Basta una riga nuova, o una cella che manca per
un'area, e la fattura aspetta la revisione: la notifica dice perché. Si
spegne dal dettaglio di una fattura caricata, con «Spegni».
