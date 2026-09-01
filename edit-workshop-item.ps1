[CmdletBinding()]
param(
    [int64]$Id,
    [string]$Name,
    [string]$Author,
    [string]$Description,
    [string]$Version,
    [string]$Tags,
    [string]$PreviewPath,
    [string]$ServerBaseUrl = "https://marble.kevin-kuhn.dev/api",
    [switch]$NonInteractive,
    [switch]$Push,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = $PSScriptRoot
$staticAssetLimit = 25MB
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("marble-workshop-edit-" + [guid]::NewGuid().ToString("N"))

function ConvertTo-Slug {
    param([string]$Value)

    $slug = $Value.ToLowerInvariant()
    $slug = [regex]::Replace($slug, "[^a-z0-9]+", "-").Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) { return "workshop-item" }
    return $slug
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
        $result = & git -c "safe.directory=$safeRepoRoot" @Arguments 2>&1
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

function Read-EditedValue {
    param(
        [string]$Label,
        [string]$CurrentValue,
        [bool]$WasSupplied,
        [string]$SuppliedValue,
        [bool]$CanClear = $false
    )

    if ($WasSupplied) { return $SuppliedValue }
    if ($NonInteractive) { return $CurrentValue }

    Write-Host "$Label`: $CurrentValue"
    $hint = if ($CanClear) { "Enter keeps it; type <clear> to empty" } else { "Enter keeps it" }
    $answer = Read-Host "New $Label ($hint)"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $CurrentValue }
    if ($CanClear -and $answer.Trim() -ceq "<clear>") { return "" }
    return $answer.Trim()
}

