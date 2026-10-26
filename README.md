# Nexus Flow Pro — Chrome Extension

A Chrome (Manifest V3) side-panel extension that automates **bulk image generation in Google Flow**
(`labs.google/fx/tools/flow`). You paste a queue of prompts, it submits each one, waits for the
result, attaches a consistent character reference to every prompt, and auto-downloads the outputs.

It is a heavily modified fork of an extension originally called **ZAPI FLOW**, rebranded and
extended into **Nexus Flow Pro**.

- **Version:** 3.1.0
- **Target site:** `https://labs.google/fx/*` (Google Flow projects)
- **Type:** Unpacked Chrome extension (Manifest V3, side panel)
- **No build step.** Plain JS/HTML/CSS. Edit files directly and reload the extension.

---

## What it does

1. **Prompt queue** — paste prompts (one per line) or import a `.txt`. Up to **5** generate at
   once, submitted **3 s** apart (fixed; not user-configurable). Each row shows its status and
   has a **Retry** that regenerates that one image and overwrites its saved file.
2. **Character references** — up to 8 images, attached to **every** prompt so characters stay
   consistent. **Upload to project** pastes them into the Flow project once; **Hard refresh**
   reloads the tab so they become selectable. References persist across restarts.
3. **Auto-save** — each finished image is saved as it completes. File names: `Serial`
   (`000-name.jpg`), `Timestamp` (`00-15-name.jpg`, from a `[mm.ss]` tag at the start of the
   line), or prompt text only. Save to **Computer** (a chosen folder via the File System
   Access API, or `Downloads/nexus-flow`) or **Google Drive** (paste a folder link; it is
   checked for write access and marked with a ✓). Drive needs a one-time Google Cloud setup:
   see [`docs/google-drive-setup.md`](docs/google-drive-setup.md).
4. **Status row** — shows whether the content script on the Flow project tab is actually
   responding, and whether Flow's Agent mode is on (which blocks starting a run).

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
│   ├── sidepanel.css          # Warm-neutral theme, light + dark
│   ├── fonts/                 # Onest + Geist Mono (latin, OFL), bundled
│   ├── drive.js               # Google Drive: sign-in, folder-link check, upload with backoff
│   └── sidepanel.js           # UI logic, queue driver, downloads, settings persistence
└── icons/                     # logo.svg + 16 / 32 / 48 / 128 px PNGs rendered from it
```

### Roles

- **`sidepanel.js`** drives the whole run. It loops the prompt queue, and for **each** prompt sends
  a single `FLOW_BATCH_RUN` message to the content script (so it can track per-prompt status,
  wait for the image, then download). Holds the reference images, naming mode and folder handle.
  Persists the naming mode and references in `chrome.storage.local`.
- **`content.js`** runs inside the Flow page. It finds the prompt editor (a Slate/React
  contenteditable), injects text, attaches the reference, clicks Create/submit, waits for the new
  image, and fetches images for saving. All logs are prefixed `[NEXUSFLOW]`.
- **`service-worker.js`** performs MAIN-world clicks (React fiber `onClick`) when needed to bypass
  `isTrusted` checks — the content script marks an element and asks the worker to click it.
- **`selectors.js`** sets `globalThis.FLOW_BATCH_DEFAULT_SELECTORS` (prompt input, submit button,
  etc.). Class hashes change often, so most discovery is done by role/icon/aria in `content.js`.

---

## Message flow (sidepanel ⇄ content script)

| Message | Direction | Purpose |
|---|---|---|
| `FLOW_BATCH_PING` | panel → content | liveness check for the status row |
| `FLOW_GET_AGENT_MODE` | panel → content | is Flow "Agent" mode on (blocks generation) |
| `FLOW_PIPELINE_BEGIN` / `FLOW_PIPELINE_END` | panel → content | snapshot existing images and start/stop the finish-order scanner |
| `FLOW_SUBMIT_ONE` | panel → content | attach references, fill and submit ONE prompt, tag its tile with `jobIndex` |
| `FLOW_COLLECT_NEXT` | panel → content | resolve with the next finished image (or failure), tagged with its `jobIndex` |
| `FLOW_LOAD_REFERENCES` | panel → content | paste every reference into the project |
| `FLOW_BATCH_STOP` | panel → content | abort whatever the content script is doing |
| `NEXUS_FETCH_IMAGE` | panel → content | fetch an image and return base64 (for writing to a chosen folder) |

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

1. (Optional) Add **character references**, click **Upload to project**, then **Hard refresh**.
2. Pick **File names** (Serial / Timestamp / prompt text only) and where to **Save to**.
3. Paste prompts — **one per line**. For Timestamp names, start each line with `[mm.ss]`
   (e.g. `[00.15] ...`); the tag is stripped before submitting and used for the filename.
4. Click **Start**. Use **Continue** to resume after a stop, or **Retry** on any single prompt.

---

## Dev notes

- No build/bundler. Edit files directly.
- Syntax-check before reloading: `node --check content.js && node --check sidepanel/sidepanel.js`.
- All content-script logs use the `[NEXUSFLOW]` prefix — filter the Flow tab console by it to trace
  a run (which "+" was clicked, whether the picker opened, whether the reference was found, etc.).
- `manifest.json` permissions: `storage`, `sidePanel`, `unlimitedStorage`, `scripting`,
  `downloads`, `debugger`, `identity`; hosts: Flow (`flow.google.com`, `labs.google/fx`) and
  `www.googleapis.com` (Drive). The `key` pins the extension ID to
  `mmdhiajpiolojckcddjdebfnekpjhhdf` so the Drive OAuth client works for every unpacked install.

---

## Current state / known limitations

- ✅ Bulk queue (5 in flight, 3 s apart), per-prompt status and Retry, Continue/Stop.
- ✅ Reference image: upload-once + re-select from project (search-box method defeats virtualization).
- ✅ Auto-save with serial/timestamp/prompt-text naming; folder picker.
- ✅ Reference image persists across browser restarts.
- ⚠️ Reference re-selection relies on Flow's current picker DOM (`role="option"`, `alt="reference.png"`,
  "Add to Prompt"). If Google changes the picker, update `findReferenceOption` / `openAssetPicker` /
  `clickAddToPrompt` in `content.js`.
- ⚠️ Multi-character shots: attach the most important character's reference, or add others manually.
