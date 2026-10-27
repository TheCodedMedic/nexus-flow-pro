// Fixed run settings: up to 8 generations in flight, with 1s between submissions.
const PARALLEL        = 8;
const SUBMIT_DELAY_MS = 1000;
const COLLECT_TIMEOUT_MS = 180000;
const CHAR_DELAY_MS   = 30;

// Reference images. Every image ever added lives in the library; the ones in use (up to
// MAX_REF_IMAGES) are attached to every prompt. Each image has a stable id derived from its
// content, and is named "<id>.png" in the Flow project, so swapping references never makes
// two different images share a name.
const MAX_REF_IMAGES = 8;
let library = [];      // [{ id, base64, name }]  newest first
let activeIds = [];    // ids from `library`, in attach order
let refImages = [];    // active library entries, kept in sync by syncActive()

const promptsEl        = document.getElementById("prompts");
const promptCountEl    = document.getElementById("promptCount");
const statusEl         = document.getElementById("status");
const appEl            = document.getElementById("app");
const versionTagEl     = document.getElementById("versionTag");
const txtUploadEl      = document.getElementById("txtUpload");
const runBtn           = document.getElementById("run");
const continueBtn      = document.getElementById("continueBtn");
const stopBtn          = document.getElementById("stop");
const connBar          = document.getElementById("connBar");
const connMsg          = document.getElementById("connMsg");
const connLink         = document.getElementById("connLink");
const agentChip        = document.getElementById("agentChip");
const agentStateEl     = document.getElementById("agentState");
const helpDialog       = document.getElementById("helpDialog");
const helpOpen         = document.getElementById("helpOpen");
const helpClose        = document.getElementById("helpClose");
const listSection      = document.getElementById("listSection");
const promptListEl     = document.getElementById("promptList");
const listCountEl      = document.getElementById("listCount");
const downloadFolderEl = document.getElementById("downloadFolder");
const namingModeEl     = document.getElementById("namingMode");
const namingBtn        = document.getElementById("namingBtn");
const namingValueEl    = document.getElementById("namingValue");
const namingListEl     = document.getElementById("namingList");
const themeBtn         = document.getElementById("themeBtn");
const refImageUploadEl = document.getElementById("refImageUpload");
const refImageClearEl  = document.getElementById("refImageClear");
const refImageListEl   = document.getElementById("refImageList");
const refImageLabelEl  = document.getElementById("refImageLabel");
const loadRefsBtn      = document.getElementById("loadRefsBtn");
const hardRefreshBtn   = document.getElementById("hardRefreshBtn");
const chooseFolderBtn  = document.getElementById("chooseFolderBtn");
const folderNameEl     = document.getElementById("folderName");
const destOpts         = Array.from(document.querySelectorAll(".seg__opt[data-dest]"));
const destLocalEl      = document.getElementById("destLocal");
const destDriveEl      = document.getElementById("destDrive");
const driveLinkWrap    = document.getElementById("driveLinkWrap");
const driveLinkInput   = document.getElementById("driveLinkInput");
const driveLinkMsg     = document.getElementById("driveLinkMsg");
const driveConnEl      = document.getElementById("driveConn");
const driveConnTitle   = document.getElementById("driveConnTitle");
const driveConnSub     = document.getElementById("driveConnSub");
const driveConnectBtn  = document.getElementById("driveConnectBtn");
const driveDisconnect  = document.getElementById("driveDisconnect");
const driveChangeBtn   = document.getElementById("driveChange");
const driveSetupEl     = document.getElementById("driveSetup");
const driveUrlInput    = document.getElementById("driveUrlInput");
const driveSetupCancel = document.getElementById("driveSetupCancel");
const driveSetupError  = document.getElementById("driveSetupError");

const { version } = chrome.runtime.getManifest();
versionTagEl.textContent = `v${version}`;

const FLOW_BASE = "https://flow.google.com";
// Anchored to scheme+host on purpose: an unanchored test also matches an unrelated
// site that merely mentions the URL, e.g. https://evil.example/?u=flow.google.com/project/
// The labs.google variants cover accounts still redirected through the old host.
const FLOW_PROJECT_RE = /^https:\/\/(?:flow\.google\.com\/project\/|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow\/project\/)/;
const FLOW_BASE_RE    = /^https:\/\/(?:flow\.google\.com(?:\/|$)|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow)/;

const MSG_OPEN_PROJECT = "Open a Google Flow project tab first.";
const MSG_NOT_READY    = "Flow tab isn't responding. Hard-refresh it, then try again.";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setStatus(text) { statusEl.textContent = friendlyRefNames(text); }

function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

let flowTabId     = null; // locked-in tab ID during a run
let resumeFromIdx = null; // index to resume from after a stop
let isRunning     = false;
let isConnected   = false;
let agentModeOn   = false;

function canStart() {
  return !isRunning && isConnected && !agentModeOn && parsePrompts().length > 0;
}

function refreshRunButton() {
  runBtn.disabled = !canStart();
}

function setBusy(busy) {
  isRunning = busy;
  appEl.classList.toggle("is-running", busy);
  promptsEl.disabled      = busy;
  namingBtn.disabled      = busy;
  if (busy) closeNamingList();
  txtUploadEl.disabled    = busy;
  chooseFolderBtn.disabled = busy;
  destOpts.forEach(b => { b.disabled = busy; });
  driveDisconnect.disabled = busy;
  driveConnectBtn.disabled = busy;
  driveChangeBtn.disabled = busy;
  driveLinkInput.disabled  = busy || driveConn !== "on";
  stopBtn.disabled        = !busy;
  loadRefsBtn.disabled    = busy || refImages.length === 0;
  refreshRunButton();
}

