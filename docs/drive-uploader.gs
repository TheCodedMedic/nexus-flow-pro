/**
 * Nexus Flow Pro — Google Drive uploader (Google Apps Script web app).
 *
 * Runs under YOUR Google account and uploads AS you into any Drive folder link the
 * extension sends: your own folders or other people's, as long as the folder lets you add
 * files (e.g. shared as "Anyone with the link: Editor"). No Google Cloud setup. Everyone
 * using your uploader link + key uploads as you.
 *
 * Setup (about 3 minutes) is in docs/google-drive-setup.md.
 */

// Leave this as "Nexus": the extension always sends it, so nobody has to type a key.
// Keep the uploader link private; anyone with it can upload as you.
const KEY = "Nexus";

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.key !== KEY) return reply({ ok: false, error: "Wrong key. Check the key in the extension matches the script." });

    switch (req.action) {
      case "ping":
        return reply({ ok: true, email: Session.getEffectiveUser().getEmail() });

      case "check": {
        const folder = openFolder(req);
        return reply({ ok: true, name: folder.getName(), canAdd: canAddTo(folder) });
      }

      case "upload": {
        const folder = openFolder(req);
        const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mimeType || "image/jpeg", req.name);
        // Same name already there (e.g. a Retry): replace it instead of keeping two copies.
        // Google only lets the account that owns a file bin it, so if someone else's upload
        // has this name, leave theirs alone and save this one under a free name instead.
        let name = req.name;
        if (!trashSameName(folder, name)) name = freeName(folder, name);
        blob.setName(name);
        const file = withRetry(function () { return folder.createFile(blob); });
        return reply({ ok: true, id: file.getId(), name: name });
      }

      default:
        return reply({ ok: false, error: "Unknown action." });
    }
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

function openFolder(req) {
  try {
    return req.resourceKey
      ? DriveApp.getFolderByIdAndResourceKey(req.folderId, req.resourceKey)
      : DriveApp.getFolderById(req.folderId);
  } catch (err) {
    throw new Error("Can't open that folder. Check the link, and that it's shared as “Anyone with the link: Editor” (or with the uploading account).");
  }
}

// Bin every file called `name` that this account may bin. False if one is left behind.
function trashSameName(folder, name) {
  let allGone = true;
  const files = withRetry(function () { return folder.getFilesByName(name); });
  while (files.hasNext()) {
    const f = files.next();
    try { f.setTrashed(true); } catch (err) { allGone = false; }
  }
  return allGone;
}

// "001-name.jpg" -> "001-name (2).jpg", the first one not already in the folder.
function freeName(folder, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = stem + " (" + n + ")" + ext;
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }
  return stem + " (" + Date.now() + ")" + ext;
}

// Drive sometimes refuses a call for a moment when several uploads land at once
// ("Access denied: DriveApp", "Service error"). Wait and try again before giving up.
function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= 4) {
        if (/access denied/i.test(String(err && err.message || err))) {
          throw new Error("Google Drive refused the upload. Check the folder is shared with " +
            Session.getEffectiveUser().getEmail() + " as Editor (or “Anyone with the link: Editor”).");
        }
        throw err;
      }
      Utilities.sleep(500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300));
    }
  }
}

function canAddTo(folder) {
  const me = Session.getEffectiveUser().getEmail();
  try {
    if (folder.getOwner() && folder.getOwner().getEmail() === me) return true;
  } catch (err) { /* shared drives have no owner */ }
  try {
    if (folder.getEditors().some(function (u) { return u.getEmail() === me; })) return true;
  } catch (err) { /* not allowed to list editors: not an editor */ }
  try {
    return folder.getSharingPermission() === DriveApp.Permission.EDIT;
  } catch (err) {
    return false;
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
