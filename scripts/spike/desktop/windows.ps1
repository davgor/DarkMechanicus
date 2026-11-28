# DM-1042 spike: the window list for the overlay evidence. EnumWindows walks the top-level windows from the top of the
# z-order down; this prints one JSON line with the visible windows of the given process ids only (the person's own
# windows are counted, never named): z index, HWND, pid, title, physical bounds, topmost / click-through / no-activate
# flags and the display affinity (content protection), plus the foreground window and how many visible windows of
# other processes sit above the first listed one.
param([Parameter(Mandatory = $true)][string]$Pids)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win1042 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern long GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<IntPtr> All() { var list = new List<IntPtr>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero); return list; }
}
'@
[void][Win1042]::SetProcessDPIAware()
$want = @($Pids -split ',' | ForEach-Object { [uint32]$_ })
$all = [Win1042]::All()
$rows = @(); $z = 0; $othersAbove = @(); $firstOurs = $null
foreach ($h in $all) {
  $procId = [uint32]0; [void][Win1042]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($want -contains $procId) {
    if ($null -eq $firstOurs) { $firstOurs = $z }
    $sb = New-Object System.Text.StringBuilder 256; [void][Win1042]::GetWindowText($h, $sb, 256)
    $r = New-Object Win1042+RECT; [void][Win1042]::GetWindowRect($h, [ref]$r)
    $ex = [Win1042]::GetWindowLongPtr($h, -20)
    $aff = [uint32]0; [void][Win1042]::GetWindowDisplayAffinity($h, [ref]$aff)
    $rows += @{ z = $z; hwnd = $h.ToInt64(); pid = $procId; title = $sb.ToString(); x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T
      topmost = [bool]($ex -band 0x8); transparent = [bool]($ex -band 0x20); layered = [bool]($ex -band 0x80000); noActivate = [bool]($ex -band 0x8000000); toolWindow = [bool]($ex -band 0x80)
      displayAffinity = ('0x{0:X}' -f $aff) }
  } elseif ($null -eq $firstOurs) {
    # Another process's window above ours: its class and bounds only, never its title.
    $cls = New-Object System.Text.StringBuilder 256; [void][Win1042]::GetClassName($h, $cls, 256)
    $r = New-Object Win1042+RECT; [void][Win1042]::GetWindowRect($h, [ref]$r)
    $ex = [Win1042]::GetWindowLongPtr($h, -20)
    $othersAbove += @{ z = $z; class = $cls.ToString(); x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T; topmost = [bool]($ex -band 0x8) }
  }
  $z++
}
$fg = [Win1042]::GetForegroundWindow()
$fgPid = [uint32]0; [void][Win1042]::GetWindowThreadProcessId($fg, [ref]$fgPid)
@{ visibleWindows = $all.Count; othersAboveFirstListed = $othersAbove; foreground = @{ hwnd = $fg.ToInt64(); pid = $fgPid; listed = ($want -contains $fgPid) }; windows = $rows } | ConvertTo-Json -Compress -Depth 4
