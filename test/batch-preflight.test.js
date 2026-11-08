const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("batch preflight ignores normalized line endings but detects staged, unstaged, and new files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marble-batch-preflight-"));
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const selector = path.resolve(__dirname, "../select-and-publish-workshop-item.ps1");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const check = () => {
    const script = `
      $ErrorActionPreference = "Stop"
      $tokens = $null
      $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(selector)}, [ref]$tokens, [ref]$errors)
      if ($errors) { throw ($errors | Out-String) }
      $names = @("Invoke-RepoGit", "Get-PendingWorkshopChanges")
      $functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)
      foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
      $pending = @(Get-PendingWorkshopChanges -RepoRoot ${quote(root)} -Paths @("items.json", "cloudflare/catalog.mjs", "public/previews"))
      ConvertTo-Json -InputObject ([object[]]$pending) -Compress
    `;
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim());
  };
  try {
    git("init", "-q");
    git("config", "core.autocrlf", "true");
    git("config", "core.safecrlf", "warn");
    fs.mkdirSync(path.join(root, "cloudflare"));
    fs.mkdirSync(path.join(root, "public/previews"), { recursive: true });
    fs.writeFileSync(path.join(root, "items.json"), "[]\n");
    fs.writeFileSync(path.join(root, "cloudflare/catalog.mjs"), "export const items = [];\n");
    git("add", ".");
    git("-c", "user.name=Publisher Test", "-c", "user.email=publisher@example.invalid", "commit", "-qm", "Initial fixture");
    fs.writeFileSync(path.join(root, "cloudflare/catalog.mjs"), "export const items = [];\r\n");
    assert.deepEqual(check(), []);
    fs.writeFileSync(path.join(root, "items.json"), '[{"Id":1}]\r\n');
    assert.deepEqual(check(), ["items.json"]);
    git("add", "items.json");
    fs.writeFileSync(path.join(root, "items.json"), "[]\r\n");
    assert.deepEqual(check(), ["items.json"], "Staged edits must count even when the working copy matches HEAD");
    fs.writeFileSync(path.join(root, "public/previews/new-item.jpg"), "preview fixture");
    assert.deepEqual(check(), ["items.json", "public/previews/new-item.jpg"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
