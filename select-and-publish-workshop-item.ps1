$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

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

    foreach ($archive in $dialog.FileNames) {
        & "$PSScriptRoot\publish-workshop-item.ps1" -ArchivePath $archive
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
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
