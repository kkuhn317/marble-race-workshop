"use strict";

const PAGE_SIZE = 48;
const TYPE_NAMES = { 0: "Level", 1: "Asset", 2: "Campaign" };
const elements = {
  form: document.querySelector("#filter-form"), search: document.querySelector("#search"),
  type: document.querySelector("#type-filter"), sort: document.querySelector("#sort-filter"),
  total: document.querySelector("#total-count"), resultCount: document.querySelector("#result-count"),
  status: document.querySelector("#status"), grid: document.querySelector("#item-grid"),
  loadMore: document.querySelector("#load-more"), dialog: document.querySelector("#item-dialog"),
  dialogContent: document.querySelector("#dialog-content"), dialogClose: document.querySelector("#dialog-close"),
};
let allItems = [];
let filteredItems = [];
let visibleCount = PAGE_SIZE;

restoreControlsFromUrl();
bindEvents();
loadItems();

async function loadItems() {
  setStatus("loading", "Loading the workshop archive…");
  try {
    const response = await fetch("/api/Items?limit=1000&sort=new", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The server returned ${response.status}.`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("The workshop returned an unexpected response.");
    allItems = payload.map(normalizeItem);
    elements.total.textContent = allItems.length.toLocaleString();
    setStatus("ready");
    applyFilters();
    openLinkedItem();
  } catch (error) {
    console.error(error);
    setStatus("error", "The workshop could not be loaded. Please try again in a moment.");
  }
}

function bindEvents() {
  elements.form.addEventListener("submit", (event) => event.preventDefault());
  elements.search.addEventListener("input", resetAndFilter);
  elements.type.addEventListener("change", resetAndFilter);
  elements.sort.addEventListener("change", resetAndFilter);
  elements.loadMore.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderItems(); });
  elements.dialogClose.addEventListener("click", closeDialog);
  elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDialog(); });
  elements.dialog.addEventListener("close", clearLinkedItem);
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== elements.search && !elements.dialog.open) {
      event.preventDefault();
      elements.search.focus();
    }
  });
  window.addEventListener("popstate", () => { restoreControlsFromUrl(); applyFilters(false); openLinkedItem(); });
}

function resetAndFilter() { visibleCount = PAGE_SIZE; applyFilters(); }

function normalizeItem(item) {
  return {
    Id: Number(item.Id), Name: String(item.Name || "Untitled item"), ResourceType: Number(item.ResourceType),
    TimeStamp: Number(item.TimeStamp) || 0, AuthorName: String(item.AuthorName || "Unknown creator"),
    PreviewUri: String(item.PreviewUri || ""), PayloadUri: String(item.PayloadUri || ""),
    Description: String(item.Description || ""), PayloadLength: Number(item.PayloadLength) || 0,
    Version: String(item.Version || "Unknown"), Rating: Number(item.Rating) || 0,
    Downloads: Number(item.Downloads) || 0,
    SteamWorkshopId: /^\d+$/.test(String(item.SteamWorkshopId || "")) ? String(item.SteamWorkshopId) : "",
  };
}

function applyFilters(updateUrl = true) {
  if (!allItems.length) return;
  const query = elements.search.value.trim().toLocaleLowerCase();
  const selectedType = elements.type.value;
  filteredItems = allItems.filter((item) => {
    const matchesType = selectedType === "all" || String(item.ResourceType) === selectedType;
    const searchable = [item.Id, `#${item.Id}`, item.Name, item.AuthorName, item.Description].join(" ").toLocaleLowerCase();
    return matchesType && (!query || searchable.includes(query));
  });
  sortItems(filteredItems, elements.sort.value);
  if (updateUrl) updateFilterUrl();
  renderItems();
}

