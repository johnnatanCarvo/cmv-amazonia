# Observa Código.js, Dados.js, Index.html e appsscript.json por POLLING.
# FileSystemWatcher nao e confiavel neste drive (Google Drive/rede), entao
# a cada $intervaloSeg segundos comparamos o hash dos arquivos-alvo; se
# algum mudou, disparamos update.bat (que faz clasp push + commit + merge).

$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $folder "update.bat"
$lockPath = Join-Path $folder ".autoupdate.lock"
$targets = @("Código.js", "Dados.js", "Index.html", "appsscript.json")
$intervaloSeg = 20

function Get-EstadoArquivos {
    $estado = @{}
    foreach ($t in $targets) {
        $p = Join-Path $folder $t
        if (Test-Path $p) {
            $estado[$t] = (Get-FileHash -Path $p -Algorithm MD5).Hash
        } else {
            $estado[$t] = $null
        }
    }
    return $estado
}

Write-Host "Observando (polling a cada ${intervaloSeg}s) em $folder ..."
$estadoAnterior = Get-EstadoArquivos

while ($true) {
    Start-Sleep -Seconds $intervaloSeg

    if (Test-Path $lockPath) { continue }

    $estadoAtual = Get-EstadoArquivos
    $mudou = $false
    foreach ($t in $targets) {
        if ($estadoAtual[$t] -ne $estadoAnterior[$t]) { $mudou = $true }
    }

    if ($mudou) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Mudanca detectada, disparando update.bat"
        $estadoAnterior = $estadoAtual
        Push-Location $folder
        try {
            & $batPath
        } catch {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ERRO ao rodar update.bat: $_"
        } finally {
            Pop-Location
        }
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] update.bat finalizado"
    }
}
