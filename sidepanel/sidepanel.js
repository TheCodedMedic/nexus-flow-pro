// Fixed run settings. These used to be user inputs; 5 in flight with 3s between
// submissions is the combination that keeps Flow stable.
const PARALLEL        = 5;
const SUBMIT_DELAY_MS = 3000;
const COLLECT_TIMEOUT_MS = 180000;
const CHAR_DELAY_MS   = 30;

// Reference images — all of them are attached to every prompt.
const MAX_REF_IMAGES = 8;
let refImages = []; // [{ base64, name }]

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
const refImageUploadEl = document.getElementById("refImageUpload");
const refImageClearEl  = document.getElementById("refImageClear");
const refImageListEl   = document.getElementById("refImageList");
const refImageLabelEl  = document.getElementById("refImageLabel");
const loadRefsBtn      = document.getElementById("loadRefsBtn");
const hardRefreshBtn   = document.getElementById("hardRefreshBtn");
const chooseFolderBtn  = document.getElementById("chooseFolderBtn");
const folderNameEl     = document.getElementById("folderName");

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

function setStatus(text) { statusEl.textContent = text; }

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
  namingModeEl.disabled   = busy;
  txtUploadEl.disabled    = busy;
  chooseFolderBtn.disabled = busy;
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
// Reference images
// ─────────────────────────────────────────────
function persistRefImages() {
  chrome.storage.local.set({ nexusRefImages: refImages });
}

function renderRefImages() {
  refImageListEl.querySelectorAll(".ref").forEach(n => n.remove());
  refImages.forEach((ref, idx) => {
    const item = document.createElement("div");
    item.className = "ref";
    item.title = ref.name || `Reference ${idx + 1}`;

    const img = document.createElement("img");
    img.src = ref.base64;
    img.alt = ref.name || `Reference ${idx + 1}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref__remove";
    remove.setAttribute("aria-label", `Remove ${img.alt}`);
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      refImages.splice(idx, 1);
      persistRefImages();
      renderRefImages();
    });

    item.append(img, remove);
    refImageListEl.insertBefore(item, refImageLabelEl);
  });

  refImageLabelEl.classList.toggle("is-full", refImages.length >= MAX_REF_IMAGES);
  refImageClearEl.hidden = refImages.length === 0;
  loadRefsBtn.disabled = refImages.length === 0 || isRunning;
}

refImageUploadEl.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  refImageUploadEl.value = "";
  if (!files.length) return;

  const remaining = MAX_REF_IMAGES - refImages.length;
  if (remaining <= 0) { setStatus(`You can add up to ${MAX_REF_IMAGES} references.`); return; }

  const toAdd = files.slice(0, remaining);
  Promise.all(toAdd.map(file => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve({ base64: ev.target.result, name: file.name });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  }))).then((loaded) => {
    refImages = refImages.concat(loaded.filter(Boolean));
    persistRefImages();
    renderRefImages();
  });

  if (files.length > remaining) setStatus(`Added ${remaining}. You can add up to ${MAX_REF_IMAGES} references.`);
});

refImageClearEl.addEventListener("click", () => {
  refImages = [];
  chrome.storage.local.remove("nexusRefImages");
  renderRefImages();
});

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
    if (dirHandle) {
      const res = await sendToFlowTab({ type: "NEXUS_FETCH_IMAGE", url });
      if (!res?.base64) { console.warn("[Nexus Flow] Image fetch failed:", res?.error); return; }
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(base64ToBlob(res.base64));
      await writable.close();
    } else {
      const folder = (downloadFolderEl.value || "nexus-flow").replace(/[/\\]+$/, "");
      // overwrite so a Retry replaces the existing file instead of making "name (1).jpg"
      await chrome.downloads.download({ url, filename: `${folder}/${filename}`, saveAs: false, conflictAction: "overwrite" });
    }
  } catch (e) {
    console.warn("[Nexus Flow] Download failed:", e);
  }
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
        setStatus(`Saving prompt ${idx + 1}…`);
        await saveImage(c.url, idx, lines[idx]);
        updateStatus(idx, "done");
        completed++;
        setStatus(`${completed} of ${totalToProcess} done · ${inFlight.length} generating`);
      } else if (c?.stopped || !isRunning) {
        break;
      } else {
        updateStatus(idx, "failed");
        submitFailed.add(idx);
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
    });
    if (!isRunning) { updateStatus(index, prevStatus); return; }
    if (!sub || sub.error) { setStatus(sub?.error || "Retry couldn't be submitted."); updateStatus(index, "failed"); return; }

    setStatus(`Prompt ${index + 1} regenerating…`);
    const c = await sendToFlowTab({ type: "FLOW_COLLECT_NEXT", timeoutMs: COLLECT_TIMEOUT_MS });

    if (c?.done && c.url) {
      await saveImage(c.url, index, item.text);   // same index → same filename → overwrite
      updateStatus(index, "done");
      setStatus(`Prompt ${index + 1} regenerated and replaced.`);
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
chrome.storage.local.get(["nexusNaming", "nexusRefImages", "nexusRefImage", "nexusRefImageName"], (r) => {
  if (r.nexusNaming) namingModeEl.value = r.nexusNaming;
  if (Array.isArray(r.nexusRefImages) && r.nexusRefImages.length) {
    refImages = r.nexusRefImages.filter(x => x && x.base64);
  } else if (r.nexusRefImage) {
    // Migrate the legacy single-reference storage into the array format.
    refImages = [{ base64: r.nexusRefImage, name: r.nexusRefImageName || "reference.png" }];
    persistRefImages();
    chrome.storage.local.remove(["nexusRefImage", "nexusRefImageName"]);
  }
  renderRefImages();
});

// Drop keys for settings that no longer exist.
chrome.storage.local.remove(["flowBatchWaitMin", "flowBatchWaitMax", "nexusParallelCount", "nexusUpscale", "nexusLang"]);

namingModeEl.addEventListener("change", () => chrome.storage.local.set({ nexusNaming: namingModeEl.value }));

stopBtn.disabled = true;
rebuildList();
