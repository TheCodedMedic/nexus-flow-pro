# Google Drive setup

Saving to Google Drive needs a Google **Client ID**: it tells Google which app is asking
for Drive access. You create it once (free) in Google Cloud and paste it into the
extension's panel. After that, each person just clicks **Connect** and **Allow**.

You'll need the extension's **redirect URI**. The panel shows it with a Copy button
(Save to → Google Drive). The extension ID is pinned by the `key` in `manifest.json`, so
for every unpacked install it is:

```
https://mmdhiajpiolojckcddjdebfnekpjhhdf.chromiumapp.org/
```

## 1. Create the project and turn on the Drive API

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Nexus Flow Pro").
2. **APIs & Services → Library**, search **Google Drive API**, click **Enable**.

## 2. Set up the consent screen

1. **APIs & Services → OAuth consent screen** (also shown as **Google Auth Platform**) → **Get started**.
2. App name `Nexus Flow Pro`, your support email. Audience: **External**. Finish.
3. **Data access → Add or remove scopes**, add `https://www.googleapis.com/auth/drive`, save.
4. **Audience**, pick one:
   - **Testing** (default): add every user's Google email under *Test users* (max 100).
     Google expires their approval after about 7 days, so Connect asks again about weekly.
   - **Publish app** (In production, unverified): anyone can use it (100-user cap). The
     first time, Google shows "Google hasn't verified this app"; they click
     **Advanced → Go to Nexus Flow Pro**.
   - If everyone is in one Google Workspace organisation, choose **Internal** instead: no
     warning, no expiry, only people in that organisation.

Publishing to the Chrome Web Store for the general public needs Google's verification for
this scope (a review plus a yearly third-party security assessment).

## 3. Create the OAuth client

1. **APIs & Services → Credentials** (or **Clients**) → **Create credentials → OAuth client ID**.
2. Application type: **Web application** (not "Chrome Extension").
3. Under **Authorized redirect URIs** click **Add URI** and paste the redirect URI above.
   Leave "Authorized JavaScript origins" empty.
4. Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
   You don't need the client secret.

## 4. Paste it into the extension

1. Open the side panel → **Save to → Google Drive**.
2. Paste the Client ID into **Google Client ID** and click **Save**.

It's stored in the browser, so you only do this once per browser. To change it later,
click **Change** next to the Client ID.

To skip this step for everyone (e.g. when sharing the extension), put the Client ID in
`BUILT_IN_CLIENT_ID` at the top of `sidepanel/drive.js`. Client IDs aren't secret, so
committing one is fine.

## Using it

1. **Save to → Google Drive → Connect**.
2. Google opens a window: pick the account and click **Allow**. The row turns green:
   **Connected to Google Drive** with the account's email. Access renews silently in the
   background while you stay signed in to Google in this browser.
3. Paste a folder link (from the folder's **Share → Copy link**, or the address bar).
   The folder must let that account add files: their own folder, or one shared with them
   (or "Anyone with the link") as **Editor**. A green ✓ and the folder name mean it's ready.

Each image then uploads as soon as it's generated.

## If Connect fails

- **Google shows "Error 400: redirect_uri_mismatch"**: the redirect URI in step 3 doesn't
  exactly match the one in the panel (including the trailing `/`).
- **"Error 401: invalid_client"** or **"OAuth client was not found"**: the Client ID was
  mistyped, or the client was deleted. Click **Change** and paste it again.
- **"Access blocked: app has not completed the Google verification process"**: the app
  is in Testing and this account isn't a test user. Add it under Audience → Test users.

Notes:
- Works in Chrome, Edge, Brave and other Chromium browsers.
- Uploaded files are owned by the account that uploaded them and count toward that account's
  storage, even inside someone else's folder.
- **Retry** replaces the file with the same name in the folder instead of adding a copy.
