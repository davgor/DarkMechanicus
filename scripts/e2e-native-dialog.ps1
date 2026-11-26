# Windows UI Automation helper for scripts/e2e-agent-chat.mjs. It reads one JSON request per stdin line and writes one
# JSON answer per stdout line. It acts only on windows of the process id each request names (the harness's isolated
# Electron app); nothing else on the desktop is captured or clicked.
#   {"op":"watch","pid":N}      opens a handle on N so its exit time stays readable after it exits
#   {"op":"exitTime","pid":N}   {"exited":bool,"exitMs":epoch ms|null} for a watched pid
#   {"op":"dialog","pid":P,"title":T,"button":B,"png":F,"timeoutMs":M}
#                               waits for P's top-level window named T, saves it (PrintWindow, not the screen) to F,
#                               then invokes its button named B; answers with the buttons seen and the click time
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class E2eNative {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
}
'@
# Per-monitor DPI awareness v2, so window rectangles and captures are in physical pixels.
[void][E2eNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

$watched = @{}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Find-Dialog($ownerPid, $title, $timeoutMs) {
  $byPid = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$ownerPid)
  $byName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$title)
  $deadline = (Now-Ms) + $timeoutMs
  while ((Now-Ms) -lt $deadline) {
    # A modal dialog is either a top-level window of the process or, as UI Automation may present an owned window,
    # a child of one of its top-level windows.
    foreach ($window in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)) {
      if ($window.Current.Name -eq $title) { return $window }
      $owned = $window.FindFirst([System.Windows.Automation.TreeScope]::Children, $byName)
      if ($null -ne $owned -and $owned.Current.ProcessId -eq [int]$ownerPid) { return $owned }
    }
    Start-Sleep -Milliseconds 50
  }
  throw "No window titled '$title' of process $ownerPid appeared within $timeoutMs ms."
}
function Save-Window($element, $png) {
  $hwnd = [IntPtr]$element.Current.NativeWindowHandle
  $rect = New-Object E2eNative+Rect
  if (-not [E2eNative]::GetWindowRect($hwnd, [ref]$rect)) { throw 'GetWindowRect failed.' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  # PW_RENDERFULLCONTENT: the window's own content, whatever covers it on screen.
  $printed = [E2eNative]::PrintWindow($hwnd, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  if (-not $printed) { $bitmap.Dispose(); throw 'PrintWindow failed.' }
  $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  return @{ width = $width; height = $height }
}

# The dialog's button once it can take input: a dialog that is still being shown has disabled buttons, and
# invoking one then throws (InvalidOperationException).
function Wait-Button($dialog, $name, $deadline) {
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  while ($true) {
    $buttons = @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition))
    $names = @($buttons | ForEach-Object { $_.Current.Name })
    $target = $buttons | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1
    $ready = $true
    $window = $null
    if ($dialog.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$window)) {
      $ready = $window.Current.WindowInteractionState -eq [System.Windows.Automation.WindowInteractionState]::ReadyForUserInteraction
    }
    if ($null -ne $target -and $ready -and $target.Current.IsEnabled -and -not $target.Current.IsOffscreen) {
      return @{ target = $target; names = $names }
    }
    if ((Now-Ms) -ge $deadline) {
      throw "The dialog's button '$name' did not become ready (buttons: $($names -join ', '); window ready: $ready)."
    }
    Start-Sleep -Milliseconds 50
  }
}

function Answer-Dialog($request) {
  $deadline = (Now-Ms) + $request.timeoutMs
  $dialog = Find-Dialog $request.pid $request.title $request.timeoutMs
  $foundAt = Now-Ms
  $button = Wait-Button $dialog $request.button $deadline
  $size = Save-Window $dialog $request.png
  $dialogHwnd = [IntPtr]$dialog.Current.NativeWindowHandle
  $buttonHwnd = [IntPtr]$button.target.Current.NativeWindowHandle
  if ($buttonHwnd -eq [IntPtr]::Zero) { throw "The button '$($request.button)' has no window handle." }
  # As the docs for BM_CLICK require for a dialog that is not active (a background test process cannot make it the
  # foreground window): WM_ACTIVATE first, then the button's own click, which the dialog handles as the person's.
  $id = [E2eNative]::GetDlgCtrlID($buttonHwnd)
  [void][E2eNative]::SendMessage($dialogHwnd, 0x0006, [IntPtr]1, [IntPtr]::Zero)
  $clickedAt = Now-Ms
  if (-not [E2eNative]::PostMessage($buttonHwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'PostMessage failed.' }
  while ([E2eNative]::IsWindow($dialogHwnd)) {
    if ((Now-Ms) -ge $deadline) { throw 'The dialog stayed open after the click.' }
    Start-Sleep -Milliseconds 20
  }
  return @{ ok = $true; title = $request.title; ownerPid = [int]$request.pid; buttons = $button.names; clicked = $request.button;
    controlId = $id; foundAt = $foundAt; clickedAt = $clickedAt; closedAt = (Now-Ms); png = $request.png; width = $size.width; height = $size.height }
}

function Handle($request) {
  switch ($request.op) {
    'watch' {
      $process = [System.Diagnostics.Process]::GetProcessById([int]$request.pid)
      [void]$process.Handle
      $watched[[int]$request.pid] = $process
      return @{ ok = $true; pid = $request.pid }
    }
    'exitTime' {
      $process = $watched[[int]$request.pid]
      if ($null -eq $process) { throw "Process $($request.pid) is not watched." }
      $process.Refresh()
      if (-not $process.HasExited) { return @{ ok = $true; exited = $false; exitMs = $null } }
      return @{ ok = $true; exited = $true; exitMs = ([DateTimeOffset]$process.ExitTime.ToUniversalTime()).ToUnixTimeMilliseconds() }
    }
    'dialog' { return Answer-Dialog $request }
    default { throw "Unknown op '$($request.op)'." }
  }
}

[Console]::Out.WriteLine((@{ ready = $true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  try {
    $answer = Handle ($line | ConvertFrom-Json)
  } catch {
    $answer = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
