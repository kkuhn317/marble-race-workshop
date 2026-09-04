$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

function Invoke-RepoGit {
    param([string[]]$Arguments)

    $safeRepoRoot = $PSScriptRoot.Replace("\", "/")
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $result = & git -c "safe.directory=$safeRepoRoot" -C $PSScriptRoot @Arguments 2>&1
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

function Wait-ForBatchDeployment {
    param(
        [object[]]$Items,
        [string]$ServerBaseUrl = "https://marble.kevin-kuhn.dev/api"
    )

    Write-Host "Waiting for one Cloudflare deployment containing all $($Items.Count) items ..."
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(7)
    $remaining = @($Items)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $catalog = Invoke-RestMethod -Uri "$ServerBaseUrl/Items?limit=1000&skip=0" -Headers @{ "Cache-Control" = "no-cache" }
            $remaining = @($Items | Where-Object {
                $expected = $_
                -not @($catalog | Where-Object {
                    [int64]$_.Id -eq [int64]$expected.Id -and
                    [int64]$_.TimeStamp -eq [int64]$expected.TimeStamp
                }).Count
            })
            if ($remaining.Count -eq 0) { return }
        }
        catch {
            # The endpoint can be briefly unavailable while the deployment switches over.
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 10
    }
    Write-Host ""
    $missingIds = @($remaining | ForEach-Object { $_.Id }) -join ", "
    throw "Git push succeeded, but item IDs $missingIds did not appear within seven minutes. Check Cloudflare Builds."
}

function Read-BatchManifest {
    param([string]$ManifestPath)

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return @() }
    return @(Get-Content -LiteralPath $ManifestPath -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {
        $_ | ConvertFrom-Json
    })
}

function Remove-AbandonedBatch {
    param([string]$ManifestPath)

    $batchItems = @(Read-BatchManifest $ManifestPath)
    if ($batchItems.Count -eq 0) { return }

    Write-Host ""
    Write-Host "Cleaning up $($batchItems.Count) prepared item(s) from the interrupted batch ..." -ForegroundColor Yellow
    $wrangler = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"
    if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
        throw "Cannot clean up the interrupted R2 uploads because Wrangler is not installed."
    }

    $hadCodexCi = Test-Path Env:CODEX_CI
    $savedCodexCi = if ($hadCodexCi) { (Get-Item Env:CODEX_CI).Value } else { $null }
    try {
        Remove-Item Env:CODEX_CI -ErrorAction SilentlyContinue
        foreach ($item in $batchItems) {
            $payloadUri = [Uri][string]$item.PayloadUri
            $payloadKey = $payloadUri.AbsolutePath.TrimStart("/")
            if ($payloadUri.Host -ne "content.marble.kevin-kuhn.dev" -or -not $payloadKey.StartsWith("payloads/")) {
                throw "Refusing to delete unexpected batch payload URI: $($item.PayloadUri)"
            }
            & $wrangler r2 object delete "marble-race-workshop-content/$payloadKey" --remote --force
            if ($LASTEXITCODE -ne 0) { throw "Could not delete abandoned R2 object $payloadKey." }
        }
    }
    finally {
        if ($hadCodexCi) { $env:CODEX_CI = $savedCodexCi }
        else { Remove-Item Env:CODEX_CI -ErrorAction SilentlyContinue }
    }

    Invoke-RepoGit @(
        "restore", "--source=HEAD", "--",
        "items.json", "cloudflare/catalog.mjs",
        "metadata-overrides.json", "cloudflare/metadata-overrides.mjs",
        "public/previews"
    ) | Out-Null

    $previewRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "public\previews")).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    foreach ($item in $batchItems) {
        $relative = ([string]$item.PreviewRelative).Replace("/", [IO.Path]::DirectorySeparatorChar)
        $target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $relative))
        if (-not $target.StartsWith($previewRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove unexpected batch preview path: $relative"
        }
        $status = @(Invoke-RepoGit @("status", "--porcelain", "--", $relative))
        if ($status.Count -eq 1 -and ([string]$status[0]).StartsWith("?? ") -and (Test-Path -LiteralPath $target -PathType Leaf)) {
            Remove-Item -LiteralPath $target -Force
        }
    }
    Write-Host "Interrupted batch cleanup finished."
}

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Choose Marble Race workshop archives"
$dialog.Filter = "Workshop archives (*.zip;*.rar)|*.zip;*.rar|ZIP files (*.zip)|*.zip|RAR files (*.rar)|*.rar"
$dialog.Multiselect = $true
$dialog.RestoreDirectory = $true
$owner = [System.Windows.Forms.Form]::new()
$owner.Text = "Marble Race Workshop Manager"
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = [Drawing.Size]::new(1, 1)
$owner.Opacity = 0

