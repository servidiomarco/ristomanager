# Sympotia - installatore dell'agente della cassa Passepartout (Windows).
#
# Da PowerShell aperto come AMMINISTRATORE sul PC della cassa, col codice
# generato in Impostazioni -> Passepartout -> «Collega il PC della cassa»:
#
#   $env:SYMPOTIA_CODICE='XXXX-XXXX'; irm __SYMPOTIA_SERVER__/installa/cassa.ps1 | iex
#
# Cosa fa: controlla il PC, trova la cassa in rete e ne verifica utente e
# password, abbina il PC col codice, scarica Node (portatile), WinSW e
# l'agente della cassa (tutti con sha256 verificato), scrive la
# configurazione leggibile solo da amministratori e SYSTEM, e installa il
# servizio «sympotia-cassa» (supervisore in modo agente: si riavvia da solo e
# si aggiorna di notte dal cloud). Le credenziali della cassa restano sul PC.
#
# Disinstallare:
#   $env:SYMPOTIA_AZIONE='disinstalla'; irm __SYMPOTIA_SERVER__/installa/cassa.ps1 | iex
#
# Variabili facoltative: SYMPOTIA_CARTELLA (default C:\Sympotia\Cassa),
# SYMPOTIA_CASSA_URL (indirizzo del Web Service, se non lo trova da solo),
# SYMPOTIA_NODO_URL (nodo di sala, per chi ce l'ha), SYMPOTIA_SERVER.
#
# Compatibile con Windows PowerShell 5.1 (Windows 10/11, Server 2016+).

