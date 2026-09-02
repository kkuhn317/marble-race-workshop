import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = resolve(REPO_ROOT, "items.json");
const HIDDEN_PATH = resolve(REPO_ROOT, "hidden-workshop-items.json");
const OVERRIDES_PATH = resolve(REPO_ROOT, "metadata-overrides.json");
const MODULE_PATH = resolve(REPO_ROOT, "cloudflare", "metadata-overrides.mjs");
const LIVE_API = "https://marble.kevin-kuhn.dev/api";
const EDITABLE_FIELDS = new Map([
  ["author", { property: "AuthorName", label: "author name", allowEmpty: false }],
  ["name", { property: "Name", label: "item name", allowEmpty: false }],
  ["description", { property: "Description", label: "description", allowEmpty: true }],
  ["version", { property: "Version", label: "minimum game version", allowEmpty: false }],
]);

export function parseArguments(argv) {
  const options = {
    field: null,
    find: null,
    replacement: null,
    nonInteractive: false,
    push: false,
    validateOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--field") options.field = String(argv[++index] || "").toLowerCase();
    else if (argument === "--find") options.find = String(argv[++index] ?? "");
    else if (argument === "--replace") options.replacement = String(argv[++index] ?? "");
    else if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--push") options.push = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (options.nonInteractive && (!options.field || options.find === null || options.replacement === null)) {
    throw new Error("Non-interactive mode requires --field, --find, and --replace.");
  }
  if (options.push && options.validateOnly) throw new Error("--push cannot be combined with --validate-only.");
  return options;
}

export function applyOverride(item, overrides) {
  return { ...item, ...(overrides[String(item.Id)] || {}) };
}

export function buildOverridesModule(overrides) {
  const entries = Object.entries(overrides)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, value]) => [Number(id), value]);
  return `export const metadataOverrides = new Map(${JSON.stringify(entries, null, 2)});\n\n`
    + "export function applyMetadataOverrides(item) {\n"
    + "  const override = metadataOverrides.get(Number(item.Id));\n"
    + "  return override ? { ...item, ...override } : item;\n"
    + "}\n";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const reader = options.nonInteractive
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const fieldKey = options.field || await chooseField(reader);
    const field = EDITABLE_FIELDS.get(fieldKey);
    if (!field) throw new Error(`Unknown field "${fieldKey}". Choose author, name, description, or version.`);

    const findValue = options.find ?? await reader.question(`Current ${field.label} (exact match): `);
    let replacement = options.replacement ?? await reader.question(`New ${field.label}${field.allowEmpty ? " (type <clear> to empty)" : ""}: `);
    if (field.allowEmpty && replacement.trim() === "<clear>") replacement = "";
    if (!findValue.trim()) throw new Error(`Current ${field.label} cannot be empty.`);
    if (!field.allowEmpty && !replacement.trim()) throw new Error(`New ${field.label} cannot be empty.`);
    if (findValue === replacement) {
      console.log("The old and new values are identical. Nothing was changed.");
      return;
    }

    const items = JSON.parse(await readFile(ITEMS_PATH, "utf8"));
    const hiddenDocument = JSON.parse(await readFile(HIDDEN_PATH, "utf8"));
    const hiddenIds = new Set((hiddenDocument.HiddenItemIds || []).map(Number));
    const overrideDocument = await readOverrideDocument();
    const matches = items
      .map((item) => ({ base: item, effective: applyOverride(item, overrideDocument.Items) }))
      .filter(({ effective }) => sameText(effective[field.property], findValue));

    if (matches.length === 0) throw new Error(`No items have the ${field.label} "${findValue}".`);

    console.log(`\n${matches.length} item${matches.length === 1 ? "" : "s"} will change:`);
    const previewLimit = 75;
    for (const { effective } of matches.slice(0, previewLimit)) {
      const hidden = hiddenIds.has(Number(effective.Id)) ? " [currently hidden]" : "";
      console.log(`  #${effective.Id}  ${effective.Name}${hidden}`);
    }
    if (matches.length > previewLimit) console.log(`  ...and ${matches.length - previewLimit} more`);
    console.log(`\n${field.label}: ${JSON.stringify(findValue)} -> ${JSON.stringify(replacement)}`);
    console.log("Upload dates, IDs, previews, and downloads will not change.");

    if (!options.nonInteractive) {
      const confirmed = await askYesNo(reader, "Apply this bulk change?", false);
      if (!confirmed) {
        console.log("Cancelled. Nothing was changed.");
        return;
      }
    }

    ensureOverrideFilesClean();
    const originalDocument = existsSync(OVERRIDES_PATH) ? await readFile(OVERRIDES_PATH, "utf8") : null;
    const originalModule = existsSync(MODULE_PATH) ? await readFile(MODULE_PATH, "utf8") : null;
    const updatedOverrides = structuredClone(overrideDocument.Items);

    for (const { base } of matches) {
      const key = String(base.Id);
      const entry = { ...(updatedOverrides[key] || {}) };
      if (replacement === String(base[field.property] ?? "")) delete entry[field.property];
      else entry[field.property] = replacement;
      if (Object.keys(entry).length === 0) delete updatedOverrides[key];
      else updatedOverrides[key] = entry;
    }

    const updatedDocument = { SchemaVersion: 1, Items: sortOverrideObject(updatedOverrides) };
    try {
      await writeFile(OVERRIDES_PATH, `${JSON.stringify(updatedDocument, null, 2)}\n`, "utf8");
      await writeFile(MODULE_PATH, buildOverridesModule(updatedDocument.Items), "utf8");
      console.log("\nRunning server tests ...");
      const tests = runProcess(process.execPath, ["--test"]);
      if (tests.status !== 0) throw new Error("Server tests failed.");
    } catch (error) {
      await restoreFile(OVERRIDES_PATH, originalDocument);
      await restoreFile(MODULE_PATH, originalModule);
      throw error;
    }

    if (options.validateOnly) {
      await restoreFile(OVERRIDES_PATH, originalDocument);
      await restoreFile(MODULE_PATH, originalModule);
      console.log("Validation passed. No repository files were changed.");
      return;
    }

    const shouldPush = options.push || (!options.nonInteractive && await askYesNo(reader, "Commit and deploy this change now?", true));
    if (!shouldPush) {
      console.log("Changes are prepared but not committed.");
      return;
    }

    runGit(["add", "--", "metadata-overrides.json", "cloudflare/metadata-overrides.mjs"]);
    runGit(["commit", "-m", `Bulk edit workshop ${field.label}`]);
    runGit(["push", "origin", "HEAD"]);

    const visibleSample = matches.map(({ effective }) => effective).find((item) => !hiddenIds.has(Number(item.Id)));
    if (visibleSample) {
      console.log(`Waiting for Cloudflare to publish item #${visibleSample.Id} ...`);
      await waitForLive(visibleSample.Id, field.property, replacement);
      console.log("Published successfully.");
    } else {
      console.log("Pushed successfully. Every affected item is hidden, so the public API cannot verify their metadata.");
    }
  } finally {
    reader?.close();
  }
}