function showContinue(fromIndex) {
  resumeFromIdx = fromIndex;
  continueBtn.textContent = `Continue from #${fromIndex + 1}`;
  continueBtn.hidden = false;
  runBtn.hidden = true;
}

function hideContinue() {
  resumeFromIdx = null;
  continueBtn.hidden = true;
  runBtn.hidden = false;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requireProjectTab() {
  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) { setStatus(MSG_OPEN_PROJECT); return null; }
  return tab;
}

async function sendToFlowTab(message) {
  if (!chrome.runtime?.id) {
    setStatus("This panel is out of date. Close it and reopen it from the toolbar icon.");
    return null;
  }
  const tabId = flowTabId || (await getActiveTab())?.id;
  if (!tabId) { setStatus("No active tab."); return null; }

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script may be missing (tab opened before install/reload): inject and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["selectors.js", "content.js"] });
      await sleep(300);
      const res = await chrome.tabs.sendMessage(tabId, message);
      checkConnection();
      return res;
    } catch (e2) {
      const msg = String(e2?.message || e2);
      setStatus(msg.includes("context invalidated")
        ? "This panel is out of date. Close it and reopen it from the toolbar icon."
        : MSG_NOT_READY);
      return null;
    }
  }
}

// ─────────────────────────────────────────────
// Help dialog
// ─────────────────────────────────────────────
helpOpen.addEventListener("click", () => helpDialog.showModal());
helpClose.addEventListener("click", () => helpDialog.close());

// ─────────────────────────────────────────────
// Theme: system → light → dark (theme.js applies the saved choice before first paint)
// ─────────────────────────────────────────────
const THEME_LABEL = { system: "Theme: match system", light: "Theme: light", dark: "Theme: dark" };

function applyTheme(mode) {
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else { delete document.documentElement.dataset.theme; mode = "system"; }
  themeBtn.dataset.mode = mode;
  themeBtn.title = THEME_LABEL[mode];
  themeBtn.setAttribute("aria-label", `${THEME_LABEL[mode]}. Click to change.`);
  try { localStorage.setItem("nexusTheme", mode); } catch { /* storage blocked */ }
}

applyTheme(document.documentElement.dataset.theme || "system");
themeBtn.addEventListener("click", () => {
  const next = { system: "light", light: "dark", dark: "system" }[themeBtn.dataset.mode] || "system";
  applyTheme(next);
});

// ─────────────────────────────────────────────
// File names dropdown (custom listbox; the hidden #namingMode input holds the value)
// ─────────────────────────────────────────────
const namingOptions = Array.from(namingListEl.querySelectorAll(".dd__opt"));
let namingActive = 0;

function setNamingMode(value, { notify = false } = {}) {
  const opt = namingOptions.find(o => o.dataset.value === value) || namingOptions[0];
  namingModeEl.value = opt.dataset.value;
  namingOptions.forEach(o => o.setAttribute("aria-selected", String(o === opt)));
  namingValueEl.innerHTML = opt.innerHTML;
  if (notify) namingModeEl.dispatchEvent(new Event("change"));
}

function setNamingActive(i) {
  namingActive = (i + namingOptions.length) % namingOptions.length;
  namingOptions.forEach((o, k) => o.classList.toggle("is-active", k === namingActive));
  namingListEl.setAttribute("aria-activedescendant", namingOptions[namingActive].id);
}

function openNamingList() {
  if (namingBtn.disabled) return;
  namingListEl.hidden = false;
  namingBtn.setAttribute("aria-expanded", "true");
  setNamingActive(Math.max(0, namingOptions.findIndex(o => o.dataset.value === namingModeEl.value)));
  namingListEl.focus();
}

function closeNamingList({ refocus = false } = {}) {
  if (namingListEl.hidden) return;
  namingListEl.hidden = true;
  namingBtn.setAttribute("aria-expanded", "false");
  if (refocus) namingBtn.focus();
}

namingBtn.addEventListener("click", () => (namingListEl.hidden ? openNamingList() : closeNamingList()));
namingBtn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openNamingList(); }
});
namingOptions.forEach((o, i) => {
  o.addEventListener("mousemove", () => setNamingActive(i));
  o.addEventListener("click", () => { setNamingMode(o.dataset.value, { notify: true }); closeNamingList({ refocus: true }); });
});
namingListEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setNamingActive(namingActive + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setNamingActive(namingActive - 1); }
  else if (e.key === "Home") { e.preventDefault(); setNamingActive(0); }
  else if (e.key === "End") { e.preventDefault(); setNamingActive(namingOptions.length - 1); }
  else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setNamingMode(namingOptions[namingActive].dataset.value, { notify: true });
    closeNamingList({ refocus: true });
  } else if (e.key === "Escape") { e.preventDefault(); closeNamingList({ refocus: true }); }
  else if (e.key === "Tab") closeNamingList();
});
document.addEventListener("mousedown", (e) => {
  if (!namingListEl.hidden && !e.target.closest("#namingDd")) closeNamingList();
});
setNamingMode(namingModeEl.value);

// ─────────────────────────────────────────────
// Prompts + queue
// ─────────────────────────────────────────────
let promptStatuses = [];

const STATUS_LABEL = {
  pending:    "Pending",
  generating: "Generating",
  done:       "Done",
  failed:     "Failed",
  stopped:    "Skipped",
};