function sortItems(items, sort) {
  const text = (value) => String(value).toLocaleLowerCase();
  const sorters = {
    new: (a, b) => b.TimeStamp - a.TimeStamp || b.Id - a.Id,
    votes: (a, b) => b.Rating - a.Rating || a.Id - b.Id,
    downloads: (a, b) => b.Downloads - a.Downloads || a.Id - b.Id,
    old: (a, b) => a.TimeStamp - b.TimeStamp || a.Id - b.Id,
    name: (a, b) => text(a.Name).localeCompare(text(b.Name)) || a.Id - b.Id,
    author: (a, b) => text(a.AuthorName).localeCompare(text(b.AuthorName)) || text(a.Name).localeCompare(text(b.Name)),
    "id-asc": (a, b) => a.Id - b.Id, "id-desc": (a, b) => b.Id - a.Id,
  };
  items.sort(sorters[sort] || sorters.new);
}

function renderItems() {
  elements.grid.replaceChildren();
  const shownItems = filteredItems.slice(0, visibleCount);
  if (!shownItems.length) {
    const empty = create("div", "empty-state");
    empty.append(create("strong", "", "No workshop items found"), create("span", "", "Try another name, creator, ID, or item type."));
    elements.grid.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    shownItems.forEach((item) => fragment.append(createItemCard(item)));
    elements.grid.append(fragment);
  }
  elements.resultCount.textContent = filteredItems.length === allItems.length
    ? `${allItems.length.toLocaleString()} items`
    : `${filteredItems.length.toLocaleString()} of ${allItems.length.toLocaleString()} items`;
  elements.loadMore.hidden = shownItems.length >= filteredItems.length;
  if (!elements.loadMore.hidden) elements.loadMore.textContent = `Show more (${(filteredItems.length - shownItems.length).toLocaleString()} remaining)`;
}

function createItemCard(item) {
  const typeName = typeNameFor(item);
  const article = create("article", `item-card ${typeName.toLocaleLowerCase()}`);
  const previewButton = create("button", "preview-button");
  previewButton.type = "button";
  previewButton.setAttribute("aria-label", `View ${item.Name}, workshop ID ${item.Id}`);
  previewButton.addEventListener("click", () => openDialog(item, true));
  const image = document.createElement("img");
  image.src = item.PreviewUri; image.alt = ""; image.loading = "lazy"; image.decoding = "async";
  image.addEventListener("error", () => image.replaceWith(create("span", "preview-fallback", item.Name.slice(0, 1).toLocaleUpperCase())), { once: true });
  previewButton.append(image);
  article.append(create("span", `type-pill ${typeName.toLocaleLowerCase()}`, typeName), create("span", "id-pill", `ID ${item.Id}`), previewButton);
  const body = create("div", "card-body");
  body.append(create("h3", "", item.Name));
  const byline = create("p", "byline");
  byline.append("by ", create("strong", "", item.AuthorName));
  body.append(byline);
  const bottom = create("div", "card-bottom");
  const cardFacts = create("div", "card-facts");
  cardFacts.append(create("span", "vote-score", `★ ${item.Rating.toLocaleString()}`), create("span", "card-date", formatDate(item.TimeStamp)));
  bottom.append(cardFacts);
  const copy = create("button", "copy-id", "Copy ID");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(String(item.Id), copy, "Copied!"));
  bottom.append(copy); body.append(bottom); article.append(body);
  return article;
}