try {
    $owner.Show()
    $owner.Activate() | Out-Null
    if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) {
        exit 0
    }

    $archives = @($dialog.FileNames)
    if ($archives.Count -eq 1) {
        & "$PSScriptRoot\publish-workshop-item.ps1" -ArchivePath $archives[0]
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    else {
        $managedPaths = @(
            "items.json",
            "cloudflare/catalog.mjs",
            "metadata-overrides.json",
            "cloudflare/metadata-overrides.mjs",
            "public/previews"
        )
        $existingChanges = @(Invoke-RepoGit (@("status", "--porcelain", "--") + $managedPaths))
        if ($existingChanges.Count -gt 0) {
            throw "The workshop has uncommitted catalog or preview changes. Finish or discard those changes before starting a multi-item batch."
        }

        $batchManifest = Join-Path ([IO.Path]::GetTempPath()) ("marble-workshop-batch-" + [guid]::NewGuid().ToString("N") + ".jsonl")
        $keepPreparedBatch = $false
        try {
            Write-Host "Batch mode: preparing $($archives.Count) workshop items."
            Write-Host "Cloudflare will be committed and deployed once, after every item is ready."
            Write-Host "The full server test suite will run once after all items are prepared."
            Write-Host ""
            foreach ($archive in $archives) {
                & "$PSScriptRoot\publish-workshop-item.ps1" -ArchivePath $archive -DeferCommit -BatchManifestPath $batchManifest -SkipTests
                if ($LASTEXITCODE -ne 0) { throw "Publishing preparation failed for $archive." }
            }

            $batchItems = @(Read-BatchManifest $batchManifest)
            if ($batchItems.Count -ne $archives.Count) {
                throw "Only $($batchItems.Count) of $($archives.Count) items were prepared. Nothing was committed or pushed."
            }

            Push-Location $PSScriptRoot
            try {
                Write-Host ""
                Write-Host "Running server tests once for the completed batch ..."
                & node --test
                if ($LASTEXITCODE -ne 0) { throw "Server tests failed. Nothing was committed or pushed." }
            }
            finally {
                Pop-Location
            }

            $deployAnswer = Read-Host "Commit and deploy all $($batchItems.Count) items now? [Y/n]"
            if ($deployAnswer -match '^(?i)n(?:o)?$') {
                $keepPreparedBatch = $true
                Write-Host "Prepared successfully but not committed. The repository changes are ready for review."
            }
            else {
                # Once Git finalization begins, preserve the prepared state if
                # Git or Cloudflare needs manual recovery rather than deleting
                # files that may already be committed or deployed.
                $keepPreparedBatch = $true
                $previewPaths = @($batchItems | ForEach-Object { [string]$_.PreviewRelative } | Sort-Object -Unique)
                $pathsToCommit = @("items.json", "cloudflare/catalog.mjs", "metadata-overrides.json", "cloudflare/metadata-overrides.mjs") + $previewPaths
                Invoke-RepoGit (@("add", "--") + $pathsToCommit) | Out-Null
                Invoke-RepoGit @("commit", "-m", "Publish $($batchItems.Count) workshop items") | Write-Host
                Invoke-RepoGit @("push", "origin", "HEAD") | Write-Host
                Wait-ForBatchDeployment $batchItems

                Write-Host ""
                Write-Host "Published $($batchItems.Count) items successfully in one deployment:"
                foreach ($item in $batchItems) {
                    Write-Host "  $($item.Name) (ID $($item.Id))"
                }
                Write-Host "Workshop API: https://marble.kevin-kuhn.dev/api"
            }
        }
        finally {
            if (-not $keepPreparedBatch) {
                Remove-AbandonedBatch $batchManifest
            }
            if (Test-Path -LiteralPath $batchManifest -PathType Leaf) {
                Remove-Item -LiteralPath $batchManifest -Force
            }
        }
    }

    Write-Host ""
    Write-Host "Finished."
    Read-Host "Press Enter to close"
}
catch {
    $logRoot = Join-Path $PSScriptRoot ".workshop-manager-logs"
    [IO.Directory]::CreateDirectory($logRoot) | Out-Null
    $logPath = Join-Path $logRoot "publisher-error.txt"
    $details = "Publisher failed: $($_.Exception.Message)" + [Environment]::NewLine + $_.ScriptStackTrace
    [IO.File]::WriteAllText($logPath, $details + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host ""
    Write-Host $details -ForegroundColor Red
    Write-Host "The error was saved to $logPath" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
finally {
    $dialog.Dispose()
    $owner.Dispose()
}