async function chooseField(reader) {
  console.log("\nWhat do you want to change everywhere it exactly matches?");
  console.log("  1. Author name");
  console.log("  2. Item name");
  console.log("  3. Description");
  console.log("  4. Minimum game version");
  const answer = (await reader.question("Choose 1-4: ")).trim();
  return ({ "1": "author", "2": "name", "3": "description", "4": "version" })[answer] || answer.toLowerCase();
}

async function readOverrideDocument() {
  if (!existsSync(OVERRIDES_PATH)) return { SchemaVersion: 1, Items: {} };
  const parsed = JSON.parse(await readFile(OVERRIDES_PATH, "utf8"));
  if (parsed.SchemaVersion !== 1 || !parsed.Items || typeof parsed.Items !== "object" || Array.isArray(parsed.Items)) {
    throw new Error("metadata-overrides.json is not in the expected format.");
  }
  return parsed;
}

function sameText(left, right) {
  return String(left ?? "").localeCompare(String(right), undefined, { sensitivity: "accent" }) === 0;
}

function sortOverrideObject(overrides) {
  return Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => Number(left) - Number(right)));
}

function ensureOverrideFilesClean() {
  const result = runProcess("git", [
    "-c", `safe.directory=${REPO_ROOT.replaceAll("\\", "/")}`,
    "-C", REPO_ROOT,
    "status", "--porcelain", "--", "metadata-overrides.json", "cloudflare/metadata-overrides.mjs",
  ], { capture: true });
  if (result.status !== 0) throw new Error(`Could not inspect the repository.\n${result.output}`);
  if (result.output.trim()) throw new Error("A previous bulk metadata change is still uncommitted. Finish or discard it before starting another.");
}

function runGit(arguments_) {
  const result = runProcess("git", [
    "-c", `safe.directory=${REPO_ROOT.replaceAll("\\", "/")}`,
    "-C", REPO_ROOT,
    ...arguments_,
  ]);
  if (result.status !== 0) throw new Error(`git ${arguments_.join(" ")} failed.`);
}

function runProcess(command, arguments_, { capture = false } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: REPO_ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return { ...result, output: capture ? `${result.stdout || ""}${result.stderr || ""}` : "" };
}

async function restoreFile(path, contents) {
  if (contents !== null) await writeFile(path, contents, "utf8");
}

async function waitForLive(id, property, expectedValue) {
  const deadline = Date.now() + 7 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${LIVE_API}/GetItem?id=${id}&cacheBust=${Date.now()}`, {
        headers: { "cache-control": "no-cache" },
      });
      if (response.ok) {
        const item = await response.json();
        if (String(item[property] ?? "") === expectedValue) return;
      }
    } catch {
      // A deployment can briefly make the API unavailable.
    }
    process.stdout.write(".");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10000));
  }
  throw new Error("Git push succeeded, but the metadata change did not appear within seven minutes. Check Cloudflare Builds.");
}

async function askYesNo(reader, question, defaultValue) {
  const prompt = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await reader.question(`${question} ${prompt}: `)).trim();
  if (!answer) return defaultValue;
  return /^y(?:es)?$/i.test(answer);
}

function printHelp() {
  console.log(`Bulk workshop metadata editor

Double-click bulk-edit-workshop-metadata.bat for guided use.

Options:
  --field author|name|description|version
  --find VALUE
  --replace VALUE
  --non-interactive
  --validate-only
  --push
  --help`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`\nBulk metadata edit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
