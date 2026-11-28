# DM-1041 throwaway: captures the whole Windows desktop (the virtual screen, every monitor) with GDI CopyFromScreen in
# a DPI-aware process, saves it to -Out, and prints one JSON line: the monitor layout in physical pixels, the time
# taken and a sampled count of non-black pixels. A minimized or disconnected RDP session draws nothing: the copy fails
# ("The handle is invalid") or comes back black, and nonBlack is then 0.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi1041 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][Dpi1041]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    @{ device = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })
$bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$result = 'ok'
try { $g.CopyFromScreen($v.Location, [System.Drawing.Point]::Empty, $v.Size) } catch { $result = 'error: ' + $_.Exception.Message }
$captureMs = $watch.Elapsed.TotalMilliseconds
$nonBlack = 0
for ($x = 0; $x -lt $v.Width; $x += 37) { for ($y = 0; $y -lt $v.Height; $y += 37) { $p = $bmp.GetPixel($x, $y); if ($p.R + $p.G + $p.B -gt 30) { $nonBlack++ } } }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$totalMs = $watch.Elapsed.TotalMilliseconds
$g.Dispose(); $bmp.Dispose()
$session = (Get-Process -Id $PID).SessionId
@{ result = $result; path = $Out; captureMs = [math]::Round($captureMs, 1); totalMs = [math]::Round($totalMs, 1); nonBlack = $nonBlack
  virtual = @{ x = $v.X; y = $v.Y; width = $v.Width; height = $v.Height }; monitors = $monitors; session = $session } | ConvertTo-Json -Compress -Depth 4