function parsePrompts() {
  return promptsEl.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function rebuildList() {
  const lines = parsePrompts();
  promptCountEl.textContent = lines.length ? plural(lines.length, "prompt") : "One per line";
  if (!lines.length) { listSection.hidden = true; promptStatuses = []; return; }

  const prev = promptStatuses;
  promptStatuses = lines.map((text, i) => ({
    text,
    status: (prev[i] && prev[i].text === text) ? prev[i].status : "pending",
  }));
  renderList();
}

function renderList() {
  promptListEl.textContent = "";
  promptStatuses.forEach((item, i) => {
    const row = document.createElement("div");
    row.id = `pr-${i}`;

    const num = document.createElement("span");
    num.className = "q-item__num";
    num.textContent = String(i + 1).padStart(2, "0");

    const text = document.createElement("span");
    text.className = "q-item__text";
    text.textContent = item.text;
    text.title = item.text;

    const side = document.createElement("span");
    side.className = "q-item__side";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "q-retry";
    retry.dataset.idx = String(i);
    retry.title = "Regenerate this image and replace the saved file";
    retry.textContent = "Retry";
    const tag = document.createElement("span");
    tag.className = "tag";
    side.append(retry, tag);

    row.append(num, text, side);
    promptListEl.appendChild(row);
    paintRow(row, item.status);
  });
  listSection.hidden = false;
  listCountEl.textContent = plural(promptStatuses.length, "prompt");
}

function paintRow(row, status) {
  row.className = "q-item" + (status === "generating" ? " is-running" : "");
  const tag = row.querySelector(".tag");
  tag.className = `tag s-${status}`;
  tag.textContent = STATUS_LABEL[status] || status;
}

function updateStatus(index, status) {
  if (index < 0 || index >= promptStatuses.length) return;
  promptStatuses[index].status = status;
  const row = document.getElementById(`pr-${index}`);
  if (!row) return;
  paintRow(row, status);
  if (status === "generating") row.scrollIntoView({ block: "nearest" });
}

promptsEl.addEventListener("input", () => {
  if (isRunning) return;
  rebuildList();
  hideContinue();   // a resume point no longer matches edited prompts
  refreshRunButton();
});

txtUploadEl.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const lines = String(ev.target.result || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    promptsEl.value = lines.join("\n");
    rebuildList();
    hideContinue();
    refreshRunButton();
    setStatus(`Imported ${plural(lines.length, "prompt")} from ${file.name}.`);
  };
  reader.readAsText(file);
  txtUploadEl.value = ""; // so the same file can be imported again
});

// ─────────────────────────────────────────────
// Reference images + library
// ─────────────────────────────────────────────
const libraryEl      = document.getElementById("refLibrary");
const libraryGridEl  = document.getElementById("refLibraryGrid");
const libraryCountEl = document.getElementById("refLibraryCount");
const libraryEmptyEl = document.getElementById("refLibraryEmpty");

async function refIdFor(base64) {
  const bytes = new TextEncoder().encode(base64);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "ref-" + Array.from(hash.slice(0, 4), b => b.toString(16).padStart(2, "0")).join("");
}

// Name the image has in the Flow project; the content script searches the picker for it.
function projectNameOf(ref) { return `${ref.id}.png`; }

function syncActive() {
  activeIds = activeIds.filter(id => library.some(r => r.id === id)).slice(0, MAX_REF_IMAGES);
  refImages = activeIds.map(id => library.find(r => r.id === id));
}

function persistRefs() {
  chrome.storage.local.set({ nexusLibrary: library, nexusActiveRefs: activeIds });
}

function refreshRefs() {
  syncActive();
  persistRefs();
  renderRefImages();
  renderLibrary();
}

function setActive(id, on) {
  if (on) {
    if (activeIds.includes(id)) return true;
    if (activeIds.length >= MAX_REF_IMAGES) {
      setStatus(`You can use up to ${MAX_REF_IMAGES} references at once. Remove one first.`);
      return false;
    }
    activeIds.push(id);
  } else {
    activeIds = activeIds.filter(x => x !== id);
  }
  refreshRefs();
  return true;
}

function thumb(ref) {
  const img = document.createElement("img");
  img.src = ref.base64;
  img.alt = ref.name || "Reference";
  img.decoding = "async";
  return img;
}

function renderRefImages() {
  refImageListEl.querySelectorAll(".ref").forEach(n => n.remove());
  refImages.forEach((ref) => {
    const item = document.createElement("div");
    item.className = "ref";
    item.title = ref.name || "Reference";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref__remove";
    remove.setAttribute("aria-label", `Stop using ${ref.name || "this reference"} (it stays in the library)`);
    remove.title = "Remove (stays in library)";
    remove.textContent = "✕";
    remove.addEventListener("click", () => setActive(ref.id, false));

    item.append(thumb(ref), remove);
    refImageListEl.insertBefore(item, refImageLabelEl);
  });

  refImageLabelEl.classList.toggle("is-full", refImages.length >= MAX_REF_IMAGES);
  refImageClearEl.hidden = refImages.length === 0;
  loadRefsBtn.disabled = refImages.length === 0 || isRunning;
}

