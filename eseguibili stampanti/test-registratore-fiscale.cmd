@echo off
REM ============================================================
REM  TEST del registratore fiscale Epson FP-81II (SOLA LETTURA)
REM ============================================================
REM  Chiede lo stato al registratore SENZA emettere nulla: serve
REM  a capire se e' acceso, in rete e in salute quando qualcosa
REM  non torna. NON stampa scontrini.
REM
REM  Cosa guardare nella risposta:
REM   - success="true"        -> il registratore risponde, OK
REM   - <rtMainStatus>02</...> -> in servizio
REM   - <rtDailyOpen>1</...>   -> giornata fiscale aperta
REM   - <rtFileRejected>0000</> -> nessuna trasmissione scartata
REM  Se non risponde: registratore spento, cavo di rete, o IP
REM  cambiato (verifica sul display del registratore).
REM ============================================================

set RT_HOST=192.168.1.201

echo.
echo  Interrogo il registratore su %RT_HOST% ...
echo.

curl -s -m 8 -X POST "http://%RT_HOST%/cgi-bin/fpmate.cgi?devid=local_printer&timeout=6000" -H "Content-Type: text/xml; charset=utf-8" -d "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><printerCommand><queryPrinterStatus operator=\"1\" statusType=\"1\" /></printerCommand></s:Body></s:Envelope>"

echo.
echo.
echo  Se sopra NON vedi nulla o un errore, il registratore non
echo  risponde: controlla che sia acceso e collegato alla rete.
echo.
pause
