$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Choose Marble Race workshop archives"
$dialog.Filter = "Workshop archives (*.zip;*.rar)|*.zip;*.rar|ZIP files (*.zip)|*.zip|RAR files (*.rar)|*.rar"
$dialog.Multiselect = $true

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 0
}

foreach ($archive in $dialog.FileNames) {
    & "$PSScriptRoot\publish-workshop-item.ps1" -ArchivePath $archive
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "Finished."
Read-Host "Press Enter to close"