function renderLibrary() {
  libraryGridEl.textContent = "";
  libraryCountEl.textContent = String(library.length);
  libraryEmptyEl.hidden = library.length > 0;

  for (const ref of library) {
    const inUse = activeIds.includes(ref.id);
    const tile = document.createElement("div");
    tile.className = "lib-item" + (inUse ? " is-active" : "");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "lib-item__pick";
    pick.setAttribute("aria-pressed", String(inUse));
    pick.title = `${ref.name || "Reference"}: ${inUse ? "in use, click to remove" : "click to use"}`;
    pick.append(thumb(ref));
    const badge = document.createElement("span");
    badge.className = "lib-item__badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "✓";
    pick.append(badge);
    pick.addEventListener("click", () => setActive(ref.id, !inUse));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "lib-item__delete";
    del.title = "Delete from library";
    del.setAttribute("aria-label", `Delete ${ref.name || "this image"} from the library`);
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
    del.addEventListener("click", () => {
      library = library.filter(r => r.id !== ref.id);
      refreshRefs();
    });

    const name = document.createElement("span");
    name.className = "lib-item__name";
    name.textContent = ref.name || "Reference";

    tile.append(pick, del, name);
    libraryGridEl.appendChild(tile);
  }
}

// Remember whether the library is open.
try { libraryEl.open = localStorage.getItem("nexusLibraryOpen") === "1"; } catch { /* storage blocked */ }
libraryEl.addEventListener("toggle", () => {
  try { localStorage.setItem("nexusLibraryOpen", libraryEl.open ? "1" : "0"); } catch { /* storage blocked */ }
});

// New uploads go into the library and straight into use. The same picture added twice
// is recognised and reused rather than stored again.
refImageUploadEl.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  refImageUploadEl.value = "";
  if (!files.length) return;

  const loaded = await Promise.all(files.map(file => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve({ base64: ev.target.result, name: file.name });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  })));

  let skipped = 0;
  for (const img of loaded.filter(Boolean)) {
    const id = await refIdFor(img.base64);
    if (!library.some(r => r.id === id)) library.unshift({ id, ...img });
    if (!activeIds.includes(id)) {
      if (activeIds.length < MAX_REF_IMAGES) activeIds.push(id);
      else skipped++;
    }
  }
  refreshRefs();
  if (skipped) setStatus(`${plural(skipped, "image")} went to the library only: you can use up to ${MAX_REF_IMAGES} references at once.`);
});

refImageClearEl.addEventListener("click", () => {
  activeIds = [];
  refreshRefs();   // the library keeps everything
});

// Status and error text from the Flow tab names references by their project name
// ("ref-1a2b3c4d.png"); show the file name people recognise instead.
function friendlyRefNames(text) {
  return String(text).replace(/ref-[0-9a-f]{8}\.png/g, (m) => {
    const ref = library.find(r => projectNameOf(r) === m);
    return ref?.name ? `“${ref.name}”` : m;
  });
}

loadRefsBtn.addEventListener("click", async () => {
  if (isRunning || !refImages.length) return;
  const tab = await requireProjectTab();
  if (!tab) return;

  flowTabId = tab.id;
  setBusy(true);
  loadRefsBtn.classList.add("is-busy");
  setStatus(`Uploading ${plural(refImages.length, "reference")} to the project…`);

  const res = await sendToFlowTab({
    type: "FLOW_LOAD_REFERENCES",
    charDelayMs: CHAR_DELAY_MS,
    refImages: refImages.map(r => r.base64),
    refNames: refImages.map(projectNameOf),
  });

  flowTabId = null;
  loadRefsBtn.classList.remove("is-busy");
  setBusy(false);

  if (!res || res.error) { setStatus(res?.error || "Upload failed. Open your Flow project tab and try again."); return; }
  const parts = [];
  if (res.loaded) parts.push(`${res.loaded} uploaded`);
  if (res.failed) parts.push(`${res.failed} failed`);
  const summary = parts.join(", ") || "Nothing to upload";
  setStatus(res.stopped
    ? `Stopped. ${summary}.`
    : `${summary}. Click Hard refresh, check the references appear in Flow, then Start.`);
});

hardRefreshBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) { setStatus("No active tab."); return; }
  try {
    await chrome.tabs.reload(tab.id, { bypassCache: true });
    setStatus("Flow tab refreshed. Check the references appear, then Start.");
  } catch {
    setStatus("Couldn't refresh the tab. Refresh it yourself (Cmd/Ctrl+Shift+R).");
  }
});

// ─────────────────────────────────────────────
// Output folder + file names
// ─────────────────────────────────────────────
let dirHandle = null;

chooseFolderBtn.addEventListener("click", async () => {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    folderNameEl.textContent = dirHandle.name;
    chooseFolderBtn.classList.add("is-chosen");
  } catch (e) {
    if (e.name !== "AbortError") console.warn("[Nexus Flow] Folder picker:", e);
  }
});

