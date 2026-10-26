# Nexus Flow Pro — Chrome Extension

A Chrome (Manifest V3) side-panel extension that automates **bulk image generation in Google Flow**
(`labs.google/fx/tools/flow`). You paste a queue of prompts, it submits each one, waits for the
result, attaches a consistent character reference to every prompt, and auto-downloads the outputs.

It is a heavily modified fork of an extension originally called **ZAPI FLOW**, rebranded and
extended into **Nexus Flow Pro** (amber + teal theme).

- **Version:** 2.2.4
- **Target site:** `https://labs.google/fx/*` (Google Flow projects)
- **Type:** Unpacked Chrome extension (Manifest V3, side panel)
- **No build step.** Plain JS/HTML/CSS. Edit files directly and reload the extension.

---

## What it does

1. **Prompt queue** — paste many prompts (one per line); it submits them to Google Flow one at a
   time, waits for each generation to finish, then moves on.
2. **Character reference image** — attach a reference (e.g. a character design sheet) that is added
   as an *ingredient* to **every** prompt so the character stays visually consistent across shots.
   The reference persists across browser restarts (`chrome.storage.local`).
3. **Auto-download** — each finished image is downloaded automatically.
4. **Filename naming modes** (dropdown): `Serial` (`01-name.jpg`), `Timestamp`
   (`00-15-name.jpg`, parsed from a `[mm.ss]` tag at the front of the prompt), or `None`.
5. **Folder picker** — choose any folder on disk via the File System Access API
   (`showDirectoryPicker`), or fall back to a subfolder of Downloads.
6. **Upscale to 2K** (toggle) — before downloading, it drives Flow's download menu and clicks
   "2K Upscaled" (free tier). Falls back to the normal 1K download if that fails.
7. **Random delay** between prompts (min/max seconds) to keep the account safe.
8. **Live connection status** — the bar actually pings the content script, so "Connected" is
   truthful (not just a URL match). It tells you to hard-refresh the tab or reopen the panel when
   the content script / side panel context is stale.

---

## File structure

```
nexus-flow-extension/
├── manifest.json              # MV3 manifest (permissions, content scripts, side panel)
├── selectors.js               # Default CSS selectors for Flow (content script #1)
├── content.js                 # Main automation logic, injected into Flow pages (content script #2)
├── background/
│   └── service-worker.js      # MAIN-world React-fiber clicks via chrome.scripting
├── sidepanel/
│   ├── sidepanel.html         # Side panel UI
│   ├── sidepanel.css          # Amber/teal theme
│   └── sidepanel.js           # UI logic, queue driver, downloads, settings persistence
└── icons/                     # 16 / 32 / 48 / 128 px Nexus Flow Pro icons
```

### Roles

- **`sidepanel.js`** drives the whole run. It loops the prompt queue, and for **each** prompt sends
  a single `FLOW_BATCH_RUN` message to the content script (so it can track per-prompt status,
  wait for the image, then download). Holds the reference image, naming mode, folder handle, and
  the upscale toggle. Persists settings (and the reference image) in `chrome.storage.local`.
- **`content.js`** runs inside the Flow page. It finds the prompt editor (a Slate/React
  contenteditable), injects text, attaches the reference, clicks Create/submit, waits for the new
  image, and handles upscale + image fetch. All logs are prefixed `[NEXUSFLOW]`.
- **`service-worker.js`** performs MAIN-world clicks (React fiber `onClick`) when needed to bypass
  `isTrusted` checks — the content script marks an element and asks the worker to click it.
- **`selectors.js`** sets `globalThis.FLOW_BATCH_DEFAULT_SELECTORS` (prompt input, submit button,
  etc.). Class hashes change often, so most discovery is done by role/icon/aria in `content.js`.

---

## Message flow (sidepanel ⇄ content script)

| Message | Direction | Purpose |
|---|---|---|
| `FLOW_BATCH_PING` | panel → content | liveness check for the connection bar |
| `FLOW_GET_AGENT_MODE` / `FLOW_DISABLE_AGENT_MODE` | panel → content | detect/turn off Flow "Agent" mode (blocks generation) |
| `FLOW_GET_TILE_COUNT` | panel → content | snapshot of existing `img[alt="Generated image"]` before submitting |
| `FLOW_BATCH_RUN` | panel → content | submit ONE prompt (`prompts:[text]`, `refImage`, `isFirstPrompt`) |
| `FLOW_WAIT_GENERATION` | panel → content | resolve when a new image appears or a failure card shows |
| `NEXUS_FETCH_IMAGE` | panel → content | content fetches a blob/URL and returns base64 (so the panel can write it to the chosen folder) |
| `NEXUS_UPSCALE_2K` | panel → content | open the image's download menu and click "2K Upscaled" |

---

## Google Flow DOM selectors (hard-won — keep these)

Flow uses styled-components (hashed classes like `sc-xxxx`) that change, so target by role/icon/alt:

- **Prompt editor:** `div[data-slate-editor="true"][contenteditable="true"]` (lowest visible one = prompt bar)
- **Submit/Create button:** button with `<i class="google-symbols">arrow_forward</i>`, or a
  visually-hidden `<span>Create</span>`, or `aria-label*="Create"`.
