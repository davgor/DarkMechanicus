# DM-1041 throwaway: reads one window's UI Automation tree with the in-box .NET UIAutomationClient (no native
# toolchain) and prints one JSON line: node count, walk time, and the "Probe button" / "Probe input" elements with
# their physical bounds. Used to tell whether a slow or failing tree read is the fixture's or the backend's.
param([Parameter(Mandatory = $true)][long]$Hwnd, [int]$MaxNodes = 2000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DpiU1041 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][DpiU1041]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$found = @{}
$count = 0
$stack = New-Object System.Collections.Stack
$stack.Push($root)
while ($stack.Count -gt 0 -and $count -lt $MaxNodes) {
  $node = $stack.Pop(); $count++
  $name = $node.Current.Name
  if ($name -eq 'Probe button' -or $name -eq 'Probe input') {
    $r = $node.Current.BoundingRectangle
    $found[$name] = @{ type = $node.Current.ControlType.ProgrammaticName; x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }
  }
  $child = $walker.GetFirstChild($node)
  while ($null -ne $child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
}
@{ nodes = $count; ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 1); found = $found } | ConvertTo-Json -Compress -Depth 4
