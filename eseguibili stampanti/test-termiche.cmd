@echo off
REM ============================================================
REM  TEST delle stampanti termiche di sala (SOLA CONNETTIVITA')
REM ============================================================
REM  Verifica che ogni termica risponda sulla porta di stampa
REM  (9100). NON stampa nulla: dice solo se la stampante e'
REM  accesa e raggiungibile in rete. Utile quando un preconto o
REM  una comanda non esce.
REM
REM  Se una riga dice "NON raggiungibile": quella stampante e'
REM  spenta, senza carta bloccata sulla rete, o con IP cambiato.
REM ============================================================

echo.
echo  Controllo le termiche di sala...
echo.

call :check preconti 192.168.1.50
call :check antipasti 192.168.1.30
call :check bar 192.168.1.200
call :check qr 192.168.1.200

echo.
pause
exit /b 0

:check
powershell -NoProfile -Command "$r = Test-NetConnection -ComputerName '%2' -Port 9100 -WarningAction SilentlyContinue; if ($r.TcpTestSucceeded) { Write-Host '  OK           %1 (%2)' -ForegroundColor Green } else { Write-Host '  NON raggiungibile   %1 (%2)' -ForegroundColor Red }"
exit /b 0