- **Generated images:** `img[alt="Generated image"]`
- **Failure card:** a `<button><span>Retry</span></button>`
- **Add-Ingredient ("+" that opens the asset picker):** `button[aria-haspopup="dialog"]` containing
  `<i class="google-symbols">add_2</i>`. ⚠️ There are multiple `add_2` buttons — must require
  `aria-haspopup="dialog"` and prefer the one lowest on screen (the prompt bar).
- **Asset picker dialog:** `[role="dialog"]` (Radix). The asset list is a **Virtuoso virtual
  scroller** (`[data-virtuoso-scroller="true"]`) — only ~visible rows exist in the DOM.
- **Asset row:** `div[role="option"]` containing `<img alt="reference.png">` and a label div with
  text `reference.png`.
- **Search box (inside picker):** `input[placeholder*="search" i]` — type `reference.png` to filter
  the virtualized list so the reference is guaranteed to render.
- **"Add to Prompt" confirm button:** button whose text matches `/add to prompt/i`.
- **Download menu (2K/4K):** opened from a `button[aria-haspopup="dialog"]` whose text includes
  "Download"; options are `button[role="menuitem"]` — the 2K one's text starts with `2K`
  (`aria-disabled="false"`), the 4K one is `aria-disabled="true"` on the free tier.

---

## The reference-image system (the core problem we solved)

**Goal:** upload the reference to a Flow project **exactly once**, then for every later prompt
**re-select that same uploaded asset** instead of re-uploading (which created duplicate
`reference.png` copies and looked broken).

**How `content.js` does it (`injectTextIntoFlowPrompt`):**

1. **STEP 1 — select existing:** open the asset picker (`openAssetPicker`), then
   `selectExistingReference()`:
   - Wait for the dialog list to populate.
   - **Type `reference.png` into the picker's search box** (`searchPickerForReference`) to defeat
     list virtualization — otherwise the reference row may not be rendered if it scrolled out of
     the visible window (this was the "works sometimes" bug).
   - Find the `div[role="option"]` whose `img[alt]`/label is `reference.png` (`findReferenceOption`),
     click it, then click **"Add to Prompt"** (`clickAddToPrompt`).
   - Scroll fallback (`scrollFindReference`) if there's no search box.
2. **STEP 2 — upload once (fallback / first time):** if no `reference.png` exists in the project
   yet, paste the reference file into the editor to upload it. After that, STEP 1 finds it forever.

`reference.png` is the **unique name** the matcher keys on (the reference file is always named
`reference.png` via `base64ToFile`).

> **Note on batching:** the extension attaches ONE reference per run. For a story with multiple
> characters, generate in batches grouped by character and swap the reference between batches.
> A combined multi-face reference tends to bleed faces, so prefer one reference per character.

---

## Install / load

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `nexus-flow-extension` folder.
3. Pin it; click the icon to open the side panel.
4. Open a Google Flow **project** tab (`labs.google/fx/tools/flow/project/…`).

**After editing any file:** reload the extension in `chrome://extensions`, **close & reopen the
side panel** (a panel left open across a reload goes stale), then **hard-refresh the Flow tab**
(`Cmd+Shift+R`) so the new content script injects. The connection bar will say exactly what's wrong
if a step is missed.

---

## Use

1. (Optional) **Upload Reference Image** — e.g. a character design sheet. It persists across restarts.
2. Pick **Name images by** (Serial / Timestamp / None) and a **download folder**.
3. Toggle **Upscale to 2K** if wanted (downloads then go to the system Downloads folder).
4. Paste prompts — **one per line**. With Timestamp mode, prefix each line with `[mm.ss]`
   (e.g. `[00.15] ...`); the tag is stripped before submitting and used for the filename.
5. Set the random delay range, click **Start Generation**. Use **Continue** to resume after a
   stop/failure.

---

## Dev notes

- No build/bundler. Edit files directly.
- Syntax-check before reloading: `node --check content.js && node --check sidepanel/sidepanel.js`.
- All content-script logs use the `[NEXUSFLOW]` prefix — filter the Flow tab console by it to trace
  a run (which "+" was clicked, whether the picker opened, whether the reference was found, etc.).
- `manifest.json` permissions: `storage`, `sidePanel`, `unlimitedStorage`, `scripting`, `downloads`;
  host: `https://labs.google/fx/*`.

---

## Current state / known limitations

- ✅ Bulk queue, per-prompt status, random delay, Continue/Stop.
- ✅ Reference image: upload-once + re-select from project (search-box method defeats virtualization).
- ✅ Auto-download with serial/timestamp/none naming; folder picker; 2K upscale toggle.
- ✅ Reference image persists across browser restarts.
- ⚠️ Reference re-selection relies on Flow's current picker DOM (`role="option"`, `alt="reference.png"`,
  "Add to Prompt"). If Google changes the picker, update `findReferenceOption` / `openAssetPicker` /
  `clickAddToPrompt` in `content.js`.
- ⚠️ Multi-character shots: attach the most important character's reference, or add others manually.
