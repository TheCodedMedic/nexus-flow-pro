(function () {
  if (window.__NEXUS_FLOW_CONTENT_INJECTED__) {
    console.log("[NEXUSFLOW] Content script already injected in this window, skipping duplicate initialization.");
    return;
  }
  window.__NEXUS_FLOW_CONTENT_INJECTED__ = true;

  const LOG_PREFIX = "[NEXUSFLOW]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Resolve as soon as `check()` returns something truthy (polled every `everyMs`), or with
  // null after `timeoutMs`. Used instead of fixed pauses so each step moves on the moment
  // Flow is ready.
  async function waitFor(check, timeoutMs, everyMs = 80) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = check();
      if (v) return v;
      if (pipelineStopped || Date.now() >= deadline) return null;
      await sleep(everyMs);
    }
  }

  /**
   * Result-grid images.
   *
   * Flow's current build renders each finished generation as
   *   <flow-image-tile><div class="container"><img class="image" alt="Tile displaying a user's image">
   * Older builds used alt="Generated image". Both are accepted so the extension keeps
   * working if Google reverts, and so a single edit here covers every call site.
   *
   * Deliberately does NOT match asset-picker thumbnails (img.asset-thumbnail-image) or
   * the detail preview (img.detail-preview-image) — those are project assets, not results.
   */
  const GENERATED_IMG_SELECTOR = [
    'flow-image-tile img.image',
    'img[alt="Tile displaying a user\'s image"]',
    'img[alt="Generated image"]',
  ].join(", ");

  function generatedImages(root) {
    return Array.from((root || document).querySelectorAll(GENERATED_IMG_SELECTOR));
  }

  function firstGeneratedImage(root) {
    return (root || document).querySelector(GENERATED_IMG_SELECTOR);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  /**
   * Plain text roughly visible in the prompt contenteditable (drops ZWSP / FEFF).
   *
   * ProseMirror renders its placeholder ("What do you want to create?") as a widget INSIDE
   * the editor, so innerText includes it while the box is empty. Strip it, or a prompt
   * that merely shares a word with the placeholder verifies as "already filled".
   */
  function editorPlainText(el) {
    if (!el) return "";
    let raw = el.innerText || "";
    for (const ph of el.querySelectorAll("[data-slate-placeholder], .prosemirror-placeholder, [class*='placeholder' i]")) {
      const phText = (ph.textContent || "").trim();
      if (phText) raw = raw.split(phText).join(" ");
    }
    return raw
      .replace(/[\u200b\ufeff]/g, "")
      .replace(/\n+/g, " ")
      .trim();
  }

  function base64ToFile(dataUrl, filename = "reference.png") {
    const arr = dataUrl.split(",");
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  /**
   * Dispatch a paste carrying `dt` at the editor.
   *
   * The clipboardData MUST go through the ClipboardEvent constructor. Defining it
   * afterwards with Object.defineProperty only shadows the property for our own JS reads —
   * ProseMirror reads the event's internal slot, still sees null, and ignores the paste.
   * That difference is exactly why image paste worked while text paste silently did not.
   */
  function dispatchPaste(el, dt) {
    const ev = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: dt,
    });
    if (!ev.clipboardData) {
      // Only reached on engines whose constructor ignores the member.
      try {
        Object.defineProperty(ev, "clipboardData", {
          value: dt, enumerable: true, configurable: true,
        });
      } catch {
        /* ignore */
      }
    }
    return el.dispatchEvent(ev);
  }

  async function pasteImageIntoEditor(el, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    dispatchPaste(el, dt);
  }

  function editorSeemsToContain(el, text) {
    const t = text.trim();
    if (!t) return false;
    const raw = editorPlainText(el);
    if (raw.includes(t)) return true;
    const head = t.slice(0, Math.min(48, t.length));
    return raw.includes(head);
  }

  /**
   * Prefer the editable with Flow's main placeholder; else the lowest visible editor box (prompt bar).
   * Current Flow builds use a ProseMirror editor; older builds (labs.google) used Slate.
   */
  function findFlowPromptEditor() {
    const proseMirrorCandidates = Array.from(
      document.querySelectorAll('.ProseMirror[contenteditable="true"]')
    ).filter(isVisible);

    const slateCandidates = Array.from(
      document.querySelectorAll('[data-slate-editor="true"][contenteditable="true"]')
    ).filter(isVisible);

    const candidates = proseMirrorCandidates.length ? proseMirrorCandidates : slateCandidates;
    if (!candidates.length) return null;

    const withPlaceholder = candidates.filter((el) => {
      const ph = el.querySelector("[data-slate-placeholder], .prosemirror-placeholder, [class*='placeholder' i]");
      if (!ph) return false;
      const label = (ph.textContent || "").toLowerCase();
      return (
        label.includes("what do you want") ||
        label.includes("create") ||
        label.includes("generate")
      );
    });
    const pool = withPlaceholder.length ? withPlaceholder : candidates;
    return pool.sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    )[0];
  }

  /**
   * Return an editor node that is actually still in the document.
   *
   * Flow re-renders the prompt bar (notably when an ingredient chip is attached), which
   * detaches the node we captured earlier. Events dispatched at a detached node go
   * nowhere and its .innerText never updates — which silently defeats both the injection
   * attempts and the verification that follows them. So never hold an editor reference
   * across an await: re-resolve it right before each use.
   */
  function liveEditor(el) {
    if (el && el.isConnected) return el;
    const fresh = findFlowPromptEditor();
    if (fresh) log("Prompt editor node went stale — re-acquired the live one.");
    return fresh;
  }

  function firstMatch(selectors) {
    for (const sel of selectors || []) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {
        /* invalid selector */
      }
    }
    return null;
  }

  /**
   * Focus like a user: scroll, then click inside the box so the editor framework
   * (ProseMirror now, Slate on older builds) actually activates the field.
   */
  async function focusEditorLikeUser(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(40);
    const r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, r.left + 8), r.right - 8);
    const cy = Math.min(Math.max(r.top + r.height / 2, r.top + 8), r.bottom - 8);
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: 1,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", common));
    el.dispatchEvent(new MouseEvent("click", common));
    el.focus();
    await sleep(50);
  }

  async function selectAllInEditor(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(30);
  }

  async function clearEditorContent(el) {
    await selectAllInEditor(el);
    try {
      document.execCommand("delete", false, null);
    } catch {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        })
      );
    }
    await sleep(40);
  }

  /**
   * Put the caret inside the editor, at the end of its content.
   *
   * ProseMirror maps DOM selection to its own state and ignores input when the selection
   * is not inside the editable. After the prompt bar re-renders (ingredient attach) the
   * old selection is gone, so re-establish it before dispatching paste/input events.
   */
  function placeCaretAtEnd(el) {
    if (!el || !el.isConnected) return false;
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchSyntheticPaste(el, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    // ProseMirror reads text/html first and falls back to text/plain; supplying both
    // avoids it treating the paste as empty content.
    dt.setData("text/html", `<p>${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</p>`);
    return dispatchPaste(el, dt);
  }

  async function typeInsertTextEvents(el, text, charDelayMs) {
    el = liveEditor(el);
    if (!el) { warn("typeInsertTextEvents: no live editor to type into."); return; }
    el.focus();
    const endSel = window.getSelection();
    const endRange = document.createRange();
    endRange.selectNodeContents(el);
    endRange.collapse(false);
    endSel.removeAllRanges();
    endSel.addRange(endRange);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertText",
          data: char,
        })
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: char,
        })
      );
      if (charDelayMs > 0) await sleep(charDelayMs);
    }
  }

  /**
   * Rich-text editors ignore raw DOM writes — drive the same path as typing/pasting.
   */
  // ── Reference image: select the existing project asset, never re-upload ──
  // The reference is uploaded to the project exactly once (named "reference.png").
  // After that, every prompt re-selects that SAME asset from the picker — no duplicates.

  /**
   * Material icon glyph name inside a button, or "".
   *
   * Icons used to be <i class="google-symbols">glyph</i>; the current build renders
   * <mat-icon class="... google-symbols ..." data-mat-icon-type="font">glyph</mat-icon>.
   * The class survived, the tag did not — so never key off the tag alone.
   */
  function iconGlyph(b) {
    const icon = b.querySelector("mat-icon, .google-symbols, i.google-symbols");
    return icon ? (icon.textContent || "").trim() : "";
  }

  function add2Icon(b) {
    // "add_2" on older builds, "add" on the current one.
    return /^add(_2)?$/.test(iconGlyph(b));
  }

  // Open the asset picker. Current Flow build: a button labeled
  // aria-label="Add ingredients to the prompt box" (an Angular Material overlay, not a
  // dialog). Older builds used a button with aria-haspopup="dialog" containing an "add_2"
  // Material icon. Several add_2 buttons exist on the page, so require the aria-label or
  // dialog-popup attribute and prefer the one lowest on screen (the prompt bar).
  async function openAssetPicker() {
    let candidates = Array.from(document.querySelectorAll('button[aria-label]'))
      .filter(b => isVisible(b) && /add ingredients to the prompt box/i.test(b.getAttribute('aria-label') || ''));
    if (!candidates.length) {
      candidates = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'))
        .filter(b => isVisible(b) && add2Icon(b));
    }
    if (!candidates.length) {
      candidates = Array.from(document.querySelectorAll("button"))
        .filter(b => isVisible(b) && add2Icon(b));
    }
    if (!candidates.length) { warn("Asset-picker (+) button not found."); return false; }
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    candidates[0].click();
    log("Clicked asset-picker + button.");
    return true;
  }

  /**
   * Send Escape where an Angular CDK overlay will actually hear it.
   *
   * CDK's OverlayKeyboardDispatcher listens on document.BODY. An event dispatched at
   * `document` only reaches `document` — body is a descendant, so nothing propagates down
   * to it and the overlay never closes. Dispatch on body and on the focused element.
   */
  async function pressEscape() {
    const mk = () => new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", keyCode: 27, which: 27,
      bubbles: true, cancelable: true,
    });
    document.body.dispatchEvent(mk());
    const active = document.activeElement;
    if (active && active !== document.body) active.dispatchEvent(mk());
    await sleep(100);
  }

  // The current Flow build renders the ingredients picker as an Angular CDK overlay
  // (<flow-add-menu-popover-content>), not a [role="dialog"]. Older builds used a real
  // dialog. Treat either as "the picker panel" everywhere below.
  function getPickerPanel() {
    return document.querySelector('flow-add-menu-popover-content') || document.querySelector('[role="dialog"]');
  }

  // Does an asset's visible text refer to the reference named `name`? Matches the full
  // "referenceN.png", the bare "referenceN" (UI sometimes drops the extension), but NOT
  // a different-numbered sibling (reference1 must never match reference10).
  function refNameMatches(text, name) {
    const t = (text || "").trim().toLowerCase();
    const target = (name || "").trim().toLowerCase();
    if (!t || !target) return false;
    if (t === target) return true;
    const base = target.replace(/\.png$/, "");
    if (t === base) return true;
    if (t.startsWith(base + ".")) return true;
    return false;
  }

  // Find the named reference option in the open picker. On the current build each asset
  // is a button[role="option"].asset-item whose thumbnail img has an EMPTY alt, so the
  // filename is matched from the row's text label instead.
  function findReferenceOption(name) {
    const dlg = getPickerPanel() || document;
    for (const opt of Array.from(dlg.querySelectorAll('[role="option"]')).filter(isVisible)) {
      const alt = opt.querySelector("img")?.getAttribute("alt") || "";
      if (refNameMatches(alt, name)) return opt;
      const labelHit = Array.from(opt.querySelectorAll("div, span"))
        .some(d => refNameMatches(d.textContent, name));
      if (labelHit) return opt;
    }
    return null;
  }

  // Set a framework-controlled input's value so the framework registers the change.
  // The native prototype setter plus input/change events is what both React and Angular
  // (ngModel / FormControl) listen for.
  function setFrameworkInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Type the reference name into the picker's "Search assets" box. This filters the
  // virtualized list down to the reference so it is guaranteed to be rendered — the list
  // is virtualized (Angular CDK now, Virtuoso on older builds), so off-screen rows simply
  // do not exist in the DOM.
  async function searchPickerForReference(name, query) {
    const dlg = getPickerPanel();
    if (!dlg) return false;

    const findInput = () =>
      dlg.querySelector('input[placeholder*="search" i]') ||
      dlg.querySelector('input[type="search"]') ||
      dlg.querySelector('input[type="text"]') ||
      dlg.querySelector("input");

    let input = findInput();

    // The current build collapses search behind an icon button — the field is not in the
    // DOM until it is clicked. Reveal it, then look again.
    if (!input || !isVisible(input)) {
      const searchTrigger = Array.from(dlg.querySelectorAll("button")).find(
        b => isVisible(b) &&
             (/search/i.test(b.getAttribute("aria-label") || "") ||
              /search/i.test(b.getAttribute("mattooltip") || "") ||
              iconGlyph(b) === "search")
      );
      if (searchTrigger) {
        log("Revealing the picker's search box.");
        searchTrigger.click();
        input = await waitFor(() => { const i = findInput(); return i && isVisible(i) ? i : null; }, 1500, 50);
      }
    }

    if (!input || !isVisible(input)) return false;
    const term = query || name;
    input.focus();
    setFrameworkInputValue(input, "");          // clear any residual filter first
    await sleep(30);
    setFrameworkInputValue(input, term);
    // Some search boxes only react to key events — nudge them too.
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: term.slice(-1) }));
    log(`Typed '${term}' into asset search to filter the list.`);
    return true;   // the caller polls for the filtered row, so no fixed pause here
  }

  // Fallback for when there is no search box: scroll the virtualized list looking for
  // the reference, since off-screen rows aren't in the DOM until scrolled into view.
  async function scrollFindReference(name) {
    // Angular CDK on the current build; Virtuoso on older ones. Setting scrollTop on the
    // CDK viewport drives its renderer correctly, so the loop body works for both.
    const scroller =
      document.querySelector("cdk-virtual-scroll-viewport.asset-list-viewport") ||
      document.querySelector("cdk-virtual-scroll-viewport") ||
      document.querySelector('[data-virtuoso-scroller="true"]') ||
      document.querySelector('[data-testid="virtuoso-scroller"]');
    if (!scroller) return findReferenceOption(name);
    scroller.scrollTop = 0;
    await sleep(250);
    for (let i = 0; i < 12; i++) {
      const opt = findReferenceOption(name);
      if (opt) return opt;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
      scroller.scrollTop += Math.max(200, scroller.clientHeight - 40);
      await sleep(350);   // CDK re-renders rows asynchronously
    }
    return findReferenceOption(name);
  }

  // Click the "Add to Prompt" button at the bottom of the picker dialog.
  async function clickAddToPrompt() {
    const btn = await waitFor(() => Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(b => isVisible(b) && /add to prompt/i.test(b.textContent) &&
                 !b.disabled && b.getAttribute("aria-disabled") !== "true"), 3000, 60);
    if (!btn) return false;
    btn.click();
    log("Clicked 'Add to Prompt'.");
    return true;
  }

  // Is `name` currently attached to the prompt bar as an ingredient?
  //
  // Flow renders the asset as <img alt="referenceN.png"> in both places, so we reuse the
  // exact matcher findReferenceOption() already relies on. The only difference is
  // location: the picker's copy sits inside the picker panel, the attached chip does not.
  // So "a matching image outside every picker panel" IS the attached copy.
  //
  // Matches on the img alt only, never on stray text — a filename can appear in a toast
  // or an asset list with nothing attached, and a false positive would skip a real attach
  // and silently cost the prompt its character.
  //
  // A false negative is cheap by design: if Flow ever renders the chip some other way,
  // this returns false and every caller below degrades to the old assume-the-click-worked
  // behaviour rather than retrying. A false negative must never be able to resurrect the
  // re-search loop.
  function isReferenceAttached(name) {
    const panels = Array.from(document.querySelectorAll('[role="dialog"], flow-add-menu-popover-content'));
    for (const img of document.querySelectorAll("img[alt]")) {
      if (!isVisible(img)) continue;
      if (panels.some(d => d.contains(img))) continue;   // that's the picker's copy
      if (refNameMatches(img.getAttribute("alt"), name)) return true;
    }
    return false;
  }

  // Poll until the ingredient chip shows up, so an attach is CONFIRMED by the page rather
  // than inferred from the fact that we clicked something.
  async function waitForReferenceAttached(name, timeoutMs = 3000) {
    return !!(await waitFor(() => isReferenceAttached(name), timeoutMs, 60));
  }

  // Select the existing reference.png from the project and attach it.
  //
  // Returns { clicked, confirmed }:
  //   clicked   — we found the asset in the picker and clicked it
  //   confirmed — the ingredient chip then actually appeared on the prompt bar
  // The caller needs both: `clicked` says "do NOT search again this prompt" (searching
  // after a click is what used to hang, since the attached asset leaves the list), while
  // `confirmed` says "the reference is really on this prompt".
  async function selectExistingReference(name) {
    // Give the picker's list a moment to populate before searching.
    await waitFor(() => getPickerPanel()?.querySelector('[role="option"]'), 2000, 50);

    let opt = findReferenceOption(name);

    // Primary: filter via the search box (defeats list virtualization). Try the full
    // name first, then the bare base name (e.g. "reference5") since the last-uploaded
    // asset is sometimes the slowest/hardest to surface by exact filename.
    const base = (name || "").replace(/\.png$/i, "");
    const queries = [name, base].filter((q, idx, a) => q && a.indexOf(q) === idx);
    for (const q of queries) {
      if (opt || pipelineStopped) break;
      if (await searchPickerForReference(name, q)) {
        opt = await waitFor(() => findReferenceOption(name), 3000, 60);   // filtered list re-render
        if (pipelineStopped) return { clicked: false, confirmed: false };
      }
    }

    // Fallback: scroll the virtualized list to bring the reference into the DOM.
    if (!opt) {
      log("Search didn't surface the reference — scrolling the list to find it.");
      opt = await scrollFindReference(name);
    }

    if (!opt) return { clicked: false, confirmed: false };
    log(`Found existing ${name} in project — selecting it.`);
    opt.click();                       // selecting the option attaches it as an ingredient
    // "Add to Prompt" is best-effort: some flows attach on click alone, and the button
    // can disappear once the asset is added. Either way we must NOT search again — the
    // asset has left the list, and re-searching it is exactly what used to hang.
    if (!isReferenceAttached(name)) await clickAddToPrompt();

    // Confirm against the page instead of assuming the click landed.
    const confirmed = await waitForReferenceAttached(name);
    return { clicked: true, confirmed };
  }

  // NOTE: there is deliberately no "references we already attached" cache here. Flow drops
  // the ingredients on every submit, so each prompt must re-find and re-attach them; a
  // cache would skip an attach that is genuinely needed. Attachment is read from the page
  // via isReferenceAttached() instead of being remembered across prompts.

  // Open the asset picker and wait for its dialog to actually appear.
  async function openPickerAndWait() {
    if (pipelineStopped) return false;
    if (!(await openAssetPicker())) return false;
    if (await waitFor(() => getPickerPanel(), 4000, 50)) return true;
    if (!pipelineStopped) warn("Asset picker dialog did not open.");
    return false;
  }

  // Close any open picker dialog (so a paste fallback lands in the prompt editor).
  /**
   * Close the open picker panel.
   *
   * Angular CDK registers its Escape handler on document.BODY. An event dispatched at
   * `document` only ever reaches `document` — body is a descendant, so there is no
   * propagation path down to it. Dispatching on body (and the focused element) is what
   * actually reaches the overlay; clicking the backdrop is the belt-and-braces fallback.
   *
   * This matters beyond tidiness: openAssetPicker() TOGGLES the panel, so a panel left
   * open makes the next reference's "open" click close it instead.
   */
  async function closeOpenDialog() {
    for (let i = 0; i < 2; i++) {
      if (!getPickerPanel()) return;
      await pressEscape();
      if (!getPickerPanel()) return;

      const backdrop = document.querySelector(".cdk-overlay-backdrop");
      if (backdrop) backdrop.click();
      await sleep(250);
    }

    if (getPickerPanel()) warn("Picker panel is still open after Escape and backdrop click.");
  }

  // ── GENERATION path: SELECT ONLY, never upload ─────────────────────────────
  // During generation we only attach references that ALREADY exist in the project.
  // Flow clears the ingredients on every submit, so each prompt genuinely has to find and
  // re-attach the reference — this is not redundant work, it is required.
  //
  // The rule that matters: NEVER search again after we have clicked the asset. A clicked
  // asset is attached, an attached asset leaves the picker list, so a post-click search
  // can only ever fail — that feedback loop is what used to hang the extension.
  //
  // A *pre*-click retry is safe and is what we now spend the budget on, because the real
  // remaining failure is a race: the previous submit has not released the asset back into
  // the picker yet, so the first look misses something that is about to reappear.
  async function selectReferenceOnly(el, name) {
    if (pipelineStopped) return false;

    // Already on the prompt bar (Flow hasn't cleared it yet)? Nothing to do — and opening
    // the picker here would only risk detaching it.
    if (isReferenceAttached(name)) {
      log(`${name} is already attached — no picker needed.`);
      return true;
    }

    let clicked = false;
    let confirmed = false;

    for (let attempt = 1; attempt <= 2 && !clicked; attempt++) {
      if (pipelineStopped) break;
      if (await openPickerAndWait()) {
        if (!pipelineStopped) {
          const r = await selectExistingReference(name);
          clicked = r.clicked;
          confirmed = r.confirmed;
        }
      }
      // Always leave a clean slate — never leave a picker panel open for the next ref.
      if (getPickerPanel()) await closeOpenDialog();

      // Missed it entirely. Most likely the last submit hasn't released the asset back
      // into the list yet, so give Flow a beat and take one more look.
      if (!clicked && attempt === 1 && !pipelineStopped) {
        log(`${name} not in the picker yet — waiting for Flow to release it, then retrying once.`);
        if (await waitFor(() => isReferenceAttached(name), 1500, 100)) { clicked = confirmed = true; break; }
      }
    }

    // Attaching a chip re-renders the prompt bar, so focus whatever node is live now.
    const editorNow = liveEditor(el);
    if (editorNow) await focusEditorLikeUser(editorNow);

    if (clicked && confirmed) {
      log(`Attached existing ${name} (confirmed on the prompt bar).`);
      return true;
    }
    if (clicked) {
      // We clicked the asset but never saw a chip. Trust the click: re-searching is the
      // one thing that is guaranteed to fail, and this is also how the extension behaved
      // before confirmation existed — so an undetectable chip degrades to the old
      // working behaviour instead of costing a generation.
      warn(`Clicked ${name} but couldn't confirm the chip on the prompt bar — proceeding anyway.`);
      return true;
    }
    warn(`${name} never appeared in the picker — this prompt has no reference attached.`);
    return false;
  }

  // Paste a brand-new image into the editor so Flow uploads it to the project library.
  // Returns true once the image is detected and the upload appears settled.
  async function uploadReferenceViaPaste(el, file, name) {
    const selectors = globalThis.FLOW_BATCH_DEFAULT_SELECTORS;
    el = liveEditor(el);
    if (!el) { warn(`No live prompt editor to paste ${name} into.`); return false; }
    const htmlBefore = el.innerHTML;
    const imgsBefore = document.querySelectorAll('img').length;
    await pasteImageIntoEditor(el, file);
    log(`Uploading ${name} via paste — waiting for it to appear…`);

    // The editor node itself may be replaced by the re-render that the paste triggers, so
    // treat "our node was swapped out" as evidence of change too, not just its innerHTML.
    let changed = false;
    for (let i = 0; i < 60; i++) {
      if (pipelineStopped) return false;
      if (!el.isConnected ||
          el.innerHTML !== htmlBefore ||
          document.querySelectorAll('img').length > imgsBefore) { changed = true; break; }
      await sleep(500);
    }
    if (!changed) { warn(`Paste of ${name} not detected after 30s.`); return false; }

    // Wait for the upload spinner to clear.
    //
    // NOTE: "submit button became enabled" is deliberately NOT used as the settle signal.
    // Flow keeps that button disabled whenever the prompt has no TEXT — which is exactly
    // the state during a reference upload — so that condition can never be true here.
    log("Image detected, waiting for upload to settle…");
    let sawSpinner = false;
    for (let i = 0; i < 60; i++) {
      if (pipelineStopped) return false;
      let visibleSpinner = false;
      for (const s of document.querySelectorAll('[role="progressbar"]')) {
        if (isVisible(s)) { visibleSpinner = true; break; }
      }
      if (visibleSpinner) { sawSpinner = true; await sleep(500); continue; }
      if (sawSpinner) { log("Upload settled (spinner cleared)."); break; }
      if (i > 6) { log("No spinner after ~3s, assuming upload complete."); break; }
      await sleep(500);
    }
    await sleep(2000);
    return true;
  }

  // `missingRefs` is an out-parameter: any reference that could not be attached is pushed
  // into it, so the caller can refuse to submit a prompt that lost its character instead
  // of silently generating without it.
  async function injectTextIntoFlowPrompt(el, text, charDelayMs, refImageFiles = [], missingRefs = []) {
    if (!text && (!refImageFiles || !refImageFiles.length)) return false;

    el = liveEditor(el);
    if (!el) { warn("No live prompt editor to inject into."); return false; }
    await focusEditorLikeUser(el);
    await clearEditorContent(el);
    await focusEditorLikeUser(el);

    // Attach every reference image by SELECTING the existing project asset. Generation
    // NEVER uploads — if a reference isn't already in the project it is reported as
    // missing. (Use the "Load references" button first to upload them.)
    for (const ref of (refImageFiles || [])) {
      if (pipelineStopped) break;
      if (!(await selectReferenceOnly(el, ref.name))) missingRefs.push(ref.name);
      el = liveEditor(el);   // attaching a chip re-renders the prompt bar
      if (!el) return false;
    }

    if (!text) return true;

    // Attaching the reference re-rendered the prompt bar, so re-focus whatever node is
    // live now — otherwise execCommand and the selection-based paths act on nothing.
    el = liveEditor(el);
    if (!el) { warn("Prompt editor disappeared before text injection."); return false; }
    await focusEditorLikeUser(el);

    // Every attempt below re-resolves the editor first: a failed attempt can itself
    // trigger a re-render, and verifying against a detached node always reports failure
    // even when the text landed correctly in the live one.
    const filled = (label) => { log(`Filled prompt via ${label}.`); return true; };

    // 1. Try synthetic paste
    el = liveEditor(el);
    if (el) {
      placeCaretAtEnd(el);
      dispatchSyntheticPaste(el, text);
    }
    await sleep(250);
    el = liveEditor(el);
    if (el && editorSeemsToContain(el, text)) return filled("synthetic paste");

    // 2. Try beforeinput
    log("Text not found, trying beforeinput...");
    el = liveEditor(el);
    if (el) {
      placeCaretAtEnd(el);
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: "insertText", data: text,
      }));
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true,
        inputType: "insertText", data: text,
      }));
    }
    await sleep(200);
    el = liveEditor(el);
    if (el && editorSeemsToContain(el, text)) return filled("insertText beforeinput");

    // 3. execCommand insertText, WHOLE STRING AT ONCE.
    //
    // This acts on the document's live selection rather than on `el`, so focus the live
    // editor first or the text lands nowhere. Inserting the whole string is a single DOM
    // mutation that ProseMirror's observer picks up in one go — the old per-character
    // loop produced the crawling "typing" effect for no benefit, since none of these
    // events are trusted anyway and Flow cannot tell them apart.
    log("Trying execCommand insertText (whole string)...");
    el = liveEditor(el);
    if (el) {
      await focusEditorLikeUser(el);
      placeCaretAtEnd(el);
      try { document.execCommand("insertText", false, text); } catch {}
    }
    await sleep(250);
    el = liveEditor(el);
    if (el && editorSeemsToContain(el, text)) return filled("execCommand insertText");

    // 3b. Per-character execCommand — last resort for an editor that rejects a bulk
    // insert. Honours charDelayMs, so this is the only genuinely slow path.
    log("Bulk insert failed — falling back to per-character execCommand...");
    el = liveEditor(el);
    if (el) {
      await focusEditorLikeUser(el);
      for (let j = 0; j < text.length; j++) {
        if (pipelineStopped) break;
        try { document.execCommand("insertText", false, text[j]); } catch {}
        if (charDelayMs > 0) await sleep(charDelayMs);
      }
    }
    await sleep(200);
    el = liveEditor(el);
    if (el && editorSeemsToContain(el, text)) return filled("per-character execCommand");

    // 4. Try InputEvents
    log("Trying per-character InputEvent insertText...");
    await typeInsertTextEvents(el, text, charDelayMs);
    await sleep(200);
    el = liveEditor(el);
    if (el && editorSeemsToContain(el, text)) return filled("synthetic InputEvents");

    log("Prompt verification failed; editor text:", el ? editorPlainText(el).slice(0, 120) : "(no live editor)");
    return false;
  }

  function isSubmitGlyph(glyph) {
    if (!glyph) return false;
    return /^(arrow_forward|arrow_upward|arrow_up|arrow_right_alt|send|play_arrow|north_east|arrow_outward|spark|auto_awesome|creation)$/i.test(glyph.trim());
  }

  function findCreateButtonByArrowIcon() {
    const candidates = [];
    for (const btn of document.querySelectorAll("button")) {
      if (!isVisible(btn)) continue;
      const glyph = iconGlyph(btn);
      if (isSubmitGlyph(glyph)) {
        candidates.push(btn);
      }
    }
    if (!candidates.length) return null;
    return candidates.sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    )[0];
  }

  /**
   * Find the Create button by its visually-hidden <span> label or aria label.
   * Google Flow wraps "Create" / "Start generation" in attributes or clip-rect spans.
   */
  function findCreateButtonByHiddenLabel() {
    for (const btn of document.querySelectorAll("button")) {
      if (!isVisible(btn)) continue;
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(start generation|generate|create|submit|send|run)/i.test(aria) || aria.includes("generation") || aria.includes("generate")) {
        return btn;
      }
      const spans = btn.querySelectorAll("span");
      for (const span of spans) {
        const txt = span.textContent?.trim().toLowerCase();
        if (txt === "create" || txt === "generate" || txt === "start generation" || txt === "submit" || txt === "send") {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * Find button inside the active prompt bar / prompt container.
   */
  function findButtonInPromptBar() {
    const editor = findFlowPromptEditor();
    if (!editor) return null;
    const bar = editor.closest("flow-prompt-bar, [class*='prompt-bar' i], [class*='prompt-box' i], [class*='prompt-input' i], form, div.container");
    if (!bar) return null;
    const buttons = Array.from(bar.querySelectorAll("button")).filter(isVisible);
    const nonActionFilter = (b) => {
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      if (add2Icon(b) || /add ingredients/i.test(aria) || /clear/i.test(aria) || /agent/i.test(aria) || /settings/i.test(aria) || /options/i.test(aria)) {
        return false;
      }
      return true;
    };
    const actionButtons = buttons.filter(nonActionFilter);
    if (!actionButtons.length) return null;
    const submitWithGlyph = actionButtons.find(b => isSubmitGlyph(iconGlyph(b)) || /generate|create|send|submit/i.test(b.getAttribute("aria-label") || ""));
    if (submitWithGlyph) return submitWithGlyph;
    return actionButtons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
  }

  /**
   * Consolidated submit button discovery with diagnostic logging.
   */
  function findSubmitButton(selectors) {
    let btn = firstMatch(selectors.submitButton || []);
    if (btn && isVisible(btn)) {
      log("Submit button found via CSS selector:", btn.getAttribute("aria-label") || iconGlyph(btn) || btn.textContent?.trim()?.slice(0, 30));
      return btn;
    }

    btn = findCreateButtonByArrowIcon();
    if (btn) {
      log("Submit button found via arrow/submit icon:", iconGlyph(btn));
      return btn;
    }

    btn = findCreateButtonByHiddenLabel();
    if (btn) {
      log("Submit button found via hidden/aria label:", btn.getAttribute("aria-label") || "hidden label");
      return btn;
    }

    btn = findButtonInPromptBar();
    if (btn) {
      log("Submit button found via prompt bar proximity:", btn.getAttribute("aria-label") || iconGlyph(btn) || "prompt bar button");
      return btn;
    }

    for (const b of document.querySelectorAll("button")) {
      if (!isVisible(b)) continue;
      const txt = b.textContent?.toLowerCase() || "";
      if (txt.includes("create") || txt.includes("generate")) {
        log("Submit button found via textContent scan.");
        return b;
      }
    }

    warn("Submit button NOT found by any strategy.");
    return null;
  }

  /* ── MAIN world React fiber click ──────────────────────────────────
   * Marks the target element, then asks the background service worker
   * to inject a function via chrome.scripting.executeScript in the
   * MAIN world. This bypasses both CSP and isTrusted checks — the
   * injected code calls React's onClick handler directly.
   * ---------------------------------------------------------------- */

  const FQ_MARKER_ATTR = "data-fq-click-target";
  let fqClickCounter = 0;

  async function clickViaReactFiber(el) {
    const token = String(++fqClickCounter);
    el.setAttribute(FQ_MARKER_ATTR, token);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "REACT_FIBER_CLICK",
        token,
        markerAttr: FQ_MARKER_ATTR,
      });
      return result || { ok: false, reason: "no response from background" };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    } finally {
      el.removeAttribute(FQ_MARKER_ATTR);
    }
  }

  /* ── Trusted (CDP-level) clicks and keystrokes ─────────────────────── */
  async function trustedClick(el) {
    if (!el) return { ok: false };
    const target = el.tagName === "BUTTON" ? el : (el.querySelector("button") || el);
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    try {
      const res = await chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", x, y });
      return res || { ok: false, reason: "no response from background" };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }

  async function trustedEnter(editorEl) {
    if (editorEl) {
      try {
        editorEl.focus();
        placeCaretAtEnd(editorEl);
      } catch {}
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: "TRUSTED_ENTER" });
      return res || { ok: false, reason: "no response from background" };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }

  /**
   * Click a button with full pointer/mouse event sequence.
   */
  function clickButtonSynthetic(btn) {
    if (!btn) return;
    const targetBtn = btn.tagName === "BUTTON" ? btn : (btn.querySelector("button") || btn);
    try { targetBtn.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    try { targetBtn.focus(); } catch {}
    const r = targetBtn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      buttons: 1,
    };

    const elementsToClick = [targetBtn];
    const touchTarget = targetBtn.querySelector(".mat-mdc-button-touch-target, mat-icon");
    if (touchTarget) elementsToClick.push(touchTarget);
    const parentHost = targetBtn.closest("flow-generate-icon-button");
    if (parentHost && parentHost !== targetBtn) elementsToClick.push(parentHost);

    for (const el of elementsToClick) {
      el.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mouseover", common));
      el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mousedown", common));
      el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse", buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    }

    try { targetBtn.click(); } catch {}

    const form = targetBtn.form || targetBtn.closest("form");
    if (form) {
      try {
        if (form.requestSubmit) form.requestSubmit(targetBtn);
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } catch {}
    }
  }

  /**
   * Check if a button is disabled.
   */
  function isButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    if (btn.getAttribute("aria-disabled") === "true") return true;
    if (btn.classList.contains("mat-button-disabled") || btn.classList.contains("disabled") || btn.classList.contains("is-disabled") || btn.hasAttribute("disabled")) return true;
    return false;
  }

  /**
   * Is this element part of a React build (i.e. can the fiber path possibly work)?
   *
   * Current Flow is Angular, where no fiber exists — so every fiber attempt costs a
   * service-worker round trip plus a MAIN-world injection and always fails. Test for the
   * fiber itself rather than sniffing the framework, so a Google revert still works.
   */
  function isLegacyReactBuild(el) {
    let node = el;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const keys = Object.keys(node);
      if (keys.some(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Click the submit button, reporting whether it actually went through.
   */
  async function clickSubmitButton(btn) {
    if (!btn) return false;
    // Give Angular / Flow a beat to enable the button after the text and references land.
    for (let i = 0; i < 25 && isButtonDisabled(btn); i++) await sleep(120);

    if (isButtonDisabled(btn)) {
      warn("Submit button is still marked disabled after wait — attempting click anyway in case DOM state is ready.");
    }

    if (isLegacyReactBuild(btn)) {
      const fiberResult = await clickViaReactFiber(btn);
      if (fiberResult.ok) {
        log(`Submit via React fiber: ${fiberResult.method} at depth ${fiberResult.depth}`);
        return true;
      }
      warn("React fiber submit failed:", JSON.stringify(fiberResult));
    }

    // Try CDP trusted click
    const trustedRes = await trustedClick(btn);
    if (trustedRes.ok) {
      log("Submit via trusted (CDP) click.");
      await sleep(150);
      return true;
    }

    clickButtonSynthetic(btn);
    await sleep(150);
    return true;
  }

  async function submitViaEnter(el) {
    if (!el) return;
    try { el.focus(); placeCaretAtEnd(el); } catch {}

    // 1. Try OS-level trusted Enter via debugger
    const tRes = await trustedEnter(el);
    if (tRes.ok) {
      log("Sent Enter via trusted (CDP) keypress.");
    }

    // 2. Also dispatch DOM KeyboardEvent
    for (const ctrl of [false, true]) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            ctrlKey: ctrl,
            metaKey: ctrl,
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        );
      }
    }
  }

  async function dismissOptionalOverlays(selectorsConfig) {
    const list = selectorsConfig.dismissOverlays || [];
    for (let i = 0; i < 3; i++) {
      const btn = firstMatch(list);
      if (btn && isVisible(btn)) {
        btn.click();
        await sleep(400);
      } else break;
    }
  }

  /**
   * The agent-mode toggle control.
   *
   * The current build wraps it in <flow-agent-mode-toggle-chip>. Older builds used a
   * button[aria-pressed] whose text contained "agent".
   */
  function findAgentModeToggle() {
    const chip = document.querySelector("flow-agent-mode-toggle-chip");
    if (chip) {
      const control =
        chip.querySelector('button, [role="switch"], [role="checkbox"], mat-slide-toggle') || chip;
      if (isVisible(control)) return control;
    }
    return (
      Array.from(document.querySelectorAll('button[aria-pressed], [role="switch"], [aria-checked]'))
        .find(b => isVisible(b) && /agent/i.test(b.textContent || "")) || null
    );
  }

  /**
   * true = on, false = off, null = could not determine.
   *
   * Angular Material reports switch state as aria-checked and toggle-button state as
   * aria-pressed, so accept either. "null" is returned rather than guessed: the sidepanel
   * treats not-found as "no agent bar", and inventing a state here would either block a
   * legitimate run or silently let one proceed with agent mode on.
   */
  function agentModeState(el) {
    if (!el) return null;
    for (const node of [el, el.querySelector('[aria-pressed], [aria-checked]')].filter(Boolean)) {
      const pressed = node.getAttribute("aria-pressed");
      if (pressed !== null) return pressed === "true";
      const checked = node.getAttribute("aria-checked");
      if (checked !== null) return checked === "true";
    }
    warn("Found an agent-mode chip but could not read its on/off state.");
    return null;
  }


  // ── Pipelined generation state ──────────────────────────────────────
  // The sidepanel submits several prompts before waiting for any of them, keeping
  // multiple Google Flow generations in flight at once. We ignore images that already
  // existed before the run (baseline) and hand each newly-finished image to the
  // sidepanel exactly once (consumed), in the order they finish.
  let pipelineStopped        = false;
  let pipelineSeenSrcs       = new Set();   // baseline images + every new image already queued
  let pipelineFinishedQueue  = [];          // { type: 'image', src, jobIndex } | { type: 'fail', jobIndex }, in finish order
  let pipelineLastFailCount  = 0;
  let pipelineScanInterval   = null;
  let pipelineObserver       = null;
  // Every submitted prompt gets its own placeholder card the moment it's submitted, well
  // before the image itself is ready. We stamp that card with our own id (see
  // NEXUS_TILE_ATTR) and record it per job (jobIndex = the prompt's index) so a finished
  // image can be matched back to the prompt that actually produced it, regardless of
  // which order the generations finish in.
  let pipelineJobTiles       = new Map();   // jobIndex -> tileId
  let pipelineResolvedTiles  = new Set();   // tileIds already pushed to the finished queue
  // Cards are matched to prompts by POSITION, not by a mark on the element: Flow replaces a
  // card's element after it appears (e.g. once the server confirms it), which drops any
  // attribute we set, and the old approach then lost the card or handed it to the next
  // prompt. Flow lists newest first and makes one card per send ("x1"), so this run's cards,
  // newest first, line up with pipelineSlots in reverse: the Nth newest card is the Nth most
  // recent slot. A slot is a sent prompt ({ jobIndex }) or an unexpected extra card ({ null }).
  let pipelineSlots          = [];          // [{ jobIndex|null, tileId }] in send order
  let pipelineBaselineIds    = new Set();   // card ids present before the run
  let pipelineBaselineSrcs   = new Set();   // image srcs present before the run

  // Flow's current build gives result tiles no stable identifier of its own — the wrapper
  // is <flow-tile-container> carrying only Angular's _ngcontent/_nghost markers. So we
  // stamp our own id on each tile the first time we see it. That is strictly more robust
  // than borrowing one of Google's attributes, since it cannot be renamed out from under
  // us. (Legacy builds' data-tile-id is still honoured if present.)
  const NEXUS_TILE_ATTR = "data-nexus-tile-id";
  let nexusTileCounter = 0;

  const TILE_SELECTOR = "flow-tile-container, flow-error-tile, [data-tile-id]";

  // Result cards in page order (newest first). A card nested inside another card (an error
  // tile inside its container) is counted once.
  function tileElements() {
    return Array.from(document.querySelectorAll(TILE_SELECTOR))
      .filter(el => !el.closest(".cdk-overlay-container") && !el.parentElement?.closest(TILE_SELECTOR));
  }

  function tileIdOf(el) {
    const legacy = el.getAttribute("data-tile-id");
    if (legacy) return legacy;
    let id = el.getAttribute(NEXUS_TILE_ATTR);
    if (!id) {
      id = `nexus-${++nexusTileCounter}`;
      el.setAttribute(NEXUS_TILE_ATTR, id);
    }
    return id;
  }

  function tileElementById(id) {
    return (
      document.querySelector(`[${NEXUS_TILE_ATTR}="${CSS.escape(id)}"]`) ||
      document.querySelector(`[data-tile-id="${CSS.escape(id)}"]`)
    );
  }

  function getAllTileIds() {
    const ids = new Set();
    for (const el of tileElements()) ids.add(tileIdOf(el));
    return ids;
  }

  // Was this card on the page before the run? Checked by its mark, or, if Flow has redrawn
  // it since, by its image.
  function isBaselineTile(el) {
    const id = el.getAttribute(NEXUS_TILE_ATTR) || el.getAttribute("data-tile-id");
    if (id && pipelineBaselineIds.has(id)) return true;
    const img = firstGeneratedImage(el);
    return !!(img && img.src && pipelineBaselineSrcs.has(img.src));
  }

  // This run's cards, newest first.
  function runTiles() {
    return tileElements().filter(el => !isBaselineTile(el));
  }

  // Put each slot's mark back on the card in its position, so a card Flow has redrawn is
  // still found. Only done when the count matches exactly; otherwise positions are
  // uncertain and nothing is moved.
  function restampRunTiles() {
    const tiles = runTiles();
    if (tiles.length !== pipelineSlots.length) return false;
    // Cross-check: a card that still carries a slot's mark must be in that slot's position.
    // If not, the order isn't what we think (e.g. an older card was redrawn), so move nothing.
    const slotIds = new Set(pipelineSlots.map(sl => sl.tileId));
    const consistent = tiles.every((el, i) => {
      const mark = el.getAttribute(NEXUS_TILE_ATTR);
      return !mark || !slotIds.has(mark) || mark === pipelineSlots[pipelineSlots.length - 1 - i].tileId;
    });
    if (!consistent) return false;
    tiles.forEach((el, i) => {
      const slot = pipelineSlots[pipelineSlots.length - 1 - i];
      if (el.getAttribute(NEXUS_TILE_ATTR) !== slot.tileId) el.setAttribute(NEXUS_TILE_ATTR, slot.tileId);
    });
    return true;
  }

  // Cards nobody sent (a late card from a prompt that was given up on, or an extra output)
  // are recorded as empty slots so positions stay lined up. Returns how many were added.
  function absorbUnexpectedTiles() {
    let added = 0;
    while (runTiles().length > pipelineSlots.length) {
      pipelineSlots.push({ jobIndex: null, tileId: `nexus-extra-${++nexusTileCounter}` });
      added++;
    }
    if (added) { restampRunTiles(); log(`Pipeline: ${added} card(s) not from our prompts — ignored.`); }
    return added;
  }

  /**
   * Does this element contain a failure indicator?
   *
   * Current Flow renders a failed generation as <flow-error-tile> and exposes the retry
   * control as button[aria-label="Retry"] (icon-only, so there is no longer a
   * <span>Retry</span> to read). Older builds used a visible "Retry" label.
   */
  function hasFailureMarker(root) {
    if (!root) return false;
    if (root.matches?.("flow-error-tile, [class*='error-tile' i]") || root.querySelector("flow-error-tile, [class*='error-tile' i], [data-testid*='error' i]")) return true;
    for (const btn of root.querySelectorAll('button[aria-label], button[mattooltip]')) {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("mattooltip") || "").trim();
      if (/^(retry|try again|generate again)$/i.test(label)) return true;
    }
    for (const span of root.querySelectorAll("button span, span, div, p")) {
      if (span.children.length === 0 && /^(retry|try again|generation failed|failed to generate|something went wrong)$/i.test(span.textContent.trim())) return true;
    }
    return false;
  }

  // A tile shows a retry control once its generation fails — scoped to just this tile
  // so we don't conflate one job's failure with another's.
  function tileHasFailed(tileEl) {
    return hasFailureMarker(tileEl);
  }

  // Record any generated image / failure that appeared since the last scan, in the order
  // it appears over time. Running this continuously (not only while collecting) keeps the
  // queue in true finish order. Each item is tagged with the jobIndex of the prompt whose
  // tracked tile produced it (via pipelineJobTiles), so out-of-order completion — e.g. the
  // 6th prompt's generation finishing before the 3rd's — no longer mislabels the file.
  function scanPipeline() {
    restampRunTiles();
    for (const [jobIndex, tileId] of pipelineJobTiles.entries()) {
      if (pipelineResolvedTiles.has(tileId)) continue;
      const tileEl = tileElementById(tileId);
      if (!tileEl) continue; // still off-screen/virtualized, or not yet rendered — keep waiting

      const img = firstGeneratedImage(tileEl);
      if (img && img.src) {
        pipelineResolvedTiles.add(tileId);
        pipelineSeenSrcs.add(img.src);
        pipelineFinishedQueue.push({ type: "image", src: img.src, jobIndex });
        continue;
      }
      if (tileHasFailed(tileEl)) {
        pipelineResolvedTiles.add(tileId);
        pipelineLastFailCount++; // account for this card so the fallback scan below doesn't double-count it
        pipelineFinishedQueue.push({ type: "fail", jobIndex });
      }
    }

    // Images outside every tracked tile used to be credited to whichever prompt had waited
    // longest, which saved one prompt's picture under another prompt's name. Every job now
    // has its own tile (or is re-sent), so an unmatched image is simply ignored.
  }

  function stopPipelineScanning() {
    if (pipelineScanInterval) { clearInterval(pipelineScanInterval); pipelineScanInterval = null; }
    if (pipelineObserver) { pipelineObserver.disconnect(); pipelineObserver = null; }
  }

  // Accept an array of reference images (refImages) and fall back to the legacy
  // single-image field (refImage) for backward compatibility. Each reference gets a
  // stable, unique name (reference1.png, reference2.png, …) so the "already in project"
  // check can match each one individually and avoid duplicate uploads.
  function buildRefImageFiles(payload) {
    const refImagesBase64 = Array.isArray(payload.refImages)
      ? payload.refImages
      : (payload.refImage ? [payload.refImage] : []);
    return refImagesBase64
      .filter(Boolean)
      .map((b64, idx) => {
        // The panel sends each image's stable project name ("ref-1a2b3c4d.png"); fall back
        // to positional names for older panels.
        const sent = Array.isArray(payload.refNames) ? payload.refNames[idx] : null;
        const name = typeof sent === "string" && /^[\w.-]{1,64}\.png$/.test(sent) ? sent : `reference${idx + 1}.png`;
        const file = base64ToFile(b64, name);
        log(`Prepared reference image ${name} (size: ${file.size} bytes)`);
        return { file, name };
      });
  }

  // ── Pipeline: submit a single prompt (attach refs + type + submit) ──────────
  // Does NOT wait for the generation to finish — that is collected separately so the
  // next prompt can be submitted while this one is still rendering.
  async function submitOnePrompt(payload) {
    if (pipelineStopped) return { stopped: true };
    const selectors = globalThis.FLOW_BATCH_DEFAULT_SELECTORS;
    const charDelayMs = Math.max(0, payload.charDelayMs ?? 50);
    const preferEnter = payload.preferEnter === true;
    const refImageFiles = buildRefImageFiles(payload);
    const text = String(payload.prompt || "").trim();

    await dismissOptionalOverlays(selectors);

    let input = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      input = findFlowPromptEditor() || firstMatch(selectors.promptInput || []);
      if (input && isVisible(input)) break;
      await sleep(500);
    }
    if (!input || !isVisible(input)) {
      return { error: "Could not find prompt field. Open a Flow project tab (…/flow/project/…) and try again." };
    }

    const missingRefs = [];
    const ok = await injectTextIntoFlowPrompt(input, text, charDelayMs, refImageFiles, missingRefs);
    if (!ok) {
      return { error: "Could not set prompt text in a way Flow accepts. Try entering one prompt manually once, then retry." };
    }
    // Don't spend a generation on a prompt that lost its character reference. Worded so it
    // does NOT match the sidepanel's structural-failure test — this one prompt is marked
    // failed and the run carries on, and it can be re-run with the per-prompt Retry button.
    if (missingRefs.length && !pipelineStopped) {
      return { error: `Reference ${missingRefs.join(", ")} could not be attached — skipped this prompt.` };
    }

    await sleep(200);

    const promptStillInBox = () => {
      const ed = liveEditor(input);
      return !!ed && editorSeemsToContain(ed, text);
    };

    // Send ONCE: the button if there is one, otherwise Enter. Sending both (as before) could
    // start the same prompt twice.
    const send = async () => {
      const submit = preferEnter ? null : findSubmitButton(selectors);
      if (submit) {
        try { await clickSubmitButton(submit); log("Pipeline: clicked submit."); return; }
        catch (e) { warn("Pipeline submit click failed:", e?.message || e); }
      }
      const ed = liveEditor(input);
      if (ed) { await submitViaEnter(ed); log("Pipeline: sent Enter."); }
    };

    // Account for any card that turned up since the last send, so this prompt's card is
    // exactly the next one.
    absorbUnexpectedTiles();
    const before = pipelineSlots.length;
    const newCardShown = (ms) => waitFor(() => runTiles().length > before, ms, 100);

    await send();
    let shown = await newCardShown(6000);

    // No card and the prompt is still in the box: Flow didn't take it (e.g. busy). Send again
    // (twice at most). If the box was cleared, Flow took it, so never send it twice.
    for (let attempt = 0; !shown && attempt < 2 && !pipelineStopped && promptStillInBox(); attempt++) {
      warn(`Pipeline: no new card and the prompt is still in the box; sending again (${attempt + 1}/2).`);
      await sleep(1500);
      await send();
      shown = await newCardShown(6000);
    }
    // Box cleared but no card yet: give a slow card a little longer.
    if (!shown && !pipelineStopped && !promptStillInBox()) shown = await newCardShown(4000);
    if (pipelineStopped) return { stopped: true };

    if (!shown) {
      // No card means no generation, even if Flow cleared the box (it does that when it
      // silently drops a prompt while busy). Report it so the panel sends it again.
      const ed = liveEditor(input);
      if (ed && promptStillInBox()) { await focusEditorLikeUser(ed); await clearEditorContent(ed); }
      return { error: "Flow didn't start a generation for this prompt (it may be busy).", notStarted: true };
    }

    // Our card is the oldest of the cards that appeared since `before`; anything newer that
    // arrived at the same moment is an extra output and gets an empty slot.
    const tileId = `nexus-job-${++nexusTileCounter}`;
    const jobIndex = typeof payload.jobIndex === "number" ? payload.jobIndex : null;
    pipelineSlots.push({ jobIndex, tileId });
    absorbUnexpectedTiles();
    restampRunTiles();
    if (jobIndex !== null) {
      pipelineJobTiles.set(jobIndex, tileId);
      log(`Pipeline: job ${jobIndex} -> card ${tileId}`);
    }

    return { ok: true };
  }

  // ── Load references: paste every reference into the project, one after another ──────
  // Triggered by the "Load references" button. It does NOT search the picker or try to
  // confirm — a freshly-pasted image isn't searchable until the page reloads. It simply
  // uploads each one in order. The user then hard-refreshes and starts generation.
  let isLoadingReferences = false;
  async function loadReferences(payload) {
    if (isLoadingReferences) {
      warn("loadReferences is already running. Skipping duplicate invocation.");
      return { ok: true, skipped: true };
    }
    isLoadingReferences = true;
    try {
      pipelineStopped = false;
      const selectors = globalThis.FLOW_BATCH_DEFAULT_SELECTORS;
      const refImageFiles = buildRefImageFiles(payload);
      if (!refImageFiles.length) return { error: "No reference images provided." };

      await dismissOptionalOverlays(selectors);

      let input = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        input = findFlowPromptEditor() || firstMatch(selectors.promptInput || []);
        if (input && isVisible(input)) break;
        await sleep(500);
      }
      if (!input || !isVisible(input)) {
        return { error: "Could not find prompt field. Open a Flow project tab (…/flow/project/…) and try again." };
      }

      await focusEditorLikeUser(input);

      const results = [];
      for (let i = 0; i < refImageFiles.length; i++) {
        const ref = refImageFiles[i];
        if (pipelineStopped) { results.push({ name: ref.name, status: "stopped" }); continue; }
        log(`Loading reference ${i + 1}/${refImageFiles.length} (${ref.name})…`);
        // Each upload re-renders the prompt bar, so re-acquire the editor every round.
        input = liveEditor(input);
        if (!input) { results.push({ name: ref.name, status: "failed" }); continue; }
        const ok = await uploadReferenceViaPaste(input, ref.file, ref.name);
        results.push({ name: ref.name, status: ok ? "loaded" : "failed" });
      }

      const loaded  = results.filter(r => r.status === "loaded").length;
      const failed  = results.filter(r => r.status === "failed").length;
      const stopped = results.some(r => r.status === "stopped");
      return { ok: true, total: refImageFiles.length, loaded, failed, stopped, results };
    } finally {
      isLoadingReferences = false;
    }
  }

  // ── Pipeline: wait for the NEXT newly-finished image (in finish order) ──────
  // Shifts the oldest unconsumed item off the finish-ordered queue. Returns its image
  // src, or a failure/timeout/stopped marker.
  function collectNextImage(timeout) {
    return new Promise((resolve) => {
      const deadline = Date.now() + Math.max(1000, timeout || 180000);
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        resolve(result);
      };
      const tick = () => {
        if (pipelineStopped) return finish({ stopped: true });
        scanPipeline();
        if (pipelineFinishedQueue.length) {
          const item = pipelineFinishedQueue.shift();
          if (item.type === "image") return finish({ done: true, url: item.src, jobIndex: item.jobIndex });
          return finish({ failed: true, jobIndex: item.jobIndex });
        }
        if (Date.now() > deadline) return finish({ timeout: true });
      };
      const iv = setInterval(tick, 700);
      tick();
    });
  }

  /**
   * Count failure cards in the results grid.
   *
   * Scoped to the grid on purpose: a document-wide scan also picks up retry controls
   * living in menus/overlays, and every phantom count here is enqueued as a fake failure
   * that consumes a real in-flight job.
   */
  function countFailCards() {
    const errorTiles = document.querySelectorAll("flow-error-tile");
    if (errorTiles.length) return errorTiles.length;

    // Fallback for builds without <flow-error-tile>: retry controls inside result tiles,
    // never inside an overlay panel.
    let n = 0;
    for (const tile of document.querySelectorAll("flow-tile-container, [data-tile-id]")) {
      if (tile.closest(".cdk-overlay-container")) continue;
      if (hasFailureMarker(tile)) n++;
    }
    return n;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    if (message?.type === "FLOW_BATCH_PING") {
      sendResponse({ ok: true, href: location.href });
      return;
    }
    if (message?.type === "FLOW_BATCH_STOP") {
      pipelineStopped = true;
      stopPipelineScanning();
      sendResponse({ ok: true });
    }

    // Begin a pipelined run: snapshot which images/failures already exist so we only
    // ever collect ones produced during this run, and start the continuous finish-order
    // scanner.
    if (message?.type === "FLOW_PIPELINE_BEGIN") {
      const imgs = generatedImages();
      pipelineSeenSrcs      = new Set(imgs.map(i => i.src).filter(Boolean));
      pipelineFinishedQueue = [];
      pipelineLastFailCount = countFailCards();
      pipelineStopped       = false;
      pipelineJobTiles      = new Map();
      pipelineResolvedTiles = new Set();
      pipelineSlots         = [];
      pipelineBaselineIds   = getAllTileIds();   // everything already on the page belongs to earlier work
      pipelineBaselineSrcs  = new Set(pipelineSeenSrcs);
      stopPipelineScanning();
      pipelineScanInterval = setInterval(scanPipeline, 700);
      pipelineObserver = new MutationObserver(scanPipeline);
      pipelineObserver.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["alt", "src", "data-tile-id"],
      });
      log(`Pipeline begin — baseline of ${pipelineSeenSrcs.size} existing image(s).`);
      sendResponse({ ok: true, baseline: pipelineSeenSrcs.size });
      return;
    }

    // End a pipelined run: stop the scanner.
    if (message?.type === "FLOW_PIPELINE_END") {
      stopPipelineScanning();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "FLOW_LOAD_REFERENCES") {
      loadReferences(message)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    }

    if (message?.type === "FLOW_SUBMIT_ONE") {
      submitOnePrompt(message)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    }

    if (message?.type === "FLOW_COLLECT_NEXT") {
      collectNextImage(message.timeoutMs ?? 180000)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ error: String(e?.message || e) }));
      return true;
    }

    if (message?.type === "FLOW_GET_AGENT_MODE") {
      const toggle = findAgentModeToggle();
      const state = agentModeState(toggle);
      sendResponse({ found: state !== null, isOn: state === true });
      return;
    }

    if (message?.type === "NEXUS_FETCH_IMAGE") {
      (async () => {
        try {
          const response = await fetch(message.url);
          const blob     = await response.blob();
          const reader   = new FileReader();
          reader.onload  = () => sendResponse({ base64: reader.result });
          reader.onerror = () => sendResponse({ error: "FileReader failed" });
          reader.readAsDataURL(blob);
        } catch (e) {
          sendResponse({ error: String(e?.message || e) });
        }
      })();
      return true;
    }
  });

  log("Content script ready on", location.href);
})();
