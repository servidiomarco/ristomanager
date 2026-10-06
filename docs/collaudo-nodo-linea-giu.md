# Collaudo a linea staccata: sala, comande e conto sul nodo

*Ottobre 2026. La prova da fare al Frantoio, a locale chiuso, prima di una
serata con «Servizio completo sul nodo» acceso. È il collaudo previsto dal
piano «sala, comande e conto sul nodo» (tappe A, B e C, PR #832–#844). I
dettagli tecnici del nodo sono in [sala-node/README.md](../sala-node/README.md).
La serata pilota delle comande resta descritta in
[serata-pilota-comande](serata-pilota-comande.md).*

## Prima del collaudo (una volta sola)

- [ ] PR #832–#844 unite e in produzione, cloud e app.
- [ ] I tre passi della firma ES256 su Railway, nell'ordine del README del
      nodo (sezione «Firma ES256»). **L'interruttore resta spento finché il
      passo 1 non è in produzione.**
- [ ] Il PC di sala con il pacchetto nuovo. Lo zip è fra gli artefatti della
      run di CI su main («Pacchetto del nodo di sala»): si appoggia in
      `inbox\` e il supervisore lo installa nella finestra 04:00–10:00, o
      subito a mano.
- [ ] Agente di stampa e agente Passepartout aggiornati insieme al nodo.
      Con i vecchi `.cmd`: `NODE_URL` per la stampa, `PP_AGENT_NODE_URL`
      per Passepartout e `PASSEPARTOUT_AGENT_TOKEN` per il nodo.
- [ ] Nella card «Nodo di sala»: online, versione uguale a quella del cloud
      (non gialla), «Sincronizzazione» con ritardi di pochi secondi.
- [ ] Impostazioni fiscali: provider **rt-local** (registratore collegato al
      CRM) oppure nessuno. Con Openapi l'interruttore non si accende.
- [ ] Ognuno ha il suo **PIN di sala** (Il tuo account → PIN di sala).
- [ ] UPS su PC, switch e registratore; PC mai in sospensione; Windows
      Update fuori dagli orari di servizio.
- [ ] Almeno due palmari e il PC della cassa, sulla Wi-Fi di sala.

## Collaudo A — comande, cucina, accoglienza (circa 1 ora)

1. **Accendi** «Servizio completo sul nodo» dalla card. Si accende solo a
   repliche allineate e senza pagamenti col QR in corso.
2. **Stacca la WAN** dal router: il cavo verso il modem, non la Wi-Fi.
3. Entro mezzo minuto la pastiglia Live dice **«dalle HH:MM»**, e la card
   (che legge dal nodo) dice che il nodo lavora in isola.
4. **Ricarica** un palmare: la sala si apre con pianta, tavoli e
   prenotazioni di oggi.
5. Da un dispositivo **mai collegato**: pagina di accesso → «Entra col PIN di
   sala» → nome e PIN. Si entra solo in sala, comande, cucina, conti e
   cassa.
6. **Comanda**: tavolo → piatti → Invia. Escono le stampe di partita; monitor
   di cucina e passe la mostrano; lancio, chiamata e servito funzionano.
7. **Accoglienza**: segna arrivata una prenotazione, assegnale un tavolo,
   scambia due tavoli, registra un **walk-in** e fallo sedere.
8. **Un palmare fuori dalla Wi-Fi** (sul 4G): un'azione di sala risponde
   «Nodo di sala non raggiungibile da qui: niente registrato». Lo stato del
   tavolo resta in coda e parte da solo al ritorno sulla Wi-Fi; la comanda
   no, si ripete l'Invia.
9. **Riattacca la WAN.** In un minuto la card torna a 0 battiture da
   inviare, e da un telefono sul 4G il CRM mostra le stesse comande, gli
   stessi arrivi e lo stesso walk-in.

## Collaudo B — conto e scontrino (circa 1 ora)

Con la WAN ancora staccata (passo 2 del collaudo A):

1. **Preconto** dalla termica, senza il QR di pagamento.
2. **Incassi**: un conto in contanti e uno con la carta (POS fisico),
   chiusura → **scontrino dall'RT** con il numero letto nella card.
3. **QR**: un telefono sul 4G che inquadra il QR di un conto legge «paga in
   cassa».
4. Se si usa Passepartout: un conto **importato dalla comanda di cassa** e
   chiuso dal CRM → il tavolo si chiude in cassa. Se la cassa non risponde,
   la card resta «In emissione» e riparte da sola.
5. **Sessione di cassa**: apertura e chiusura col fondo.
6. **Riattacca la WAN** e controlla:
   - stessi conti, pagamenti e documenti fiscali nel cloud e sul nodo
     (query sotto);
   - nessun doppio scontrino: un solo documento vivo per conto, uno solo
     job RT per documento.

## Il riscontro (10 minuti)

Le stesse query sul Postgres del nodo (dal PC) e sul cloud (Railway CLI, in
lettura); `<data>` è la data del collaudo:

```sql
SELECT COUNT(*) AS comande FROM orders WHERE service_date = '<data>';
SELECT status, COUNT(*) FROM table_bills WHERE service_date = '<data>' GROUP BY 1 ORDER BY 1;
SELECT COUNT(*) AS incassi, SUM(amount_cents) AS centesimi
  FROM table_bill_payments p JOIN table_bills b ON b.id = p.table_bill_id
 WHERE b.service_date = '<data>' AND p.voided_at IS NULL;
SELECT provider, status, COUNT(*) FROM fiscal_documents
 WHERE created_at >= '<data>' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT arrival_status, COUNT(*) FROM reservations
 WHERE reservation_time >= '<data>' AND reservation_time < '<data>'::date + 1 GROUP BY 1;
```

I numeri devono coincidere. Gli id nati sul nodo partono da 1.000.000.000:
vederli anche nel cloud è la prova che sono risaliti.

## Fine collaudo

- **Spegni** «Servizio completo sul nodo». Lo spegnimento aspetta che il
  cloud abbia importato ogni battitura del nodo.
- Se il PC del nodo è morto e l'interruttore non si spegne, c'è l'uscita
  d'emergenza (README, «Il conto sul nodo»). Si perdono le battiture non
  ancora salite: la copia fiscale resta nella memoria dell'RT.

## Se qualcosa si rompe

- **Pianta vuota al ricaricamento**: il palmare non vede il nodo. Controlla
  la Wi-Fi di sala e che il dominio del nodo risolva (niente DNS privato o
  DoH sul dispositivo).
- **«Accesso scaduto senza linea»**: la proroga di 12 ore è finita, oppure
  l'utente è stato disattivato. Si entra col PIN di sala.
- **Le stampe non escono**: l'agente di stampa deve avere `NODE_URL`; il
  token legacy il nodo lo ricorda anche dopo un riavvio a linea giù.
- **Passepartout «In emissione» a lungo**: l'agente deve essere quello
  nuovo (annuncia `chiudi-riprendi`), altrimenti dopo un errore la chiusura
  va fatta a mano con «Chiudi in cassa».
- **In ogni caso**: interruttore spento, si torna al servizio di sempre.
