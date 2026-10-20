param([string]$PreviewPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'public/assets/terminal-roblox/roblox-04.png'))
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$scaled = New-Object System.Drawing.Bitmap 256, 256
$scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
$roundedPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$brush = $null
$imageStream = New-Object System.IO.MemoryStream
try {
  $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scaledGraphics.DrawImage($source, 0, 0, 256, 256)
  $brush = New-Object System.Drawing.TextureBrush $scaled
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $roundedPath.AddArc(0, 0, 104, 104, 180, 90)
  $roundedPath.AddArc(152, 0, 104, 104, 270, 90)
  $roundedPath.AddArc(152, 152, 104, 104, 0, 90)
  $roundedPath.AddArc(0, 152, 104, 104, 90, 90)
  $roundedPath.CloseFigure()
  $graphics.FillPath($brush, $roundedPath)
  if ($PreviewPath) { $bitmap.Save([IO.Path]::GetFullPath($PreviewPath), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bitmap.Save($imageStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $imageStream.ToArray()
  $iconPath = Join-Path $projectRoot 'desktop/icon.ico'
  $stream = [System.IO.File]::Create($iconPath)
  $writer = New-Object System.IO.BinaryWriter $stream
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]1)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]22)
    $writer.Write($bytes)
  } finally { $writer.Dispose(); $stream.Dispose() }
  Write-Output "Icon generated: $iconPath"
} finally {
  $imageStream.Dispose()
  if ($brush) { $brush.Dispose() }
  $roundedPath.Dispose()
  $scaledGraphics.Dispose()
  $scaled.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  $source.Dispose()
}
