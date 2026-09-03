[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$MetadataPath,
    [Parameter(Mandatory = $true)][string]$OutputZipPath,
    [Parameter(Mandatory = $true)][string]$OutputPreviewPath,
    [Parameter(Mandatory = $true)][string]$OutputInfoPath,
    [string]$FallbackPreviewPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("marble-steam-prepare-" + [guid]::NewGuid().ToString("N"))

function Write-Utf8Json([string]$Path, [object]$Value) {
    $json = $Value | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Get-Property([object]$Object, [string]$Name, [object]$Fallback = $null) {
    if ($null -eq $Object) { return $Fallback }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
    return $property.Value
}

function Expand-SafeZip([string]$Path, [string]$Destination) {
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd([char[]]"\/") + [IO.Path]::DirectorySeparatorChar
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace("\", "/")
            if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith("/") -or $name -match '^[A-Za-z]:' -or $name.Split("/") -contains "..") {
                throw "Unsafe archive entry: $name"
            }
            if ([string]::IsNullOrEmpty($entry.Name)) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $root $name.Replace("/", [IO.Path]::DirectorySeparatorChar)))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escaped the temporary folder: $name" }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            $input = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
    }
    finally { $zip.Dispose() }
}

function Resolve-ModernRoot([string]$ExtractedPath) {
    $current = (Resolve-Path -LiteralPath $ExtractedPath).Path
    for ($depth = 0; $depth -lt 8; $depth++) {
        $files = @(Get-ChildItem -LiteralPath $current -File -Force)
        foreach ($candidate in @(
            @{ Name = "campaign.json"; Type = 2; Kind = "Campaign" },
            @{ Name = "level.json"; Type = 0; Kind = "Level" },
            @{ Name = "block.json"; Type = 1; Kind = "Block" }
        )) {
            $match = @($files | Where-Object { $_.Name -ieq $candidate.Name } | Select-Object -First 1)
            if ($match.Count -eq 1) { return [pscustomobject]@{ Root = $current; JsonPath = $match[0].FullName; ResourceType = $candidate.Type; Kind = $candidate.Kind } }
        }
        $children = @(Get-ChildItem -LiteralPath $current -Force | Where-Object { $_.Name -notin @("__MACOSX", ".DS_Store") })
        if ($children.Count -ne 1 -or -not $children[0].PSIsContainer) { return $null }
        $current = $children[0].FullName
    }
    return $null
}

function Copy-ContentTree([string]$Source, [string]$Destination) {
    $sourceRoot = (Resolve-Path -LiteralPath $Source).Path.TrimEnd([char[]]"\/")
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
        if (@($relative.Split("/") | Where-Object { $_ -ieq "backup" }).Count -gt 0) { continue }
        $target = Join-Path $Destination $relative.Replace("/", [IO.Path]::DirectorySeparatorChar)
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.File]::Copy($file.FullName, $target, $true)
    }
}

function Normalize-Color([string]$Value, [string]$Fallback = "0xFFFFFFFF") {
    if ($Value -match '^0x([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$') {
        return "0x" + $matches[1].ToUpperInvariant() + $(if ($matches[2]) { $matches[2].ToUpperInvariant() } else { "FF" })
    }
    return $Fallback
}

function Normalize-BlockAttributes([object]$Node) {
    if ($null -eq $Node) { return }
    $item = Get-Property $Node "Item"
    $attributes = Get-Property $item "Attributes"
    if ($null -ne $attributes) {
        $normalized = [ordered]@{}
        foreach ($property in $attributes.PSObject.Properties) { $normalized[$property.Name.ToLowerInvariant()] = $property.Value }
        $item.Attributes = [pscustomobject]$normalized
    }
    foreach ($child in @(Get-Property $Node "Children" @())) { Normalize-BlockAttributes $child }
    foreach ($property in $Node.PSObject.Properties) {
        if ($property.Name -ne "Children" -and $property.Name -ne "Item" -and $property.Value -is [System.Management.Automation.PSCustomObject]) {
            Normalize-BlockAttributes $property.Value
        }
    }
}

