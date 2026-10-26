# Google Drive setup (no Google Cloud)

Images go to Drive through a small **uploader**: a Google Apps Script that runs under
**one person's Google account** (yours). You set it up once in about 3 minutes; then you
and anyone you give the link + key to can upload. Nobody touches Google Cloud.

Good to know:
- Every uploaded file is **owned by the uploader's account** and counts toward its Drive
  storage, including files your friend uploads.
- The uploader's account must be able to add files to the folder: your own folder, or a
  folder shared as **Anyone with the link → Editor** (or shared with you as Editor).
- Anyone with the uploader link **and** the key can upload into folders you can edit.
  Keep the key private.

## 1. Create the uploader (once, by you)

1. Go to <https://script.google.com> and click **New project**.
2. Delete everything in the editor and paste the whole of
   [`docs/drive-uploader.gs`](drive-uploader.gs).
3. On the line `const KEY = "change-me";` replace `change-me` with a password of your own.
4. Click **Save** (💾). Name the project "Nexus Flow uploader" if asked.
5. Click **Deploy → New deployment**. Click the ⚙ next to "Select type" and choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Click **Deploy**, then **Authorize access** and pick your Google account.
   Google says "Google hasn't verified this app" because it's your own new script:
   click **Advanced → Go to Nexus Flow uploader (unsafe) → Allow**.
7. Copy the **Web app URL**. It ends in `/exec`.

## 2. Connect the extension (you and your friend)

1. Open the side panel → **Save to → Google Drive**.
2. Paste the **Uploader link** (the Web app URL) and the **Key**, click **Connect**.
   The row turns green: **Connected to Google Drive · Uploads go to you@gmail.com's Drive**.
3. Paste the folder link (from the folder's **Share → Copy link**). A green ✓ and the
   folder name mean it's ready.

Each image uploads as soon as it's generated. **Retry** replaces the file with the same
name instead of adding a copy.

To skip step 2's link and key for everyone, put them in `BUILT_IN_URL` and `BUILT_IN_KEY`
at the top of `sidepanel/drive.js`. Only do that if the repo stays private.

## Changing the script later

After editing the script, use **Deploy → Manage deployments → ✏ → Version: New version →
Deploy**. That keeps the same URL. ("New deployment" makes a new URL, which you'd then
have to paste into the extension again.)

## If something goes wrong

- **"The uploader link didn't answer properly"**: the link isn't the `/exec` Web app URL,
  or "Who has access" isn't **Anyone**. Fix it under Manage deployments.
- **"Wrong key"**: the key in the extension doesn't match `KEY` in the script.
- **"No folder found at that link, or the uploader's account can't open it"**: the folder
  isn't shared with the uploader's account. Share it with Editor access, or use "Anyone
  with the link → Editor".
- **"can't add files"**: the folder is shared as Viewer. Ask the owner for Editor.

Apps Script has daily limits on a free Google account, but they're far above a few
hundred images a day.
