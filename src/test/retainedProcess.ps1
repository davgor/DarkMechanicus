$Node = $env:DM_TEST_OWNED_NODE
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Node)) { throw 'Owned Node executable was not supplied.' }
$child = $null
$ownedPid = 0

function Write-Receipt([string]$phase) {
  [Console]::Out.WriteLine((@{ phase = $phase; pid = $ownedPid } | ConvertTo-Json -Compress))
}

try {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Node
  $start.Arguments = '-e "setInterval(() => {}, 1000)"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $ownedPid = $child.Id
  # Force acquisition BEFORE readiness. Process keeps this handle until Dispose, including after
  # WaitForExit, so Git subprocesses cannot reuse the owned PID while the restore is in flight.
  # https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803/
  if ($child.Handle -eq [IntPtr]::Zero -or $child.HasExited) { throw 'Owned process did not start.' }
  Write-Receipt 'ready'
  while ($null -ne ($command = [Console]::In.ReadLine())) {
    if ($command -eq 'exit') {
      if (-not $child.HasExited) { $child.Kill() }
      $child.WaitForExit()
      Write-Receipt 'exited'
    } elseif ($command -eq 'release') {
      break
    } else {
      throw 'Unexpected owned-process command.'
    }
  }
} finally {
  if ($null -ne $child) {
    try {
      # EOF also reaches this path when a caller fails or its process disappears.
      if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    } finally { $child.Dispose() }
    Write-Receipt 'released'
  }
}
