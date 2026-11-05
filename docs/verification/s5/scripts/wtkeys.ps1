param([int]$TargetPid,[string]$Keys)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
"@
$wsh = New-Object -ComObject WScript.Shell
[void]$wsh.AppActivate($TargetPid); Start-Sleep -Milliseconds 700
$fg = [FG]::GetForegroundWindow(); $p = 0; [void][FG]::GetWindowThreadProcessId($fg, [ref]$p)
if ($p -ne $TargetPid) { "foreground pid $p is not $TargetPid; not sending"; exit 1 }
[System.Windows.Forms.SendKeys]::SendWait($Keys); "sent"