function extractTimestamp(line) {
  const m = line.match(/^\[(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\]/);
  return m ? m[1] : null;
}

function stripTimestamp(line) {
  return line.replace(/^\[\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\]\s*[-–—]?\s*/, "").trim();
}

function safePromptName(text) {
  return text
    .slice(0, 30)
    .replace(/:/g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^\w_\-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 25);
}

function base64ToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mime  = parts[0].match(/:(.*?);/)[1];
  const bytes = atob(parts[1]);
  const buf   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

function fileNameFor(serialNum, rawPromptText) {
  const ts   = extractTimestamp(rawPromptText);
  const name = safePromptName(stripTimestamp(rawPromptText));
  const mode = namingModeEl.value;
  // serialNum is the zero-based prompt index, so the first prompt is 000.
  if (mode === "timestamp" && ts) return `${ts.replace(/[:.]/g, "-")}-${name}.jpg`;
  if (mode === "serial") return `${String(serialNum).padStart(3, "0")}-${name}.jpg`;
  return `${name}.jpg`;
}

// Saves one finished image to the chosen destination.
// Resolves { ok: true } or { ok: false, error, needsAuth }.
async function saveImage(url, serialNum, rawPromptText) {
  if (!url.startsWith("http") && !url.startsWith("blob:")) {
    let origin = FLOW_BASE;
    try {
      const activeUrl = (await getActiveTab())?.url;
      if (activeUrl) origin = new URL(activeUrl).origin;
    } catch { /* fall back to FLOW_BASE */ }
    url = origin + url;
  }
  const filename = fileNameFor(serialNum, rawPromptText);

  try {
    if (saveDest === "drive") {
      // Flow's image URLs only load with the page's cookies, so the content script fetches it.
      const res = await sendToFlowTab({ type: "NEXUS_FETCH_IMAGE", url });
      if (!res?.base64) return { ok: false, error: res?.error || "Couldn't read the image from Flow." };
      await Drive.uploadImage(driveFolder, filename, base64ToBlob(res.base64));
    } else if (dirHandle) {
      const res = await sendToFlowTab({ type: "NEXUS_FETCH_IMAGE", url });
      if (!res?.base64) return { ok: false, error: res?.error || "Couldn't read the image from Flow." };
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(base64ToBlob(res.base64));
      await writable.close();
    } else {
      const folder = (downloadFolderEl.value || "nexus-flow").replace(/[/\\]+$/, "");
      // overwrite so a Retry replaces the existing file instead of making "name (1).jpg"
      await chrome.downloads.download({ url, filename: `${folder}/${filename}`, saveAs: false, conflictAction: "overwrite" });
    }
    return { ok: true };
  } catch (e) {
    console.warn("[Nexus Flow] Save failed:", e);
    return { ok: false, error: String(e?.message || e), needsAuth: e instanceof Drive.NeedsAuthError };
  }
}

// ─────────────────────────────────────────────
// Google Drive destination: paste a folder link, we verify it and show a checkmark
// ─────────────────────────────────────────────
let saveDest    = "local";   // "local" | "drive"
let driveFolder = null;      // verified folder { id, name, resourceKey, owner, canAdd }; null until checked
let checkSeq    = 0;
let checkTimer  = null;

function setDest(dest, { persist = true } = {}) {
  saveDest = dest === "drive" ? "drive" : "local";
  destOpts.forEach(b => b.setAttribute("aria-checked", String(b.dataset.dest === saveDest)));
  destLocalEl.hidden = saveDest !== "local";
  destDriveEl.hidden = saveDest !== "drive";
  if (persist) chrome.storage.local.set({ nexusSaveDest: saveDest });
  if (saveDest === "drive") initDrive();
}

destOpts.forEach(b => b.addEventListener("click", () => setDest(b.dataset.dest)));

// ── Step 1: connect to the Drive uploader (an Apps Script web app; docs/drive-uploader.gs) ──
let driveConn = "off";   // "off" | "connecting" | "on"

function setDriveConn(state, sub) {
  driveConn = state;
  driveConnEl.className = `dconn is-${state}`;
  driveConnTitle.textContent = state === "on" ? "Ready to upload to Drive" : "Google Drive uploads";
  driveConnSub.textContent = sub || { off: "Not connected", connecting: "Connecting…", on: "Connected" }[state];
  driveChangeBtn.hidden = driveDisconnect.hidden = state !== "on";
  driveConnectBtn.disabled = state === "connecting" || isRunning;
  driveConnectBtn.textContent = state === "connecting" ? "Connecting…" : "Connect";
  driveLinkInput.disabled = state !== "on" || isRunning;
  // The folder box only matters once uploads can go somewhere.
  driveLinkWrap.hidden = driveLinkMsg.hidden = state !== "on";
}

function showDriveSetup(open, { canCancel = false } = {}) {
  driveSetupEl.hidden = !open;
  driveSetupCancel.hidden = !canCancel;
  driveSetupError.hidden = true;
  if (open) {
    const u = Drive.getUploader();
    driveUrlInput.value = u.url || "";
  }
}

async function refreshDriveConn() {
  await Drive.ready;
  if (Drive.isConnected()) {
    // The email is only who the files are uploaded AS; they go into whatever folder link is pasted.
    setDriveConn("on", `Uploading as ${Drive.getUploader().email}`);
    showDriveSetup(false);
    return true;
  }
  setDriveConn("off");
  showDriveSetup(true);
  return false;
}

driveConnectBtn.addEventListener("click", async () => {
  driveSetupError.hidden = true;
  setDriveConn("connecting");
  try {
    await Drive.connect(driveUrlInput.value);
  } catch (e) {
    setDriveConn("off");
    driveSetupError.textContent = e.message;
    driveSetupError.hidden = false;
    return;
  }
  driveFolder = null;
  await refreshDriveConn();
  if (driveLinkInput.value.trim()) checkDriveLink();
  else { setLinkState("", DRIVE_EMPTY_HINT); driveLinkInput.focus(); }
});
driveUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") driveConnectBtn.click(); });

driveChangeBtn.addEventListener("click", () => {
  setDriveConn("off", "Paste a new uploader link");
  showDriveSetup(true, { canCancel: true });
  driveUrlInput.focus();
});
driveSetupCancel.addEventListener("click", () => initDrive());

driveDisconnect.addEventListener("click", async () => {
  await Drive.disconnect();
  driveFolder = null;
  setDriveConn("off", "Disconnected");
  showDriveSetup(true);
});

// ── Step 2: the folder link ──
// state: "" | "checking" | "ok" | "bad"
function setLinkState(state, message) {
  driveLinkWrap.className = "dlink" + (state ? ` is-${state}` : "");
  driveLinkMsg.className = "dlink__msg" + (state === "ok" || state === "bad" ? ` is-${state}` : "");
  driveLinkMsg.textContent = "";
  if (state === "ok" && driveFolder) {
    driveLinkMsg.append("Can upload to ");
    const name = document.createElement("b");
    name.textContent = driveFolder.name;
    driveLinkMsg.append(name);
    if (driveFolder.owner && driveFolder.owner !== "You") driveLinkMsg.append(` · ${driveFolder.owner}`);
    const open = document.createElement("a");
    open.href = Drive.folderUrl(driveFolder);
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open";
    driveLinkMsg.append(open);
    return;
  }
  driveLinkMsg.textContent = message || "";
}

const DRIVE_EMPTY_HINT = "Paste any Google Drive folder link — yours or someone else's. It must allow adding files (e.g. “Anyone with the link: Editor”).";

async function initDrive() {
  const connected = await refreshDriveConn();
  if (!connected) { setLinkState("", ""); return; }
  if (driveLinkInput.value.trim()) checkDriveLink();
  else setLinkState("", DRIVE_EMPTY_HINT);
}

// Verify the pasted link: it must be a Drive folder this account can add files to.
async function checkDriveLink() {
  const seq = ++checkSeq;
  const text = driveLinkInput.value.trim();
  driveFolder = null;
  chrome.storage.local.set({ nexusDriveLink: text, nexusDriveFolder: null });

  if (driveConn !== "on") { setLinkState("", ""); return; }
  if (!text) { setLinkState("", DRIVE_EMPTY_HINT); return; }
  const ref = Drive.parseFolderRef(text);
  if (!ref) { setLinkState("bad", "That isn't a Google Drive folder link. Copy it from the folder's Share menu or address bar."); return; }

  setLinkState("checking", "Checking access…");
  try {
    const folder = await Drive.getFolder(ref);
    if (seq !== checkSeq) return;
    if (!folder.canAdd) {
      setLinkState("bad", `You can view “${folder.name}” but can't add files to it. Ask the owner to set it to “Anyone with the link: Editor” or share it with you as Editor.`);
      return;
    }
    driveFolder = folder;
    chrome.storage.local.set({ nexusDriveFolder: folder });
    setLinkState("ok");
    driveLinkInput.scrollLeft = 0;   // show the start of the link, not the tail
  } catch (e) {
    if (seq !== checkSeq) return;
    if (e instanceof Drive.NeedsAuthError) {
      setDriveConn("off", "The uploader script's password isn't \"Nexus\". Fix the script, then Connect again.");
      showDriveSetup(true);
    } else {
      setLinkState("bad", e.message);
    }
  }
}

driveLinkInput.addEventListener("input", () => {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkDriveLink, 500);
});
driveLinkInput.addEventListener("paste", () => {
  clearTimeout(checkTimer);
  // let the pasted text land in the input first
  checkTimer = setTimeout(checkDriveLink, 0);
});
driveLinkInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { clearTimeout(checkTimer); checkDriveLink(); }
});

