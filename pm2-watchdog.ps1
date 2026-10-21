# HermesVO PM2 Watchdog — dicek tiap 5 menit via Task Scheduler (sebagai SYSTEM).
# Kalau proses 'hermes-vo' tidak online, coba 'pm2 resurrect' dulu (dari dump),
# kalau masih tidak online, 'pm2 start' fresh. Semua path absolut karena
# task jalan sebagai SYSTEM (%APPDATA% milik SYSTEM, bukan administrator).
$env:PM2_HOME = 'C:\Users\Administrator.FB-BOGORRECP\.pm2'
$pm2 = 'C:\Users\Administrator.FB-BOGORRECP\AppData\Roaming\npm\pm2.cmd'

function Test-HermesOnline {
  try {
    $raw = & $pm2 jlist 2>$null | Out-String
    if (-not $raw.Trim()) { return $false }
    $j = $raw | ConvertFrom-Json
    $hit = @($j | Where-Object { $_.name -eq 'hermes-vo' -and $_.pm2_env.status -eq 'online' })
    return $hit.Count -gt 0
  } catch { return $false }
}

if (Test-HermesOnline) { exit 0 }

# Tidak online — coba resurrect dari dump (pm2 save terakhir).
& $pm2 resurrect 2>$null | Out-Null
Start-Sleep -Seconds 5
if (Test-HermesOnline) { exit 0 }

# Resurrect gagal — start fresh.
& $pm2 start D:\hermes-vo\app\server.js --name hermes-vo 2>$null | Out-Null
Start-Sleep -Seconds 3
& $pm2 save 2>$null | Out-Null
exit 0
