/**
 * Nexus Flow Pro — Google Drive uploader (Google Apps Script web app).
 *
 * Runs under YOUR Google account, so the extension can save images into a Drive folder
 * without any Google Cloud setup. Everyone who uses your uploader link + key uploads as
 * you: the files are owned by you and count toward your Drive storage.
 *
 * Setup (about 3 minutes) is in docs/google-drive-setup.md.
 */

// Change this to your own password. You and your friend paste the same one into the
// extension. Anyone with the uploader link AND this key can upload into folders you can edit.
const KEY = "change-me";

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
    throw new Error("No folder found at that link, or the uploader's account can't open it.");
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
