[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Int64]$ItemId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$dialog.Title = "Choose the new archive for workshop item #$ItemId"
$dialog.Filter = "Marble Race archives (*.zip;*.rar)|*.zip;*.rar|ZIP archives (*.zip)|*.zip|RAR archives (*.rar)|*.rar"
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true

try {
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "Update cancelled."
        return
    }

    $host.UI.RawUI.WindowTitle = "Updating Marble Race workshop item #$ItemId"
    & (Join-Path $PSScriptRoot "publish-workshop-item.ps1") -ArchivePath $dialog.FileName -UpdateItemId $ItemId
}
catch {
    Write-Host ""
    Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    $dialog.Dispose()
    Write-Host ""
    Read-Host "Press Enter to close"
}
