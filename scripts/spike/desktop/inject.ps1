# DM-1042 spike: synthetic input through SendInput, so the hook helper can be shown what injected input looks like.
#   -Esc [-Tag <helper pid> -Kind 2]  one Escape down+up; tagged, the helper swallows it so no window receives it;
#                                     untagged, it goes to the foreground window (the caller checks that is a fixture).
#   -Loop -Tag <helper pid> [-IntervalMs 10]  the agent stand-in: tagged VK 0xE8 (unassigned) down+up forever, every
#                                     one swallowed by the helper. It is the input a killed process tree must stop.
#   -ClickX <x> -ClickY <y>           one left click at a physical screen point (the caller checks it is in a fixture).
# Prints one JSON line per send: {"sent":..,"qpcNs":..}.
param([switch]$Esc, [switch]$Loop, [int]$Tag = 0, [int]$Kind = 3, [int]$IntervalMs = 10, [int]$ClickX = -1, [int]$ClickY = -1)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Inject1042 {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  public static long NowNs() { return (long)(Stopwatch.GetTimestamp() * (1e9 / Stopwatch.Frequency)); }
  static IntPtr Extra(int tag, int kind) { return tag == 0 ? IntPtr.Zero : (IntPtr)((0x444DL << 48) | ((long)kind << 32) | (uint)tag); }
  public static uint Key(ushort vk, int tag, int kind) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1; inputs[0].u.ki.wVk = vk; inputs[0].u.ki.dwExtraInfo = Extra(tag, kind);
    inputs[1].type = 1; inputs[1].u.ki.wVk = vk; inputs[1].u.ki.dwFlags = 2; inputs[1].u.ki.dwExtraInfo = Extra(tag, kind);
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Click(int x, int y) {
    SetProcessDPIAware();
    SetCursorPos(x, y);
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0; inputs[0].u.mi.dwFlags = 0x0002;
    inputs[1].type = 0; inputs[1].u.mi.dwFlags = 0x0004;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
if ($ClickX -ge 0) {
  $at = [Inject1042]::NowNs(); $n = [Inject1042]::Click($ClickX, $ClickY)
  @{ sent = $n; click = @($ClickX, $ClickY); qpcNs = $at } | ConvertTo-Json -Compress
} elseif ($Esc) {
  $at = [Inject1042]::NowNs(); $n = [Inject1042]::Key(0x1B, $Tag, 2)
  @{ sent = $n; vk = 27; tag = $Tag; qpcNs = $at } | ConvertTo-Json -Compress
} elseif ($Loop) {
  [Console]::Out.WriteLine((@{ looping = $true; pid = $PID; qpcNs = [Inject1042]::NowNs() } | ConvertTo-Json -Compress))
  while ($true) { [void][Inject1042]::Key(0xE8, $Tag, $Kind); Start-Sleep -Milliseconds $IntervalMs }
}
