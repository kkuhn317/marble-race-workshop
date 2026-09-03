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
    $owner.Dispose()
    Write-Host ""
    Read-Host "Press Enter to close"
}