function Installa-SympotiaCassa {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $Server = '__SYMPOTIA_SERVER__'
    if ($env:SYMPOTIA_SERVER) { $Server = $env:SYMPOTIA_SERVER }
    $Server = $Server.TrimEnd('/')
    $Cartella = 'C:\Sympotia\Cassa'
    if ($env:SYMPOTIA_CARTELLA) { $Cartella = $env:SYMPOTIA_CARTELLA }
    $Servizio = 'sympotia-cassa'

    # Versioni fissate, con lo sha256 pubblicato (Node: SHASUMS256.txt).
    $NodeVersione = '22.23.3'
    $NodeUrl = "https://nodejs.org/dist/v$NodeVersione/node-v$NodeVersione-win-x64.zip"
    $NodeSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
    $WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
    $WinSWSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

    function Passo([string]$testo) { Write-Host ''; Write-Host "==> $testo" -ForegroundColor Cyan }
    function Ok([string]$testo) { Write-Host "    $testo" -ForegroundColor Green }
    function Nota([string]$testo) { Write-Host "    $testo" }

    function Scarica([string]$url, [string]$dest, [string]$sha256, [hashtable]$intestazioni) {
        if ($intestazioni) { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers $intestazioni }
        else { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
        $hash = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $sha256.ToLowerInvariant()) {
            Remove-Item -Force $dest
            throw "Il file scaricato da $url non è quello atteso (sha256 diverso): installazione interrotta."
        }
    }

    function Scrivi-Utf8([string]$file, [string]$testo) {
        # Senza BOM: Node non legge un JSON che comincia col BOM.
        [System.IO.File]::WriteAllText($file, $testo, (New-Object System.Text.UTF8Encoding $false))
    }

    function Solo-Amministratori([string]$file) {
        # SID e non nomi: i gruppi hanno nomi diversi a seconda della lingua di Windows.
        & icacls.exe $file /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Non riesco a restringere i permessi di $file" }
    }

    function Leggi-Configurazione() {
        $file = Join-Path $Cartella 'nodo.json'
        if (-not (Test-Path $file)) { return $null }
        return (Get-Content -Raw -Path $file | ConvertFrom-Json)
    }

    # ------------------------------------------------------------------
    if ($env:SYMPOTIA_AZIONE -eq 'disinstalla') {
        Passo 'Disinstallo il servizio della cassa'
        $exe = Join-Path $Cartella "$Servizio.exe"
        if (Get-Service -Name $Servizio -ErrorAction SilentlyContinue) {
            & $exe stop | Out-Null
            & $exe uninstall | Out-Null
            Ok 'Servizio fermato e rimosso.'
        } else { Nota 'Il servizio non c''era.' }
        $cfg = Leggi-Configurazione
        if ($cfg -and $cfg.passepartout_agent.env.PP_AGENT_TOKEN) {
            try {
                Invoke-RestMethod -Method Post -Uri "$Server/pp-agent/scollega" -Headers @{ Authorization = "Bearer $($cfg.passepartout_agent.env.PP_AGENT_TOKEN)" } | Out-Null
                Ok 'PC scollegato dal ristorante: il suo codice non vale più.'
            } catch { Nota "Non sono riuscito a scollegarlo dal cloud ($($_.Exception.Message)): fallo dalla sezione Passepartout con «Scollega»." }
        }
        Nota "La cartella $Cartella (log e configurazione) è rimasta: cancellala a mano se non serve più."
        return
    }

    # ------------------------------------------------------------------
    Passo 'Controllo il PC'
    $identita = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $identita.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Serve PowerShell aperto come amministratore (tasto destro -> «Esegui come amministratore»).'
    }
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Serve Windows 10/11 o Windows Server 2016 o più recente.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Serve Windows a 64 bit.' }
    $disco = Get-PSDrive -Name $Cartella.Substring(0, 1)
    if ($disco.Free -lt 500MB) { throw "Spazio insufficiente sul disco $($disco.Name): servono almeno 500 MB liberi." }
    if (Get-Service -Name $Servizio -ErrorAction SilentlyContinue) {
        throw "Il servizio $Servizio è già installato. Per reinstallarlo prima disinstallalo (SYMPOTIA_AZIONE='disinstalla')."
    }
    Ok "Windows $([Environment]::OSVersion.Version), amministratore, spazio ok."

    $codice = $env:SYMPOTIA_CODICE
    if (-not $codice) { $codice = Read-Host 'Codice dalla sezione Passepartout (XXXX-XXXX)' }
    $codice = ($codice -replace '[^A-Za-z0-9]', '').ToUpperInvariant()
    if ($codice.Length -ne 8) { throw 'Il codice ha 8 caratteri (es. KX7P-4M2Q): generane uno in Impostazioni -> Passepartout.' }

    # ------------------------------------------------------------------
    Passo 'Cerco la cassa Passepartout in rete'
    $cassaUrl = $env:SYMPOTIA_CASSA_URL
    if (-not $cassaUrl) {
        $candidati = @('localhost')
        try {
            $candidati += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                ForEach-Object { $_.IPAddress }
        } catch { }
        foreach ($h in $candidati) {
            try {
                $r = Invoke-WebRequest -Uri "http://${h}:7606/?wsdl" -UseBasicParsing -TimeoutSec 4
                if ($r.Content -match 'wsdl') { $cassaUrl = "http://${h}:7606/AdapterWS"; break }
            } catch { }
        }
        if ($cassaUrl) {
            $risposta = Read-Host "Trovata la cassa su $cassaUrl. Invio per confermare, o scrivi un altro indirizzo"
            if ($risposta) { $cassaUrl = $risposta.Trim() }
        } else {
            Nota 'Non la trovo da solo su questo PC (porta 7606).'
            $cassaUrl = (Read-Host 'Indirizzo del Web Service della cassa (es. http://192.168.1.10:7606/AdapterWS)').Trim()
        }
    }
    if (-not $cassaUrl) { throw 'Serve l''indirizzo del Web Service della cassa: chiedilo al rivenditore.' }
    $cassaUrl = $cassaUrl.TrimEnd('/')

    # Utente e password del Web Service: si provano subito, prima di
    # abbinare il PC, con la stessa chiamata che fa l'agente all'avvio.
    $versione = $null
    for ($tentativo = 1; $tentativo -le 3 -and -not $versione; $tentativo++) {
        $utente = Read-Host 'Utente del Web Service della cassa'
        $sicura = Read-Host 'Password del Web Service della cassa' -AsSecureString
        $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sicura))
        $u = [System.Security.SecurityElement]::Escape($utente)
        $p = [System.Security.SecurityElement]::Escape($password)
        $busta = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
            '<GetVersioneGestionale xmlns="http://tempuri.org/"><datiLogin xmlns:k="http://schemas.datacontract.org/2004/07/PMessageBox.Kernel">' +
            "<k:Password>$p</k:Password><k:Utente>$u</k:Utente></datiLogin></GetVersioneGestionale></s:Body></s:Envelope>"
        try {
            $r = Invoke-WebRequest -Uri $cassaUrl -Method Post -UseBasicParsing -TimeoutSec 20 -Body ([Text.Encoding]::UTF8.GetBytes($busta)) `
                -ContentType 'text/xml; charset=utf-8' -Headers @{ SOAPAction = '"http://tempuri.org/IAdapterWS/GetVersioneGestionale"' }
            $xml = [xml]$r.Content
            $fault = $xml.GetElementsByTagName('faultstring')
            if ($fault.Count -gt 0) { throw $fault[0].InnerText }
            $risultato = $xml.GetElementsByTagName('GetVersioneGestionaleResult')
            if ($risultato.Count -eq 0) { throw 'risposta inattesa' }
            $versione = $risultato[0].InnerText
            if (-not $versione) { $versione = '?' }
        } catch {
            $messaggio = $_.Exception.Message
            if ($_.Exception.Response) {
                try {
                    $lettore = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
                    $corpo = [xml]$lettore.ReadToEnd()
                    $f = $corpo.GetElementsByTagName('faultstring')
                    if ($f.Count -gt 0) { $messaggio = $f[0].InnerText }
                } catch { }
            }
            Write-Host "    La cassa non accetta l'accesso: $messaggio" -ForegroundColor Yellow
        }
    }
    if (-not $versione) { throw 'Utente o password della cassa non validi (o Web Service spento): verificali col rivenditore e rilancia.' }
    Ok "Cassa raggiungibile: Passepartout $versione."

    # ------------------------------------------------------------------
    Passo 'Abbino il PC al ristorante'
    try {
        $abbina = Invoke-RestMethod -Method Post -Uri "$Server/pp-agent/abbina" -ContentType 'application/json' `
            -Body (@{ codice = $codice; hostname = $env:COMPUTERNAME; versione = 'installatore' } | ConvertTo-Json)
    } catch {
        throw "Abbinamento non riuscito: il codice è sbagliato, scaduto (vale 15 minuti) o già usato. Generane uno nuovo e rilancia. ($($_.Exception.Message))"
    }
    $token = $abbina.token
    $nomeRistorante = $abbina.ristorante
    if (-not $nomeRistorante) { $nomeRistorante = 'il ristorante' }
    Ok "PC abbinato a $nomeRistorante."
    $auth = @{ Authorization = "Bearer $token" }

    # ------------------------------------------------------------------
    Passo "Scarico Node $NodeVersione, WinSW e l'agente della cassa"
    New-Item -ItemType Directory -Force -Path $Cartella, (Join-Path $Cartella 'versions'), (Join-Path $Cartella 'scaricati') | Out-Null
    $scaricati = Join-Path $Cartella 'scaricati'

    $nodeZip = Join-Path $scaricati "node-v$NodeVersione-win-x64.zip"
    Scarica $NodeUrl $nodeZip $NodeSha256 $null
    $nodeDir = Join-Path $Cartella 'node'
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $scaricati -Force
    Move-Item -Path (Join-Path $scaricati "node-v$NodeVersione-win-x64") -Destination $nodeDir
    $node = Join-Path $nodeDir 'node.exe'
    Ok "Node $(& $node --version)"

    $winsw = Join-Path $Cartella "$Servizio.exe"
    Scarica $WinSWUrl $winsw $WinSWSha256 $null
    Ok 'WinSW 2.12.0'

    $rilascio = Invoke-WebRequest -Uri "$Server/pp-agent/aggiornamento" -Headers $auth -UseBasicParsing
    if ($rilascio.StatusCode -eq 204) { throw 'Nel cloud non c''è ancora un pacchetto dell''agente per questo ristorante: avvisa Sympotia.' }
    $rel = $rilascio.Content | ConvertFrom-Json
    $agenteZip = Join-Path $scaricati "sympotia-agente-$($rel.sha).zip"
    Scarica "$Server$($rel.url)" $agenteZip $rel.sha256 $auth
    $versioneDir = Join-Path (Join-Path $Cartella 'versions') $rel.sha
    if (Test-Path $versioneDir) { Remove-Item -Recurse -Force $versioneDir }
    Expand-Archive -LiteralPath $agenteZip -DestinationPath $versioneDir -Force
    Copy-Item -Force (Join-Path $versioneDir 'supervisor.mjs') (Join-Path $Cartella 'supervisor.mjs')
    Scrivi-Utf8 (Join-Path $Cartella 'current.txt') $rel.sha
    Ok "Agente della cassa $($rel.sha) (canale $($rel.canale))"

    # ------------------------------------------------------------------
    Passo 'Scrivo la configurazione'
    $envAgente = [ordered]@{
        PP_AGENT_TOKEN = $token
        PASSEPARTOUT_WS_URL = $cassaUrl
        PASSEPARTOUT_WS_USER = $utente
        PASSEPARTOUT_WS_PASSWORD = $password
    }
    if ($env:SYMPOTIA_NODO_URL) { $envAgente.PP_AGENT_NODE_URL = $env:SYMPOTIA_NODO_URL }
    $config = [ordered]@{
        modo = 'agente'
        cloud_url = $Server
        update_window = [ordered]@{ from = '04:00'; to = '10:00' }
        passepartout_agent = [ordered]@{ env = $envAgente }
    }
    $fileConfig = Join-Path $Cartella 'nodo.json'
    Scrivi-Utf8 $fileConfig ($config | ConvertTo-Json -Depth 5)
    Solo-Amministratori $fileConfig
    Ok "$fileConfig (leggibile solo da amministratori e SYSTEM)"

    # ------------------------------------------------------------------
    Passo 'Installo il servizio'
    $env:SYMPOTIA_NODE_ROOT = $Cartella
    & $node (Join-Path $Cartella 'supervisor.mjs') check
    if ($LASTEXITCODE -ne 0) { throw 'La configurazione non passa il controllo del supervisore.' }
    & $node (Join-Path $Cartella 'supervisor.mjs') install | Out-Null
    & $winsw install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "WinSW non è riuscito a installare il servizio $Servizio." }
    & $winsw start | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Il servizio $Servizio è installato ma non parte: guarda i log in $(Join-Path $Cartella 'logs')." }
    Ok "Servizio $Servizio installato e avviato (si riavvia da solo con Windows)."

    # L'agente installato a mano prima: con l'abbinamento il suo token non
    # vale più, ma l'attività pianificata continuerebbe a riprovare. Solo le
    # attività che lanciano l'agente: quelle del gestionale non si toccano.
    $vecchie = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.State -ne 'Disabled' -and ($_.Actions | Where-Object { "$($_.Execute) $($_.Arguments)" -match 'passepartout-agent' })
    }
    foreach ($attivita in $vecchie) {
        $risposta = Read-Host "C'è l'attività pianificata «$($attivita.TaskName)» dell'agente di prima. La disattivo? [S/n]"
        if ($risposta -notmatch '^[nN]') {
            Stop-ScheduledTask -TaskName $attivita.TaskName -TaskPath $attivita.TaskPath -ErrorAction SilentlyContinue
            Disable-ScheduledTask -TaskName $attivita.TaskName -TaskPath $attivita.TaskPath | Out-Null
            Ok "Disattivata «$($attivita.TaskName)»."
        }
    }

    # ------------------------------------------------------------------
    Passo 'Aspetto che l''agente si colleghi'
    $stato = Join-Path $Cartella 'state\agente.json'
    $scadenza = (Get-Date).AddMinutes(2)
    $collegato = $false
    while ((Get-Date) -lt $scadenza -and -not $collegato) {
        Start-Sleep -Seconds 2
        if (Test-Path $stato) {
            try { $collegato = ((Get-Content -Raw $stato | ConvertFrom-Json).ok -eq $true) } catch { }
        }
    }
    if ($collegato) {
        Write-Host ''
        Write-Host "Fatto. Il PC della cassa è collegato a $nomeRistorante." -ForegroundColor Green
        Write-Host 'Torna in Impostazioni -> Passepartout ed esegui la verifica della cassa.'
    } else {
        Write-Host ''
        Write-Host 'Il servizio è installato ma l''agente non risulta ancora collegato.' -ForegroundColor Yellow
        Write-Host "Guarda i log in $(Join-Path $Cartella 'logs') (passepartout.log, supervisor.log)."
    }
}

try {
    Installa-SympotiaCassa
} catch {
    Write-Host ''
    Write-Host "Installazione interrotta: $($_.Exception.Message)" -ForegroundColor Red
}