// Blocks a run that would generate images with nowhere to put them.
async function destinationProblem() {
  if (saveDest !== "drive") return null;
  await Drive.ready;
  if (!Drive.isConnected()) return "Connect your Drive uploader under Save to, or switch to Computer.";
  if (!driveFolder) return "Paste a Google Drive folder link under Save to and wait for the checkmark.";
  return null;
}

// ─────────────────────────────────────────────
// Connection + agent mode
// ─────────────────────────────────────────────
function setConnection(state, msg, link) {
  isConnected = state === "is-connected";
  connBar.className = `status-row ${state}`;
  connMsg.textContent = msg;
  connLink.hidden = !link;
  if (link) { connLink.textContent = link.text; connLink.href = link.href; }
  if (!isConnected) agentChip.hidden = true;
  refreshRunButton();
}

async function checkAgentMode() {
  const res = await sendToFlowTab({ type: "FLOW_GET_AGENT_MODE" });
  if (!res?.found) { agentChip.hidden = true; agentModeOn = false; refreshRunButton(); return; }
  agentModeOn = !!res.isOn;
  agentChip.hidden = false;
  agentChip.classList.toggle("is-on", agentModeOn);
  agentStateEl.textContent = agentModeOn ? "on" : "off";
  agentChip.title = agentModeOn ? "Turn off Agent mode in Flow to start generating" : "Agent mode is off";
  refreshRunButton();
}

async function pingContentScript(tabId) {
  if (!chrome.runtime?.id || !tabId) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "FLOW_BATCH_PING" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

async function checkConnection() {
  const tab = await getActiveTab();
  const url = tab?.url || "";
  if (FLOW_PROJECT_RE.test(url)) {
    let alive = await pingContentScript(tab.id);
    if (!alive && tab?.id) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["selectors.js", "content.js"] });
        await sleep(250);
        alive = await pingContentScript(tab.id);
      } catch (err) {
        console.warn("[Nexus Flow] Auto-inject failed:", err);
      }
    }
    if (alive) {
      setConnection("is-connected", "Connected to Flow");
      checkAgentMode();
    } else {
      setConnection("is-warn", "Hard-refresh the Flow tab (Cmd/Ctrl+Shift+R)");
    }
  } else if (FLOW_BASE_RE.test(url)) {
    setConnection("is-warn", "Open a Flow project to continue");
  } else {
    setConnection("is-off", "Not on Google Flow", { text: "Open Flow", href: FLOW_BASE });
  }
}

checkConnection();
setInterval(() => { if (isConnected) checkAgentMode(); }, 3000);
chrome.tabs.onActivated.addListener(() => checkConnection());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) checkConnection();
    });
  }
});

