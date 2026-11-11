const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("publisher allocates new IDs for duplicate titles and updates only an explicitly selected ID", () => {
  const publisher = path.resolve(__dirname, "../publish-workshop-item.ps1").replace(/'/g, "''");
  const script = `
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${publisher}', [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { throw ($parseErrors | Out-String) }
    $names = @("Get-ObjectProperty", "ConvertTo-Slug", "Resolve-PublishItemId", "Get-PublishFileNames")
    $functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)
    foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
    $items = @(
      [pscustomobject]@{Id=700; Name="test"; MirrorSource="official-main"},
      [pscustomobject]@{Id=701; Name="Test"; MirrorSource="official-main"},
      [pscustomobject]@{Id=10001; Name="test"},
      [pscustomobject]@{Id=10002; Name="Another item"}
    )
    $newId = Resolve-PublishItemId -Items $items
    if ($newId -ne 10003) { throw "Duplicate titles did not receive a new ID" }
    $items += [pscustomobject]@{Id=$newId; Name="test"}
    $nextId = Resolve-PublishItemId -Items $items
    if ($nextId -ne 10004) { throw "The next item in a same-title batch reused an ID" }
    if ((Resolve-PublishItemId -Items $items -UpdateItemId 701) -ne 701) { throw "Explicit update lost the selected ID" }
    if ((Resolve-PublishItemId -Items @([pscustomobject]@{Id=700; Name="test"})) -ne 10001) { throw "A single matching title was treated as an update" }
    if ((Resolve-PublishItemId -Items @()) -ne 10001) { throw "Empty catalog did not start at the custom ID floor" }
    $invalidRejected = $false
    try { Resolve-PublishItemId -Items $items -UpdateItemId 99999 | Out-Null }
    catch { $invalidRejected = $true }
    if (-not $invalidRejected) { throw "Unknown update ID was accepted" }
    $first = Get-PublishFileNames -Name "test" -ItemId $newId -Timestamp 1234567890 -PreviewExtension ".jpg"
    $second = Get-PublishFileNames -Name "test" -ItemId $nextId -Timestamp 1234567890 -PreviewExtension ".jpg"
    if ($first.Preview -eq $second.Preview -or $first.Payload -eq $second.Payload) { throw "Same-title items overwrite each other's files" }
    $collision = Get-PublishFileNames -Name "Test!" -ItemId $nextId -Timestamp 1234567890 -PreviewExtension ".jpg"
    if ($first.Preview -eq $collision.Preview -or $first.Payload -eq $collision.Payload) { throw "Slug collisions overwrite another item's files" }
    $later = Get-PublishFileNames -Name "test" -ItemId $newId -Timestamp 1234567891 -PreviewExtension ".jpg"
    if ($first.Preview -eq $later.Preview) { throw "An updated preview reused its old URL" }
    "publisher identity checks passed"
  `;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  assert.match(output, /publisher identity checks passed/);
});