function openDialog(item, updateUrl) {
  elements.dialogContent.replaceChildren();
  const image = document.createElement("img");
  image.className = "dialog-preview"; image.src = item.PreviewUri; image.alt = `Preview for ${item.Name}`;
  image.addEventListener("error", () => image.remove(), { once: true });
  const body = create("div", "dialog-body");
  const labels = create("div", "dialog-labels");
  labels.append(create("span", "", typeNameFor(item)), create("span", "", `Workshop ID ${item.Id}`));
  const title = create("h2", "", item.Name); title.id = "dialog-name";
  body.append(labels, title, create("p", "dialog-author", `Created by ${item.AuthorName}`), create("p", "dialog-description", item.Description || "No description was provided."));
  const details = create("div", "details-grid");
  details.append(detail("Item ID", String(item.Id)), detail("Vote score", item.Rating.toLocaleString()), detail("Published", formatDate(item.TimeStamp)), detail("Game version", item.Version), detail("Type", typeNameFor(item)), detail("Downloads", item.Downloads.toLocaleString()), detail("Download size", formatBytes(item.PayloadLength)), detail("Creator", item.AuthorName));
  body.append(details);
  const actions = create("div", "dialog-actions");
  if (item.PayloadUri) {
    const download = create("a", "primary-action", "Download item");
    download.href = item.PayloadUri; download.target = "_blank"; download.rel = "noopener"; actions.append(download);
  }
  const copyId = create("button", "secondary-action", "Copy ID");
  copyId.type = "button"; copyId.addEventListener("click", () => copyText(String(item.Id), copyId, "ID copied!"));
  const api = create("a", "secondary-action", "View API record");
  api.href = `/api/GetItem?id=${encodeURIComponent(item.Id)}`; api.target = "_blank"; api.rel = "noopener";
  actions.append(copyId, api);
  if (item.SteamWorkshopId) {
    const steam = create("a", "steam-action", "View on Steam Workshop");
    steam.href = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(item.SteamWorkshopId)}`;
    steam.target = "_blank"; steam.rel = "noopener noreferrer"; actions.append(steam);
  }
  body.append(actions); elements.dialogContent.append(image, body);
  if (!elements.dialog.open) elements.dialog.showModal();
  if (updateUrl) { const url = new URL(window.location.href); url.searchParams.set("item", String(item.Id)); history.pushState(null, "", url); }
}

function closeDialog() { if (elements.dialog.open) elements.dialog.close(); }
function openLinkedItem() {
  if (!allItems.length) return;
  const id = Number(new URL(window.location.href).searchParams.get("item"));
  const item = allItems.find((candidate) => candidate.Id === id);
  if (item) openDialog(item, false); else if (elements.dialog.open) elements.dialog.close();
}
function clearLinkedItem() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("item")) return;
  url.searchParams.delete("item"); history.replaceState(null, "", url);
}

function updateFilterUrl() {
  const url = new URL(window.location.href);
  setOrDelete(url.searchParams, "q", elements.search.value.trim(), "");
  setOrDelete(url.searchParams, "type", elements.type.value, "all");
  setOrDelete(url.searchParams, "sort", elements.sort.value, "new");
  history.replaceState(null, "", url);
}
function restoreControlsFromUrl() {
  const params = new URL(window.location.href).searchParams;
  elements.search.value = params.get("q") || "";
  elements.type.value = ["all", "0", "1", "2"].includes(params.get("type")) ? params.get("type") : "all";
  elements.sort.value = ["new", "votes", "downloads", "old", "name", "author", "id-asc", "id-desc"].includes(params.get("sort")) ? params.get("sort") : "new";
}
function setOrDelete(params, key, value, defaultValue) { if (value && value !== defaultValue) params.set(key, value); else params.delete(key); }
function setStatus(mode, message = "") {
  elements.status.hidden = mode === "ready";
  if (mode === "ready") return;
  elements.status.replaceChildren();
  if (mode === "loading") elements.status.append(create("span", "loader"));
  elements.status.append(create("span", "", message));
}
function detail(label, value) { const wrapper = create("div"); wrapper.append(create("small", "", label), create("strong", "", value)); return wrapper; }
function typeNameFor(item) { return TYPE_NAMES[item.ResourceType] || "Item"; }
function formatDate(timestamp) {
  if (!timestamp) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(timestamp * 1000));
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
async function copyText(value, button, successLabel) {
  const original = button.textContent;
  try { await navigator.clipboard.writeText(value); }
  catch {
    const input = document.createElement("textarea"); input.value = value; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.append(input); input.select(); document.execCommand("copy"); input.remove();
  }
  button.textContent = successLabel;
  window.setTimeout(() => { button.textContent = original; }, 1300);
}
function create(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