// ─────────────────────────────────────────────
// Run queue
// ─────────────────────────────────────────────
async function startQueue(startIndex = 0) {
  const lines = parsePrompts();
  if (!lines.length) { setStatus("Add at least one prompt."); return; }
  const destError = await destinationProblem();
  if (destError) { setStatus(destError); return; }

  const activeTab = await getActiveTab();
  if (!activeTab?.id) { setStatus("No active tab."); return; }
  flowTabId = activeTab.id;

  // Fresh start resets every status; Continue keeps the finished ones.
  if (startIndex === 0) {
    promptStatuses = lines.map(text => ({ text, status: "pending" }));
  } else {
    for (let j = startIndex; j < lines.length; j++) {
      if (promptStatuses[j]) promptStatuses[j].status = "pending";
    }
  }
  renderList();

  hideContinue();
  setBusy(true);
  let completed = 0;
  const total = lines.length;
  setStatus(`Starting ${plural(total - startIndex, "prompt")}…`);

  // Snapshot existing images and start the content script's finish-order scanner.
  const begin = await sendToFlowTab({ type: "FLOW_PIPELINE_BEGIN" });
  if (isRunning && (!begin || begin.error)) {
    setStatus(begin?.error || MSG_NOT_READY);
    isRunning = false;
  }

  let submitIdx = startIndex;
  let inFlight  = [];                 // jobIndexes submitted but not yet collected
  let collectedCount = 0;
  const submitFailed = new Set();
  const totalToProcess = total - startIndex;

  try {
    while (isRunning && (collectedCount + submitFailed.size) < totalToProcess) {
      // Phase 1: submit until PARALLEL slots are full.
      while (isRunning && submitIdx < total && inFlight.length < PARALLEL) {
        const curIdx = submitIdx;
        updateStatus(curIdx, "generating");
        setStatus(`Submitting prompt ${curIdx + 1} of ${total}…`);

        const res = await sendToFlowTab({
          type: "FLOW_SUBMIT_ONE",
          prompt: stripTimestamp(lines[curIdx]),
          charDelayMs: CHAR_DELAY_MS,
          refImages: refImages.map(r => r.base64),
          refNames: refImages.map(projectNameOf),
          jobIndex: curIdx,
        });

        if (!isRunning) break;

        if (!res || res.error) {
          updateStatus(curIdx, "failed");
          submitFailed.add(curIdx);
          setStatus(res?.error || `Prompt ${curIdx + 1} couldn't be submitted.`);
          // Can't find or fill the prompt box: every later prompt would fail the same way.
          if (res?.error && /prompt field|prompt text/i.test(res.error)) {
            for (let j = curIdx + 1; j < total; j++) updateStatus(j, "stopped");
            isRunning = false;
            break;
          }
        } else {
          inFlight.push(curIdx);
        }
        submitIdx++;

        if (isRunning && submitIdx < total && inFlight.length < PARALLEL) await sleep(SUBMIT_DELAY_MS);
      }

      if (!isRunning || !inFlight.length) break;

      // Phase 2: collect whichever generation finishes next.
      setStatus(`Waiting for results… ${inFlight.length} generating`);
      const c = await sendToFlowTab({ type: "FLOW_COLLECT_NEXT", timeoutMs: COLLECT_TIMEOUT_MS });
      if (!isRunning) break;

      // The content script tags each result with the prompt whose tile produced it.
      let idx = (typeof c?.jobIndex === "number") ? c.jobIndex : null;
      if (idx === null || !inFlight.includes(idx)) idx = inFlight[0];
      inFlight = inFlight.filter(j => j !== idx);

      if (c?.done && c.url) {
        setStatus(saveDest === "drive" ? `Uploading prompt ${idx + 1} to Drive…` : `Saving prompt ${idx + 1}…`);
        const saved = await saveImage(c.url, idx, lines[idx]);
        if (saved.ok) {
          updateStatus(idx, "done");
          completed++;
          setStatus(`${completed} of ${totalToProcess} done · ${inFlight.length} generating`);
        } else {
          updateStatus(idx, "failed");
          setStatus(`Prompt ${idx + 1} generated but wasn't saved: ${saved.error}`);
          if (saved.needsAuth) {
            // Every later upload would fail the same way; stop so Continue can resume after reconnecting.
            isRunning = false;
            setStatus('The Drive uploader script\'s password isn\'t "Nexus". Fix the script, then Continue.');
            setDriveConn("off", "The uploader script's password isn't \"Nexus\". Fix the script, then Connect again.");
            showDriveSetup(true);
          }
        }
      } else if (c?.stopped || !isRunning) {
        break;
      } else {
        // Not added to submitFailed: collectedCount below already accounts for this job,
        // and counting it twice ended the loop with prompts still generating.
        updateStatus(idx, "failed");
        setStatus(`Prompt ${idx + 1} failed.`);
      }
      collectedCount++;
    }
  } catch (err) {
    setStatus(`Run error: ${err.message || err}`);
  } finally {
    await sendToFlowTab({ type: "FLOW_PIPELINE_END" });

    const wasStopped = !isRunning;
    if (wasStopped) {
      for (let j = startIndex; j < total; j++) {
        const s = promptStatuses[j]?.status;
        if (s && s !== "done" && s !== "failed") updateStatus(j, "stopped");
      }
    }

    flowTabId = null;
    setBusy(false);

    const failedCount  = promptStatuses.filter(p => p.status === "failed").length;
    const stoppedCount = promptStatuses.filter(p => p.status === "stopped").length;

    if (stoppedCount > 0) {
      showContinue(promptStatuses.findIndex(p => p.status === "stopped"));
      setStatus(`Stopped. ${completed} done, ${stoppedCount} skipped.`);
    } else if (failedCount > 0) {
      setStatus(`Finished. ${completed} done, ${failedCount} failed. Use Retry on the failed ones.`);
    } else {
      setStatus(`All ${plural(completed, "image")} generated and saved.`);
    }
  }
}

