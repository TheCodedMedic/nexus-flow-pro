// Google Drive: sign-in via the Chrome profile's Google account, folder-link checks,
// and image upload. Loaded before sidepanel.js, which uses the global `Drive`.
//
// Uses the full `drive` scope because people paste links to folders the extension did
// not create (e.g. a team folder shared as "Anyone with the link: Editor"); the narrow
// drive.file scope cannot write into those.

const Drive = (() => {
  const API    = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const FOLDER_FIELDS = "id,name,resourceKey,driveId,capabilities/canAddChildren,owners(displayName,me)";

  class NeedsAuthError extends Error {}

  function isConfigured() {
    const id = chrome.runtime.getManifest().oauth2?.client_id || "";
    return !!id && !id.startsWith("YOUR_CLIENT_ID");
  }

  async function getToken(interactive) {
    try {
      const res = await chrome.identity.getAuthToken({ interactive });
      const token = typeof res === "string" ? res : res?.token;
      if (!token) throw new NeedsAuthError("Not connected to Google Drive.");
      return token;
    } catch (e) {
      if (e instanceof NeedsAuthError) throw e;
      // Non-interactive calls fail this way whenever the user has not approved yet.
      if (!interactive) throw new NeedsAuthError("Not connected to Google Drive.");
      const msg = String(e?.message || e);
      if (/did not approve|canceled|cancelled|user denied/i.test(msg)) throw new Error("Google Drive access was not allowed.");
      throw new Error(`Couldn't connect to Google Drive: ${msg}`);
    }
  }

  // Folders shared by link before 2021 need their resource key sent along, or the API
  // answers 404 even though the link works in a browser.
  function resourceKeyHeader(folder) {
    return folder?.resourceKey ? { "X-Goog-Drive-Resource-Keys": `${folder.id}/${folder.resourceKey}` } : {};
  }

  const MAX_ATTEMPTS = 5;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Google signals "slow down" as 429, or 403 with a rate-limit reason; 5xx are transient.
  function isRetryable(status, reason) {
    return status === 429 || status >= 500 || (status === 403 && /rateLimitExceeded/i.test(reason || ""));
  }

  async function request(url, init = {}, attempt = 1, refreshedToken = false) {
    const token = await getToken(false);
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // Network blip: treat like a transient server error.
      if (attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); return request(url, init, attempt + 1, refreshedToken); }
      throw new Error("Couldn't reach Google Drive. Check your internet connection.");
    }
    if (res.status === 401 && !refreshedToken) {
      // Expired or revoked token: drop it from Chrome's cache and try once more.
      await chrome.identity.removeCachedAuthToken({ token });
      return request(url, init, attempt, true);
    }
    if (res.status === 401) throw new NeedsAuthError("Google Drive access expired. Allow access again.");
    if (!res.ok) {
      let detail = "", reason = "";
      try {
        const body = await res.json();
        detail = body?.error?.message || "";
        reason = body?.error?.errors?.[0]?.reason || "";
      } catch { /* not JSON */ }
      if (isRetryable(res.status, reason) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        return request(url, init, attempt + 1, refreshedToken);
      }
      const err = new Error(detail || `Google Drive returned ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // 1s, 2s, 4s, 8s plus jitter — Google's recommended exponential backoff.
  function backoffMs(attempt) {
    return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
  }

  async function connect() {
    await getToken(true);
    return account();
  }

  async function isConnected() {
    try { await getToken(false); return true; } catch { return false; }
  }

  async function account() {
    const r = await request(`${API}/about?fields=user(emailAddress,displayName)`);
    return r.user || {};
  }

  async function disconnect() {
    let token = null;
    try { token = await getToken(false); } catch { /* already disconnected */ }
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
      // Revoke the grant too, so the next Connect shows the account's Allow screen again.
      try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }); } catch { /* offline */ }
    }
    await chrome.identity.clearAllCachedAuthTokens?.();
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

  function toFolder(f) {
    return {
      id: f.id,
      name: f.name,
      resourceKey: f.resourceKey || null,
      canAdd: f.capabilities?.canAddChildren !== false,
      owner: f.driveId ? "Shared drive" : (f.owners?.[0]?.me ? "You" : (f.owners?.[0]?.displayName || "")),
    };
  }

  async function getFolder(ref) {
    const f = await request(
      `${API}/files/${encodeURIComponent(ref.id)}?supportsAllDrives=true&fields=mimeType,${FOLDER_FIELDS}`,
      { headers: resourceKeyHeader(ref) }
    ).catch((e) => {
      if (e.status === 404) throw new Error("No folder found at that link, or your account can't open it.");
      throw e;
    });
    if (f.mimeType !== FOLDER_MIME) throw new Error("That link is a file, not a folder.");
    return toFolder({ ...f, resourceKey: f.resourceKey || ref.resourceKey });
  }

  async function findByName(folder, filename) {
    const q = `name='${filename.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${folder.id}' in parents and trashed=false`;
    const params = new URLSearchParams({
      q, pageSize: "1", fields: "files(id)",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives",
    });
    const r = await request(`${API}/files?${params}`, { headers: resourceKeyHeader(folder) });
    return r.files?.[0]?.id || null;
  }

  /**
   * Upload `blob` as `filename` into `folder`. A file with the same name already in the
   * folder is overwritten in place, so a Retry replaces the image the same way it does
   * for local saves instead of leaving two copies.
   */
  async function uploadImage(folder, filename, blob) {
    const existingId = await findByName(folder, filename);
    if (existingId) {
      return request(`${UPLOAD}/files/${existingId}?uploadType=media&supportsAllDrives=true&fields=id`, {
        method: "PATCH",
        headers: { "Content-Type": blob.type || "image/jpeg" },
        body: blob,
      });
    }
    const boundary = `nexus${Math.random().toString(36).slice(2)}`;
    const meta = { name: filename, parents: [folder.id] };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || "image/jpeg"}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    return request(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}`, ...resourceKeyHeader(folder) },
      body,
    });
  }

  function folderUrl(folder) {
    const rk = folder.resourceKey ? `?resourcekey=${encodeURIComponent(folder.resourceKey)}` : "";
    return `https://drive.google.com/drive/folders/${folder.id}${rk}`;
  }

  return {
    NeedsAuthError, isConfigured, connect, isConnected, account, disconnect,
    parseFolderRef, getFolder, uploadImage, folderUrl,
  };
})();
