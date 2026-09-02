"use strict";

const token = new URL(window.location.href).searchParams.get("token") || "";
const typeNames = { 0: "Level", 1: "Asset", 2: "Campaign" };
const elements = {
  publish: document.querySelector("#publish"), publishLabel: document.querySelector("#publish-label"),
  list: document.querySelector("#item-list"), resultCount: document.querySelector("#result-count"),
  search: document.querySelector("#search"), visibility: document.querySelector("#visibility"), type: document.querySelector("#type"),
  total: document.querySelector("#stat-total"), visible: document.querySelector("#stat-visible"), hidden: document.querySelector("#stat-hidden"), edited: document.querySelector("#stat-edited"),
  editor: document.querySelector("#editor"), editorForm: document.querySelector("#editor-form"), editorId: document.querySelector("#editor-id"), editorTitle: document.querySelector("#editor-title"),
  editName: document.querySelector("#edit-name"), editAuthor: document.querySelector("#edit-author"), editVersion: document.querySelector("#edit-version"), editTags: document.querySelector("#edit-tags"), editDescription: document.querySelector("#edit-description"),
  bulkForm: document.querySelector("#bulk-form"), bulkField: document.querySelector("#bulk-field"), bulkFind: document.querySelector("#bulk-find"), bulkReplace: document.querySelector("#bulk-replace"), bulkResult: document.querySelector("#bulk-result"),
  reviewTool: document.querySelector("#review-tool"), toast: document.querySelector("#toast"),
};

let items = [];
let activeItemId = null;
let toastTimer = null;

bindEvents();
loadCatalog();

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-manager-token": token, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({ error: "The manager returned an unreadable response." }));
  if (!response.ok) throw new Error(payload.error || `Manager error ${response.status}`);
  return payload;
}

async function loadCatalog() {
  try {
    const payload = await api("/api/catalog");
    items = payload.items;
    updateStats(payload.stats);
    updateDirty(payload.dirty);
    elements.reviewTool.disabled = !payload.duplicateReportAvailable;
    renderItems();
  } catch (error) {
    elements.list.replaceChildren(emptyState(error.message));
    showToast(error.message, true);
  }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button)));
  document.querySelector("#filters").addEventListener("submit", (event) => event.preventDefault());
  elements.search.addEventListener("input", renderItems);
  elements.visibility.addEventListener("change", renderItems);
  elements.type.addEventListener("change", renderItems);
  elements.publish.addEventListener("click", publishChanges);
  document.querySelector("#editor-close").addEventListener("click", closeEditor);
  document.querySelector("#editor-cancel").addEventListener("click", closeEditor);
  elements.editorForm.addEventListener("submit", saveEditor);
  elements.editor.addEventListener("click", (event) => { if (event.target === elements.editor) closeEditor(); });
  document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => launchTool(button)));
  document.querySelector("#bulk-preview").addEventListener("click", () => runBulk(true));
  elements.bulkForm.addEventListener("submit", (event) => { event.preventDefault(); runBulk(false); });
}

function switchTab(button) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === button.dataset.panel));
}

function renderItems() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const visibility = elements.visibility.value;
  const type = elements.type.value;
  const filtered = items.filter((item) => {
    const matchesSearch = !query || [item.Id, item.Name, item.AuthorName, item.Description].join(" ").toLocaleLowerCase().includes(query);
    const matchesVisibility = visibility === "all" || (visibility === "hidden" ? item.Hidden : !item.Hidden);
    return matchesSearch && matchesVisibility && (type === "all" || String(item.ResourceType) === type);
  });
  elements.list.replaceChildren();
  if (!filtered.length) elements.list.append(emptyState("No matching workshop items."));
  else {
    const fragment = document.createDocumentFragment();
    filtered.forEach((item) => fragment.append(createRow(item)));
    elements.list.append(fragment);
  }
  elements.resultCount.textContent = `${filtered.length.toLocaleString()} item${filtered.length === 1 ? "" : "s"}`;
}

function createRow(item) {
  const typeName = typeNames[item.ResourceType] || "Item";
  const row = create("article", `item-row ${typeName.toLocaleLowerCase()}${item.Hidden ? " hidden" : ""}`);
  const image = document.createElement("img");
  image.src = item.PreviewUri; image.alt = ""; image.loading = "lazy";
  image.addEventListener("error", () => image.replaceWith(create("span", "thumb-fallback", item.Name.slice(0, 1).toLocaleUpperCase())), { once: true });
  const main = create("div", "item-main");
  main.append(create("h2", "", item.Name), create("p", "", `by ${item.AuthorName || "Unknown"}`));
  const meta = create("div", "item-meta");
  meta.append(create("span", "pill type", typeName), create("span", "pill", `ID ${item.Id}`));
  if (item.HasOverride) meta.append(create("span", "pill", "Edited"));
  if (item.Hidden) meta.append(create("span", "pill state", "Hidden"));
  const actions = create("div", "row-actions");
  const edit = create("button", "", "Edit"); edit.type = "button"; edit.addEventListener("click", () => openEditor(item.Id));
  const update = create("button", "secondary", "Update file"); update.type = "button"; update.addEventListener("click", () => updateItemFile(item, update));
  const visibility = create("button", "visibility-button", item.Hidden ? "Unhide" : "Hide");
  visibility.type = "button"; visibility.addEventListener("click", () => changeVisibility(item, visibility));
  actions.append(edit, update, visibility); row.append(image, main, meta, actions);
  return row;
}

