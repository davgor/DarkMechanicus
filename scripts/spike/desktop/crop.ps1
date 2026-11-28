# DM-1041 throwaway: crops a PNG to one rectangle (the fixture window) so attached evidence shows nothing of the
# person's own windows. The rectangle is clamped to the image; prints one JSON line with the size written.
param(
  [Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out,
  [int]$X, [int]$Y, [int]$W, [int]$H
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Bitmap]::FromFile($In)
$left = [math]::Max(0, $X); $top = [math]::Max(0, $Y)
$right = [math]::Min($source.Width, $X + $W); $bottom = [math]::Min($source.Height, $Y + $H)
$rect = New-Object System.Drawing.Rectangle $left, $top, ($right - $left), ($bottom - $top)
$crop = $source.Clone($rect, $source.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
@{ path = $Out; x = $left; y = $top; width = $rect.Width; height = $rect.Height; sourceWidth = $source.Width; sourceHeight = $source.Height } | ConvertTo-Json -Compress
$crop.Dispose(); $source.Dispose()
