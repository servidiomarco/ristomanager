@echo off
REM ============================================================
REM  AVVIO DI EMERGENZA dell'agente di stampa del Vecchio Frantoio
REM ============================================================
REM  Un SOLO agente gestisce SIA le stampanti termiche di sala
REM  (antipasti, bar, preconti, QR) SIA il registratore fiscale
REM  Epson FP-81II. Normalmente parte da solo col task di Windows
REM  "RistoManager Print Agent" (Utilita' di pianificazione).
REM
REM  Questo file serve SOLO in emergenza, se il task non parte:
REM  doppio click e l'agente riparte in loop (si riavvia da solo
REM  se cade). NON aprirne DUE insieme, e non lasciarlo aperto se
REM  il task e' gia' attivo: due agenti = confusione.
REM
REM  PRIMA DEL PRIMO USO: incolla il token qui sotto al posto di
REM  INSERISCI_IL_TOKEN. Lo trovi nel file gia' funzionante
REM  C:\ristomanager-agents\run-print-agent.cmd (riga
REM  set PRINT_AGENT_TOKEN=...), oppure su Railway.
REM ============================================================

cd /d C:\ristomanager-agents\app

set API_URL=https://prenotazioni.vecchiofrantoio.com
set PRINT_AGENT_TOKEN=INSERISCI_IL_TOKEN

REM --- Registratore fiscale Epson FP-81II ---
REM  IP del registratore sulla rete di sala.
set RT_FISCAL_HOST=192.168.1.201
REM  Mappa aliquota=reparto DELL'RT (confermata 05/09/2026:
REM  reparto 1 = 22%%, reparto 2 = 10%%). Se il tecnico cambia i
REM  reparti sull'RT, aggiorna questa riga o l'IVA stampata sara'
REM  sbagliata.
set RT_FISCAL_REPARTI=22=1,10=2

if "%PRINT_AGENT_TOKEN%"=="INSERISCI_IL_TOKEN" (
  echo.
  echo  ATTENZIONE: manca il token. Apri questo file col Blocco note
  echo  e incolla il valore al posto di INSERISCI_IL_TOKEN, poi riprova.
  echo.
  pause
  exit /b 1
)

:loop
node scripts\print-agent.mjs >> C:\ristomanager-agents\print-agent.log 2>&1
timeout /t 10 /nobreak >nul
goto loop
