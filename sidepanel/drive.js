// Google Drive through a Google Apps Script "uploader" (docs/drive-uploader.gs) that one
// person deploys under their own Google account. The extension posts images to it with a
// fixed shared key; no Google Cloud project, Client ID or per-user sign-in is needed. Files are
// owned by the uploader's account. Loaded before sidepanel.js, which uses `Drive`.

const Drive = (() => {
  // Ship a build where nobody has to paste anything: fill this in.
  const BUILT_IN_URL = "";
  // Every uploader uses this key, so nobody has to enter one. It must match KEY in
  // docs/drive-uploader.gs. It only stops casual misuse of an uploader link; the link
  // itself is what to keep private.
  const KEY = "Nexus";

  const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec\/?$/;
  const STORE_KEY = "nexusDriveUploader";   // chrome.storage.local: { url, email }

  class NeedsAuthError extends Error {}

  let uploader = { url: BUILT_IN_URL, email: "" };

  const ready = (async () => {
    const r = await chrome.storage.local.get(STORE_KEY);
    if (r[STORE_KEY]?.url) uploader = { url: r[STORE_KEY].url, email: r[STORE_KEY].email || "" };
  })();

  function isValidUrl(url) { return URL_RE.test((url || "").trim()); }
  function isConfigured() { return isValidUrl(uploader.url); }
  function isConnected() { return isConfigured() && !!uploader.email; }
  function getUploader() { return { ...uploader }; }

  const MAX_ATTEMPTS = 4;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 1s, 2s, 4s plus jitter.
  function backoffMs(attempt) { return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500); }

  async function call(action, payload = {}, target = uploader, attempt = 1) {
    if (!isValidUrl(target.url)) throw new NeedsAuthError("Connect your Drive uploader first.");
    let res, text;
    try {
      // text/plain keeps this a "simple" request: Apps Script can't answer a CORS preflight.
      res = await fetch(target.url.trim(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, key: KEY, ...payload }),
      });
      text = await res.text();
    } catch {
      if (attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); return call(action, payload, target, attempt + 1); }
      throw new Error("Couldn't reach the Drive uploader. Check your internet connection.");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt));
      return call(action, payload, target, attempt + 1);
    }
    let data;
    try { data = JSON.parse(text); } catch {
      // A sign-in page or Google error page instead of JSON.
      throw new Error("The uploader link didn't answer properly. Check it ends in /exec and was deployed with “Who has access: Anyone”.");
    }
    if (!data.ok) {
      if (/wrong key/i.test(data.error || "")) {
        throw new NeedsAuthError('The uploader script\'s password isn\'t "Nexus". Set KEY = "Nexus" in the script and deploy a new version.');
      }
      throw new Error(data.error || "The Drive uploader returned an error.");
    }
    return data;
  }

  // Try the link; on success remember it (and which account uploads through it).
  async function connect(url) {
    url = (url || "").trim();
    if (!isValidUrl(url)) throw new Error("That isn't an uploader link. It looks like https://script.google.com/macros/s/…/exec");
    const r = await call("ping", {}, { url });
    uploader = { url, email: r.email || "" };
    await chrome.storage.local.set({ [STORE_KEY]: uploader });
    return uploader.email;
  }

  async function disconnect() {
    uploader = { url: BUILT_IN_URL, email: "" };
    await chrome.storage.local.remove(STORE_KEY);
  }

  /**
   * Pull a folder ID (and resource key, if any) out of whatever was pasted:
   *   https://drive.google.com/drive/folders/<id>?resourcekey=<key>
   *   https://drive.google.com/drive/u/1/folders/<id>
   *   https://drive.google.com/open?id=<id>
   *   a bare ID
   * Returns null when the text isn't a folder reference (so it's treated as a search).
   */
  function parseFolderRef(text) {
    const s = (text || "").trim();
    if (!s) return null;
    let id = null, resourceKey = null;
    try {
      const u = new URL(s);
      if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
      id = u.pathname.match(/\/folders\/([\w-]{10,})/)?.[1] || u.searchParams.get("id");
      resourceKey = u.searchParams.get("resourcekey");
    } catch {
      if (/^[\w-]{25,}$/.test(s)) id = s;
    }
    return id ? { id, resourceKey } : null;
  }

  async function getFolder(ref) {
    const r = await call("check", { folderId: ref.id, resourceKey: ref.resourceKey || "" });
    return { id: ref.id, resourceKey: ref.resourceKey || null, name: r.name, canAdd: !!r.canAdd, owner: "" };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Couldn't read the image."));
      reader.readAsDataURL(blob);
    });
  }

  // A file with the same name in the folder is replaced, so a Retry overwrites it.
  async function uploadImage(folder, filename, blob) {
    return call("upload", {
      folderId: folder.id,
      resourceKey: folder.resourceKey || "",
      name: filename,
      mimeType: blob.type || "image/jpeg",
      data: await blobToBase64(blob),
    });
  }

  function folderUrl(folder) {
    const rk = folder.resourceKey ? `?resourcekey=${encodeURIComponent(folder.resourceKey)}` : "";
    return `https://drive.google.com/drive/folders/${folder.id}${rk}`;
  }
  return {
    NeedsAuthError, ready, isValidUrl, isConfigured, isConnected, getUploader,
    connect, disconnect, parseFolderRef, getFolder, uploadImage, folderUrl,
  };
})();