function New-CheckerTexture([string]$Path, [string]$ColorValue, [bool]$Inverted) {
    Add-Type -AssemblyName System.Drawing
    $hex = (Normalize-Color $ColorValue).Substring(2)
    $color = [Drawing.Color]::FromArgb(
        [Convert]::ToInt32($hex.Substring(6, 2), 16),
        [Convert]::ToInt32($hex.Substring(0, 2), 16),
        [Convert]::ToInt32($hex.Substring(2, 2), 16),
        [Convert]::ToInt32($hex.Substring(4, 2), 16)
    )
    $bitmap = [Drawing.Bitmap]::new(512, 512, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $colored = [Drawing.SolidBrush]::new($color)
    $white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
    try {
        for ($row = 0; $row -lt 2; $row++) {
            for ($column = 0; $column -lt 2; $column++) {
                $useColor = (($row + $column) % 2 -eq 0) -xor $Inverted
                $graphics.FillRectangle($(if ($useColor) { $colored } else { $white }), $column * 256, $row * 256, 256, 256)
            }
        }
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $colored.Dispose(); $white.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

function New-MaterialDocument([object]$Material, [string]$TexturePath) {
    $color = Normalize-Color ([string](Get-Property $Material "Color" "0xFFFFFF"))
    $emission = [bool](Get-Property $Material "Emission" $false)
    $mainColor = if ([string]::IsNullOrWhiteSpace($TexturePath)) { $color } else { "0xFFFFFFFF" }
    return [ordered]@{
        Name = [string](Get-Property $Material "Name" "Material")
        Shader = "Standard"
        Properties = @(
            [ordered]@{ Key = "_Mode"; Type = "Mode"; Value = "Opaque" },
            [ordered]@{ Key = "_Color"; Type = "Color"; Value = $mainColor },
            [ordered]@{ Key = "_MainTex"; Type = "Texture"; Value = [ordered]@{ Path = $TexturePath; FilterMode = "Bilinear" } },
            [ordered]@{ Key = "_METALLICGLOSSMAP"; Type = "Bool"; Value = $false },
            [ordered]@{ Key = "_MetallicGlossMap"; Type = "Texture"; Value = [ordered]@{ FilterMode = "Bilinear" } },
            [ordered]@{ Key = "_Metallic"; Type = "Float"; Value = 0.0 },
            [ordered]@{ Key = "_Glossiness"; Type = "Float"; Value = 1.0 },
            [ordered]@{ Key = "_NORMALMAP"; Type = "Bool"; Value = $false },
            [ordered]@{ Key = "_BumpMap"; Type = "Texture"; Value = [ordered]@{ FilterMode = "Bilinear" } },
            [ordered]@{ Key = "_BumpScale"; Type = "Float"; Value = 1.0 },
            [ordered]@{ Key = "_OcclusionMap"; Type = "Texture"; Value = [ordered]@{ FilterMode = "Bilinear" } },
            [ordered]@{ Key = "_OcclusionStrength"; Type = "Float"; Value = 1.0 },
            [ordered]@{ Key = "_EMISSION"; Type = "Bool"; Value = $emission },
            [ordered]@{ Key = "_EmissionMap"; Type = "Texture"; Value = [ordered]@{ FilterMode = "Bilinear" } },
            [ordered]@{ Key = "_EmissionColor"; Type = "Color"; Value = $(if ($emission) { $color } else { "0x000000FF" }) },
            [ordered]@{ Key = "_SPECULARHIGHLIGHTS_OFF"; Type = "Bool"; Value = $true },
            [ordered]@{ Key = "_SpecularHighlights"; Type = "Float"; Value = 1.0 },
            [ordered]@{ Key = "_GLOSSYREFLECTIONS_OFF"; Type = "Bool"; Value = $true },
            [ordered]@{ Key = "_GlossyReflections"; Type = "Float"; Value = 1.0 }
        )
    }
}

function Write-LegacyMaterials([object[]]$Materials, [string]$ContentRoot, [bool]$GenerateBuiltInTextures) {
    $materialsRoot = Join-Path $ContentRoot "materials"
    [IO.Directory]::CreateDirectory($materialsRoot) | Out-Null
    $materialIndex = 0
    foreach ($material in @($Materials)) {
        $materialIndex++
        $materialName = [string](Get-Property $material "Name" "Material $materialIndex")
        $safeName = [regex]::Replace($materialName, '[^A-Za-z0-9._-]+', '-').Trim('-')
        if ([string]::IsNullOrWhiteSpace($safeName)) { $safeName = "material-$materialIndex" }
        $textureKind = [string](Get-Property $material "Texture" "")
        $texturePath = ""
        if ($GenerateBuiltInTextures -and $textureKind -in @("Standart", "Inverted")) {
            $texturePath = "$safeName-$materialIndex.png"
            New-CheckerTexture (Join-Path $ContentRoot $texturePath) ([string](Get-Property $material "Color" "0xFFFFFF")) ($textureKind -eq "Inverted")
        }
        elseif (-not [string]::IsNullOrWhiteSpace($textureKind) -and (Test-Path -LiteralPath (Join-Path $ContentRoot $textureKind) -PathType Leaf)) {
            $texturePath = $textureKind.Replace("\", "/")
        }
        Write-Utf8Json (Join-Path $materialsRoot "$safeName-$materialIndex.json") (New-MaterialDocument $material $texturePath)
    }
}

function New-PlaceholderPreview([string]$Path, [string]$Title, [string]$BackgroundValue) {
    Add-Type -AssemblyName System.Drawing
    $hex = (Normalize-Color $BackgroundValue "0x86B7FFFF").Substring(2)
    $background = [Drawing.Color]::FromArgb(255, [Convert]::ToInt32($hex.Substring(0, 2), 16), [Convert]::ToInt32($hex.Substring(2, 2), 16), [Convert]::ToInt32($hex.Substring(4, 2), 16))
    $bitmap = [Drawing.Bitmap]::new(512, 416, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dark = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(28, 42, 100))
    $light = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(232, 242, 255))
    $black = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(5, 7, 12))
    $white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
    $font = [Drawing.Font]::new("Segoe UI", 27, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $format = [Drawing.StringFormat]::new(); $format.Alignment = [Drawing.StringAlignment]::Center; $format.LineAlignment = [Drawing.StringAlignment]::Center
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear($background)
        for ($row = 0; $row -lt 4; $row++) { for ($column = 0; $column -lt 6; $column++) { $graphics.FillRectangle($(if (($row + $column) % 2 -eq 0) { $light } else { $dark }), $column * 86, 220 + $row * 50, 86, 50) } }
        $graphics.FillEllipse($black, 196, 58, 120, 120)
        $graphics.FillEllipse($white, 254, 93, 42, 42)
        $graphics.FillRectangle($dark, 0, 184, 512, 62)
        $graphics.DrawString($(if ([string]::IsNullOrWhiteSpace($Title)) { "Recovered Steam item" } else { $Title }), $font, $white, [Drawing.RectangleF]::new(14, 184, 484, 62), $format)
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Jpeg)
    }
    finally { $format.Dispose(); $font.Dispose(); $white.Dispose(); $black.Dispose(); $light.Dispose(); $dark.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

function Find-Preview([string]$ContentRoot, [object]$RootMetadata) {
    $thumbnail = [string](Get-Property $RootMetadata "ThumbnailPath" "")
    if (-not [string]::IsNullOrWhiteSpace($thumbnail)) {
        $candidate = Join-Path $ContentRoot $thumbnail
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    $match = @(Get-ChildItem -LiteralPath $ContentRoot -File -Recurse -Force | Where-Object { $_.Extension.ToLowerInvariant() -in @(".png", ".jpg", ".jpeg") -and $_.BaseName -match '(?i)thumbnail|preview|icon|picture' } | Select-Object -First 1)
    if ($match.Count -eq 1) { return $match[0].FullName }
    return $null
}

function New-FileOnlyZip([string]$SourceRoot, [string]$DestinationPath, [string]$RequiredRootJson) {
    if (Test-Path -LiteralPath $DestinationPath) { Remove-Item -LiteralPath $DestinationPath -Force }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($DestinationPath)) | Out-Null
    $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd([char[]]"\/")
    $stream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force) {
            $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
            if (@($relative.Split("/") | Where-Object { $_ -ieq "backup" }).Count -gt 0) { continue }
            $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $source = $file.OpenRead(); $target = $entry.Open()
            try { $source.CopyTo($target) } finally { $target.Dispose(); $source.Dispose() }
        }
    }
    finally { $zip.Dispose() }
    $check = [IO.Compression.ZipFile]::OpenRead($DestinationPath)
    try {
        if (-not ($check.Entries | Where-Object { $_.FullName -ceq $RequiredRootJson })) { throw "Prepared ZIP is missing $RequiredRootJson at its root." }
        if ($check.Entries | Where-Object { [string]::IsNullOrEmpty($_.Name) }) { throw "Prepared ZIP contains directory-only entries." }
    }
    finally { $check.Dispose() }
}

try {
    [IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    $extractRoot = Join-Path $tempRoot "extracted"
    $contentRoot = Join-Path $tempRoot "content"
    [IO.Directory]::CreateDirectory($contentRoot) | Out-Null
    Expand-SafeZip (Resolve-Path -LiteralPath $ArchivePath).Path $extractRoot
    $steam = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
    $modern = Resolve-ModernRoot $extractRoot
    $resourceType = -1; $kind = ""; $version = "1.0.0"; $embeddedAuthor = ""; $requiredJson = ""; $rootMetadata = $null

    if ($null -ne $modern) {
        Copy-ContentTree $modern.Root $contentRoot
        $rootMetadata = Get-Content -Raw -LiteralPath (Join-Path $contentRoot ([IO.Path]::GetFileName($modern.JsonPath))) | ConvertFrom-Json
        $resourceType = [int]$modern.ResourceType; $kind = $modern.Kind
        $requiredJson = @("level.json", "block.json", "campaign.json")[$resourceType]
        $version = [string](Get-Property $rootMetadata "Version" "1.0.0")
        $embeddedAuthor = [string](Get-Property $rootMetadata "Author" "")
        $embeddedBlockGroups = Get-Property $rootMetadata "BlockGroups"
        if ($resourceType -eq 0 -and $null -ne $embeddedBlockGroups) {
            Normalize-BlockAttributes $embeddedBlockGroups
            Write-Utf8Json (Join-Path $contentRoot "block.json") $embeddedBlockGroups
            Write-LegacyMaterials @(Get-Property $rootMetadata "Materials" @()) $contentRoot $false
            $rootMetadata.PSObject.Properties.Remove("BlockGroups")
            $rootMetadata.PSObject.Properties.Remove("Materials")
            $rootMetadata | Add-Member -NotePropertyName "WorkshopId" -NotePropertyValue ([int64]$steam.publishedfileid) -Force
            $rootMetadata | Add-Member -NotePropertyName "Timestamp" -NotePropertyValue ([int64]$steam.time_created) -Force
            $rootMetadata | Add-Member -NotePropertyName "Author" -NotePropertyValue ([string]$steam.author_name) -Force
            $rootMetadata | Add-Member -NotePropertyName "Description" -NotePropertyValue ([string]$steam.description) -Force
            $rootMetadata | Add-Member -NotePropertyName "Tags" -NotePropertyValue @($steam.tags) -Force
            $rootMetadata | Add-Member -NotePropertyName "Version" -NotePropertyValue $version -Force
            $rootMetadata | Add-Member -NotePropertyName "Type" -NotePropertyValue "Level" -Force
            Write-Utf8Json (Join-Path $contentRoot "level.json") $rootMetadata
        }
        $preview = Find-Preview $contentRoot $rootMetadata
    }
    else {
        $payloadPath = Join-Path $extractRoot "payload.json"
        if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) { throw "Archive is neither a modern item nor a legacy payload.json package." }
        $payload = Get-Content -Raw -LiteralPath $payloadPath | ConvertFrom-Json
        $blockGroups = Get-Property $payload "BlockGroups"
        if ($null -ne $blockGroups) {
            $resourceType = 0; $kind = "Level"; $requiredJson = "level.json"
            Normalize-BlockAttributes $blockGroups
            Write-Utf8Json (Join-Path $contentRoot "block.json") $blockGroups
            $version = [string](Get-Property $payload "AppVersion" "1.0.0")
            if ([string]::IsNullOrWhiteSpace($version)) { $version = "1.0.0" }
            $embeddedAuthor = [string](Get-Property $payload "Author" "")
            $thumbnailName = "thumbnail.jpg"
            $thumbnailText = [string](Get-Property $payload "Thumbnail" "")
            if (-not [string]::IsNullOrWhiteSpace($thumbnailText)) {
                $bytes = [Convert]::FromBase64String($thumbnailText)
                if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $thumbnailName = "thumbnail.png" }
                [IO.File]::WriteAllBytes((Join-Path $contentRoot $thumbnailName), $bytes)
            }
            Write-LegacyMaterials @(Get-Property $payload "Materials" @()) $contentRoot $true
            $level = [ordered]@{
                RngSeed = [int64](Get-Property $payload "RngSeed" 0)
                UiColor = Normalize-Color ([string](Get-Property $payload "MediumColor" "0xD7E7FF"))
                BackgroundColor = Normalize-Color ([string](Get-Property $payload "BackgroundColor" "0xD7E7FF"))
                ThumbnailPath = $thumbnailName
                LevelType = [string](Get-Property $payload "LevelType" "Race")
                WorkshopId = [int64]$steam.publishedfileid
                Timestamp = [int64]$steam.time_created
                Author = [string]$steam.author_name
                Description = [string]$steam.description
                Tags = @($steam.tags)
                Version = $version
                Type = "Level"
            }
            Write-Utf8Json (Join-Path $contentRoot "level.json") $level
            $rootMetadata = [pscustomobject]$level
            $preview = Find-Preview $contentRoot $level
        }
        else {
            $resourceType = 1; $kind = "Block"; $requiredJson = "block.json"; $version = "1.0.0"
            Normalize-BlockAttributes $payload
            Write-Utf8Json (Join-Path $contentRoot "block.json") $payload
            $preview = $null
        }
    }

    if ($null -eq $preview -and -not [string]::IsNullOrWhiteSpace($FallbackPreviewPath) -and (Test-Path -LiteralPath $FallbackPreviewPath -PathType Leaf)) { $preview = (Resolve-Path -LiteralPath $FallbackPreviewPath).Path }
    if ($null -eq $preview) {
        $preview = Join-Path $contentRoot "thumbnail.jpg"
        New-PlaceholderPreview $preview ([string]$steam.title) ([string](Get-Property $rootMetadata "BackgroundColor" "0x86B7FF"))
        if ($null -ne $rootMetadata -and $resourceType -ne 1) {
            $rootMetadata | Add-Member -NotePropertyName "ThumbnailPath" -NotePropertyValue "thumbnail.jpg" -Force
            Write-Utf8Json (Join-Path $contentRoot $requiredJson) $rootMetadata
        }
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPreviewPath)) | Out-Null
    [IO.File]::Copy($preview, $OutputPreviewPath, $true)
    New-FileOnlyZip $contentRoot $OutputZipPath $requiredJson
    Write-Utf8Json $OutputInfoPath ([ordered]@{ ResourceType = $resourceType; Kind = $kind; Version = $version; EmbeddedAuthor = $embeddedAuthor; RequiredRootJson = $requiredJson })
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
