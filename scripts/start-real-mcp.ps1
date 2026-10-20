$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Result([bool]$ok, [bool]$clicked, [string]$message) {
    [Console]::WriteLine((ConvertTo-Json -InputObject @{ok=$ok;clicked=$clicked;message=$message} -Compress))
    exit $(if ($ok) { 0 } else { 1 })
}

$endpoint = Join-Path $env:LOCALAPPDATA 'Real\sessions\mcp\endpoint.json'
if (Test-Path -LiteralPath $endpoint) { Result $true $false 'Real MCP is already running' }

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $real = Get-Process -Name Real -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object -First 1
    if (!$real) {
        $updater = Join-Path $env:LOCALAPPDATA 'Real\Update.exe'
        if (!(Test-Path -LiteralPath $updater)) { Result $false $false 'Project Real is not installed' }
        Start-Process -FilePath $updater -ArgumentList '--processStart','Real.exe' | Out-Null
        $limit = [DateTime]::UtcNow.AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 400
            $real = Get-Process -Name Real -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object -First 1
        } until ($real -or [DateTime]::UtcNow -ge $limit)
    }
    if (!$real) { Result $false $false 'Project Real did not open in this Windows session' }

    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate($real.Id)
    Start-Sleep -Milliseconds 600
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $realWindow = $null
    for ($i = 0; $i -lt $windows.Count; $i++) {
        $candidate = $windows.Item($i)
        if ($candidate.Current.ProcessId -eq $real.Id) { $realWindow = $candidate; break }
    }
    if (!$realWindow) { Result $false $false 'Open the Real window, then use Settings > Connections > Real MCP > Start' }

    $descendants = $realWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $hasMcp = $false
    $startButtons = @()
    for ($i = 0; $i -lt $descendants.Count; $i++) {
        $item = $descendants.Item($i)
        if ($item.Current.Name -match '^Real MCP$') { $hasMcp = $true }
        if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $item.Current.Name -match '^Start$') { $startButtons += $item }
    }
    if (!$hasMcp -or $startButtons.Count -ne 1) { Result $false $false 'Open Settings > Connections so the Real MCP Start button is visible' }
    $invoke = $startButtons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    $limit = [DateTime]::UtcNow.AddSeconds(15)
    do { Start-Sleep -Milliseconds 300 } until ((Test-Path -LiteralPath $endpoint) -or [DateTime]::UtcNow -ge $limit)
    if (Test-Path -LiteralPath $endpoint) { Result $true $true 'Real MCP started' }
    Result $false $true 'The Start button was pressed, but Real MCP did not become ready'
} catch {
    Result $false $false 'Real MCP could not be enabled automatically; open Settings > Connections and press Start'
}
