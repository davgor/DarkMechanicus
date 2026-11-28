# DM-1041 throwaway: prints the foreground window's handle and owning process id as one JSON line, so a probe can
# refuse to send physical keystrokes unless the fixture window it launched is the one in front.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Fg1041 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$h = [Fg1041]::GetForegroundWindow()
$fgPid = [uint32]0
[void][Fg1041]::GetWindowThreadProcessId($h, [ref]$fgPid)
@{ hwnd = $h.ToInt64(); pid = $fgPid } | ConvertTo-Json -Compress
