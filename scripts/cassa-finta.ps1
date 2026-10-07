# Cassa Passepartout finta, per provare l'installatore e l'agente su un PC
# senza Passepartout (una VM Windows). Risponde come l'AdapterWS alle
# chiamate che fanno l'installatore, la verifica della cassa e gli import:
# versione, tipi di pagamento, sale e tavoli, articoli, prenotazioni (tenute
# in memoria finché resta aperta), comande e conti del giorno (vuoti). Le
# altre operazioni rispondono con un errore SOAP.
#
# Da PowerShell come amministratore, in una finestra sua:
#   irm __SYMPOTIA_SERVER__/installa/cassa-finta.ps1 | iex
# Utente e password del Web Service: prova / prova. Si cambiano, come la
# porta (7606) e la versione, con $env:CASSA_FINTA_UTENTE,
# $env:CASSA_FINTA_PASSWORD, $env:CASSA_FINTA_PORTA e
# $env:CASSA_FINTA_VERSIONE prima del comando. Ctrl+C la ferma.
#
# È uno strumento di prova: mai sul PC della cassa di un ristorante.
# Compatibile con Windows PowerShell 5.1 e con PowerShell 7.

function Avvia-CassaFinta {
    param(
        [int]$Porta = 7606,
        [string]$Utente = 'prova',
        [string]$Password = 'prova',
        [string]$Versione = '2026C1'
    )
    $ErrorActionPreference = 'Stop'

    $NS_A = 'http://schemas.datacontract.org/2004/07/PMessageBox.Contract'
    $NS_B = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays'
    $NS_I = 'http://www.w3.org/2001/XMLSchema-instance'

    # Sale e tavoli (nome:coperti), come li disegna la pianta della cassa.
    $sale = [ordered]@{
        'DENTRO' = '1:4 2:4 3:2 4:6 5:4 29:4'
        'FUORI'  = '10:4 11:4 12:8'
    }
    $tipiPagamento = @('Contanti|Contanti', 'CartaCredito1|POS', 'Varie1|ESTERNO')
    # id|codice|descrizione|prezzo|iva|categoria|categoria padre
    $articoli = @(
        '101|ANT01|Bruschetta al pomodoro|6.00|10|Antipasti|Cucina',
        '102|ANT02|Tagliere di salumi|14.00|10|Antipasti|Cucina',
        '201|PRI01|Spaghetti alla carbonara|12.00|10|Primi|Cucina',
        '202|PRI02|Risotto ai funghi porcini|14.00|10|Primi|Cucina',
        '301|SEC01|Tagliata di manzo|22.00|10|Secondi|Cucina',
        '401|DOL01|Panna cotta|6.00|10|Dolci|Cucina',
        '501|BEV01|Acqua naturale 75cl|3.00|10|Bevande|Bar',
        '502|BEV02|Calice di vino rosso|6.00|22|Bevande|Bar'
    )
    $prenotazioni = New-Object System.Collections.ArrayList
    # In una tabella, perché le funzioni qui dentro possano farlo crescere.
    $contatore = @{ id = 5001 }

    function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }

    # Il valore di un elemento, con o senza prefisso (k:Utente, p:Sala).
    function Campo([string]$xml, [string]$nome) {
        $m = [regex]::Match($xml, "<(?:\w+:)?$nome(?:\s[^>]*)?>([^<]*)</(?:\w+:)?$nome>")
        if ($m.Success) { return [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) }
        return $null
    }

    function Busta([string]$op, [string]$contenuto) {
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
        "<${op}Response xmlns=""http://tempuri.org/""><${op}Result xmlns:a=""$NS_A"" xmlns:b=""$NS_B"" xmlns:i=""$NS_I"">" +
        $contenuto + "</${op}Result></${op}Response></s:Body></s:Envelope>"
    }

    function BustaNil([string]$op) {
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
        "<${op}Response xmlns=""http://tempuri.org/""><${op}Result i:nil=""true"" xmlns:i=""$NS_I""/></${op}Response></s:Body></s:Envelope>"
    }

    function Errore([string]$messaggio) {
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
        '<faultcode xmlns:a="http://schemas.microsoft.com/net/2005/12/windowscommunicationfoundation/dispatcher">a:InternalServiceFault</faultcode>' +
        '<faultstring xml:lang="it-IT">' + (Esc $messaggio) + '</faultstring></s:Fault></s:Body></s:Envelope>'
    }

    function PrenotazioneXml($p) {
        $tavoli = ($p.Tavoli | ForEach-Object { '<b:string>' + (Esc $_) + '</b:string>' }) -join ''
        $campo = {
            param($nome, $valore)
            if ($null -eq $valore -or "$valore" -eq '') { return "<a:$nome i:nil=""true""/>" }
            return "<a:$nome>" + (Esc "$valore") + "</a:$nome>"
        }
        '<a:IDDati>' + (Esc $p.IDDati) + '</a:IDDati>' +
        '<a:IdGestionale>' + $p.IdGestionale + '</a:IdGestionale>' +
        (& $campo 'Adulti' $p.Adulti) + (& $campo 'Bambini' $p.Bambini) +
        (& $campo 'DataOra' $p.DataOra) + (& $campo 'Durata' $p.Durata) +
        (& $campo 'Intestazione' $p.Intestazione) + (& $campo 'Note' $p.Note) +
        (& $campo 'NumeroPersone' $p.NumeroPersone) + (& $campo 'Sala' $p.Sala) +
        (& $campo 'StatoEnum' $p.StatoEnum) + (& $campo 'Tag' $p.Tag) +
        "<a:Tavoli>$tavoli</a:Tavoli>" + (& $campo 'Telefono' $p.Telefono)
    }

    function Cerca-Prenotazione([int]$id) {
        foreach ($p in $prenotazioni) { if ($p.IdGestionale -eq $id) { return $p } }
        return $null
    }

    function Gestisci([string]$op, [string]$corpo) {
        switch ($op) {
            'GetVersioneGestionale' { return Busta $op (Esc $Versione) }
            'GetTipiPagamento' {
                $xml = ($tipiPagamento | ForEach-Object {
                    $t = $_.Split('|')
                    '<a:PMBTipoPagamento><a:Categoria>' + $t[0] + '</a:Categoria><a:Codice>' + $t[1] + '</a:Codice></a:PMBTipoPagamento>'
                }) -join ''
                return Busta $op $xml
            }
            'GetSaleMenu' {
                return Busta $op (($sale.Keys | ForEach-Object { '<b:string>' + $_ + '</b:string>' }) -join '')
            }
            'GetDisponibilitaTavoliMenu' {
                $sala = Campo $corpo 'sala'
                if (-not $sale.Contains("$sala")) { return Errore "Sala non trovata: $sala" }
                $xml = ($sale["$sala"].Split(' ') | ForEach-Object {
                    $t = $_.Split(':')
                    '<a:PMBTavolo><a:Coperti>' + $t[1] + '</a:Coperti><a:Nome>' + $t[0] + '</a:Nome><a:Tipo>Tavolo</a:Tipo></a:PMBTavolo>'
                }) -join ''
                # Un ingombro della pianta (una colonna): la cassa vera li elenca coi tavoli.
                $xml += '<a:PMBTavolo><a:Coperti>0</a:Coperti><a:Nome i:nil="true"/><a:Tipo>IngombroColonna</a:Tipo></a:PMBTavolo>'
                return Busta $op "<a:Sala>$(Esc $sala)</a:Sala><a:Tavoli>$xml</a:Tavoli>"
            }
            'GetArticoli' {
                $xml = ($articoli | ForEach-Object {
                    $a = $_.Split('|')
                    '<a:ContrattoArticolo><a:IdGestionale>' + $a[0] + '</a:IdGestionale>' +
                    '<a:AliquotaIVA><a:Codice>' + $a[4] + '%</a:Codice><a:Percentuale>' + $a[4] + '.00</a:Percentuale></a:AliquotaIVA>' +
                    '<a:Categoria><a:Descrizione>' + $a[5] + '</a:Descrizione><a:IsAttivo>true</a:IsAttivo>' +
                    '<a:Padre><a:Descrizione>' + $a[6] + '</a:Descrizione><a:IsAttivo>true</a:IsAttivo><a:Padre i:nil="true"/><a:Varianti i:nil="true"/></a:Padre>' +
                    '<a:Varianti i:nil="true"/></a:Categoria>' +
                    '<a:Codice>' + $a[1] + '</a:Codice><a:Descrizione>' + (Esc $a[2]) + '</a:Descrizione>' +
                    '<a:IsAttivo>true</a:IsAttivo><a:Prezzo>' + $a[3] + '</a:Prezzo><a:TipoEnum>Semplice</a:TipoEnum>' +
                    '<a:Varianti i:nil="true"/></a:ContrattoArticolo>'
                }) -join ''
                return Busta $op $xml
            }
            'GetComandeGiorno' { return Busta $op '' }
            'GetContiGiorno' { return Busta $op '' }
            'GetComandaTavolo' { return BustaNil $op }
            'GetComanda' { return BustaNil $op }
            'GetPrenotazioniMenuGiorno' {
                $giorno = "$(Campo $corpo 'giorno')"
                if ($giorno.Length -ge 10) { $giorno = $giorno.Substring(0, 10) }
                $xml = ($prenotazioni | Where-Object { "$($_.DataOra)".StartsWith($giorno) } | ForEach-Object {
                    '<a:ContrattoPrenotazioneMenu>' + (PrenotazioneXml $_) + '</a:ContrattoPrenotazioneMenu>'
                }) -join ''
                return Busta $op $xml
            }
            'GetPrenotazioneMenu' {
                $p = Cerca-Prenotazione ([int](Campo $corpo 'idGestionale'))
                if (-not $p) { return BustaNil $op }
                return Busta $op (PrenotazioneXml $p)
            }
            'PutPrenotazioneMenu' {
                $id = Campo $corpo 'IdGestionale'
                $p = $null
                if ($id) {
                    $p = Cerca-Prenotazione ([int]$id)
                    if (-not $p) { return Errore "Prenotazione $id non trovata" }
                } else {
                    $p = @{ IdGestionale = $contatore.id; IDDati = [guid]::NewGuid().ToString() }
                    $contatore.id++
                    [void]$prenotazioni.Add($p)
                }
                $blocco = [regex]::Match($corpo, '<(?:\w+:)?Tavoli>(.*?)</(?:\w+:)?Tavoli>').Groups[1].Value
                $p.Tavoli = @([regex]::Matches($blocco, '<(?:\w+:)?string>([^<]*)<') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) })
                # Come la cassa: l'ora di sala, senza fuso.
                $dataOra = "$(Campo $corpo 'DataOra')"
                if ($dataOra.Length -gt 19) { $dataOra = $dataOra.Substring(0, 19) }
                $p.DataOra = $dataOra
                foreach ($nome in 'Adulti', 'Bambini', 'Durata', 'Intestazione', 'Note', 'NumeroPersone', 'Sala', 'Tag', 'Telefono') {
                    $p[$nome] = Campo $corpo $nome
                }
                $stato = Campo $corpo 'StatoEnum'
                if (-not $stato) { $stato = 'Confermata' }
                $p.StatoEnum = $stato
                Write-Host ("          prenotazione {0}: {1}, {2} {3}, tavoli {4}, {5} persone" -f $p.IdGestionale, $p.StatoEnum, $p.Sala, $p.DataOra, ($p.Tavoli -join ','), $p.NumeroPersone)
                return Busta $op (PrenotazioneXml $p)
            }
            default { return Errore "Operazione non prevista dalla cassa finta: $op" }
        }
    }

    function Wsdl() {
        $operazioni = 'GetVersioneGestionale', 'GetTipiPagamento', 'GetSaleMenu', 'GetDisponibilitaTavoliMenu', 'GetArticoli',
            'GetComandeGiorno', 'GetContiGiorno', 'GetComandaTavolo', 'GetComanda', 'GetPrenotazioniMenuGiorno',
            'GetPrenotazioneMenu', 'PutPrenotazioneMenu'
        '<?xml version="1.0" encoding="utf-8"?><wsdl:definitions name="AdapterWS" targetNamespace="http://tempuri.org/" ' +
        'xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"><wsdl:portType name="IAdapterWS">' +
        (($operazioni | ForEach-Object { "<wsdl:operation name=""$_""/>" }) -join '') +
        '</wsdl:portType></wsdl:definitions>'
    }

    function Invia($ctx, [int]$codice, [string]$tipo, [string]$testo) {
        $byte = [Text.Encoding]::UTF8.GetBytes($testo)
        $ctx.Response.StatusCode = $codice
        $ctx.Response.ContentType = $tipo
        $ctx.Response.ContentLength64 = $byte.Length
        $ctx.Response.OutputStream.Write($byte, 0, $byte.Length)
        $ctx.Response.OutputStream.Close()
    }

    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://+:$Porta/")
    try {
        $listener.Start()
    } catch {
        # Senza amministratore Windows non lascia ascoltare su tutti gli
        # indirizzi: si ripiega su localhost, che all'installatore basta.
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$Porta/")
        try {
            $listener.Start()
        } catch {
            throw "Non riesco ad ascoltare sulla porta ${Porta}: forse e' occupata dalla cassa vera. Scegline un'altra con `$env:CASSA_FINTA_PORTA."
        }
        Write-Host 'Senza amministratore: risponde solo dalle richieste di questo PC (localhost).' -ForegroundColor Yellow
    }

    Write-Host "Cassa finta in ascolto su http://localhost:$Porta/AdapterWS" -ForegroundColor Green
    Write-Host "Utente '$Utente', versione $Versione. Ctrl+C per fermarla."
    try {
        while ($listener.IsListening) {
            $attesa = $listener.GetContextAsync()
            # Attese brevi, così Ctrl+C la ferma.
            while (-not $attesa.Wait(500)) { }
            $ctx = $attesa.Result
            try {
                if ($ctx.Request.HttpMethod -eq 'GET') {
                    if ($ctx.Request.Url.Query -match 'wsdl') {
                        Invia $ctx 200 'text/xml; charset=utf-8' (Wsdl)
                    } else {
                        Invia $ctx 200 'text/plain; charset=utf-8' 'Cassa Passepartout finta: il Web Service risponde su /AdapterWS'
                    }
                    continue
                }
                $lettore = New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)
                $corpo = $lettore.ReadToEnd()
                $op = "$($ctx.Request.Headers['SOAPAction'])".Trim('"').Split('/')[-1]
                if ((Campo $corpo 'Utente') -ne $Utente -or (Campo $corpo 'Password') -ne $Password) {
                    Write-Host ("{0:HH:mm:ss}  {1}: utente o password sbagliati" -f (Get-Date), $op) -ForegroundColor Yellow
                    Invia $ctx 500 'text/xml; charset=utf-8' (Errore 'Utente o password non validi')
                    continue
                }
                Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $op)
                $risposta = Gestisci $op $corpo
                $codice = 200
                if ($risposta -match '<s:Fault>') { $codice = 500 }
                Invia $ctx $codice 'text/xml; charset=utf-8' $risposta
            } catch {
                Write-Host ("{0:HH:mm:ss}  errore: {1}" -f (Get-Date), $_.Exception.Message) -ForegroundColor Red
                try { Invia $ctx 500 'text/xml; charset=utf-8' (Errore $_.Exception.Message) } catch { }
            }
        }
    } finally {
        $listener.Stop()
        $listener.Close()
        Write-Host 'Cassa finta fermata.'
    }
}

$cassaFintaOpzioni = @{}
if ($env:CASSA_FINTA_PORTA) { $cassaFintaOpzioni.Porta = [int]$env:CASSA_FINTA_PORTA }
if ($env:CASSA_FINTA_UTENTE) { $cassaFintaOpzioni.Utente = $env:CASSA_FINTA_UTENTE }
if ($env:CASSA_FINTA_PASSWORD) { $cassaFintaOpzioni.Password = $env:CASSA_FINTA_PASSWORD }
if ($env:CASSA_FINTA_VERSIONE) { $cassaFintaOpzioni.Versione = $env:CASSA_FINTA_VERSIONE }
Avvia-CassaFinta @cassaFintaOpzioni
