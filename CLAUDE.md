# Working on Nexus Flow Pro

## Version bump on every update (required)

Every change shipped to `main` bumps the extension version, in all three places:

- `manifest.json` → `"version"` (the source of truth; the panel reads it at runtime)
- `sidepanel/sidepanel.html` → the `#versionTag` text (`v1.2.3`)
- `README.md` → `- **Version:**`

Use semantic versioning: patch (`1.1.0 → 1.1.1`) for fixes and small tweaks, minor
(`1.1.0 → 1.2.0`) for new features or behaviour changes, major only for a rework.
Include the bump in the same PR as the change.

## Checks before pushing

- `node --check` on `content.js`, `selectors.js`, `background/service-worker.js` and every
  file in `sidepanel/*.js`; `manifest.json` must be valid JSON.
- There is no build step. Load the folder unpacked in `chrome://extensions`.
