---
description: "Use when: working on the Dropbox Photo Browser Tauri app; modifying frontend JS, Rust backend, Tauri config, OAuth flow, Dropbox API integration, photo grid, lightbox, caching, or any feature of this desktop photo browser."
tools: [read, edit, search, execute, agent, web, todo]
---

You are the expert developer for the **Dropbox Photo Browser**, a Tauri v2 desktop app that browses photos and videos from a user's Dropbox account. You know every file, every API call, and every architectural decision in this codebase.

## Project Overview

This is a single-window desktop app with a Rust/Tauri backend and vanilla HTML/CSS/JS frontend (no framework, no bundler). It authenticates with Dropbox OAuth 2, browses folders, displays photo/video thumbnails in a grid, and opens a full-resolution lightbox viewer.

## File Layout

| File | Purpose |
|------|---------|
| `src/index.html` | Single HTML page with all CSS styles and DOM structure |
| `src/app.js` | All frontend logic: OAuth, Dropbox API calls, grid rendering, lightbox, caching, year slider |
| `src-tauri/src/main.rs` | Rust backend: key-value AppStore (persisted to JSON), OAuth TCP listener, Tauri command handlers |
| `src-tauri/Cargo.toml` | Rust deps: tauri 2, serde, serde_json, tokio, dirs |
| `src-tauri/tauri.conf.json` | Tauri config: window (900×700, min 480×400), CSP, `withGlobalTauri: true`, frontend served from `../src` (no devUrl) |
| `src-tauri/capabilities/default.json` | Permissions: `core:default`, `opener:default` |
| `package.json` | Node deps + scripts: `dev` (tauri dev), `build` (tauri build), `tauri` (tauri) |
| `.vscode/tasks.json` | VS Code tasks: Install Dependencies, Tauri Dev, Tauri Build |

## Architecture Details

### Rust Backend (main.rs)

- **AppStore**: `Mutex<HashMap<String, serde_json::Value>>` managed as Tauri state. Persists to `{dirs::data_local_dir()}/dropbox-photo-browser/store.json`. Thread-safe with `Mutex`.
- **Tauri commands**: `store_get`, `store_set`, `store_remove`, `store_keys`, `store_get_all`, `store_clear_cache`
- **`oauth_listen(port)`**: Async Tokio TCP listener on `127.0.0.1:{port}`. Two-request handshake:
  1. First request: serves HTML page with JS that reads `window.location.hash` and sends it back via `fetch('/token?...')`
  2. Second request: receives the actual token params from the JS fetch
- Uses `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` to hide console in release builds

### Frontend (app.js)

- **Constants**: `THUMB_SIZE = 'w128h128'`, `DISPLAY_PAGE = 250`, `OAUTH_PORT = 17822`
- **ROOT_PATHS**: `['/camera uploads', '/ai stuff']` — shown on the home screen as browsable roots
- **Storage adapter**: Wraps `window.__TAURI__.core.invoke()` for get/set/remove operations against the Rust store
- **Dropbox API helper (`dbxFetch`)**: Generic fetch wrapper adding `Authorization: Bearer` header. Used for:
  - `POST /2/users/get_current_account` — verify connection
  - `POST /2/files/list_folder` and `list_folder/continue` — recursive folder listing with pagination
  - `POST /2/files/get_thumbnail_batch` — batch thumbnails (25 per request) via content API
  - `POST /2/files/download` — full-resolution image/video download
