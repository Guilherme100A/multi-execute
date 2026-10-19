param(
    [Parameter(Mandatory=$true)][ValidateSet('ImportRam','List','ImportCookie','Verify','Launch','LaunchBatch','HoldMulti')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Vault
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Net.Http
$entropy = [Text.Encoding]::UTF8.GetBytes('multi-execute.accounts.v1')
$vaultLock = $null
$lockHeld = $false
function Fail([string]$message) { throw "DIRECT: $message" }
function Read-Vault {
    if (!(Test-Path -LiteralPath $Vault)) { return @() }
    $encrypted = [IO.File]::ReadAllBytes($Vault)
    $clear = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $decoded = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json; foreach ($row in $decoded) { Write-Output $row } }
    finally { [Array]::Clear($clear, 0, $clear.Length) }
}
function Check-Account($row) {
    if ($row.Username -notmatch '^[A-Za-z0-9_]{3,20}$' -or $row.SecurityToken -notmatch '^[^\s;]{20,4096}$') { Fail 'Invalid account data' }
}
function Save-Vault($rows) {
    $rows = @($rows | ForEach-Object { Check-Account $_; [pscustomobject]@{Username=$_.Username;SecurityToken=$_.SecurityToken} })
    $clear = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $rows -Compress))
    try { $encrypted = [Security.Cryptography.ProtectedData]::Protect($clear, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
    finally { [Array]::Clear($clear, 0, $clear.Length) }
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Vault))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = $Vault + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllBytes($temporary, $encrypted)
        if (Test-Path -LiteralPath $Vault) { [IO.File]::Replace($temporary, $Vault, $null) }
        else { [IO.File]::Move($temporary, $Vault) }
    } finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
}
function Send-Roblox([string]$url, [string]$method, [string]$cookie, [string]$csrf='') {
    # All callers use fixed HTTPS Roblox endpoints. Never follow redirects with credentials.
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(15)
    $request = New-Object Net.Http.HttpRequestMessage((New-Object Net.Http.HttpMethod($method)), $url)
    $request.Headers.Add('Cookie', '.ROBLOSECURITY=' + $cookie)
    $request.Headers.Referrer = [Uri]'https://www.roblox.com/'
    if ($method -eq 'POST') { $request.Content = New-Object Net.Http.StringContent('{}', [Text.Encoding]::UTF8, 'application/json') }
    if ($csrf) { $request.Headers.Add('X-CSRF-TOKEN', $csrf) }
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $token = ''; $ticket = ''
            if ($response.Headers.Contains('x-csrf-token')) { $token = @($response.Headers.GetValues('x-csrf-token'))[0] }
            if ($response.Headers.Contains('rbx-authentication-ticket')) { $ticket = @($response.Headers.GetValues('rbx-authentication-ticket'))[0] }
            return @{Status=[int]$response.StatusCode;Body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();Csrf=$token;Ticket=$ticket}
        } finally { $response.Dispose() }
    } finally { $request.Dispose(); $client.Dispose(); $handler.Dispose() }
}
function Get-Identity([string]$cookie) {
    Check-Account ([pscustomobject]@{Username='validation';SecurityToken=$cookie})
    $response = Send-Roblox 'https://users.roblox.com/v1/users/authenticated' 'GET' $cookie
    if ($response.Status -ne 200) { Fail ('Roblox session unavailable or expired (HTTP ' + $response.Status + '). Sign in again to refresh this account.') }
    $identity = $response.Body | ConvertFrom-Json
    if ($identity.name -notmatch '^[A-Za-z0-9_]{3,20}$' -or !$identity.id) { Fail 'Roblox returned an invalid identity' }
    return $identity
}
function New-LaunchRequest([string]$username, [string]$placeId) {
    if ($placeId -notmatch '^\d{6,15}$') { Fail 'Invalid PlaceId' }
    $rows = @((Read-Vault) | Where-Object { $_.Username -eq $username })
    if ($rows.Count -ne 1) { Fail 'Account is missing from the encrypted local vault; import it first' }
    $row = $rows[0]; Check-Account $row
    $identity = Get-Identity $row.SecurityToken
    if ($identity.name -ne $row.Username) { Fail 'Saved session belongs to a different Roblox account; import it again' }
    $response = Send-Roblox 'https://auth.roblox.com/v1/authentication-ticket/' 'POST' $row.SecurityToken
    if ($response.Status -eq 403 -and $response.Csrf) { $response = Send-Roblox 'https://auth.roblox.com/v1/authentication-ticket/' 'POST' $row.SecurityToken $response.Csrf }
    if ($response.Status -ne 200 -or !$response.Ticket) { Fail ('Roblox did not authorize launching (HTTP ' + $response.Status + ')') }
    if ($response.Ticket -notmatch '^[A-Za-z0-9_.=-]+$') { Fail 'Invalid launch ticket format' }
    $tracker = Get-Random -Minimum 100000000 -Maximum 2000000000
    $launchUrl = 'https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGame&browserTrackerId=' + $tracker + '&placeId=' + $placeId + '&isPlayTogetherGame=false'
    $time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $uri = 'roblox-player:1+launchmode:play+gameinfo:' + $response.Ticket + '+launchtime:' + $time + '+placelauncherurl:' + [Uri]::EscapeDataString($launchUrl) + '+browsertrackerid:' + $tracker + '+robloxLocale:pt_br+gameLocale:pt_br+channel:+LaunchExp:InApp'
    return [pscustomobject]@{Uri=$uri;Username=$row.Username;UserId=$identity.id;PlaceId=$placeId}
}
try {
    if ($Action -eq 'HoldMulti') {
        $mutex = New-Object Threading.Mutex($false, 'ROBLOX_singletonMutex')
        $held = $false
        try {
            try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
            if (!$held) { Fail 'Close Roblox and Account Manager once, then retry so this project can own multi-instance launching.' }
            [Console]::WriteLine('{"ok":true}')
            [Console]::In.ReadLine() | Out-Null
        } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
        exit 0
    }
    $inputData = [Console]::In.ReadToEnd()
    $data = if ($inputData) { $inputData | ConvertFrom-Json } else { @{} }
    if ($Action -in 'ImportRam','ImportCookie') {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Vault).ToLowerInvariant()))).Replace('-', '') }
        finally { $sha.Dispose() }
        $vaultLock = New-Object Threading.Mutex($false, ('Local\multi-execute-vault-' + $key))
        try { $lockHeld = $vaultLock.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $lockHeld = $true }
        if (!$lockHeld) { Fail 'Another account import is still running; retry shortly' }
    }
    switch ($Action) {
        'List' {
            $names = @((Read-Vault) | ForEach-Object { $_.Username })
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$true;accounts=$names} -Compress))
        }
        'ImportRam' {
            $bytes = [IO.File]::ReadAllBytes([string]$data.source)
            $ramEntropy = [Text.Encoding]::UTF8.GetBytes('ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf')
            try { $clear = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $ramEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
            catch { Fail 'Cannot unlock the RAM file with this Windows account. Password-encrypted RAM files require an explicit export.' }
            try { $source = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json }
            finally { [Array]::Clear($clear, 0, $clear.Length) }
            $selected = @($source | Where-Object { $_.Username -in @($data.usernames) })
            if (!$selected.Count -or $selected.Count -ne @($data.usernames).Count) { Fail 'Requested accounts were not found uniquely in the RAM file' }
            $rows = @((Read-Vault) | Where-Object { $_.Username -notin @($data.usernames) }) + $selected
            Save-Vault $rows
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$true;accounts=@($selected | ForEach-Object {$_.Username})} -Compress))
        }
        'ImportCookie' {
            $identity = Get-Identity ([string]$data.cookie)
            $rows = @((Read-Vault) | Where-Object { $_.Username -ne $identity.name })
            $rows += [pscustomobject]@{Username=$identity.name;SecurityToken=[string]$data.cookie}
            Save-Vault $rows
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$true;username=$identity.name} -Compress))
        }
        'Verify' {
            $rows = @((Read-Vault) | Where-Object { $_.Username -eq [string]$data.username })
            if ($rows.Count -ne 1) { Fail 'Account is missing from the encrypted local vault; import it first' }
            $row = $rows[0]; Check-Account $row
            $identity = Get-Identity $row.SecurityToken
            if ($identity.name -ne $row.Username) { Fail 'Saved session belongs to a different Roblox account; import it again' }
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$true;username=$identity.name;userId=$identity.id} -Compress))
        }
        { $_ -in 'Launch','LaunchBatch' } {
            $games = @(if ($Action -eq 'Launch') { $data } else { $data.games })
            if (!$games.Count -or $games.Count -gt 10) { Fail 'A direct launch batch requires 1 to 10 accounts' }
            # Prepare all tickets before opening any window, so Real observes one batch.
            $requests = @($games | ForEach-Object { New-LaunchRequest ([string]$_.username) ([string]$_.placeId) })
            foreach ($launch in $requests) { Start-Process -FilePath $launch.Uri | Out-Null }
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$true;accounts=@($requests | ForEach-Object {$_.Username})} -Compress))
        }
    }
} catch {
    $message = 'Local account operation failed; credentials were not logged.'
    if ($_.Exception.Message.StartsWith('DIRECT: ')) { $message = $_.Exception.Message.Substring(8) }
    [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$false;error=$message} -Compress))
    exit 1
} finally {
    if ($lockHeld) { $vaultLock.ReleaseMutex() }
    if ($vaultLock) { $vaultLock.Dispose() }
}
