[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ArchivePath,

    [string]$Name,
    [string]$Author,
    [string]$Description,
    [string]$Version,
    [string]$PreviewPath,
    [string]$ServerBaseUrl = "https://marble.kevin-kuhn.dev/api",
    [string]$R2Bucket = "marble-race-workshop-content",
    [string]$R2PublicBaseUrl = "https://content.marble.kevin-kuhn.dev",
    [switch]$NonInteractive,
    [switch]$Push,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = $PSScriptRoot
$staticAssetLimit = 25MB
$customIdFloor = [int64]990000000001
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("marble-workshop-publish-" + [guid]::NewGuid().ToString("N"))

function Get-ObjectProperty {
    param(
        [object]$Object,
        [string]$PropertyName,
        [object]$Fallback = $null
    )

    if ($null -eq $Object) { return $Fallback }
    $property = $Object.PSObject.Properties[$PropertyName]
    if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
    return $property.Value
}

function ConvertTo-Slug {
    param([string]$Value)

    $slug = $Value.ToLowerInvariant()
    $slug = [regex]::Replace($slug, "[^a-z0-9]+", "-").Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) { return "workshop-item" }
    return $slug
}

function Resolve-ContentRoot {
    param([string]$ExtractedPath)

    $current = (Resolve-Path -LiteralPath $ExtractedPath).Path
    for ($depth = 0; $depth -lt 8; $depth++) {
        $files = @(Get-ChildItem -LiteralPath $current -File -Force)
        $campaign = @($files | Where-Object { $_.Name -ieq "campaign.json" } | Select-Object -First 1)
        $level = @($files | Where-Object { $_.Name -ieq "level.json" } | Select-Object -First 1)
        $block = @($files | Where-Object { $_.Name -ieq "block.json" } | Select-Object -First 1)

        if ($campaign.Count -eq 1) {
            return [pscustomobject]@{ Root = $current; JsonPath = $campaign[0].FullName; ResourceType = 2; Kind = "Campaign" }
        }
        if ($level.Count -eq 1) {
            return [pscustomobject]@{ Root = $current; JsonPath = $level[0].FullName; ResourceType = 0; Kind = "Level" }
        }
        if ($block.Count -eq 1) {
            return [pscustomobject]@{ Root = $current; JsonPath = $block[0].FullName; ResourceType = 1; Kind = "Block" }
        }

        $children = @(Get-ChildItem -LiteralPath $current -Force | Where-Object {
            $_.Name -notin @("__MACOSX", ".DS_Store")
        })
        if ($children.Count -ne 1 -or -not $children[0].PSIsContainer) {
            throw "Could not find campaign.json, level.json, or block.json at the archive root (or inside one enclosing folder)."
        }
        $current = $children[0].FullName
    }

    throw "The archive has too many enclosing folders."
}

function New-FileOnlyZip {
    param(
        [string]$SourceRoot,
        [string]$DestinationPath,
        [string]$RequiredRootJson
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd("\", "/")
    $allFiles = @(Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force)
    if ($allFiles.Count -eq 0) { throw "The workshop archive contains no files." }

    $excludedBackupFiles = @()
    $includedFiles = @()
    foreach ($file in $allFiles) {
        $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
        $pathParts = $relative.Split("/", [StringSplitOptions]::RemoveEmptyEntries)
        if (@($pathParts | Where-Object { $_ -ieq "backup" }).Count -gt 0) {
            $excludedBackupFiles += $file
        }
        else {
            $includedFiles += $file
        }
    }
    if ($includedFiles.Count -eq 0) { throw "Only backup files remained after cleanup." }

    foreach ($file in $includedFiles) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Archive contains a link/reparse point, which is not allowed: $($file.FullName)"
        }
        if (-not $file.FullName.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Archive file escaped the expected content root: $($file.FullName)"
        }
    }

    $destinationStream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $zip = [IO.Compression.ZipArchive]::new($destinationStream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in $includedFiles) {
            $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
            if ($relative.Split("/") -contains "..") { throw "Unsafe archive path: $relative" }
            $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $file.LastWriteTime
            $sourceStream = $file.OpenRead()
            $entryStream = $entry.Open()
            try {
                $sourceStream.CopyTo($entryStream)
            }
            finally {
                $entryStream.Dispose()
                $sourceStream.Dispose()
            }
        }
    }
    finally {
        $zip.Dispose()
    }

    $check = [IO.Compression.ZipFile]::OpenRead($DestinationPath)
    try {
        $directoryEntries = @($check.Entries | Where-Object { [string]::IsNullOrEmpty($_.Name) })
        if ($directoryEntries.Count -ne 0) { throw "Generated ZIP contains directory-only entries." }
        if (-not ($check.Entries | Where-Object { $_.FullName -ceq $RequiredRootJson })) {
            throw "Generated ZIP does not contain $RequiredRootJson at its root."
        }
    }
    finally {
        $check.Dispose()
    }

    return [pscustomobject]@{
        IncludedFiles = $includedFiles.Count
        ExcludedBackupFiles = $excludedBackupFiles.Count
        ExcludedBackupBytes = [int64](($excludedBackupFiles | Measure-Object -Property Length -Sum).Sum)
    }
}

