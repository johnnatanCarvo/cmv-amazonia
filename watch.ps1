# Observa Código.js, Dados.js, Index.html e appsscript.json.
# Ao detectar uma alteracao salva, espera 5s (debounce) e dispara update.bat.
# Ignora eventos disparados pelo proprio update.bat (checagem do arquivo de lock).

$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$global:batPath = Join-Path $folder "update.bat"
$global:lockPath = Join-Path $folder ".autoupdate.lock"
$global:targets = @("Código.js", "Dados.js", "Index.html", "appsscript.json")
$global:debounceTimer = $null

$fsw = New-Object System.IO.FileSystemWatcher
$fsw.Path = $folder
$fsw.Filter = "*.*"
$fsw.IncludeSubdirectories = $false
$fsw.EnableRaisingEvents = $true

$action = {
    $name = $Event.SourceEventArgs.Name
    if ($global:targets -contains $name -and -not (Test-Path $global:lockPath)) {
        if ($global:debounceTimer) {
            $global:debounceTimer.Stop()
            $global:debounceTimer.Dispose()
        }
        $global:debounceTimer = New-Object System.Timers.Timer
        $global:debounceTimer.Interval = 5000
        $global:debounceTimer.AutoReset = $false
        Register-ObjectEvent -InputObject $global:debounceTimer -EventName Elapsed -Action {
            Start-Process -FilePath $global:batPath -WindowStyle Hidden
        } | Out-Null
        $global:debounceTimer.Start()
    }
}

Register-ObjectEvent -InputObject $fsw -EventName Changed -Action $action | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Created -Action $action | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Renamed -Action $action | Out-Null

Write-Host "Observando alteracoes em $folder ..."
while ($true) { Start-Sleep -Seconds 5 }