runBtn.addEventListener("click", () => startQueue(0));
continueBtn.addEventListener("click", () => {
  if (resumeFromIdx !== null) startQueue(resumeFromIdx);
});

stopBtn.addEventListener("click", async () => {
  if (!isRunning) return;
  isRunning = false;
  // Tell the locked Flow tab BEFORE releasing it so the content script aborts its loops.
  await sendToFlowTab({ type: "FLOW_BATCH_STOP" });
  setStatus("Stopping…");
});

// ─────────────────────────────────────────────
// Per-prompt Retry: regenerate one image and replace its saved file
// ─────────────────────────────────────────────
promptListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".q-retry");
  if (!btn || isRunning) return;
  const idx = Number(btn.dataset.idx);
  if (!Number.isNaN(idx)) retryPrompt(idx);
});

async function retryPrompt(index) {
  const item = promptStatuses[index];
  if (!item || isRunning) return;
  const destError = await destinationProblem();
  if (destError) { setStatus(destError); return; }
  const tab = await requireProjectTab();
  if (!tab) return;
  flowTabId = tab.id;

  const prevStatus = item.status;
  setBusy(true);
  updateStatus(index, "generating");
  setStatus(`Retrying prompt ${index + 1}…`);

  try {
    const begin = await sendToFlowTab({ type: "FLOW_PIPELINE_BEGIN" });
    if (!begin || begin.error) { setStatus(begin?.error || MSG_NOT_READY); updateStatus(index, prevStatus); return; }

    const sub = await sendToFlowTab({
      type: "FLOW_SUBMIT_ONE",
      prompt: stripTimestamp(item.text),
      charDelayMs: CHAR_DELAY_MS,
      refImages: refImages.map(r => r.base64),
      refNames: refImages.map(projectNameOf),
    });
    if (!isRunning) { updateStatus(index, prevStatus); return; }
    if (!sub || sub.error) { setStatus(sub?.error || "Retry couldn't be submitted."); updateStatus(index, "failed"); return; }

    setStatus(`Prompt ${index + 1} regenerating…`);
    const c = await sendToFlowTab({ type: "FLOW_COLLECT_NEXT", timeoutMs: COLLECT_TIMEOUT_MS });

    if (c?.done && c.url) {
      const saved = await saveImage(c.url, index, item.text);   // same index → same filename → overwrite
      if (saved.ok) {
        updateStatus(index, "done");
        setStatus(`Prompt ${index + 1} regenerated and replaced.`);
      } else {
        updateStatus(index, "failed");
        setStatus(`Prompt ${index + 1} regenerated but wasn't saved: ${saved.error}`);
        if (saved.needsAuth) { setDriveConn("off", "The uploader script's password isn't \"Nexus\". Fix the script, then Connect again."); showDriveSetup(true); }
      }
    } else if (c?.stopped || !isRunning) {
      updateStatus(index, prevStatus);
      setStatus("Retry stopped. The old image was kept.");
    } else {
      updateStatus(index, "failed");
      setStatus(`Retry of prompt ${index + 1} failed. The old image was kept.`);
    }
  } finally {
    await sendToFlowTab({ type: "FLOW_PIPELINE_END" });
    flowTabId = null;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────
// Persist / restore (settings and references only; prompts start fresh)
// ─────────────────────────────────────────────
chrome.storage.local.get(["nexusNaming", "nexusSaveDest", "nexusDriveLink", "nexusLibrary", "nexusActiveRefs", "nexusRefImages", "nexusRefImage", "nexusRefImageName"], (r) => {
  if (r.nexusNaming) setNamingMode(r.nexusNaming);
  if (r.nexusDriveLink) driveLinkInput.value = r.nexusDriveLink;
  setDest(r.nexusSaveDest || "local", { persist: false });
  restoreRefs(r);
});

async function restoreRefs(r) {
  if (Array.isArray(r.nexusLibrary)) {
    library = r.nexusLibrary.filter(x => x && x.id && x.base64);
    activeIds = Array.isArray(r.nexusActiveRefs) ? r.nexusActiveRefs : [];
  } else {
    // Older versions kept only the references in use: they become the library and stay in use.
    const old = Array.isArray(r.nexusRefImages) ? r.nexusRefImages.filter(x => x && x.base64)
      : r.nexusRefImage ? [{ base64: r.nexusRefImage, name: r.nexusRefImageName || "reference.png" }] : [];
    for (const img of old) {
      const id = await refIdFor(img.base64);
      if (!library.some(x => x.id === id)) library.push({ id, base64: img.base64, name: img.name || "reference.png" });
      if (!activeIds.includes(id)) activeIds.push(id);
    }
    chrome.storage.local.remove(["nexusRefImages", "nexusRefImage", "nexusRefImageName"]);
  }
  refreshRefs();
}

// Drop keys for settings that no longer exist.
chrome.storage.local.remove(["flowBatchWaitMin", "flowBatchWaitMax", "nexusParallelCount", "nexusUpscale", "nexusLang"]);

namingModeEl.addEventListener("change", () => chrome.storage.local.set({ nexusNaming: namingModeEl.value }));

stopBtn.disabled = true;
rebuildList();
