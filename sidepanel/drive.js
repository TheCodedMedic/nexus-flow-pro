// Google Drive: sign-in, folder-link checks, and image upload. Loaded before
// sidepanel.js, which uses the global `Drive`.
//
// Sign-in uses chrome.identity.launchWebAuthFlow with a "Web application" OAuth client
// whose ID is entered in the panel (or baked in below), not chrome.identity.getAuthToken:
// getAuthToken only accepts a client ID written into manifest.json, and only works in
// Google Chrome. launchWebAuthFlow takes the ID at runtime and works in other Chromium
// browsers too.
//
// Uses the full `drive` scope because people paste links to folders the extension did
// not create (e.g. a team folder shared as "Anyone with the link: Editor"); the narrow
// drive.file scope cannot write into those.

const Drive = (() => {
  const API    = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const FOLDER_FIELDS = "id,name,resourceKey,driveId,capabilities/canAddChildren,owners(displayName,me)";

  const SCOPE  = "https://www.googleapis.com/auth/drive";

  // Set this to ship a build where nobody has to paste a Client ID. Client IDs are
  // public identifiers (they appear in every sign-in URL), so committing one is fine.
  const BUILT_IN_CLIENT_ID = "";

  const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;
  const TOKEN_KEY = "nexusDriveToken";      // chrome.storage.session: cleared when the browser closes
  const EMAIL_KEY = "nexusDriveEmail";      // chrome.storage.local: login hint for silent refresh
  const CLIENT_KEY = "nexusGoogleClientId"; // chrome.storage.local

  class NeedsAuthError extends Error {}

  let clientId = BUILT_IN_CLIENT_ID;
  let cached = null;       // { token, expiresAt }
  let loginHint = "";

  // Read the saved Client ID, token and account hint. Await before using anything else.
  const ready = (async () => {
    const local = await chrome.storage.local.get([CLIENT_KEY, EMAIL_KEY]);
    if (local[CLIENT_KEY]) clientId = local[CLIENT_KEY];
    loginHint = local[EMAIL_KEY] || "";
    try {
      const sess = await chrome.storage.session.get(TOKEN_KEY);
      if (sess[TOKEN_KEY]?.token) cached = sess[TOKEN_KEY];
    } catch { /* storage.session unavailable */ }
  })();

  function isConfigured() { return CLIENT_ID_RE.test(clientId); }
  function getClientId() { return clientId; }
  function redirectUri() { return chrome.identity.getRedirectURL(); }
  function isValidClientId(id) { return CLIENT_ID_RE.test((id || "").trim()); }

  async function setClientId(id) {
    id = (id || "").trim();
    if (!isValidClientId(id)) throw new Error("That doesn't look like a Client ID. It ends in .apps.googleusercontent.com.");
    if (id === clientId) return;
    await forgetToken();            // a token from another client can't be reused
    clientId = id;
    await chrome.storage.local.set({ [CLIENT_KEY]: id });
  }

  async function saveToken(token, expiresInSec) {
    cached = { token, expiresAt: Date.now() + (Number(expiresInSec) || 3600) * 1000 };
    try { await chrome.storage.session.set({ [TOKEN_KEY]: cached }); } catch { /* memory only */ }
  }

  async function forgetToken() {
    cached = null;
    try { await chrome.storage.session.remove(TOKEN_KEY); } catch { /* ignore */ }
  }

  /**
   * Run Google's sign-in. interactive=true opens the account/Allow window; false tries
   * a silent refresh (prompt=none), which succeeds while the person is still signed in
   * to Google in this browser and has allowed access before.
   */
  async function authorize(interactive) {
    if (!isConfigured()) throw new NeedsAuthError("Google Drive isn't set up.");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: "token",
      scope: SCOPE,
      include_granted_scopes: "true",
      ...(interactive ? { prompt: "select_account" } : { prompt: "none" }),
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();

    let responseUrl;
    try {
      responseUrl = await chrome.identity.launchWebAuthFlow({
        url: url.toString(),
        interactive,
        ...(interactive ? {} : { timeoutMsForNonInteractive: 8000 }),
      });
    } catch (e) {
      if (!interactive) throw new NeedsAuthError("Not connected to Google Drive.");
      const msg = String(e?.message || e);
      if (/did not approve|closed|cancel/i.test(msg)) {
        throw new Error("The Google window was closed before access was allowed. If it showed an error, check the Client ID and redirect URI.");
      }
      throw new Error(`Couldn't connect to Google Drive: ${msg}`);
    }

    const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    const error = params.get("error");
    if (error) {
      if (!interactive) throw new NeedsAuthError("Not connected to Google Drive.");
      if (error === "access_denied") throw new Error("Google Drive access was not allowed.");
      throw new Error(`Google sign-in failed: ${error}.`);
    }
    const token = params.get("access_token");
    if (!token) throw new NeedsAuthError("Not connected to Google Drive.");
    await saveToken(token, params.get("expires_in"));
    return token;
  }

  let silentRenewal = null;   // shared, so parallel uploads don't each open a sign-in

  async function getToken(interactive) {
    await ready;
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    // Access tokens last an hour. Renew silently for someone who connected before;
    // only show Google's window when asked to.
    if (loginHint) {
      silentRenewal ||= authorize(false).finally(() => { silentRenewal = null; });
      try { return await silentRenewal; } catch (e) { if (!interactive) throw e; }
    }
    if (!interactive) throw new NeedsAuthError("Not connected to Google Drive.");
    return authorize(true);
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
      // Expired or revoked token: forget it, renew silently, and try once more.
      await forgetToken();
      return request(url, init, attempt, true);
    }
    if (res.status === 401) throw new NeedsAuthError("Google Drive access expired. Connect again.");
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
    await forgetToken();
    await authorize(true);
    const user = await account();
    loginHint = user.emailAddress || "";
    await chrome.storage.local.set({ [EMAIL_KEY]: loginHint });
    return user;
  }

  async function isConnected() {
    try { await getToken(false); return true; } catch { return false; }
  }

  async function account() {
    const r = await request(`${API}/about?fields=user(emailAddress,displayName)`);
    return r.user || {};
  }

  async function disconnect() {
    await ready;
    const token = cached?.token;
    await forgetToken();
    loginHint = "";
    await chrome.storage.local.remove(EMAIL_KEY);
    // Revoke the grant too, so the next Connect shows Google's Allow screen again.
    if (token) {
      try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }); } catch { /* offline */ }
    }
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
    NeedsAuthError, ready, isConfigured, isValidClientId, getClientId, setClientId, redirectUri,
    connect, isConnected, account, disconnect,
    parseFolderRef, getFolder, uploadImage, folderUrl,
  };
})();
