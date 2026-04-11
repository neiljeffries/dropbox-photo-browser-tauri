# Dropbox Photo Browser

A lightweight desktop app built with [Tauri v2](https://v2.tauri.app/) for browsing photos and videos stored in your Dropbox account.

## Features

- **OAuth Authentication** — Connects to Dropbox via OAuth 2 implicit grant flow using a local HTTP listener on port 17822
- **Folder Browsing** — Navigate your Dropbox folder tree with a home screen showing configurable root paths (`/camera uploads`, `/ai stuff`)
- **Photo Grid** — Thumbnails displayed in a 120×120 grid with shimmer loading placeholders and lazy batch loading (25 at a time via Dropbox thumbnail batch API)
- **Year Slider** — Filter photos by year with a range slider extracted from EXIF/metadata dates
- **Lightbox Viewer** — Full-resolution image and video viewer with keyboard navigation (arrow keys, Escape)
- **Video Support** — Plays mp4, mov, avi, mkv, webm directly in the lightbox with blob URLs
- **Thumbnail Caching** — Base64 thumbnails cached locally to avoid re-downloading; auto-persisted every 2 seconds
- **Folder Caching** — Folder listings cached in local storage with age display; manual rescan available
- **Infinite Scroll** — Loads 250 photos at a time with automatic scroll-based loading and a "Show more" button
- **Breadcrumb Navigation** — Clickable path breadcrumbs for quick folder traversal

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri v2 (Rust backend) |
| Frontend | Vanilla HTML/CSS/JS (no framework, no bundler) |
| Backend state | Rust `HashMap<String, serde_json::Value>` persisted to `store.json` in local app data |
| API | Dropbox HTTP API v2 (files, thumbnails, user account) |
| Dependencies | `@tauri-apps/api`, `@tauri-apps/plugin-opener`, `@anthropic-ai/sdk` |

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (for the Tauri CLI)
- A [Dropbox App Key](https://www.dropbox.com/developers/apps) (created at the Dropbox developer console)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run in development mode:**
   ```bash
   npm run dev
   ```
   Or use the VS Code task: `Ctrl+Shift+P` → "Tasks: Run Task" → "Tauri Dev"

3. **Build for production:**
   ```bash
   npm run build
   ```
   Or use the VS Code task: `Ctrl+Shift+P` → "Tasks: Run Task" → "Tauri Build"

4. **First launch:**
   - Enter your Dropbox App Key on the setup screen
   - Click "Connect Dropbox" to authorize via your browser
   - Browse your photos

## Project Structure

```
├── package.json                 # Node dependencies and scripts (dev, build)
├── .vscode/
│   └── tasks.json               # VS Code tasks (Install Dependencies, Tauri Dev, Tauri Build)
├── .github/
│   └── agents/
│       └── dropbox-photo-browser.agent.md  # Copilot agent with full app knowledge
├── src/
│   ├── index.html               # Single-page UI (styles + markup)
│   └── app.js                   # All frontend logic (OAuth, API, grid, lightbox, caching)
└── src-tauri/
    ├── Cargo.toml               # Rust dependencies
    ├── tauri.conf.json           # Tauri config (window size, CSP, plugins)
    ├── build.rs                  # Tauri build script
    ├── capabilities/
    │   └── default.json          # Tauri permission capabilities
    └── src/
        └── main.rs              # Rust backend (key-value store, OAuth listener)
```

## Architecture

### Rust Backend (`main.rs`)

- **AppStore** — Thread-safe `Mutex<HashMap>` persisted to `{LocalAppData}/dropbox-photo-browser/store.json`. Exposes Tauri commands: `store_get`, `store_set`, `store_remove`, `store_keys`, `store_get_all`, `store_clear_cache`.
- **OAuth Listener** (`oauth_listen`) — Spawns a TCP listener on `127.0.0.1:17822`, receives the OAuth redirect, extracts the access token from the URL fragment via a two-request handshake (initial page + JS fetch with hash params).

### Frontend (`app.js`)

- **Storage adapter** — Wraps Tauri `invoke()` calls to provide `get/set/remove` interface over the Rust store.
- **Dropbox API** — Direct `fetch()` calls to `api.dropboxapi.com` and `content.dropboxapi.com` with bearer token auth.
- **Display windowing** — Renders photos in pages of 250, with infinite scroll triggering at 400px from page bottom.
- **Thumb cache** — In-memory `thumbCache` object flushed to persistent store on a 2-second debounce timer.

### Dev Server

There is no `devUrl` configured — Tauri serves `frontendDist` (`../src`) directly via its built-in asset protocol in both dev and production. This means frontend changes require restarting the Tauri process (no hot reload). For Rust backend changes, `tauri dev` watches and recompiles automatically.

### Content Security Policy

Configured in `tauri.conf.json` to allow connections to `api.dropboxapi.com`, `content.dropboxapi.com`, and `www.dropbox.com` alongside `self`. Images allowed from `data:` and `blob:` schemes.

## Supported Media Types

- **Images:** jpg, jpeg, png, gif, webp, heic, bmp, tiff, tif
- **Videos:** mp4, mov, avi, mkv, webm