async function updateItemFile(item, button) {
  button.disabled = true;
  try {
    const payload = await api("/api/update-item", { method: "POST", body: JSON.stringify({ id: item.Id }) });
    showToast(payload.message);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

async function changeVisibility(item, button) {
  button.disabled = true;
  try {
    const payload = await api("/api/visibility", { method: "POST", body: JSON.stringify({ id: item.Id, hidden: !item.Hidden }) });
    item.Hidden = payload.hidden;
    updateDirty(payload.dirty);
    recalculateStats();
    renderItems();
    showToast(`${payload.message} Press Publish changes when ready.`);
  } catch (error) { showToast(error.message, true); button.disabled = false; }
}

function openEditor(id) {
  const item = items.find((candidate) => candidate.Id === id);
  if (!item) return;
  activeItemId = id;
  elements.editorId.textContent = `WORKSHOP ID ${id}`;
  elements.editorTitle.textContent = item.Name;
  elements.editName.value = item.Name || "";
  elements.editAuthor.value = item.AuthorName || "";
  elements.editVersion.value = item.Version || "0.0";
  elements.editTags.value = Array.isArray(item.Tags) ? item.Tags.join(", ") : "";
  elements.editDescription.value = item.Description || "";
  elements.editor.showModal();
}

function closeEditor() { if (elements.editor.open) elements.editor.close(); activeItemId = null; }

async function saveEditor(event) {
  event.preventDefault();
  if (activeItemId === null) return;
  const submit = elements.editorForm.querySelector("button[type=submit]"); submit.disabled = true;
  const values = {
    Name: elements.editName.value, AuthorName: elements.editAuthor.value, Version: elements.editVersion.value,
    Tags: elements.editTags.value.split(",").map((tag) => tag.trim()).filter(Boolean), Description: elements.editDescription.value,
  };
  try {
    const payload = await api("/api/metadata", { method: "POST", body: JSON.stringify({ id: activeItemId, values }) });
    const index = items.findIndex((item) => item.Id === activeItemId);
    if (index >= 0) items[index] = { ...items[index], ...payload.item, HasOverride: payload.hasOverride };
    updateDirty(payload.dirty); recalculateStats(); renderItems(); closeEditor();
    showToast(`${payload.message} Press Publish changes when ready.`);
  } catch (error) { showToast(error.message, true); }
  finally { submit.disabled = false; }
}

async function runBulk(preview) {
  const button = preview ? document.querySelector("#bulk-preview") : elements.bulkForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const request = { field: elements.bulkField.value, find: elements.bulkFind.value, replace: elements.bulkReplace.value, preview };
    const payload = await api("/api/bulk-metadata", { method: "POST", body: JSON.stringify(request) });
    elements.bulkResult.hidden = false;
    if (preview) {
      const sample = payload.items.map((item) => `#${item.Id}  ${item.Name}`).join("\n");
      elements.bulkResult.textContent = `${payload.count} exact match${payload.count === 1 ? "" : "es"}${sample ? `:\n${sample}` : "."}`;
    } else {
      elements.bulkResult.textContent = `${payload.message} Press Publish changes when ready.`;
      updateDirty(payload.dirty); await loadCatalog(); showToast(payload.message);
    }
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

async function publishChanges() {
  if (!window.confirm("Run all tests, commit the manager changes, and publish them to the live workshop?")) return;
  elements.publish.disabled = true; elements.publishLabel.textContent = "Testing and publishing…";
  try {
    const payload = await api("/api/deploy", { method: "POST", body: "{}" });
    updateDirty(payload.dirty); showToast(payload.message); await loadCatalog();
  } catch (error) { showToast(error.message, true); elements.publish.disabled = false; elements.publishLabel.textContent = "Publish changes"; }
}

async function launchTool(button) {
  if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
  button.disabled = true;
  try {
    const payload = await api("/api/launch", { method: "POST", body: JSON.stringify({ tool: button.dataset.tool }) });
    showToast(payload.message);
  } catch (error) { showToast(error.message, true); }
  finally { window.setTimeout(() => { button.disabled = false; }, 500); }
}

function updateStats(stats) {
  elements.total.textContent = stats.total.toLocaleString(); elements.visible.textContent = stats.visible.toLocaleString();
  elements.hidden.textContent = stats.hidden.toLocaleString(); elements.edited.textContent = stats.edited.toLocaleString();
}
function recalculateStats() {
  updateStats({ total: items.length, visible: items.filter((item) => !item.Hidden).length, hidden: items.filter((item) => item.Hidden).length, edited: items.filter((item) => item.HasOverride).length });
}
function updateDirty(dirty) {
  const hasChanges = Boolean(dirty && dirty.hasChanges);
  elements.publish.disabled = !hasChanges;
  elements.publishLabel.textContent = hasChanges ? "Publish changes" : "No changes to publish";
}
function showToast(message, isError = false) {
  window.clearTimeout(toastTimer); elements.toast.textContent = message; elements.toast.classList.toggle("error", isError); elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, isError ? 7000 : 4000);
}
function emptyState(text) { return create("div", "empty", text); }
function create(tag, className = "", text = "") { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