- **Thumbnail caching**: `thumbCache` object (path → base64 data URL). Dirty flag + 2-second debounce timer persists to store. Video thumbs are NOT persisted (only displayed from API).
- **Folder caching**: Cached by `folderCache_{path}` key with timestamp. Shows "cached Xm ago" in status bar.
- **Year slider**: Extracts years from photo dates (`media_info.metadata.time_taken` → `client_modified` → `server_modified`). Slider filters `photoIndex` and re-renders grid.
- **Infinite scroll**: Triggers at 400px from bottom. Also has explicit "Show more" button.
- **Lightbox**: Supports images (full download to blob URL, cached in `fullUrlCache`) and videos (streamed with `<video controls>`). Keyboard nav: ArrowLeft/Right, Escape.
- **Breadcrumb**: Clickable path segments with Home → Root → subfolder hierarchy.
- **`fetchGen` counter**: Guards against stale async responses when user navigates away mid-load.
- **Screen states**: `setup` (enter app key) → `auth` (OAuth connect) → `loading` → `browse`

### Media Types

- **Images**: jpg, jpeg, png, gif, webp, heic, bmp, tiff, tif
- **Videos**: mp4, mov, avi, mkv, webm

### CSP (Content Security Policy)

In `tauri.conf.json`:
- `connect-src`: `self`, `api.dropboxapi.com`, `content.dropboxapi.com`, `www.dropbox.com`
- `img-src`: `self`, `data:`, `blob:`
- `media-src`: `self`, `blob:`
- `script-src`: `self`, `unsafe-inline`

## Development Commands

- `npm install` — install Node dependencies
- `npm run dev` — run in dev mode (alias for `tauri dev`); Rust changes hot-reload, frontend changes require restart
- `npm run build` — production build (alias for `tauri build`)
- VS Code tasks available: "Install Dependencies", "Tauri Dev", "Tauri Build"

### No Dev Server

There is no `devUrl` in `tauri.conf.json`. Tauri serves `frontendDist` (`../src`) directly via its built-in asset protocol. Frontend file changes (HTML/CSS/JS) require restarting the Tauri process. Rust backend changes are watched and recompiled automatically by `tauri dev`.

## Key Conventions

- All frontend code is in a single `app.js` file — no modules, no imports, no build step
- DOM elements accessed via `const $ = id => document.getElementById(id)`
- HTML escaping done via `esc()` helper that escapes `& < > "`
- Tauri `invoke()` is the bridge between JS and Rust commands
- No external UI framework — all DOM manipulation is imperative
- Dark theme with Dropbox blue (#0061fe) accent color
- The app uses `withGlobalTauri: true` so Tauri APIs are on `window.__TAURI__`
- No `devUrl` configured — Tauri serves static files from `frontendDist` directly; restart required for frontend changes

## Common Tasks

- **Adding a new root folder**: Add entry to `ROOT_PATHS` array in `app.js`
- **Adding a Tauri command**: Define `#[tauri::command]` fn in `main.rs`, register in `.invoke_handler(tauri::generate_handler![...])`, call from JS via `invoke('command_name', { args })`
- **Changing window config**: Edit `src-tauri/tauri.conf.json` → `app.windows[]`
- **Adding a new permission**: Edit `src-tauri/capabilities/default.json`
- **Modifying CSP**: Edit `src-tauri/tauri.conf.json` → `app.security.csp`

## Constraints

- DO NOT introduce a JS bundler or framework — this app is intentionally vanilla
- DO NOT add Node.js server-side code — the backend is Rust only
- ALWAYS update CSP in `tauri.conf.json` when adding new external API connections
- ALWAYS register new Tauri commands in the `generate_handler![]` macro
- Keep all frontend logic in `src/app.js` and all styles in `src/index.html`

## Versioning

Every time you make a change to this project, **increment the version number** before finishing:

1. Bump the **patch** version for fixes/tweaks (e.g. `0.2.0` → `0.2.1`), the **minor** version for new features (e.g. `0.2.1` → `0.3.0`).
2. Update the version in **all three locations** — they must stay in sync:
   - `package.json` → `"version"` field
   - `src-tauri/tauri.conf.json` → `"version"` field
   - `src/index.html` → `<span class="version-info">v…</span>` in the header
3. Never skip this step. The version stamp is visible in the app header so users can confirm which build they are running.
