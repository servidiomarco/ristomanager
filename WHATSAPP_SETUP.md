# WhatsApp Integration Setup Guide

This guide will help you set up and test the WhatsApp booking integration using Vonage API.

## Prerequisites

- Vonage API account with WhatsApp enabled
- API Key and API Secret from Vonage
- WhatsApp Business number (or sandbox number for testing)

## 1. Environment Configuration

Add these variables to your `.env` file:

```bash
VONAGE_API_KEY=your_api_key_here
VONAGE_API_SECRET=your_api_secret_here
VONAGE_WHATSAPP_NUMBER=your_whatsapp_number
```

## 2. Local Testing Setup

### Option A: Using ngrok (Recommended for local testing)

1. **Install ngrok** (if not already installed):
```bash
npm install -g ngrok
```

2. **Start your development server**:
```bash
npm run dev
```

3. **In another terminal, start ngrok**:
```bash
ngrok http 3000
```

4. **Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

5. **Configure Vonage Webhook**:
   - Go to Vonage Dashboard → Messages & Dispatch
   - Set **Inbound Messages URL**: `https://abc123.ngrok.io/webhook/vonage-inbound`
   - Set **Status URL**: `https://abc123.ngrok.io/webhook/vonage-status`

### Option B: Deploy to Railway (Production testing)

1. **Push to Railway**:
```bash
git push origin whatsapp
```

2. **Configure webhook in Vonage**:
   - Inbound: `https://your-railway-url.up.railway.app/webhook/vonage-inbound`
   - Status: `https://your-railway-url.up.railway.app/webhook/vonage-status`

## 3. Testing the Integration

### Test Message Formats

**Format 1: Structured** (Easiest to parse)
```
15/12 20:00 4 Marco Rossi
```

**Format 2: Natural Language**
```
Vorrei prenotare per 4 persone il 15/12 alle 20:00, nome Marco Rossi
```

**Format 3: With year**
```
15/12/2025 20:00 4 Marco Rossi
```

### Expected Flow

1. **Customer sends WhatsApp message**:
   ```
   15/12 20:00 4 Marco Rossi
   ```

2. **Server receives webhook** → Logs:
   ```
   [Vonage] Incoming message: {...}
   [WhatsApp] Processing booking from 393331234567: 15/12 20:00 4 Marco Rossi
   ```

3. **Server creates reservation** → Logs:
   ```
   [WhatsApp] ✅ Reservation created successfully for Marco Rossi
   [Vonage] ✅ Message sent to 393331234567
   ```

4. **Customer receives confirmation**:
   ```
   ✅ Prenotazione Confermata!

   📅 Data: 15/12/2025
   🕐 Ora: 20:00
   👥 Ospiti: 4
   👤 Nome: Marco Rossi
   🍽️ Turno: Cena

   Grazie Marco! Ti aspettiamo! 🎉
   ```

5. **Reservation appears in web app** (via Socket.IO broadcast)

## 4. Monitoring & Debugging

### View Server Logs

**Local:**
```bash
npm run dev
```
Watch for:
- `[Vonage] Incoming message`
- `[WhatsApp] Processing booking`
- `[Vonage] ✅ Message sent`

**Railway:**
```bash
railway logs
```

### Test Webhook Manually (Development)

```bash
curl -X POST http://localhost:3000/webhook/vonage-inbound \
  -H "Content-Type: application/json" \
  -d '{
    "from": "393331234567",
    "to": "your_whatsapp_number",
    "message": {
      "content": {
        "type": "text",
        "text": "15/12 20:00 4 Marco Rossi"
      }
    }
  }'
```

## 5. Error Handling

### Missing Information
If customer sends incomplete message:
```
Customer: "Prenotazione per 4 persone"
Bot: "⚠️ Mancano alcune informazioni: data, ora, nome
      Per favore invia: DATA ORA OSPITI NOME
      Esempio: 15/12 20:00 4 Marco Rossi"
```

### Invalid Format
```
Customer: "Hello"
Bot: "❌ Non ho capito il messaggio. Per favore usa questo formato:
      DATA ORA OSPITI NOME
      Esempio: 15/12 20:00 4 Marco Rossi"
```

### Database Error
```
Bot: "❌ Si è verificato un errore durante la creazione della prenotazione.
      Per favore riprova o contattaci telefonicamente."
```

## 6. API Endpoints

### POST /webhook/vonage-inbound
- **Purpose**: Receives WhatsApp messages from Vonage
- **Method**: POST
- **Body**: Vonage webhook payload
- **Response**: 200 OK (always, to avoid retries)

### POST /webhook/vonage-status
- **Purpose**: Receives message delivery status updates
- **Method**: POST
- **Body**: Vonage status payload
- **Response**: 200 OK

## 7. Message Parsing Patterns

The system supports:

**Structured Format:**
```regex
(\d{1,2}/\d{1,2}(?:/\d{4})?)\s+(\d{1,2}:\d{2})\s+(\d+)\s+(.+)
```
Example: `15/12 20:00 4 Marco Rossi`

**Natural Language Extraction:**
- **Date**: `\d{1,2}/\d{1,2}(?:/\d{4})?`
- **Time**: `\d{1,2}:\d{2}`
- **Guests**: `\d+\s*(?:persone?|ospiti?|pax)`
- **Name**: `(?:nome[:\s]+|per\s+)([A-Za-zÀ-ÿ\s]+?)`

## 8. Troubleshooting

### Webhook not receiving messages

1. **Check ngrok is running** (for local testing)
2. **Verify webhook URL in Vonage dashboard**
3. **Check server logs** for incoming requests
4. **Test with curl** (see section 4)

### Messages not sending

1. **Verify environment variables** are set:
   ```bash
   echo $VONAGE_API_KEY
   echo $VONAGE_API_SECRET
   echo $VONAGE_WHATSAPP_NUMBER
   ```
2. **Check Vonage API credentials** are correct
3. **Review server logs** for Vonage errors

### Reservation not appearing in web app

1. **Check Socket.IO is initialized**:
   ```
   ✅ Socket.IO initialized
   ```
2. **Verify frontend is connected** to Socket.IO
3. **Check browser console** for Socket.IO events

## 9. Production Deployment Checklist

- [ ] Add Vonage credentials to Railway environment variables
- [ ] Update webhook URLs in Vonage dashboard to Railway URL
- [ ] Test with real WhatsApp number
- [ ] Monitor logs for errors
- [ ] Test full flow: WhatsApp → Database → Web App
- [ ] Verify Socket.IO broadcasts work
- [ ] Test error scenarios (missing info, invalid format)

## 10. Next Steps (Future Enhancements)

- [ ] Add table auto-assignment logic
- [ ] Handle conversation state (multi-message bookings)
- [ ] Send 24h reminder messages
- [ ] Allow modifications via WhatsApp
- [ ] Add "Domani/Oggi" date parsing
- [ ] Support voice messages (transcription)
- [ ] Add rich messages with buttons
- [ ] Multi-language support

## Support

For Vonage API documentation: https://developer.vonage.com/
For issues: Check server logs and Vonage dashboard for error details
