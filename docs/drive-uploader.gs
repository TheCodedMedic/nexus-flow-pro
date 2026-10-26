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
        // Same name already there (e.g. a Retry): replace it instead of keeping two copies.
        const existing = folder.getFilesByName(req.name);
        while (existing.hasNext()) existing.next().setTrashed(true);
        const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mimeType || "image/jpeg", req.name);
        const file = folder.createFile(blob);
        return reply({ ok: true, id: file.getId() });
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