function New-CampaignPreview {
    param(
        [string]$ContentRoot,
        [string]$DestinationPath
    )

    Add-Type -AssemblyName System.Drawing
    $root = (Resolve-Path -LiteralPath $ContentRoot).Path.TrimEnd("\", "/")
    $levelJsonFiles = @(Get-ChildItem -LiteralPath $root -Filter "level.json" -File -Recurse -Force | Where-Object {
        $relative = $_.FullName.Substring($root.Length).TrimStart([char[]]"\/").Replace("\", "/")
        @($relative.Split("/", [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_ -ieq "backup" }).Count -eq 0
    } | Sort-Object FullName)

    $candidates = @()
    foreach ($levelJson in $levelJsonFiles) {
        $levelRoot = $levelJson.Directory.FullName
        $levelMetadata = $null
        try { $levelMetadata = Get-Content -Raw -LiteralPath $levelJson.FullName | ConvertFrom-Json }
        catch { continue }

        $thumbnail = [string](Get-ObjectProperty $levelMetadata "ThumbnailPath" "")
        $candidate = $null
        if (-not [string]::IsNullOrWhiteSpace($thumbnail)) {
            $metadataCandidate = Join-Path $levelRoot $thumbnail
            if (Test-Path -LiteralPath $metadataCandidate -PathType Leaf) {
                $resolvedCandidate = (Resolve-Path -LiteralPath $metadataCandidate).Path
                $levelPrefix = $levelRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
                if ($resolvedCandidate.StartsWith($levelPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $candidate = $resolvedCandidate
                }
            }
        }

        if ($null -eq $candidate) {
            $matches = @(Get-ChildItem -LiteralPath $levelRoot -File -Force | Where-Object {
                $_.Extension.ToLowerInvariant() -in @(".png", ".jpg", ".jpeg") -and
                $_.BaseName -match "(?i)^(thumbnail|preview|icon|picture)$"
            } | Sort-Object Name | Select-Object -First 1)
            if ($matches.Count -eq 1) { $candidate = $matches[0].FullName }
        }

        if ($null -ne $candidate -and $candidates -notcontains $candidate) {
            $candidates += $candidate
        }
    }

    if ($candidates.Count -eq 0) {
        throw "No preview image was found in the campaign or any of its levels. Pass -PreviewPath with a PNG or JPEG file."
    }

    $canvasWidth = 512
    $canvasHeight = 416
    $gap = 4
    $cellWidth = [int](($canvasWidth - $gap) / 2)
    $cellHeight = [int](($canvasHeight - $gap) / 2)
    $bitmap = [Drawing.Bitmap]::new($canvasWidth, $canvasHeight, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $drawn = 0
    try {
        $graphics.Clear([Drawing.Color]::FromArgb(20, 24, 32))
        $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality

        foreach ($candidate in $candidates) {
            if ($drawn -ge 4) { break }
            $image = $null
            try {
                $image = [Drawing.Image]::FromFile($candidate)
                if ($image.Width -le 0 -or $image.Height -le 0) { continue }

                $column = $drawn % 2
                $row = [int][math]::Floor($drawn / 2)
                $destination = [Drawing.Rectangle]::new(
                    $column * ($cellWidth + $gap),
                    $row * ($cellHeight + $gap),
                    $cellWidth,
                    $cellHeight
                )

                $cellAspect = $cellWidth / [double]$cellHeight
                $imageAspect = $image.Width / [double]$image.Height
                if ($imageAspect -gt $cellAspect) {
                    $sourceHeight = $image.Height
                    $sourceWidth = [int][math]::Round($sourceHeight * $cellAspect)
                    $sourceX = [int][math]::Floor(($image.Width - $sourceWidth) / 2)
                    $sourceY = 0
                }
                else {
                    $sourceWidth = $image.Width
                    $sourceHeight = [int][math]::Round($sourceWidth / $cellAspect)
                    $sourceX = 0
                    $sourceY = [int][math]::Floor(($image.Height - $sourceHeight) / 2)
                }

                $graphics.DrawImage(
                    $image,
                    $destination,
                    $sourceX,
                    $sourceY,
                    $sourceWidth,
                    $sourceHeight,
                    [Drawing.GraphicsUnit]::Pixel
                )
                $drawn++
            }
            catch {
                # Skip an unreadable level thumbnail and try the next level.
            }
            finally {
                if ($null -ne $image) { $image.Dispose() }
            }
        }

        if ($drawn -eq 0) { throw "The campaign's level thumbnails could not be decoded." }
        $bitmap.Save($DestinationPath, [Drawing.Imaging.ImageFormat]::Jpeg)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    Write-Host "Generated campaign preview from $drawn level thumbnail(s)."
    return $DestinationPath
}

function Find-PreviewFile {
    param(
        [string]$ContentRoot,
        [object]$Metadata,
        [string]$ExplicitPreview,
        [int]$ResourceType,
        [string]$GeneratedPreviewPath
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPreview)) {
        return (Resolve-Path -LiteralPath $ExplicitPreview).Path
    }

    $thumbnail = [string](Get-ObjectProperty $Metadata "ThumbnailPath" "")
    if (-not [string]::IsNullOrWhiteSpace($thumbnail)) {
        $candidate = Join-Path $ContentRoot $thumbnail
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $resolved = (Resolve-Path -LiteralPath $candidate).Path
            $rootPrefix = (Resolve-Path -LiteralPath $ContentRoot).Path.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
            if (-not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "ThumbnailPath points outside the workshop item."
            }
            return $resolved
        }
    }

    $preview = @(Get-ChildItem -LiteralPath $ContentRoot -File -Force | Where-Object {
        $_.Extension.ToLowerInvariant() -in @(".png", ".jpg", ".jpeg") -and
        $_.BaseName -match "(?i)thumbnail|preview|icon|picture"
    } | Select-Object -First 1)
    if ($preview.Count -eq 1) { return $preview[0].FullName }

    if ($ResourceType -eq 2) {
        return New-CampaignPreview $ContentRoot $GeneratedPreviewPath
    }

    $anyImage = @(Get-ChildItem -LiteralPath $ContentRoot -File -Force | Where-Object {
        $_.Extension.ToLowerInvariant() -in @(".png", ".jpg", ".jpeg")
    } | Select-Object -First 1)
    if ($anyImage.Count -eq 1) { return $anyImage[0].FullName }

    throw "No preview image was found. Pass -PreviewPath with a PNG or JPEG file."
}

function Sync-CloudflareCatalog {
    param([string]$ItemsJson)

    $catalogPath = Join-Path $script:RepoRoot "cloudflare\catalog.mjs"
    $catalog = [IO.File]::ReadAllText($catalogPath)
    $pattern = [regex]::new('(?s)\Aexport const items = \[.*?\r?\n\];(?=\r?\n\r?\nexport function json)')
    if (-not $pattern.IsMatch($catalog)) {
        throw "Could not locate the generated item array in cloudflare/catalog.mjs."
    }
    $replacement = "export const items = " + $ItemsJson.Trim() + ";"
    $updated = $pattern.Replace($catalog, $replacement, 1)
    [IO.File]::WriteAllText($catalogPath, $updated, [Text.UTF8Encoding]::new($false))
}

function Invoke-RepoGit {
    param([string[]]$Arguments)

    $safeRepoRoot = $script:RepoRoot.Replace("\", "/")
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Git writes harmless warnings to stderr even when it succeeds. Windows
        # PowerShell otherwise turns those warnings into terminating errors.
        $ErrorActionPreference = "Continue"
        $result = & git -c "safe.directory=$safeRepoRoot" -C $script:RepoRoot @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed:`n$($result -join [Environment]::NewLine)"
    }
    return $result
}

function Get-WranglerCommand {
    $localWrangler = Join-Path $script:RepoRoot "node_modules\.bin\wrangler.cmd"
    if (Test-Path -LiteralPath $localWrangler -PathType Leaf) {
        return $localWrangler
    }

    $wrangler = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
    if ($null -ne $wrangler) { return $wrangler.Source }

    throw "Wrangler is not installed. Run npm install in the server folder once, then try again."
}

function Publish-R2Object {
    param(
        [string]$Bucket,
        [string]$Key,
        [string]$FilePath
    )

    $wrangler = Get-WranglerCommand
    Write-Host "Uploading payload to Cloudflare R2 ..."
    $previousErrorActionPreference = $ErrorActionPreference
    $hadCodexCi = Test-Path Env:CODEX_CI
    $savedCodexCi = if ($hadCodexCi) { (Get-Item Env:CODEX_CI).Value } else { $null }
    try {
        # CODEX_CI describes the parent app, not this user-started publisher.
        # Wrangler treats it as a headless CI session and refuses to use the
        # user's saved OAuth login, so do not pass that flag to Wrangler.
        Remove-Item Env:CODEX_CI -ErrorAction SilentlyContinue

        # Let Wrangler inherit the real console. Capturing or piping its output
        # makes Node report that stdout is not interactive, which prevents
        # Wrangler from using the saved browser-login credentials.
        $ErrorActionPreference = "Continue"
        & $wrangler r2 object put "$Bucket/$Key" --file $FilePath --content-type "application/zip" --cache-control "public, max-age=31536000, immutable" --remote
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hadCodexCi) {
            $env:CODEX_CI = $savedCodexCi
        }
        else {
            Remove-Item Env:CODEX_CI -ErrorAction SilentlyContinue
        }
    }

    if ($exitCode -ne 0) {
        throw "R2 upload failed. Wrangler printed the details above. If it reports an expired login, run 'npx wrangler login' once and try again."
    }
}

function Read-WithDefault {
    param(
        [string]$Label,
        [string]$CurrentValue,
        [bool]$WasSupplied
    )

    if ($NonInteractive -or $WasSupplied) { return $CurrentValue }
    $answer = Read-Host "$Label [$CurrentValue]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $CurrentValue }
    return $answer.Trim()
}

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
    if ([IO.Path]::GetExtension($resolvedArchive).ToLowerInvariant() -notin @(".zip", ".rar")) {
        throw "Only ZIP and RAR archives are supported."
    }

    $sevenZip = (Get-Command 7z -ErrorAction Stop).Source
    $extractPath = Join-Path $tempRoot "extracted"
    New-Item -ItemType Directory -Path $extractPath | Out-Null
    Write-Host "Extracting $resolvedArchive ..."
    & $sevenZip x -y "-o$extractPath" -- $resolvedArchive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract the archive." }

    $detected = Resolve-ContentRoot $extractPath
    $metadata = Get-Content -Raw -LiteralPath $detected.JsonPath | ConvertFrom-Json
    $archiveName = [IO.Path]::GetFileNameWithoutExtension($resolvedArchive)
    $embeddedAuthor = [string](Get-ObjectProperty $metadata "Author" "Unknown")
    $embeddedDescription = [string](Get-ObjectProperty $metadata "Description" "")
    $embeddedVersion = [string](Get-ObjectProperty $metadata "Version" "0.0")

    $displayName = Read-WithDefault "Display name" $(if ($Name) { $Name } else { $archiveName }) (-not [string]::IsNullOrWhiteSpace($Name))
    $authorName = Read-WithDefault "Author" $(if ($Author) { $Author } else { $embeddedAuthor }) (-not [string]::IsNullOrWhiteSpace($Author))
    $itemDescription = Read-WithDefault "Description" $(if ($Description) { $Description } else { $embeddedDescription }) (-not [string]::IsNullOrWhiteSpace($Description))
    $itemVersion = Read-WithDefault "Minimum game version" $(if ($Version) { $Version } else { $embeddedVersion }) (-not [string]::IsNullOrWhiteSpace($Version))
    if ([string]::IsNullOrWhiteSpace($displayName) -or $displayName -in @(".", "..") -or
        $displayName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw "Display name must be a non-empty, filesystem-safe directory name."
    }
    if ([string]::IsNullOrWhiteSpace($itemVersion)) { $itemVersion = "0.0" }

    $generatedPreview = Join-Path $tempRoot "campaign-preview.jpg"
    $previewSource = Find-PreviewFile $detected.Root $metadata $PreviewPath $detected.ResourceType $generatedPreview
    if ([IO.Path]::GetExtension($previewSource).ToLowerInvariant() -notin @(".png", ".jpg", ".jpeg")) {
        throw "Preview must be a PNG or JPEG image."
    }
    $rootJsonName = [IO.Path]::GetFileName($detected.JsonPath).ToLowerInvariant()
    $normalizedZip = Join-Path $tempRoot "normalized.zip"
    Write-Host "Building Android-compatible ZIP (file entries only) ..."
    $zipResult = New-FileOnlyZip $detected.Root $normalizedZip $rootJsonName
    $normalizedInfo = Get-Item -LiteralPath $normalizedZip

    Write-Host ""
    Write-Host "Detected item"
    Write-Host "  Name:       $displayName"
    Write-Host "  Type:       $($detected.Kind) ($($detected.ResourceType))"
    Write-Host "  Author:     $authorName"
    Write-Host "  Version:    $itemVersion"
    Write-Host "  Preview:    $previewSource"
    Write-Host "  ZIP bytes:  $($normalizedInfo.Length)"
    Write-Host "  Root JSON:  $rootJsonName"
    Write-Host "  Files:      $($zipResult.IncludedFiles)"
    if ($zipResult.ExcludedBackupFiles -gt 0) {
        $savedMiB = [math]::Round($zipResult.ExcludedBackupBytes / 1MB, 2)
        Write-Host "  Removed:    $($zipResult.ExcludedBackupFiles) backup files ($savedMiB MiB before compression)"
    }
    Write-Host ""

    if ($ValidateOnly) {
        Write-Host "Validation passed. No repository files were changed."
        return
    }

    $itemsPath = Join-Path $script:RepoRoot "items.json"
    $parsedItems = Get-Content -Raw -LiteralPath $itemsPath | ConvertFrom-Json
    $items = @($parsedItems | Where-Object {
        $null -ne $_ -and
        $null -ne $_.PSObject.Properties["Id"] -and
        $null -ne $_.PSObject.Properties["Name"]
    })
    $matching = @($items | Where-Object { $_.Name -ieq $displayName })
    if ($matching.Count -gt 1) { throw "More than one existing item is named '$displayName'." }

    if ($matching.Count -eq 1) {
        $itemId = [int64]$matching[0].Id
        Write-Host "Updating existing workshop item ID $itemId."
    }
    else {
        $usedCustomIds = @($items | ForEach-Object { [int64]$_.Id } | Where-Object { $_ -ge $customIdFloor })
        $itemId = if ($usedCustomIds.Count -eq 0) { $customIdFloor } else { [int64](($usedCustomIds | Measure-Object -Maximum).Maximum + 1) }
        Write-Host "Assigned new workshop item ID $itemId."
    }

    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $slug = ConvertTo-Slug $displayName
    $previewExtension = [IO.Path]::GetExtension($previewSource).ToLowerInvariant()
    if ($previewExtension -eq ".jpeg") { $previewExtension = ".jpg" }
    $previewFileName = "$slug$previewExtension"
    $previewRelative = "public/previews/$previewFileName"
    $previewTarget = Join-Path $script:RepoRoot $previewRelative
    $previewInfo = Get-Item -LiteralPath $previewSource
    if ($previewInfo.Length -gt $staticAssetLimit) { throw "Preview exceeds Cloudflare's 25 MiB static asset limit." }
    $payloadFileName = "$slug-$timestamp.zip"
    $payloadKey = "payloads/$payloadFileName"
    $payloadUri = $R2PublicBaseUrl.TrimEnd("/") + "/" + $payloadKey

    # Save the catalog and preview so a validation or upload failure can roll back cleanly.
    $itemsBackup = Join-Path $tempRoot "items.json.backup"
    $catalogPath = Join-Path $script:RepoRoot "cloudflare\catalog.mjs"
    $catalogBackup = Join-Path $tempRoot "catalog.mjs.backup"
    Copy-Item -LiteralPath $itemsPath -Destination $itemsBackup
    Copy-Item -LiteralPath $catalogPath -Destination $catalogBackup
    $previewExisted = Test-Path -LiteralPath $previewTarget -PathType Leaf
    $previewBackup = Join-Path $tempRoot "preview.backup"
    if ($previewExisted) { Copy-Item -LiteralPath $previewTarget -Destination $previewBackup }

    # Do not mutate the repository until all size and storage checks pass.
    Copy-Item -LiteralPath $previewSource -Destination $previewTarget -Force

    $metadataTags = @(Get-ObjectProperty $metadata "Tags" @())
    if ($metadataTags.Count -eq 0) { $metadataTags = @($detected.Kind.ToLowerInvariant()) }
    $newItem = [ordered]@{
        Id = $itemId
        Name = $displayName
        ResourceType = $detected.ResourceType
        TimeStamp = $timestamp
        AuthorId = 0
        AuthorName = $authorName
        PreviewUri = "/previews/$previewFileName"
        PayloadUri = $payloadUri
        Description = $itemDescription
        PayloadLength = $normalizedInfo.Length
        Version = $itemVersion
        Tags = $metadataTags
        Downloads = 0
        Rating = 0
    }

    $updatedItems = @()
    $replaced = $false
    foreach ($item in $items) {
        if ([int64]$item.Id -eq $itemId) {
            $updatedItems += [pscustomobject]$newItem
            $replaced = $true
        }
        else {
            $updatedItems += $item
        }
    }
    if (-not $replaced) { $updatedItems += [pscustomobject]$newItem }

    try {
        $itemsJson = ConvertTo-Json -InputObject ([object[]]$updatedItems) -Depth 100
        [IO.File]::WriteAllText($itemsPath, $itemsJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Sync-CloudflareCatalog $itemsJson

        Push-Location $script:RepoRoot
        try {
            Write-Host "Running server tests ..."
            & node --test
            if ($LASTEXITCODE -ne 0) { throw "Server tests failed. Nothing was committed or pushed." }
        }
        finally {
            Pop-Location
        }

        Publish-R2Object $R2Bucket $payloadKey $normalizedZip
    }
    catch {
        Copy-Item -LiteralPath $itemsBackup -Destination $itemsPath -Force
        Copy-Item -LiteralPath $catalogBackup -Destination $catalogPath -Force
        if ($previewExisted) {
            Copy-Item -LiteralPath $previewBackup -Destination $previewTarget -Force
        }
        elseif (Test-Path -LiteralPath $previewTarget -PathType Leaf) {
            Remove-Item -LiteralPath $previewTarget -Force
        }
        throw
    }

    $shouldPush = $Push.IsPresent
    if (-not $Push -and -not $NonInteractive) {
        $deployAnswer = Read-Host "Commit and deploy this item now? [Y/n]"
        $shouldPush = $deployAnswer -notmatch '^(?i)n(?:o)?$'
    }

    if (-not $shouldPush) {
        Write-Host "Prepared successfully but not committed. Review the changes, then commit and push when ready."
        return
    }

    Invoke-RepoGit @("add", "--", "items.json", "cloudflare/catalog.mjs", $previewRelative) | Out-Null
    Invoke-RepoGit @("commit", "-m", "Publish workshop item: $displayName") | Write-Host
    Invoke-RepoGit @("push", "origin", "HEAD") | Write-Host

    Write-Host "Waiting for Cloudflare to publish item ID $itemId ..."
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(7)
    $live = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            # Invoke-RestMethod already returns the JSON array. Wrapping the
            # invocation in @() creates a nested array in newer PowerShell,
            # causing each property lookup below to see the entire catalog.
            $catalog = Invoke-RestMethod -Uri "$ServerBaseUrl/Items?limit=1000&skip=0" -Headers @{ "Cache-Control" = "no-cache" }
            $published = @($catalog | Where-Object { [int64]$_.Id -eq $itemId -and [int64]$_.TimeStamp -eq $timestamp })
            if ($published.Count -eq 1) {
                $live = $true
                break
            }
        }
        catch {
            # A deployment can briefly make the endpoint unavailable; retry.
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 10
    }
    Write-Host ""
    if (-not $live) {
        throw "Git push succeeded, but the updated item did not appear at $ServerBaseUrl within seven minutes. Check Cloudflare Builds."
    }

    Write-Host "Published successfully: $displayName"
    Write-Host "Workshop API: $ServerBaseUrl"
    Write-Host "Payload:      $payloadUri"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
        $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
        if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTemp).StartsWith("marble-workshop-publish-")) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
