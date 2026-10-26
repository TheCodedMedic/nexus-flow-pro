# Google Drive setup

Saving to Google Drive needs a (free) Google Cloud project so Google knows which app is
asking for Drive access. You do this once; everyone who installs the extension then just
pastes a folder link and clicks **Allow** the first time.

The extension's ID is fixed by the `key` in `manifest.json`, so it is the same on every
machine that loads it unpacked:

```
mmdhiajpiolojckcddjdebfnekpjhhdf
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
     Their approval expires after about 7 days, so they click Allow roughly once a week.
   - **Publish app** (In production, unverified): anyone can use it (100-user cap), approval
     lasts until they remove it. The first time, Google shows a "Google hasn't verified this
     app" screen; they click **Advanced → Go to Nexus Flow Pro**.
   - If everyone is in one Google Workspace organisation, choose **Internal** instead: no
     warning, no expiry, only people in that organisation.

Publishing to the Chrome Web Store for the general public needs Google's verification for
this scope (a review plus a yearly third-party security assessment).

## 3. Create the OAuth client

1. **APIs & Services → Credentials** (or **Clients**) → **Create credentials → OAuth client ID**.
2. Application type: **Chrome Extension**. Item ID: `mmdhiajpiolojckcddjdebfnekpjhhdf`.
3. Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

## 4. Put the Client ID in the extension

In `manifest.json`, replace the placeholder:

```json
"oauth2": {
   "client_id": "PASTE_IT_HERE.apps.googleusercontent.com",
   "scopes": [ "https://www.googleapis.com/auth/drive" ]
}
```

Reload the extension in `chrome://extensions` and reopen the side panel.

## Using it

Once the Client ID is in, each person using the extension does this once:

1. In the panel, **Save to → Google Drive**, then click **Connect**.
2. Google opens a window: pick the account and click **Allow**. The row turns green:
   **Connected to Google Drive** with the account's email. Chrome remembers this.
3. Paste a folder link (from the folder's **Share → Copy link**, or the address bar).
   The folder must let that account add files: their own folder, or one shared with them
   (or "Anyone with the link") as **Editor**. A green ✓ and the folder name mean it's ready.

Each image then uploads as soon as it's generated.

Before the Client ID is added, the panel shows "Google Drive isn't set up" instead of
the Connect button.

Notes:
- Uploads go through the Google account signed into **Chrome itself** (the profile), which
  may differ from the account you use on Flow. If Chrome isn't signed in, it asks you to sign in.
- Works in Google Chrome. Other Chromium browsers (Edge, Brave) don't support this sign-in.
- Uploaded files are owned by the account that uploaded them and count toward that account's
  storage, even inside someone else's folder.
- **Retry** replaces the file with the same name in the folder instead of adding a copy.
