const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("updating previews defaults to the archive thumbnail and keeps the old preview only on request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marble-preview-choice-"));
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  try {
    const old = path.join(root, "old.png");
    const updated = path.join(root, "new.png");
    const custom = path.join(root, "custom.png");
    for (const file of [old, updated, custom]) fs.writeFileSync(file, path.basename(file));
    const script = `
      Set-StrictMode -Version Latest
      $ErrorActionPreference = "Stop"
      $tokens = $null
      $parseErrors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve(__dirname, "../publish-workshop-item.ps1"))}, [ref]$tokens, [ref]$parseErrors)
      if ($parseErrors) { throw ($parseErrors | Out-String) }
      $names = @("Get-ObjectProperty", "Find-PreviewFile", "Resolve-PublishPreview")
      $functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)
      foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
      $options = @{ ContentRoot=${quote(root)}; Metadata=[pscustomobject]@{ThumbnailPath="new.png"}; ResourceType=2; ExistingPreviewPath=${quote(old)} }
      $default = Resolve-PublishPreview @options
      if ($default -ne ${quote(updated)}) { throw "The archive's thumbnail was not used by default" }
      $kept = Resolve-PublishPreview @options -KeepCurrent
      if ($kept -ne ${quote(old)}) { throw "Explicit keep did not retain the old thumbnail" }
      $overridden = Resolve-PublishPreview @options -ExplicitPreview ${quote(custom)}
      if ($overridden -ne ${quote(custom)}) { throw "The explicit override was ignored" }
      $rejected = $false
      try { Resolve-PublishPreview @options -KeepCurrent -ExplicitPreview ${quote(custom)} | Out-Null }
      catch { $rejected = $true }
      if (-not $rejected) { throw "Conflicting preview choices were accepted" }
      $options.Metadata = [pscustomobject]@{ThumbnailPath="missing.png"}
      $stillKept = Resolve-PublishPreview @options -KeepCurrent
      if ($stillKept -ne ${quote(old)}) { throw "Keeping the old preview required an archive thumbnail" }
      "preview selection checks passed"
    `;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    assert.match(output, /preview selection checks passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
