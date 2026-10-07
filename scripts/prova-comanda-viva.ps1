# Lancia prova-comanda-viva.mjs sul PC della cassa con le credenziali del web
# service prese dal .cmd dell'agente Passepartout, solo in questo processo e
# senza stamparle. Il pacchetto (per il parser XML) è quello su cui punta il
# `cd /d` dell'agente. Stato e log restano nella cartella dello script.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File prova-comanda-viva.ps1 crea COD1 COD2
#
# Va usato a LOCALE CHIUSO: scrive comande in cassa e `invia` stampa in cucina.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cmd = if ($env:PP_AGENTE_CMD) { $env:PP_AGENTE_CMD } else { 'C:\ristomanager-agents\run-passepartout-agent.cmd' }

foreach ($riga in Get-Content $cmd) {
    if ($riga -match '^\s*set\s+"?(PASSEPARTOUT_[A-Z_]+)=(.*?)"?\s*$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
    if ($riga -match '^\s*cd\s+/d\s+(.+?)\s*$' -and -not $env:PP_PACCHETTO) {
        $env:PP_PACCHETTO = $Matches[1].Trim('"')
    }
}
if (-not $env:PASSEPARTOUT_WS_URL) { throw "PASSEPARTOUT_WS_URL non trovato in $cmd" }

Set-Location $PSScriptRoot
& node (Join-Path $PSScriptRoot 'prova-comanda-viva.mjs') @args
exit $LASTEXITCODE
