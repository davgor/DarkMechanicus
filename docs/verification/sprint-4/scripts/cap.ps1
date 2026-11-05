param([int]$TargetPid,[int64]$Hwnd,[string]$Prefix,[int]$N=6)
$wsh = New-Object -ComObject WScript.Shell
[void]$wsh.AppActivate($TargetPid); Start-Sleep -Milliseconds 1200
for($i=0;$i -lt $N;$i++){ & "$PSScriptRoot\winshot.ps1" -Hwnd $Hwnd -Out "$PSScriptRoot\$Prefix$i.png" | Out-Null; Start-Sleep -Milliseconds 230 }