function Normalize-PathInput {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return $Value.Trim().Trim('"')
}

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $itemsPath = Join-Path $script:RepoRoot "items.json"
    $catalogPath = Join-Path $script:RepoRoot "cloudflare\catalog.mjs"
    $parsedItems = Get-Content -Raw -LiteralPath $itemsPath | ConvertFrom-Json
    $items = @($parsedItems | Where-Object {
        $null -ne $_ -and
        $null -ne $_.PSObject.Properties["Id"] -and
        $null -ne $_.PSObject.Properties["Name"]
    })
    if ($items.Count -eq 0) { throw "The workshop catalog is empty." }

    $selected = $null
    if ($PSBoundParameters.ContainsKey("Id")) {
        $matches = @($items | Where-Object { [int64]$_.Id -eq $Id })
        if ($matches.Count -ne 1) { throw "No workshop item has ID $Id." }
        $selected = $matches[0]
    }
    elseif ($NonInteractive) {
        throw "Non-interactive editing requires -Id."
    }
    else {
        Write-Host ""
        Write-Host "Workshop items"
        for ($index = 0; $index -lt $items.Count; $index++) {
            $kind = switch ([int]$items[$index].ResourceType) {
                0 { "Level" }
                1 { "Block" }
                2 { "Campaign" }
                default { "Type $($items[$index].ResourceType)" }
            }
            Write-Host ("  {0,2}. {1} [{2}] (ID {3})" -f ($index + 1), $items[$index].Name, $kind, $items[$index].Id)
        }
        Write-Host ""
        $answer = Read-Host "Choose an item number"
        $selectionNumber = 0
        if (-not [int]::TryParse($answer, [ref]$selectionNumber) -or $selectionNumber -lt 1 -or $selectionNumber -gt $items.Count) {
            throw "Choose a number from 1 to $($items.Count)."
        }
        $selected = $items[$selectionNumber - 1]
    }

    $oldName = [string]$selected.Name
    $oldAuthor = [string]$selected.AuthorName
    $oldDescription = [string]$selected.Description
    $oldVersion = [string]$selected.Version
    $oldTags = @($selected.Tags | ForEach-Object { [string]$_ })

    Write-Host ""
    Write-Host "Editing: $oldName"
    Write-Host "ID and payload information are protected and will not be changed."
    Write-Host ""

    $newName = Read-EditedValue "name" $oldName $PSBoundParameters.ContainsKey("Name") $Name
    $newAuthor = Read-EditedValue "author" $oldAuthor $PSBoundParameters.ContainsKey("Author") $Author
    $newDescription = Read-EditedValue "description" $oldDescription $PSBoundParameters.ContainsKey("Description") $Description $true
    $newVersion = Read-EditedValue "minimum game version" $oldVersion $PSBoundParameters.ContainsKey("Version") $Version
    $oldTagsText = $oldTags -join ", "
    $newTagsText = Read-EditedValue "tags" $oldTagsText $PSBoundParameters.ContainsKey("Tags") $Tags $true
    $newTags = @($newTagsText.Split(",", [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ })

    if ([string]::IsNullOrWhiteSpace($newName)) { throw "Name cannot be empty." }
    if ([string]::IsNullOrWhiteSpace($newAuthor)) { throw "Author cannot be empty." }
    if ([string]::IsNullOrWhiteSpace($newVersion)) { throw "Minimum game version cannot be empty." }

    $newPreviewSource = Normalize-PathInput $PreviewPath
    if (-not $PSBoundParameters.ContainsKey("PreviewPath") -and -not $NonInteractive) {
        $newPreviewSource = Normalize-PathInput (Read-Host "New preview PNG/JPEG path (Enter keeps current preview)")
    }
    if (-not [string]::IsNullOrWhiteSpace($newPreviewSource)) {
        $newPreviewSource = (Resolve-Path -LiteralPath $newPreviewSource).Path
        $previewExtension = [IO.Path]::GetExtension($newPreviewSource).ToLowerInvariant()
        if ($previewExtension -notin @(".png", ".jpg", ".jpeg")) { throw "Preview must be a PNG or JPEG image." }
        if ((Get-Item -LiteralPath $newPreviewSource).Length -gt $staticAssetLimit) {
            throw "Preview exceeds Cloudflare's 25 MiB static asset limit."
        }
    }

    $metadataChanged =
        $newName -cne $oldName -or
        $newAuthor -cne $oldAuthor -or
        $newDescription -cne $oldDescription -or
        $newVersion -cne $oldVersion -or
        ($newTags -join "`n") -cne ($oldTags -join "`n")
    if (-not $metadataChanged -and [string]::IsNullOrWhiteSpace($newPreviewSource)) {
        Write-Host "No changes were entered. Nothing was modified."
        return
    }

    $itemsBackup = Join-Path $tempRoot "items.json.backup"
    $catalogBackup = Join-Path $tempRoot "catalog.mjs.backup"
    Copy-Item -LiteralPath $itemsPath -Destination $itemsBackup
    Copy-Item -LiteralPath $catalogPath -Destination $catalogBackup

    $previewRelative = $null
    $previewTarget = $null
    $previewExisted = $false
    $previewBackup = Join-Path $tempRoot "preview.backup"
    if (-not [string]::IsNullOrWhiteSpace($newPreviewSource)) {
        $previewExtension = [IO.Path]::GetExtension($newPreviewSource).ToLowerInvariant()
        if ($previewExtension -eq ".jpeg") { $previewExtension = ".jpg" }
        $previewFileName = "$(ConvertTo-Slug $newName)$previewExtension"
        $previewRelative = "public/previews/$previewFileName"
        $previewTarget = Join-Path $script:RepoRoot $previewRelative
        $previewExisted = Test-Path -LiteralPath $previewTarget -PathType Leaf
        if ($previewExisted) { Copy-Item -LiteralPath $previewTarget -Destination $previewBackup }
    }

    try {
        $selected.Name = $newName
        $selected.AuthorName = $newAuthor
        $selected.Description = $newDescription
        $selected.Version = $newVersion
        $selected.Tags = [object[]]$newTags
        $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $selected.TimeStamp = $timestamp

        if ($null -ne $previewTarget) {
            Copy-Item -LiteralPath $newPreviewSource -Destination $previewTarget -Force
            $selected.PreviewUri = "/previews/$previewFileName"
        }

        $itemsJson = ConvertTo-Json -InputObject ([object[]]$items) -Depth 100
        [IO.File]::WriteAllText($itemsPath, $itemsJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Sync-CloudflareCatalog $itemsJson

        Push-Location $script:RepoRoot
        try {
            Write-Host "Running server tests ..."
            & node --test
            if ($LASTEXITCODE -ne 0) { throw "Server tests failed." }
        }
        finally {
            Pop-Location
        }

        if ($ValidateOnly) {
            Copy-Item -LiteralPath $itemsBackup -Destination $itemsPath -Force
            Copy-Item -LiteralPath $catalogBackup -Destination $catalogPath -Force
            if ($null -ne $previewTarget) {
                if ($previewExisted) { Copy-Item -LiteralPath $previewBackup -Destination $previewTarget -Force }
                elseif (Test-Path -LiteralPath $previewTarget -PathType Leaf) { Remove-Item -LiteralPath $previewTarget -Force }
            }
            Write-Host "Validation passed. No repository files were changed."
            return
        }
    }
    catch {
        Copy-Item -LiteralPath $itemsBackup -Destination $itemsPath -Force
        Copy-Item -LiteralPath $catalogBackup -Destination $catalogPath -Force
        if ($null -ne $previewTarget) {
            if ($previewExisted) { Copy-Item -LiteralPath $previewBackup -Destination $previewTarget -Force }
            elseif (Test-Path -LiteralPath $previewTarget -PathType Leaf) { Remove-Item -LiteralPath $previewTarget -Force }
        }
        throw
    }

    $shouldPush = $Push.IsPresent
    if (-not $Push -and -not $NonInteractive) {
        $deployAnswer = Read-Host "Commit and deploy these changes now? [Y/n]"
        $shouldPush = $deployAnswer -notmatch '^(?i)n(?:o)?$'
    }

    if (-not $shouldPush) {
        Write-Host "Changes prepared but not committed."
        return
    }

    $pathsToAdd = @("items.json", "cloudflare/catalog.mjs")
    if ($null -ne $previewRelative) { $pathsToAdd += $previewRelative }
    Invoke-RepoGit (@("add", "--") + $pathsToAdd) | Out-Null
    Invoke-RepoGit @("commit", "-m", "Edit workshop item: $oldName") | Write-Host
    Invoke-RepoGit @("push", "origin", "HEAD") | Write-Host

    Write-Host "Waiting for Cloudflare to publish item ID $($selected.Id) ..."
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(7)
    $live = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $published = Invoke-RestMethod -Uri "$ServerBaseUrl/GetItem?id=$($selected.Id)" -Headers @{ "Cache-Control" = "no-cache" }
            if ([int64]$published.TimeStamp -eq $timestamp) {
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
        throw "Git push succeeded, but the edited item did not appear at $ServerBaseUrl within seven minutes. Check Cloudflare Builds."
    }

    Write-Host "Published successfully: $newName"
    Write-Host "Workshop API: $ServerBaseUrl"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
        $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
        if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTemp).StartsWith("marble-workshop-edit-")) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
