const { invoke } = window.__TAURI__.core;
const { openUrl } = window.__TAURI__.opener;

const IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','bmp','tiff','tif']);
const VID_EXTS = new Set(['mp4','mov','avi','mkv','webm']);
const MEDIA_EXTS = new Set([...IMG_EXTS, ...VID_EXTS]);
const THUMB_SIZE = 'w128h128';
const DISPLAY_PAGE = 250;
const DISPLAY_PAGE_PEOPLE = 80;
const ROOT_PATHS = [
  { path: '/camera uploads', label: 'Camera Uploads' },
  { path: '/ai stuff', label: 'AI Stuff' },
  { path: '/pictures', label: 'Pictures' }
];
const HOME_PATH = '__home__';
const OAUTH_PORT = 17822;

let appKey = '';
let accessToken = '';
let refreshToken = '';
let currentPath = HOME_PATH;
let photoIndex = [];
let displayCount = 0;
let lightboxIdx = 0;
let allYears = [];
let filteredIndex = [];
let thumbCache = {};
let thumbCacheCount = 0;
const MAX_THUMB_CACHE_ENTRIES = 20000;
let photoDateMap = {};  // path_lower → timestamp, built from all folder caches
let fetchGen = 0;
let folderCache = [];
const CACHE_KEY_PREFIX = 'folderCache_';
const THUMB_CACHE_KEY = 'thumbCacheStore';
let thumbCacheDirty = false;
let thumbSaveTimer = null;

// ── Save indicator ──────────────────────────────────────────────────────────
let _saveCount = 0;
let _saveFadeTimer = null;
function showSaveIndicator() {
  _saveCount++;
  const el = document.getElementById('save-indicator');
  if (!el) return;
  if (_saveFadeTimer) { clearTimeout(_saveFadeTimer); _saveFadeTimer = null; }
  el.classList.remove('fade-out');
  el.classList.add('visible');
}
function hideSaveIndicator() {
  _saveCount = Math.max(0, _saveCount - 1);
  if (_saveCount > 0) return;
  const el = document.getElementById('save-indicator');
  if (!el) return;
  el.classList.add('fade-out');
  _saveFadeTimer = setTimeout(() => {
    el.classList.remove('visible', 'fade-out');
    _saveFadeTimer = null;
  }, 300);
}

// ── Storage adapter (wraps Tauri invoke) ──────────────────────────────────────
const storage = {
  async get(keys) {
    if (typeof keys === 'string') keys = [keys];
    if (keys === null) {
      // get all
      const all = await invoke('store_get_all');
      return all || {};
    }
    const result = await invoke('store_get_batch', { keys });
    return result || {};
  },
  async set(obj) {
    const entries = Object.entries(obj);
    if (entries.length === 0) return;
    showSaveIndicator();
    try {
      if (entries.length === 1) {
        await invoke('store_set', { key: entries[0][0], value: entries[0][1] });
      } else {
        await invoke('store_set_batch', { entries: obj });
      }
    } finally {
      hideSaveIndicator();
    }
  },
  /** Save a pre-built JSON string directly — skips JS-side JSON.stringify. */
  async setRaw(key, json) {
    showSaveIndicator();
    try {
      await invoke('store_set_raw', { key, json });
    } finally {
      hideSaveIndicator();
    }
  },
  async remove(keys) {
    if (typeof keys === 'string') keys = [keys];
    await invoke('store_remove', { keys });
  }
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setupScreen  = $('setup-screen');
const authScreen   = $('auth-screen');
const loadingScreen= $('loading-screen');
const toolbar      = $('toolbar');
const folderList   = $('folder-list');
const photoGrid    = $('photo-grid');
const statusBar    = $('status-bar');
const loadMoreBtn  = $('load-more-btn');
const lightbox     = $('lightbox');
const lightboxImg  = $('lightbox-img');
const lightboxName = $('lightbox-name');
const faceScanBar  = $('face-scan-bar');
const faceScanFill = $('face-scan-fill');
const faceScanCount= $('face-scan-count');
const faceScanLabel= $('face-scan-label');
const peopleView   = $('people-view');
const btnPeople    = $('btn-people');
const timelineView = $('timeline-view');
const btnTimeline  = $('btn-timeline');

let peopleMode = false;         // true when People view is active
let timelineMode = false;       // true when Timeline view is active
let peopleClusterId = null;     // when viewing a single person's photos
let savedPhotoIndex = null;     // stash photoIndex before People view replaces it
let selectedPhotoPaths = new Set(); // multi-select in person detail view

function showScreen(name) {
  setupScreen.style.display   = name === 'setup'   ? '' : 'none';
  authScreen.style.display    = name === 'auth'    ? '' : 'none';
  loadingScreen.style.display = name === 'loading' ? '' : 'none';
  toolbar.style.display       = name === 'browse'  ? '' : 'none';
  if (name !== 'browse') {
    folderList.innerHTML = '';
    photoGrid.innerHTML  = '';
    statusBar.classList.remove('visible');
    loadMoreBtn.classList.remove('visible');
    $('year-slider-bar').classList.remove('visible');
    faceScanBar.classList.remove('visible');
    peopleView.classList.remove('visible');
    peopleView.innerHTML = '';
    timelineView.classList.remove('visible');
    timelineView.innerHTML = '';
    timelineMode = false;
    btnTimeline.classList.remove('active');
    peopleMode = false;
    peopleClusterId = null;
    cleanupBulkSelection();
    btnPeople.classList.remove('active');
  }
}
function setLoading(msg) {
  showScreen('loading');
  $('loading-msg').textContent = msg || 'Loading…';
}

// ── Thumb cache persistence ──────────────────────────────────────────────────
async function loadThumbCache() {
  const stored = await storage.get([THUMB_CACHE_KEY]);
  thumbCache = stored[THUMB_CACHE_KEY] || {};
  thumbCacheCount = Object.keys(thumbCache).length;
}

function scheduleThumbSave() {
  thumbCacheDirty = true;
  if (thumbSaveTimer) clearTimeout(thumbSaveTimer);
  thumbSaveTimer = setTimeout(() => {
    thumbSaveTimer = null;
    if (!thumbCacheDirty) return;
    // Wait for browser idle so scroll/paint are not blocked
    requestIdleCallback(() => {
      if (!thumbCacheDirty) return;
      thumbCacheDirty = false;
      const json = JSON.stringify(thumbCache);
      storage.setRaw(THUMB_CACHE_KEY, json);
    });
  }, 180000);
}

// ── Debounced face-data save ──────────────────────────────────────────────────
let _faceSaveTimer = null;
let _faceSaveIdleCb = null;
let _faceSaveInProgress = false;
let _faceSavePendingAgain = false;

function scheduleFaceDataSave(immediate) {
  if (_faceSaveTimer) { clearTimeout(_faceSaveTimer); _faceSaveTimer = null; }
  if (_faceSaveIdleCb) { cancelIdleCallback(_faceSaveIdleCb); _faceSaveIdleCb = null; }
  // If a save is already in flight, just flag that we need another round
  if (_faceSaveInProgress) { _faceSavePendingAgain = true; return; }
  const delay = immediate ? 300 : 180000;
  _faceSaveTimer = setTimeout(() => {
    _faceSaveTimer = null;
    // Wait for browser idle so save never interrupts scroll/paint
    _faceSaveIdleCb = requestIdleCallback(() => {
      _faceSaveIdleCb = null;
      _doFaceSave();
    }, { timeout: immediate ? 2000 : 30000 });
  }, delay);
}

async function _doFaceSave() {
  if (_faceSaveInProgress) { _faceSavePendingAgain = true; return; }
  _faceSaveInProgress = true;
  try {
    await FaceScan.saveFaceData(storage);
  } finally {
    _faceSaveInProgress = false;
    if (_faceSavePendingAgain) {
      _faceSavePendingAgain = false;
      scheduleFaceDataSave();
    }
  }
}

// ── File Menu ─────────────────────────────────────────────────────────────────
{
  const menuBtn = $('file-menu-btn');
  const menuDrop = $('file-menu-dropdown');
  let menuOpen = false;

  function toggleMenu(open) {
    menuOpen = typeof open === 'boolean' ? open : !menuOpen;
    menuDrop.classList.toggle('open', menuOpen);
    menuBtn.classList.toggle('open', menuOpen);
  }

  menuBtn.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', () => { if (menuOpen) toggleMenu(false); });
  menuDrop.addEventListener('click', e => e.stopPropagation());

  // ── Save now ──
  $('btn-save').addEventListener('click', async () => {
    toggleMenu(false);
    const btn = $('btn-save');
    btn.disabled = true;
    btn.textContent = '⏳ Saving…';
    try {
      if (thumbCacheDirty) {
        thumbCacheDirty = false;
        await storage.setRaw(THUMB_CACHE_KEY, JSON.stringify(thumbCache));
      }
      if (thumbSaveTimer) { clearTimeout(thumbSaveTimer); thumbSaveTimer = null; }
      await _doFaceSave();
      if (_faceSaveTimer) { clearTimeout(_faceSaveTimer); _faceSaveTimer = null; }
      if (_faceSaveIdleCb) { cancelIdleCallback(_faceSaveIdleCb); _faceSaveIdleCb = null; }
      btn.textContent = '✓ Saved!';
      setTimeout(() => { btn.textContent = '💾 Save Now'; }, 1500);
    } catch (e) {
      console.error('[Save] Manual save failed:', e);
      btn.textContent = '💾 Save Now';
    } finally {
      btn.disabled = false;
    }
  });

  // ── Export full backup ──
  $('menu-export').addEventListener('click', async () => {
    toggleMenu(false);
    const btn = $('menu-export');
    btn.disabled = true;
    btn.textContent = '⏳ Exporting…';
    try {
      // Flush pending saves first
      await flushFaceDataSave();
      if (thumbCacheDirty) {
        thumbCacheDirty = false;
        await storage.set({ [THUMB_CACHE_KEY]: thumbCache });
      }
      const allData = await storage.get(null);
      // Remove auth tokens from export for security
      const exportData = { ...allData };
      delete exportData.accessToken;
      delete exportData.refreshToken;
      delete exportData.appKey;
      exportData._exportVersion = 1;
      exportData._exportDate = new Date().toISOString();
      const json = JSON.stringify(exportData);
      const ok = await invoke('export_data', { jsonData: json });
      btn.textContent = ok ? '✓ Exported!' : '📤 Export Backup';
      if (ok) setTimeout(() => { btn.textContent = '📤 Export Backup'; }, 2000);
    } catch (e) {
      console.error('[Export] Failed:', e);
      btn.textContent = '❌ Failed';
      setTimeout(() => { btn.textContent = '📤 Export Backup'; }, 2000);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Import backup ──
  $('menu-import').addEventListener('click', async () => {
    toggleMenu(false);
    const btn = $('menu-import');
    btn.disabled = true;
    btn.textContent = '⏳ Reading…';
    try {
      const result = await invoke('import_data');
      if (!result) { btn.textContent = '📥 Import Backup'; btn.disabled = false; return; }
      let imported;
      try { imported = JSON.parse(result); } catch (_) {
        btn.textContent = '❌ Invalid file';
        setTimeout(() => { btn.textContent = '📥 Import Backup'; }, 2000);
        btn.disabled = false;
        return;
      }
      // Validate it looks like our backup
      if (!imported || typeof imported !== 'object') {
        btn.textContent = '❌ Invalid format';
        setTimeout(() => { btn.textContent = '📥 Import Backup'; }, 2000);
        btn.disabled = false;
        return;
      }
      // Remove export metadata before importing
      delete imported._exportVersion;
      delete imported._exportDate;
      // Don't overwrite current auth tokens
      delete imported.accessToken;
      delete imported.refreshToken;
      delete imported.appKey;

      btn.textContent = '⏳ Importing…';
      // Write all entries to the store
      await storage.set(imported);

      // Reload in-memory caches from the newly imported data
      if (imported[THUMB_CACHE_KEY]) {
        thumbCache = imported[THUMB_CACHE_KEY];
        thumbCacheCount = Object.keys(thumbCache).length;
      }
      const faceKey = 'faceDataStore_v3';
      if (imported[faceKey]) {
        await FaceScan.loadFaceData(storage);
      }
      btn.textContent = '✓ Imported!';
      setTimeout(() => { btn.textContent = '📥 Import Backup'; location.reload(); }, 1500);
    } catch (e) {
      console.error('[Import] Failed:', e);
      btn.textContent = '❌ Failed';
      setTimeout(() => { btn.textContent = '📥 Import Backup'; }, 2000);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Export thumbnails only ──
  $('menu-export-thumbs').addEventListener('click', async () => {
    toggleMenu(false);
    const btn = $('menu-export-thumbs');
    btn.disabled = true;
    btn.textContent = '⏳ Exporting…';
    try {
      if (thumbCacheDirty) {
        thumbCacheDirty = false;
        await storage.set({ [THUMB_CACHE_KEY]: thumbCache });
      }
      const exportData = {
        _exportVersion: 1,
        _exportDate: new Date().toISOString(),
        _type: 'thumbnails',
        [THUMB_CACHE_KEY]: thumbCache
      };
      const json = JSON.stringify(exportData);
      const ok = await invoke('export_data', { jsonData: json });
      btn.textContent = ok ? '✓ Exported!' : '🖼️ Export Thumbnails Only';
      if (ok) setTimeout(() => { btn.textContent = '🖼️ Export Thumbnails Only'; }, 2000);
    } catch (e) {
      console.error('[Export Thumbs] Failed:', e);
      btn.textContent = '❌ Failed';
      setTimeout(() => { btn.textContent = '🖼️ Export Thumbnails Only'; }, 2000);
    } finally {
      btn.disabled = false;
    }
  });
}

async function flushFaceDataSave() {
  if (_faceSaveTimer) {
    clearTimeout(_faceSaveTimer);
    _faceSaveTimer = null;
  }
  _faceSavePendingAgain = false;
  // Wait for any in-flight save to finish, then do one final save
  if (_faceSaveInProgress) {
    _faceSavePendingAgain = false;
    await new Promise(resolve => {
      const check = () => _faceSaveInProgress ? setTimeout(check, 50) : resolve();
      check();
    });
  }
  await _doFaceSave();
}

// ── Save on close ─────────────────────────────────────────────────────────────
// Flush any pending face data + thumb cache when the window is about to close.
window.addEventListener('beforeunload', () => {
  if (_faceSaveTimer) {
    clearTimeout(_faceSaveTimer);
    _faceSaveTimer = null;
    // Fire-and-forget — browser may or may not complete this
    _doFaceSave();
  }
  if (_faceSaveIdleCb) {
    cancelIdleCallback(_faceSaveIdleCb);
    _faceSaveIdleCb = null;
    _doFaceSave();
  }
  if (thumbCacheDirty) {
    thumbCacheDirty = false;
    storage.setRaw(THUMB_CACHE_KEY, JSON.stringify(thumbCache));
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadThumbCache();
  await FaceScan.loadFaceData(storage);

  // Auto-merge any clusters with duplicate names (fixes v2→v3 migration splits)
  const merged = FaceScan.mergeByName();
  if (merged > 0) {
    console.log(`[FaceScan] Auto-merged ${merged} duplicate-name clusters on startup`);
    await FaceScan.saveFaceData(storage);
  }

  // Wire up full-resolution image downloader for face scanning
  FaceScan.setImageDownloader(async (path) => {
    const doFetch = () => fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Dropbox-API-Arg': JSON.stringify({ path })
      }
    });
    let res = await doFetch();
    // Auto-refresh on 401
    if (res.status === 401 && refreshToken) {
      try { await refreshAccessToken(); } catch (_) {}
      res = await doFetch();
    }
    if (!res.ok) {
      const err = new Error('Download failed ' + res.status);
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  });

  let lastVisibleCount = -1;
  let pendingPeopleRender = null;

  FaceScan.setCallbacks({
    progress: (done, total, facesFound, clusters) => {
      faceScanBar.classList.add('visible');
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      faceScanFill.style.width = pct + '%';
      const peopleCount = clusters ? clusters.length : 0;
      faceScanCount.textContent = `${done}/${total} · ${facesFound} faces · ${peopleCount} people`;
      faceScanLabel.textContent = 'Scanning faces (full resolution)…';
      // Throttled live-update: only re-render when visible cluster count changes
      if (peopleMode && !peopleClusterId && clusters) {
        const visCount = clusters.filter(c => c.photos.some(p => thumbCache[p])).length;
        if (visCount !== lastVisibleCount) {
          lastVisibleCount = visCount;
          if (!pendingPeopleRender) {
            pendingPeopleRender = setTimeout(() => {
              pendingPeopleRender = null;
              renderPeopleGrid();
            }, 2000);
          }
        }
      }
    },
    complete: async (clusters) => {
      // Auto-merge clusters that share the same name (from legacy migration or manual renames)
      const merged = FaceScan.mergeByName();
      if (merged > 0) console.log(`[FaceScan] Auto-merged ${merged} duplicate-name clusters`);
      faceScanLabel.textContent = 'Face scan complete';
      faceScanCount.textContent = FaceScan.getClusters().length + ' people found';
      faceScanFill.style.width = '100%';
      await FaceScan.saveFaceData(storage);
      setTimeout(() => faceScanBar.classList.remove('visible'), 4000);
      lastVisibleCount = -1;
      if (pendingPeopleRender) { clearTimeout(pendingPeopleRender); pendingPeopleRender = null; }
      if (peopleMode && !peopleClusterId) renderPeopleGrid();
    },
  });

  const stored = await storage.get(['appKey', 'accessToken', 'refreshToken']);
  appKey       = stored.appKey || '';
  accessToken  = stored.accessToken || '';
  refreshToken = stored.refreshToken || '';

  if (!appKey) { showScreen('setup'); return; }
  if (!accessToken && !refreshToken) { showScreen('auth'); return; }

  // If we have a refresh token but no access token, refresh first
  if (!accessToken && refreshToken) {
    try {
      await refreshAccessToken();
    } catch (e) {
      showScreen('auth');
      return;
    }
  }

  setLoading('Connecting…');
  try {
    const info = await dbxFetch('https://api.dropboxapi.com/2/users/get_current_account', null, 'POST');
    $('account-name').textContent = info.name?.display_name || info.email || '';
    $('btn-logout').style.display = '';
    showHome();
  } catch(e) {
    if (e.status === 401) {
      accessToken = '';
      await storage.remove(['accessToken']);
      showScreen('auth');
    } else {
      showScreen('auth');
      $('auth-error').textContent = 'Could not connect: ' + (e.message || e);
    }
  }
}

// ── Dropbox API helper ────────────────────────────────────────────────────────
async function dbxFetch(url, body, method = 'POST') {
  const headers = { 'Authorization': 'Bearer ' + accessToken };
  const opts = { method, headers };
  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res = await fetch(url, opts);
  // Auto-refresh on 401 if we have a refresh token
  if (res.status === 401 && refreshToken) {
    try {
      await refreshAccessToken();
      opts.headers = { ...opts.headers, 'Authorization': 'Bearer ' + accessToken };
      res = await fetch(url, opts);
    } catch (_) { /* refresh failed, fall through to error */ }
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch(_) {}
    const err = new Error('Dropbox API error ' + res.status + (detail ? ': ' + detail : ''));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function dbxGetThumbnailBatch(paths) {
  const entries = paths.map(p => ({ path: p, format: { '.tag': 'jpeg' }, size: { '.tag': THUMB_SIZE } }));
  const doFetch = () => fetch('https://content.dropboxapi.com/2/files/get_thumbnail_batch', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entries })
  });
  let res = await doFetch();
  if (res.status === 401 && refreshToken) {
    try { await refreshAccessToken(); } catch (_) {}
    res = await doFetch();
  }
  if (!res.ok) throw new Error('Thumbnail batch failed ' + res.status);
  return res.json();
}

async function dbxGetFullImage(path) {
  const doFetch = () => fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  let res = await doFetch();
  if (res.status === 401 && refreshToken) {
    try { await refreshAccessToken(); } catch (_) {}
    res = await doFetch();
  }
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function isRootPath(path) {
  return ROOT_PATHS.some(r => r.path === (path || '').toLowerCase());
}

function getRootInfo(path) {
  return ROOT_PATHS.find(r => r.path === (path || '').toLowerCase());
}

function getContainingRoot(path) {
  const lp = (path || '').toLowerCase();
  return ROOT_PATHS.find(r => lp === r.path || lp.startsWith(r.path + '/'));
}

function showHome() {
  currentPath = HOME_PATH;
  photoIndex = [];
  folderCache = [];
  displayCount = 0;
  peopleMode = false;
  peopleClusterId = null;
  btnPeople.classList.remove('active');
  showScreen('browse');
  folderList.innerHTML = '';
  photoGrid.innerHTML = '';
  photoGrid.style.display = '';
  folderList.style.display = '';
  peopleView.classList.remove('visible');
  peopleView.innerHTML = '';
  statusBar.classList.remove('visible');
  loadMoreBtn.classList.remove('visible');
  $('year-slider-bar').classList.remove('visible');
  $('btn-up').style.display = 'none';
  $('path-display').innerHTML = '<span style="cursor:default">Home</span>';

  for (const root of ROOT_PATHS) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    li.innerHTML = `<span class="folder-icon">📁</span><span class="folder-name">${esc(root.label)}</span><span class="chevron">›</span>`;
    li.addEventListener('click', () => browseFolder(root.path));
    folderList.appendChild(li);
  }
}

// ── Cache helpers ──────────────────────────────────────────────────────────────
function cacheKeyFor(path) {
  return CACHE_KEY_PREFIX + (path || '').toLowerCase();
}

async function loadCachedFolder(path) {
  const key = cacheKeyFor(path);
  const stored = await storage.get([key]);
  return stored[key] || null;
}

async function saveFolderCache(path, entries) {
  const key = cacheKeyFor(path);
  await storage.set({ [key]: { entries, timestamp: Date.now() } });
}

function formatCacheAge(timestamp) {
  if (!timestamp) return '';
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Folder helpers ────────────────────────────────────────────────────────────
async function fetchFolderEntries(path, recursive = false) {
  let allEntries = [];
  let data = await dbxFetch('https://api.dropboxapi.com/2/files/list_folder', {
    path: path || '',
    recursive,
    include_media_info: true,
    limit: 2000
  });
  allEntries.push(...data.entries);
  while (data.has_more) {
    data = await dbxFetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      cursor: data.cursor
    });
    allEntries.push(...data.entries);
  }
  return allEntries;
}

// Refresh all ROOT_PATHS folder caches from Dropbox and rebuild photoIndex
async function refreshFolderCaches() {
  await Promise.all(ROOT_PATHS.map(async (rp) => {
    try {
      const entries = await fetchFolderEntries(rp.path, true);
      await saveFolderCache(rp.path, entries);
    } catch (e) {
      console.warn('Failed to refresh', rp.path, e.message);
    }
  }));
  await buildPhotoDateMap();
}

// ── Folder browse ─────────────────────────────────────────────────────────────
async function browseFolder(path, forceRefresh = false) {
  currentPath = path;
  photoIndex  = [];
  folderCache = [];
  displayCount = 0;
  const gen = ++fetchGen;
  updateBreadcrumb(path);

  if (!forceRefresh) {
    const cached = await loadCachedFolder(path);
    if (cached && cached.entries) {
      renderFolderData(path, cached.entries, cached.timestamp);
      return;
    }
  }

  setLoading('Scanning folder…');
  try {
    const allEntries = await fetchFolderEntries(path);
    if (gen !== fetchGen) return;
    await saveFolderCache(path, allEntries);
    renderFolderData(path, allEntries, Date.now());
  } catch(e) {
    setLoading('Error: ' + e.message);
  }
}

function renderFolderData(path, allEntries, cacheTimestamp) {
  folderCache = allEntries.filter(e => e['.tag'] === 'folder');
  photoIndex = allEntries.filter(isMedia);
  sortPhotosNewest(photoIndex);

  showScreen('browse');

  folderList.innerHTML = '';
  $('btn-up').style.display = (path && !isRootPath(path)) ? '' : 'none';
  const folderFrag = document.createDocumentFragment();
  for (const f of folderCache) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    li.innerHTML = `<span class="folder-icon">📁</span><span class="folder-name">${esc(f.name)}</span><span class="chevron">›</span>`;
    li.addEventListener('click', () => browseFolder(f.path_lower));
    folderFrag.appendChild(li);
  }
  folderList.appendChild(folderFrag);

  buildYearSlider();

  photoGrid.innerHTML = '';
  displayCount = 0;
  showMorePhotos();

  if (cacheTimestamp) {
    statusBar.textContent += ` · cached ${formatCacheAge(cacheTimestamp)}`;
  }

  // Auto-scan new photos if faces have been scanned before
  if (FaceScan.getScannedCount() > 0 && !FaceScan.isScanning()) {
    const unscanned = photoIndex
      .filter(p => isLikelyPhoto(p))
      .map(p => p.path_lower)
      .filter(path => !FaceScan.getFaceData().photos[path]);
    if (unscanned.length > 0) {
      console.log(`[AutoScan] ${unscanned.length} new photo(s) detected, queuing for face scan`);
      FaceScan.queuePhotosForScan(unscanned, true);
    }
  }
}

// ── Display windowing ─────────────────────────────────────────────────────────
let _filteredCache = null;
let _filteredCacheKey = '';

function invalidateFilteredCache() {
  _filteredCache = null;
  _filteredCacheKey = '';
}

// After removing photos from the DOM, keep filteredIndex & displayCount in sync
function syncAfterRemoval(removedPaths) {
  const removed = removedPaths instanceof Set ? removedPaths : new Set(removedPaths);
  const before = filteredIndex.length;
  filteredIndex = filteredIndex.filter(p => !removed.has(p.path_lower));
  const delta = before - filteredIndex.length;
  displayCount = Math.max(0, displayCount - delta);
  invalidateFilteredCache();

  // Re-index remaining cells so data-idx matches the new filteredIndex positions
  const cells = photoGrid.querySelectorAll('.photo-cell[data-idx]');
  let idx = 0;
  for (const cell of cells) {
    cell.dataset.idx = idx++;
  }
}

function getFilteredPhotos() {
  // Build a cache key from the current filter state
  let cacheKey;
  if (peopleClusterId) {
    const cluster = FaceScan.getClusters().find(c => c.id === peopleClusterId);
    cacheKey = 'person:' + peopleClusterId + ':' + (cluster ? cluster.photos.length : 0);
  } else {
    const slider = $('year-slider');
    const selectedIdx = parseInt(slider.value);
    cacheKey = 'year:' + selectedIdx + ':' + photoIndex.length;
  }

  if (_filteredCache && _filteredCacheKey === cacheKey) return _filteredCache;

  let result;
  if (peopleClusterId) {
    const cluster = FaceScan.getClusters().find(c => c.id === peopleClusterId);
    if (cluster) {
      const clusterPaths = new Set(cluster.photos);
      result = photoIndex.filter(p => clusterPaths.has(p.path_lower));
    } else {
      result = photoIndex;
    }
  } else {
    const slider = $('year-slider');
    const selectedIdx = parseInt(slider.value);
    const selectedYear = selectedIdx === 0 ? null : allYears[selectedIdx - 1];
    if (selectedYear) {
      result = photoIndex.filter(p => {
        const d = getPhotoDate(p);
        return d && new Date(d).getFullYear() === selectedYear;
      });
    } else {
      result = photoIndex;
    }
  }

  _filteredCache = result;
  _filteredCacheKey = cacheKey;
  return result;
}

let _showingMore = false;
function showMorePhotos() {
  if (_showingMore) return;
  _showingMore = true;
  const photos = getFilteredPhotos();
  filteredIndex = photos;
  const pageSize = peopleClusterId ? DISPLAY_PAGE_PEOPLE : DISPLAY_PAGE;
  const end = Math.min(displayCount + pageSize, photos.length);
  const needThumbPhotos = [];
  const needThumbCells = [];

  let lastYearMonth = null;
  if (displayCount > 0) {
    const prevD = getPhotoDate(photos[displayCount - 1]);
    if (prevD) {
      const pd = new Date(prevD);
      lastYearMonth = pd.getFullYear() + '-' + pd.getMonth();
    }
  }

  const slider = $('year-slider');
  const selectedIdx = parseInt(slider.value);
  const showDividers = selectedIdx === 0 || !!peopleClusterId;

  const MONTH_NAMES = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];

  const frag = document.createDocumentFragment();
  for (let i = displayCount; i < end; i++) {
    const d = getPhotoDate(photos[i]);
    let ym = null;
    if (d) {
      const dt = new Date(d);
      ym = dt.getFullYear() + '-' + dt.getMonth();
    }
    if (showDividers && ym && ym !== lastYearMonth) {
      const dt = new Date(d);
      const div = document.createElement('div');
      div.className = 'year-divider';
      div.textContent = MONTH_NAMES[dt.getMonth()] + ' ' + dt.getFullYear();
      frag.appendChild(div);
      lastYearMonth = ym;
    }
    // When viewing a person's photos, use shared helper with selection + actions
    if (peopleClusterId) {
      const { wrap, cell: wrapCell } = createPersonPhotoWrap(photos[i], i, peopleClusterId);
      const cached2 = thumbCache[photos[i].path_lower];
      if (!cached2) {
        wrapCell.classList.add('loading');
        needThumbPhotos.push(photos[i]);
        needThumbCells.push(wrapCell);
      }
      frag.appendChild(wrap);
      continue;
    }

    const cell = document.createElement('div');
    cell.className = 'photo-cell';
    cell.dataset.idx = i;
    cell.addEventListener('click', () => openLightbox(parseInt(cell.dataset.idx)));

    const cached = thumbCache[photos[i].path_lower];
    if (cached) {
      const img = document.createElement('img');
      img.src = cached;
      img.alt = photos[i].name;
      cell.appendChild(img);
      if (isVideo(photos[i])) {
        const badge = document.createElement('span');
        badge.className = 'video-badge';
        badge.textContent = '\u25B6';
        cell.appendChild(badge);
      }
    } else {
      cell.classList.add('loading');
      needThumbPhotos.push(photos[i]);
      needThumbCells.push(cell);
    }

    frag.appendChild(cell);
  }
  photoGrid.appendChild(frag);

  displayCount = end;
  updateStatus();

  if (displayCount < photos.length) {
    loadMoreBtn.textContent = `Show more (${photos.length - displayCount} remaining)`;
    loadMoreBtn.disabled = false;
    loadMoreBtn.classList.add('visible');
  } else {
    loadMoreBtn.classList.remove('visible');
  }

  _showingMore = false;
  if (needThumbPhotos.length > 0) {
    loadThumbnailsForCells(needThumbPhotos, needThumbCells);
  }

  // Upgrade newly loaded cells if cluster slider is above base size
  if (peopleClusterId && _clusterThumbSize > 128) {
    upgradeClusterDetailThumbs(_clusterThumbSize);
  }
}

function resetAndShowPhotos() {
  invalidateFilteredCache();
  photoGrid.innerHTML = '';
  displayCount = 0;
  showMorePhotos();
}

function isMedia(entry) {
  const ext = (entry.name || '').split('.').pop().toLowerCase();
  return entry['.tag'] === 'file' && MEDIA_EXTS.has(ext);
}

function isVideo(entry) {
  const ext = (entry.name || '').split('.').pop().toLowerCase();
  return VID_EXTS.has(ext);
}

const SCREENSHOT_PATTERNS = /screenshot|screen_shot|screen shot|screen.?recording|screen.?capture/i;
function isLikelyPhoto(entry) {
  if (isVideo(entry)) return false;
  const name = entry.name || '';
  if (SCREENSHOT_PATTERNS.test(name)) return false;
  const ext = name.split('.').pop().toLowerCase();
  // PNG/GIF/BMP/TIFF are rarely camera photos — skip unless they have camera metadata
  if (['png','gif','bmp','tiff','tif','webp'].includes(ext)) {
    if (!entry.media_info?.metadata?.dimensions) return false;
  }
  return IMG_EXTS.has(ext);
}

function getPhotoDate(entry) {
  return entry.media_info?.metadata?.time_taken
    || entry.client_modified
    || entry.server_modified
    || '';
}

function getPhotoTimestamp(entry) {
  const d = getPhotoDate(entry);
  return d ? new Date(d).getTime() : 0;
}

// Build a path→timestamp map from all folder caches in storage,
// and populate photoIndex with entries from ALL scanned folders so
// People view works even if the user hasn't browsed a folder yet.
async function buildPhotoDateMap() {
  photoDateMap = {};
  savedPhotoIndex = photoIndex;
  const merged = new Map(); // path_lower → entry (dedup across folders)
  // Include currently loaded photoIndex
  for (const entry of photoIndex) {
    if (entry.path_lower) {
      photoDateMap[entry.path_lower] = getPhotoTimestamp(entry);
      merged.set(entry.path_lower, entry);
    }
  }
  // Load all ROOT_PATHS folder caches from storage
  const cacheKeys = ROOT_PATHS.map(rp => cacheKeyFor(rp.path));
  const allCached = await storage.get(cacheKeys);
  for (const rp of ROOT_PATHS) {
    const cached = allCached[cacheKeyFor(rp.path)];
    if (!cached || !cached.entries) continue;
    for (const entry of cached.entries) {
      if (entry.path_lower && isMedia(entry)) {
        photoDateMap[entry.path_lower] = getPhotoTimestamp(entry);
        if (!merged.has(entry.path_lower)) merged.set(entry.path_lower, entry);
      }
    }
  }
  photoIndex = Array.from(merged.values());
  sortPhotosNewest(photoIndex);
}

// Pick the most recent cached thumbnail for a cluster (or use poster override)
// Returns { thumb, hasAny } — hasAny indicates at least one photo has a cached thumb.
function getClusterThumb(cluster) {
  // Use manually chosen poster if set and cached
  if (cluster.posterPhoto && thumbCache[cluster.posterPhoto]) {
    return { thumb: thumbCache[cluster.posterPhoto], path: cluster.posterPhoto, hasAny: true };
  }
  let best = null;
  let bestTime = -1;
  let hasAny = false;
  for (const p of cluster.photos) {
    if (!thumbCache[p]) continue;
    hasAny = true;
    const t = photoDateMap[p] || 0;
    if (t > bestTime || best === null) {
      bestTime = t;
      best = p;
    }
  }
  return { thumb: best ? thumbCache[best] : null, path: best, hasAny };
}

function sortPhotosNewest(arr) {
  arr.sort((a, b) => getPhotoTimestamp(b) - getPhotoTimestamp(a));
}

function buildYearSlider() {
  const years = new Set();
  for (const p of photoIndex) {
    const ts = photoDateMap[p.path_lower];
    if (ts) years.add(new Date(ts).getFullYear());
  }
  allYears = [...years].sort((a, b) => b - a);
  const bar = $('year-slider-bar');
  const slider = $('year-slider');
  if (allYears.length < 2) {
    bar.classList.remove('visible');
    return;
  }
  slider.min = 0;
  slider.max = allYears.length;
  slider.value = 0;
  $('year-label').textContent = 'All';
  $('year-min-label').textContent = 'All';
  $('year-max-label').textContent = allYears[allYears.length - 1];
  bar.classList.add('visible');
}

async function loadThumbnailsForCells(photos, cells) {
  const BATCH = 25;
  for (let i = 0; i < photos.length; i += BATCH) {
    const slice = photos.slice(i, i + BATCH);
    const sliceCells = cells.slice(i, i + BATCH);
    const paths = slice.map(p => p.path_lower);
    try {
      const result = await dbxGetThumbnailBatch(paths);
      for (let j = 0; j < slice.length; j++) {
        const cell = sliceCells[j];
        if (!cell) continue;
        cell.classList.remove('loading');
        const entry = result.entries[j];
        if (entry?.['.tag'] === 'success' && entry.thumbnail) {
          const dataUrl = 'data:image/jpeg;base64,' + entry.thumbnail;
          if (!thumbCache[slice[j].path_lower]) thumbCacheCount++;
          thumbCache[slice[j].path_lower] = dataUrl;
          if (!isVideo(slice[j])) {
            scheduleThumbSave();
          }
          // Evict oldest entries if cache exceeds limit
          if (thumbCacheCount > MAX_THUMB_CACHE_ENTRIES) {
            const keys = Object.keys(thumbCache);
            const evictCount = Math.floor(keys.length * 0.1);
            for (let k = 0; k < evictCount; k++) {
              delete thumbCache[keys[k]];
            }
            thumbCacheCount = keys.length - evictCount;
            scheduleThumbSave();
          }
          const img = document.createElement('img');
          img.src = dataUrl;
          img.alt = slice[j].name;
          cell.appendChild(img);
          if (isVideo(slice[j])) {
            const badge = document.createElement('span');
            badge.className = 'video-badge';
            badge.textContent = '\u25B6';
            cell.appendChild(badge);
          }
        } else {
          cell.classList.add('error');
          cell.textContent = '\u{1F5BC}';
        }
      }
    } catch(e) {
      for (let j = 0; j < sliceCells.length; j++) {
        const cell = sliceCells[j];
        if (cell) { cell.classList.remove('loading'); cell.classList.add('error'); cell.textContent = '\u{1F5BC}'; }
      }
    }
  }
}

function updateStatus() {
  const total = photoIndex.length;
  const shown = filteredIndex.length;
  if (total > 0) {
    if (shown !== total) {
      statusBar.textContent = `Showing ${displayCount} of ${shown} filtered (${total} total)`;
    } else {
      statusBar.textContent = `Showing ${displayCount} of ${total} photo${total !== 1 ? 's' : ''}`;
    }
    statusBar.classList.add('visible');
  } else {
    statusBar.classList.remove('visible');
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
function updateBreadcrumb(path) {
  const display = $('path-display');
  const root = getContainingRoot(path);
  if (!root) {
    display.innerHTML = '<span data-path="__home__" style="cursor:pointer">Home</span>';
    display.querySelector('span').addEventListener('click', () => showHome());
    return;
  }
  const rootLabel = root.label;
  if (path.toLowerCase() === root.path) {
    let html = '<span data-path="__home__" style="cursor:pointer">Home</span>';
    html += ` / <span data-path="${root.path}" style="cursor:pointer">${rootLabel}</span>`;
    display.innerHTML = html;
    display.querySelectorAll('span').forEach(s => {
      s.style.cursor = 'pointer';
      s.addEventListener('click', () => {
        if (s.dataset.path === '__home__') showHome();
        else browseFolder(s.dataset.path);
      });
    });
    return;
  }
  const rel = path.slice(root.path.length).replace(/^\//, '');
  const parts = rel.split('/').filter(Boolean);
  let html = '<span data-path="__home__" style="cursor:pointer">Home</span>';
  html += ` / <span data-path="${root.path}" style="cursor:pointer">${rootLabel}</span>`;
  let acc = root.path;
  for (const p of parts) {
    acc += '/' + p;
    html += ` / <span data-path="${esc(acc)}">${esc(p)}</span>`;
  }
  display.innerHTML = html;
  display.querySelectorAll('span').forEach(s => {
    s.style.cursor = 'pointer';
    s.addEventListener('click', () => {
      if (s.dataset.path === '__home__') showHome();
      else browseFolder(s.dataset.path);
    });
  });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
let fullUrlCache = {};

let lightboxGen = 0;

async function openLightbox(idx) {
  if (idx < 0 || idx >= filteredIndex.length) return;
  const gen = ++lightboxGen;
  lightboxIdx = idx;
  lightbox.classList.add('open');

  const entry = filteredIndex[idx];
  const path = entry.path_lower;
  const video = isVideo(entry);
  lightboxName.textContent = entry.name;

  // Update info panel if open
  if ($('lightbox-info-panel').classList.contains('open')) {
    buildInfoPanel(entry);
  }

  // Show thumbnail instantly while full image loads
  if (thumbCache[path]) {
    lightboxImg.src = thumbCache[path];
    lightboxImg.style.opacity = '0.6';
  }

  const lightboxVid = $('lightbox-vid');
  if (video) {
    lightboxImg.style.display = 'none';
    lightboxVid.style.display = '';
    lightboxVid.src = '';
    lightboxVid.poster = thumbCache[path] || '';
    try {
      const url = await dbxGetFullImage(path);
      if (gen !== lightboxGen) return; // stale
      lightboxVid.src = url;
      lightboxVid.dataset.blobUrl = url;
      lightboxVid.play().catch(() => {});
    } catch(e) {
      if (gen !== lightboxGen) return;
      lightboxName.textContent = 'Failed to load video';
      return;
    }
  } else {
    lightboxVid.style.display = 'none';
    lightboxVid.pause();
    lightboxVid.src = '';
    lightboxImg.style.display = '';
    if (!fullUrlCache[path]) {
      try {
        fullUrlCache[path] = await dbxGetFullImage(path);
      } catch(e) {
        if (gen !== lightboxGen) return;
        lightboxName.textContent = 'Failed to load image';
        return;
      }
    }
    if (gen !== lightboxGen) return; // stale
    lightboxImg.src = fullUrlCache[path];
    lightboxImg.style.opacity = '1';
  }
}

function closeLightbox() {
  const vid = $('lightbox-vid');
  if (vid.dataset.blobUrl) {
    URL.revokeObjectURL(vid.dataset.blobUrl);
    delete vid.dataset.blobUrl;
  }
  vid.pause(); vid.src = '';
  lightbox.classList.remove('open');
  $('lightbox-info-panel').classList.remove('open');
  $('lightbox-info-btn').classList.remove('active');
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function buildInfoPanel(entry) {
  const panel = $('lightbox-info-panel');
  let html = '<button class="info-panel-close" title="Close info">✕</button>';
  html += '<h3>File</h3>';
  html += `<div class="info-row"><span class="info-label">Name</span><span class="info-value">${esc(entry.name)}</span></div>`;
  html += `<div class="info-row"><span class="info-label">Path</span><span class="info-value">${esc(entry.path_display || entry.path_lower)}</span></div>`;
  html += `<div class="info-row"><span class="info-label">Size</span><span class="info-value">${formatFileSize(entry.size)}</span></div>`;

  const mi = entry.media_info?.metadata;
  if (mi) {
    html += '<h3>Media</h3>';
    if (mi.dimensions) {
      html += `<div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${mi.dimensions.width} × ${mi.dimensions.height}</span></div>`;
    }
    if (mi.time_taken) {
      const dt = new Date(mi.time_taken);
      html += `<div class="info-row"><span class="info-label">Taken</span><span class="info-value">${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}</span></div>`;
    }
    if (mi.location) {
      html += `<div class="info-row"><span class="info-label">Latitude</span><span class="info-value">${mi.location.latitude.toFixed(6)}</span></div>`;
      html += `<div class="info-row"><span class="info-label">Longitude</span><span class="info-value">${mi.location.longitude.toFixed(6)}</span></div>`;
    }
    if (mi.duration) {
      const secs = Math.round(mi.duration / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      html += `<div class="info-row"><span class="info-label">Duration</span><span class="info-value">${m}:${String(s).padStart(2, '0')}</span></div>`;
    }
  }

  html += '<h3>Dates</h3>';
  if (entry.client_modified) {
    const dt = new Date(entry.client_modified);
    html += `<div class="info-row"><span class="info-label">Modified</span><span class="info-value">${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}</span></div>`;
  }
  if (entry.server_modified) {
    const dt = new Date(entry.server_modified);
    html += `<div class="info-row"><span class="info-label">Uploaded</span><span class="info-value">${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}</span></div>`;
  }

  // Face data
  const fd = FaceScan.getFaceData();
  const faces = fd.photos?.[entry.path_lower];
  if (faces && faces.length > 0) {
    // Build a map of which clusters contain this photo
    const matchingClusters = fd.clusters?.filter(c => c.photos.includes(entry.path_lower)) || [];
    html += `<h3>Faces (${faces.length})</h3>`;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const name = matchingClusters[i]?.name || matchingClusters[0]?.name || 'Unknown';
      html += `<div class="info-row"><span class="info-label">Face ${i + 1}</span><span class="info-value">${esc(name)} (score ${f.score?.toFixed(2) || '—'})</span></div>`;
    }
  }

  if (entry.content_hash) {
    html += '<h3>Hash</h3>';
    html += `<div class="info-row"><span class="info-label">Content</span><span class="info-value" style="font-size:9px;">${entry.content_hash}</span></div>`;
  }

  panel.innerHTML = html;
  panel.querySelector('.info-panel-close').addEventListener('click', () => {
    panel.classList.remove('open');
    $('lightbox-info-btn').classList.remove('active');
  });
}

$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-download').addEventListener('click', downloadCurrentPhoto);
$('lightbox-info-btn').addEventListener('click', () => {
  const panel = $('lightbox-info-panel');
  const btn = $('lightbox-info-btn');
  const isOpen = panel.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  if (isOpen) {
    const entry = filteredIndex[lightboxIdx];
    if (entry) buildInfoPanel(entry);
  }
});
$('lightbox-prev').addEventListener('click', () => openLightbox(lightboxIdx - 1));
$('lightbox-next').addEventListener('click', () => openLightbox(lightboxIdx + 1));
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', e => {
  if (!lightbox.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft')  openLightbox(lightboxIdx - 1);
  if (e.key === 'ArrowRight') openLightbox(lightboxIdx + 1);
  if (e.key === 'i' || e.key === 'I') $('lightbox-info-btn').click();
});

// ── Download helpers ──────────────────────────────────────────────────────────
async function ensureFreshToken() {
  if (!refreshToken) return;
  try {
    await dbxFetch('https://api.dropboxapi.com/2/check/user', { query: 'ping' });
  } catch (_) {}
}

async function downloadCurrentPhoto() {
  const entry = filteredIndex[lightboxIdx];
  if (!entry) return;
  const btn = $('lightbox-download');
  const orig = btn.textContent;
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    await ensureFreshToken();
    const saved = await invoke('download_single_file', {
      dropboxPath: entry.path_lower,
      filename: entry.name,
      accessToken: accessToken
    });
    btn.textContent = saved ? '✓' : '⬇';
  } catch (e) {
    console.error('[Download] Failed:', e);
    btn.textContent = '✗';
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
}

async function downloadClusterAsZip(clusterId, statusBtn) {
  const cluster = FaceScan.getClusters().find(c => c.id === clusterId);
  if (!cluster || cluster.photos.length === 0) return;
  const zipName = (cluster.name || 'photos') + '.zip';
  const clusterPaths = new Set(cluster.photos);
  const entries = photoIndex.filter(p => clusterPaths.has(p.path_lower));
  if (entries.length === 0) return;
  if (statusBtn) { statusBtn.textContent = '⏳ Downloading…'; statusBtn.disabled = true; }
  try {
    await ensureFreshToken();
    await invoke('download_files_zip', {
      dropboxPaths: entries.map(e => e.path_lower),
      filenames: entries.map(e => e.name),
      accessToken: accessToken,
      zipName: zipName
    });
    if (statusBtn) { statusBtn.textContent = '✓ Done'; setTimeout(() => { statusBtn.textContent = '⬇ Download All'; statusBtn.disabled = false; }, 2000); }
  } catch (e) {
    console.error('[Download] Zip failed:', e);
    alert('Download failed: ' + e);
    if (statusBtn) { statusBtn.textContent = '⬇ Download All'; statusBtn.disabled = false; }
  }
}

async function downloadSelectedAsZip() {
  if (selectedPhotoPaths.size === 0) return;
  const entries = photoIndex.filter(p => selectedPhotoPaths.has(p.path_lower));
  if (entries.length === 0) return;
  let zipName = 'selected-photos.zip';
  if (peopleClusterId) {
    const cluster = FaceScan.getClusters().find(c => c.id === peopleClusterId);
    if (cluster && cluster.name) zipName = cluster.name + ' (selected).zip';
  }
  try {
    await ensureFreshToken();
    await invoke('download_files_zip', {
      dropboxPaths: entries.map(e => e.path_lower),
      filenames: entries.map(e => e.name),
      accessToken: accessToken,
      zipName: zipName
    });
  } catch (e) {
    console.error('[Download] Zip failed:', e);
    alert('Download failed: ' + e);
  }
}

// ── OAuth (local HTTP redirect for Tauri) ─────────────────────────────────────
$('btn-auth').addEventListener('click', startAuth);
$('btn-change-key').addEventListener('click', async () => {
  await storage.remove(['accessToken', 'refreshToken', 'appKey']);
  appKey = ''; accessToken = ''; refreshToken = '';
  showScreen('setup');
});

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64url(arr);
}
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}
function base64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
    }),
  });
  if (!res.ok) {
    // Refresh token revoked or invalid — clear everything
    accessToken = '';
    refreshToken = '';
    await storage.remove(['accessToken', 'refreshToken']);
    throw new Error('Token refresh failed ' + res.status);
  }
  const data = await res.json();
  accessToken = data.access_token;
  await storage.set({ accessToken });
}

async function startAuth() {
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const state = Math.random().toString(36).slice(2);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  await storage.set({ oauthState: state });

  const authUrl = `https://www.dropbox.com/oauth2/authorize?` +
    `client_id=${encodeURIComponent(appKey)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256` +
    `&token_access_type=offline`;

  $('auth-error').textContent = '';

  // Start the local OAuth listener in Rust, then open the browser
  const listenPromise = invoke('oauth_listen', { port: OAUTH_PORT });
  await openUrl(authUrl);

  try {
    const resultPath = await listenPromise;
    // resultPath looks like "/callback?code=...&state=..."
    const params = new URLSearchParams(resultPath.split('?')[1] || '');
    const code = params.get('code');
    const retState = params.get('state');

    const stored = await storage.get(['oauthState']);
    if (retState !== stored.oauthState) throw new Error('State mismatch');
    if (!code) throw new Error('No authorization code returned');

    // Exchange authorization code for access + refresh tokens
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: appKey,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed ' + tokenRes.status);
    const tokenData = await tokenRes.json();

    accessToken  = tokenData.access_token;
    refreshToken = tokenData.refresh_token || '';
    await storage.set({ accessToken, refreshToken });
    await init();
  } catch(e) {
    $('auth-error').textContent = 'Auth failed: ' + (e.message || e);
  }
}

// ── Setup screen ──────────────────────────────────────────────────────────────
$('btn-save-key').addEventListener('click', async () => {
  const key = $('app-key-input').value.trim();
  if (!key) { $('setup-error').textContent = 'Please enter your app key'; return; }
  appKey = key;
  await storage.set({ appKey: key });
  showScreen('auth');
});
$('app-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-save-key').click(); });

// ── Toolbar buttons ───────────────────────────────────────────────────────────
$('btn-scan').addEventListener('click', () => {
  if (currentPath === HOME_PATH) showHome();
  else browseFolder(currentPath, true);
});
$('btn-clear-cache').addEventListener('click', async () => {
  if (!confirm('Clear all cached data? This will re-download everything.')) return;
  await invoke('store_clear_cache', { prefix: CACHE_KEY_PREFIX, thumbKey: THUMB_CACHE_KEY });
  await FaceScan.clearFaceData(storage);
  thumbCache = {};
  thumbCacheCount = 0;
  fullUrlCache = {};
  if (currentPath === HOME_PATH) showHome();
  else browseFolder(currentPath, true);
});
$('btn-up').addEventListener('click', () => {
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  const parent = parts.length ? '/' + parts.join('/') : '';
  if (isRootPath(parent)) {
    browseFolder(parent);
  } else if (getContainingRoot(parent)) {
    browseFolder(parent);
  } else {
    showHome();
  }
});
$('btn-logout').addEventListener('click', async () => {
  // Revoke the refresh token with Dropbox (best-effort)
  if (refreshToken) {
    fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    }).catch(() => {});
  }
  await storage.remove(['accessToken', 'refreshToken']);
  accessToken = '';
  refreshToken = '';
  showScreen('auth');
  $('btn-logout').style.display = 'none';
  $('account-name').textContent = 'Not connected';
});
loadMoreBtn.addEventListener('click', () => showMorePhotos());

// ── Infinite scroll (throttled) + scroll-to-top button ──────────────────────
const btnTop = $('btn-top');
btnTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
let _scrollTimer = null;
window.addEventListener('scroll', () => {
  btnTop.classList.toggle('visible', window.scrollY > 400);
  if (_scrollTimer) return;
  _scrollTimer = setTimeout(() => {
    _scrollTimer = null;
    if (displayCount >= filteredIndex.length) return;
    const scrollBottom = window.scrollY + window.innerHeight;
    const docHeight = document.body.scrollHeight;
    if (docHeight - scrollBottom < 400) {
      showMorePhotos();
    }
  }, 100);
});

// ── Year slider ───────────────────────────────────────────────────────────────
$('year-slider').addEventListener('input', () => {
  const val = parseInt($('year-slider').value);
  $('year-label').textContent = val === 0 ? 'All' : allYears[val - 1];
  resetAndShowPhotos();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// ── Face Scanning Integration ─────────────────────────────────────────────
function startFaceScanForCurrentFolder() {
  // Queue only likely camera photos (skip screenshots & graphics)
  const imagePaths = photoIndex
    .filter(p => isLikelyPhoto(p))
    .map(p => p.path_lower);
  if (imagePaths.length === 0) return;
  FaceScan.queuePhotosForScan(imagePaths, true);
}

// ── People View ──────────────────────────────────────────────────────────
let mergeMode = false;
let mergeSelected = new Set();

$('btn-people').addEventListener('click', () => {
  if (peopleMode && !peopleClusterId) {
    exitPeopleMode();
  } else {
    showPeopleView();
  }
});

// ── People Timelines View ─────────────────────────────────────────────────────
const DROPBOX_THUMB_SIZES = [
  { tag: 'w128h128',  px: 128 },
  { tag: 'w256h256',  px: 256 },
  { tag: 'w480h320',  px: 480 },
  { tag: 'w640h480',  px: 640 },
  { tag: 'w1024h768', px: 1024 },
];
let _timelineThumbCache = {};   // keyed by `${sizeTag}::${path}`
let _timelineCurrentSize = 160; // current slider value in px
let _peopleThumbSize = 140;     // people grid card size in px
let _clusterThumbSize = 120;    // cluster detail photo cell size in px

$('btn-timeline').addEventListener('click', () => {
  if (timelineMode) {
    exitPeopleMode();
  } else {
    showTimelineView();
  }
});

async function showTimelineView() {
  timelineMode = true;
  peopleMode = false;
  peopleClusterId = null;
  cleanupBulkSelection();
  btnTimeline.classList.add('active');
  btnPeople.classList.remove('active');

  photoGrid.style.display = 'none';
  folderList.style.display = 'none';
  loadMoreBtn.classList.remove('visible');
  $('year-slider-bar').classList.remove('visible');
  statusBar.classList.remove('visible');
  peopleView.classList.remove('visible');
  peopleView.innerHTML = '';
  document.querySelectorAll('.singles-grid').forEach(g => g.remove());

  timelineView.classList.add('visible');
  await buildPhotoDateMap();
  renderTimelineView();
}

function pickThumbSize(displayPx) {
  // Pick the smallest Dropbox thumb size that is >= displayPx for crisp rendering
  for (const s of DROPBOX_THUMB_SIZES) {
    if (s.px >= displayPx) return s;
  }
  return DROPBOX_THUMB_SIZES[DROPBOX_THUMB_SIZES.length - 1];
}

async function fetchTimelineThumb(path, sizeTag) {
  const cacheKey = sizeTag + '::' + path;
  if (_timelineThumbCache[cacheKey]) return _timelineThumbCache[cacheKey];
  // For the smallest size, use the existing thumbCache
  if (sizeTag === 'w128h128' && thumbCache[path]) {
    _timelineThumbCache[cacheKey] = thumbCache[path];
    return thumbCache[path];
  }
  try {
    const entries = [{ path, format: { '.tag': 'jpeg' }, size: { '.tag': sizeTag } }];
    const doFetch = () => fetch('https://content.dropboxapi.com/2/files/get_thumbnail_batch', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entries })
    });
    let res = await doFetch();
    if (res.status === 401 && refreshToken) {
      try { await refreshAccessToken(); } catch (_) {}
      res = await doFetch();
    }
    if (!res.ok) return thumbCache[path] || null;
    const data = await res.json();
    if (data.entries && data.entries[0] && data.entries[0].thumbnail) {
      const dataUrl = 'data:image/jpeg;base64,' + data.entries[0].thumbnail;
      _timelineThumbCache[cacheKey] = dataUrl;
      return dataUrl;
    }
  } catch (e) {
    console.error('[Timeline] Thumb fetch failed:', e);
  }
  return thumbCache[path] || null;
}

// Batch-fetch higher-quality thumbnails and apply to img elements
// entries: [{ path, img }]  — path is the Dropbox path, img is the DOM element to update
let _upgradeGeneration = 0; // incremented on each slider change to cancel stale batches
async function batchUpgradeThumbs(entries, sizeTag) {
  const gen = ++_upgradeGeneration;
  const BATCH = 25;
  for (let i = 0; i < entries.length; i += BATCH) {
    if (gen !== _upgradeGeneration) return; // newer slider event — abort this run
    const slice = entries.slice(i, i + BATCH);
    const apiEntries = slice.map(e => ({ path: e.path, format: { '.tag': 'jpeg' }, size: { '.tag': sizeTag } }));
    try {
      const doFetch = () => fetch('https://content.dropboxapi.com/2/files/get_thumbnail_batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entries: apiEntries })
      });
      let res = await doFetch();
      if (res.status === 401 && refreshToken) {
        try { await refreshAccessToken(); } catch (_) {}
        res = await doFetch();
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.entries) continue;
      for (let j = 0; j < slice.length; j++) {
        const entry = data.entries[j];
        if (entry?.['.tag'] === 'success' && entry.thumbnail) {
          const dataUrl = 'data:image/jpeg;base64,' + entry.thumbnail;
          _timelineThumbCache[sizeTag + '::' + slice[j].path] = dataUrl;
          slice[j].img.src = dataUrl;
        }
      }
    } catch (e) {
      console.error('[batchUpgrade] Batch failed:', e);
    }
  }
}

// Upgrade people grid face thumbnails to higher quality when slider increases
function upgradePeopleGridThumbs(displayPx) {
  const needed = pickThumbSize(displayPx);
  if (needed.tag === 'w128h128') return;
  const toUpgrade = [];
  const imgs = peopleView.querySelectorAll('.face-thumb');
  for (const img of imgs) {
    const path = img.dataset.thumbPath;
    if (!path) continue;
    const cacheKey = needed.tag + '::' + path;
    if (_timelineThumbCache[cacheKey]) {
      img.src = _timelineThumbCache[cacheKey];
    } else {
      toUpgrade.push({ path, img });
    }
  }
  if (toUpgrade.length > 0) batchUpgradeThumbs(toUpgrade, needed.tag);
}

// Upgrade cluster detail photo thumbnails to higher quality when slider increases
function upgradeClusterDetailThumbs(displayPx) {
  const needed = pickThumbSize(displayPx);
  if (needed.tag === 'w128h128') return;
  const toUpgrade = [];
  const cells = photoGrid.querySelectorAll('.photo-cell');
  for (const cell of cells) {
    const path = cell.dataset.thumbPath;
    if (!path) continue;
    const img = cell.querySelector('img');
    if (!img) continue;
    const cacheKey = needed.tag + '::' + path;
    if (_timelineThumbCache[cacheKey]) {
      img.src = _timelineThumbCache[cacheKey];
    } else {
      toUpgrade.push({ path, img });
    }
  }
  if (toUpgrade.length > 0) batchUpgradeThumbs(toUpgrade, needed.tag);
}

function buildTimelineData(clusterId) {
  const clusters = FaceScan.getClusters();
  const cluster = clusters.find(c => c.id === clusterId);
  if (!cluster) return [];
  const fd = FaceScan.getFaceData();

  // For each photo, get its best face score and date
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthMap = new Map(); // 'YYYY-MM' → { year, month, photo, score, path }

  for (const photoPath of cluster.photos) {
    const ts = photoDateMap[photoPath] || 0;
    if (!ts) continue;
    const dt = new Date(ts);
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const key = y + '-' + String(m).padStart(2, '0');

    // Get best face score for this photo in this cluster
    const faces = fd.photos[photoPath];
    let bestScore = 0;
    if (faces && faces.length > 0) {
      for (const f of faces) {
        if (f.score > bestScore) bestScore = f.score;
      }
    }

    const existing = monthMap.get(key);
    if (!existing || bestScore > existing.score) {
      monthMap.set(key, {
        year: y,
        month: m,
        monthName: MONTH_NAMES[m],
        score: bestScore,
        path: photoPath,
        entry: photoIndex.find(p => p.path_lower === photoPath)
      });
    }
  }

  // Sort by date ascending (oldest first for timeline)
  const sorted = [...monthMap.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  // Group by year
  const yearGroups = [];
  let curYear = null;
  let curGroup = null;
  for (const item of sorted) {
    if (item.year !== curYear) {
      curYear = item.year;
      curGroup = { year: curYear, months: [] };
      yearGroups.push(curGroup);
    }
    curGroup.months.push(item);
  }
  return yearGroups;
}

function renderTimelineView(selectedClusterId) {
  timelineView.innerHTML = '';

  // Get named clusters sorted alphabetically
  const clusters = FaceScan.getClusters()
    .filter(c => c.name && c.name.trim())
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  if (clusters.length === 0) {
    timelineView.innerHTML = '<div class="timeline-empty">No named people found. Go to People view and name some face clusters first.</div>';
    return;
  }

  // Controls bar
  const controls = document.createElement('div');
  controls.className = 'timeline-controls';

  const label = document.createElement('label');
  label.textContent = 'Person:';
  controls.appendChild(label);

  const select = document.createElement('select');
  select.id = 'timeline-person-select';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '— Select a person —';
  select.appendChild(defaultOpt);
  for (const c of clusters) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.photoCount} photos)`;
    if (c.id === selectedClusterId) opt.selected = true;
    select.appendChild(opt);
  }
  controls.appendChild(select);

  // Spacer
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  controls.appendChild(spacer);

  // Size slider
  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Size:';
  controls.appendChild(sizeLabel);

  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '80';
  sizeSlider.max = '400';
  sizeSlider.step = '20';
  sizeSlider.value = String(_timelineCurrentSize);
  controls.appendChild(sizeSlider);

  const sizeValue = document.createElement('span');
  sizeValue.className = 'timeline-size-label';
  sizeValue.textContent = _timelineCurrentSize + 'px';
  controls.appendChild(sizeValue);

  timelineView.appendChild(controls);

  // Content container
  const content = document.createElement('div');
  content.id = 'timeline-content';
  timelineView.appendChild(content);

  if (selectedClusterId) {
    renderTimelineContent(content, selectedClusterId, _timelineCurrentSize);
  } else {
    content.innerHTML = '<div class="timeline-empty">Select a person from the dropdown to see their photo timeline.</div>';
  }

  // Event: person changed
  select.addEventListener('change', () => {
    const cid = select.value;
    const cnt = document.getElementById('timeline-content');
    if (!cid) {
      cnt.innerHTML = '<div class="timeline-empty">Select a person from the dropdown to see their photo timeline.</div>';
      return;
    }
    renderTimelineContent(cnt, cid, parseInt(sizeSlider.value, 10));
  });

  // Event: size changed — resize immediately, batch-fetch on release
  sizeSlider.addEventListener('input', () => {
    const px = Number.parseInt(sizeSlider.value, 10);
    _timelineCurrentSize = px;
    sizeValue.textContent = px + 'px';
    // Resize existing images instantly via CSS
    const imgs = document.querySelectorAll('.timeline-month-card img');
    const lbls = document.querySelectorAll('.timeline-month-card .month-label');
    for (const img of imgs) { img.style.width = px + 'px'; img.style.height = px + 'px'; }
    for (const lbl of lbls) { lbl.style.width = px + 'px'; }
  });
  sizeSlider.addEventListener('change', () => {
    const px = _timelineCurrentSize;
    const cid = select.value;
    if (cid) {
      upgradeTimelineThumbs(px);
    }
  });
}

function renderTimelineContent(container, clusterId, thumbPx) {
  container.innerHTML = '';
  const yearGroups = buildTimelineData(clusterId);
  if (yearGroups.length === 0) {
    container.innerHTML = '<div class="timeline-empty">No dated photos found for this person.</div>';
    return;
  }

  const sizeInfo = pickThumbSize(thumbPx);
  const frag = document.createDocumentFragment();

  for (const yg of yearGroups) {
    const yearDiv = document.createElement('div');
    yearDiv.className = 'timeline-year-group';

    const yearLabel = document.createElement('div');
    yearLabel.className = 'timeline-year-label';
    yearLabel.textContent = yg.year;
    yearDiv.appendChild(yearLabel);

    const monthsDiv = document.createElement('div');
    monthsDiv.className = 'timeline-months';

    for (const m of yg.months) {
      const card = document.createElement('div');
      card.className = 'timeline-month-card';
      card.title = `${m.monthName} ${m.year} — score: ${m.score.toFixed(2)}`;

      const img = document.createElement('img');
      img.style.width = thumbPx + 'px';
      img.style.height = thumbPx + 'px';
      img.dataset.thumbPath = m.path;
      // Use existing low-res thumb as placeholder
      if (thumbCache[m.path]) {
        img.src = thumbCache[m.path];
      }
      // Load appropriate quality thumb
      const cacheKey = sizeInfo.tag + '::' + m.path;
      if (_timelineThumbCache[cacheKey]) {
        img.src = _timelineThumbCache[cacheKey];
      }
      card.appendChild(img);

      const lbl = document.createElement('div');
      lbl.className = 'month-label';
      lbl.style.width = thumbPx + 'px';
      lbl.textContent = m.monthName;
      card.appendChild(lbl);

      // Click to open lightbox at that photo
      card.addEventListener('click', () => {
        if (m.entry) {
          const idx = filteredIndex.indexOf(m.entry);
          if (idx >= 0) {
            openLightbox(idx);
          } else {
            // Put it in filtered so lightbox works
            filteredIndex = [m.entry];
            openLightbox(0);
          }
        }
      });

      monthsDiv.appendChild(card);
    }

    yearDiv.appendChild(monthsDiv);
    frag.appendChild(yearDiv);
  }
  container.appendChild(frag);

  // Batch-fetch any thumbnails not already cached
  upgradeTimelineThumbs(thumbPx);
}

// Upgrade all timeline card images to higher quality via batch API
function upgradeTimelineThumbs(displayPx) {
  const needed = pickThumbSize(displayPx);
  if (needed.tag === 'w128h128') return;
  const toUpgrade = [];
  const imgs = document.querySelectorAll('.timeline-month-card img');
  for (const img of imgs) {
    const path = img.dataset.thumbPath;
    if (!path) continue;
    const cacheKey = needed.tag + '::' + path;
    if (_timelineThumbCache[cacheKey]) {
      img.src = _timelineThumbCache[cacheKey];
    } else {
      toUpgrade.push({ path, img });
    }
  }
  if (toUpgrade.length > 0) batchUpgradeThumbs(toUpgrade, needed.tag);
}

async function showPeopleView() {
  peopleMode = true;
  peopleClusterId = null;
  cleanupBulkSelection();
  mergeMode = false;
  mergeSelected.clear();
  btnPeople.classList.add('active');
  // Exit timeline if active
  timelineMode = false;
  btnTimeline.classList.remove('active');
  timelineView.classList.remove('visible');
  timelineView.innerHTML = '';
  document.querySelectorAll('.singles-grid').forEach(g => g.remove());
  document.querySelectorAll('.people-header').forEach(h => h.remove());
  const sliderRow2 = document.getElementById('cluster-size-slider-row');
  if (sliderRow2) sliderRow2.remove();
  photoGrid.style.removeProperty('--cell-size');

  photoGrid.style.display = 'none';
  folderList.style.display = 'none';
  loadMoreBtn.classList.remove('visible');
  $('year-slider-bar').classList.remove('visible');
  statusBar.classList.remove('visible');

  peopleView.classList.add('visible');
  await buildPhotoDateMap();
  renderPeopleGrid();
}

function exitPeopleMode() {
  flushFaceDataSave(); // persist any pending saves before leaving
  invalidateFilteredCache();
  peopleMode = false;
  timelineMode = false;
  peopleClusterId = null;
  cleanupBulkSelection();
  btnPeople.classList.remove('active');
  btnTimeline.classList.remove('active');

  // Restore photoIndex to the folder-specific version
  if (savedPhotoIndex !== null) {
    photoIndex = savedPhotoIndex;
    savedPhotoIndex = null;
  }

  peopleView.classList.remove('visible');
  peopleView.innerHTML = '';
  timelineView.classList.remove('visible');
  timelineView.innerHTML = '';
  document.querySelectorAll('.singles-grid').forEach(g => g.remove());
  document.querySelectorAll('.people-header').forEach(h => h.remove());
  const exitSliderRow = document.getElementById('cluster-size-slider-row');
  if (exitSliderRow) exitSliderRow.remove();
  photoGrid.style.removeProperty('--cell-size');
  photoGrid.style.display = '';
  folderList.style.display = '';

  // Restore normal view
  if (currentPath === HOME_PATH) {
    showHome();
  } else {
    resetAndShowPhotos();
    buildYearSlider();
    updateStatus();
  }
}

function renderPeopleGrid() {
  const clusters = FaceScan.getClusters();
  const scannedCount = FaceScan.getScannedCount();
  let totalImages = 0;
  for (const p of photoIndex) { if (isLikelyPhoto(p)) totalImages++; }

  // Pre-compute thumbs for all clusters in a single pass
  const clusterThumbs = new Map();
  const clusterThumbPaths = new Map();
  let visibleCount = 0;
  for (const c of clusters) {
    const result = getClusterThumb(c);
    if (result.thumb) { clusterThumbs.set(c.id, result.thumb); clusterThumbPaths.set(c.id, result.path); visibleCount++; }
  }
  peopleView.innerHTML = '';

  // Header with scan + merge buttons
  const header = document.createElement('div');
  header.className = 'people-header';

  const headerLeft = document.createElement('div');
  headerLeft.innerHTML = `
    <div class="people-title">\ud83d\udc64 People</div>
    <div class="people-subtitle">${visibleCount} ${visibleCount === 1 ? 'person' : 'people'} found \u00b7 ${scannedCount} of ${totalImages} photos scanned</div>
  `;
  header.appendChild(headerLeft);

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;gap:8px;align-items:center;';

  if (totalImages > 0) {
    if (FaceScan.isScanning()) {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn-primary';
      stopBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
      stopBtn.textContent = '\u23f9 Stop Scan';
      stopBtn.addEventListener('click', () => {
        FaceScan.abortScanning();
        renderPeopleGrid();
      });
      headerRight.appendChild(stopBtn);
    } else if (scannedCount > 0) {
      // "Rescan All" — re-detect faces on all photos, keeping clusters/names/exclusions
      const rescanBtn = document.createElement('button');
      rescanBtn.className = 'btn-people';
      rescanBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
      rescanBtn.textContent = '\ud83d\udd04 Rescan All';
      rescanBtn.addEventListener('click', () => {
        if (!confirm('This will re-scan every photo for faces. Your people names, merges, and removals will be preserved. Continue?')) return;
        FaceScan.resetScanData(storage).then(() => {
          startFaceScanForCurrentFolder();
          renderPeopleGrid();
        });
      });
      headerRight.appendChild(rescanBtn);
    }
  }

  // "Re-cluster" — re-run clustering algorithm on existing face data (show when clusters exist)
  if (visibleCount > 0 && !FaceScan.isScanning()) {
    const reclusterBtn = document.createElement('button');
    reclusterBtn.className = 'btn-people';
    reclusterBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
    reclusterBtn.textContent = '\ud83d\udd00 Re-cluster';
    reclusterBtn.addEventListener('click', async () => {
      if (!confirm('This will re-group all detected faces into people using the clustering algorithm. Names will be preserved where possible. Continue?')) return;
      reclusterBtn.disabled = true;
      reclusterBtn.textContent = '\u23f3 Clustering\u2026';
      await new Promise(r => setTimeout(r, 50));
      await FaceScan.rebuildClusters();
      await FaceScan.saveFaceData(storage);
      renderPeopleGrid();
    });
    headerRight.appendChild(reclusterBtn);
  }

  // "Refine Small" — rescan & recluster all unnamed clusters with < 10 photos
  if (visibleCount > 0 && !FaceScan.isScanning()) {
    const smallCount = clusters.filter(c => !c.name && c.photoCount < 10).length;
    if (smallCount > 0) {
      const refineBtn = document.createElement('button');
      refineBtn.className = 'btn-people';
      refineBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
      refineBtn.textContent = `\ud83e\udea9 Refine Small (${smallCount})`;
      refineBtn.addEventListener('click', async () => {
        if (!confirm(`This will re-scan and re-cluster ${smallCount} unnamed clusters with fewer than 10 photos. Faces will be reassigned to the best matching person. Continue?`)) return;
        refineBtn.disabled = true;
        refineBtn.textContent = '\u23f3 Scanning\u2026';
        await new Promise(r => setTimeout(r, 50));
        try {
          const result = await FaceScan.rescanSmallClusters(10, (done, total, faces) => {
            refineBtn.textContent = `\u23f3 ${done}/${total} (${faces} faces)`;
          });
          alert(`Refined ${result.clusters} clusters: ${result.scanned} photos rescanned, ${result.faces} faces found.`);
        } catch (err) {
          console.error('[refineSmall] Error:', err);
          alert('Refine failed: ' + err.message);
        }
        renderPeopleGrid();
      });
      headerRight.appendChild(refineBtn);
    }
  }

  // Merge toggle button (only when 2+ visible clusters exist)
  if (visibleCount >= 2) {
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'btn-people';
    mergeBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
    mergeBtn.textContent = mergeMode ? '\u2716 Cancel Merge' : '\ud83d\udd17 Merge People';
    mergeBtn.addEventListener('click', () => {
      mergeMode = !mergeMode;
      mergeSelected.clear();
      renderPeopleGrid();
    });
    headerRight.appendChild(mergeBtn);
  }

  header.appendChild(headerRight);
  peopleView.appendChild(header);

  // Merge action bar (shown during merge mode)
  if (mergeMode) {
    const bar = document.createElement('div');
    bar.className = 'merge-bar';
    bar.innerHTML = `
      <div class="merge-info">Select 2 or more people to merge them into one. The first selected keeps the name.</div>
      <div class="merge-actions">
        <button class="btn-people" id="merge-confirm-btn" disabled>Merge Selected (0)</button>
      </div>
    `;
    peopleView.appendChild(bar);
  }

  // Size slider
  const sliderRow = document.createElement('div');
  sliderRow.className = 'size-slider-row';
  sliderRow.innerHTML = `
    <label>Size</label>
    <input type="range" min="80" max="300" step="10" value="${_peopleThumbSize}">
    <span class="size-value">${_peopleThumbSize}px</span>
  `;
  peopleView.appendChild(sliderRow);
  const pSlider = sliderRow.querySelector('input[type="range"]');
  const pLabel = sliderRow.querySelector('.size-value');
  pSlider.addEventListener('input', () => {
    const px = Number.parseInt(pSlider.value);
    _peopleThumbSize = px;
    pLabel.textContent = px + 'px';
    peopleView.style.setProperty('--people-thumb-size', px + 'px');
  });
  pSlider.addEventListener('change', () => {
    upgradePeopleGridThumbs(_peopleThumbSize);
  });
  peopleView.style.setProperty('--people-thumb-size', _peopleThumbSize + 'px');

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:40px;color:#555;font-size:13px;';
    if (FaceScan.isScanning()) {
      empty.textContent = 'Scanning faces\u2026 People will appear here as thumbnails load.';
    } else if (scannedCount === 0) {
      empty.innerHTML = 'No photos have been scanned yet.<br>Click <strong>\ud83d\udd0d Scan Faces</strong> above to start face detection using full-resolution images.';
    } else {
      empty.textContent = 'No faces detected in the scanned photos.';
    }
    peopleView.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'people-grid' + (mergeMode ? ' merge-mode' : '');

  // Sort: named clusters first (alphabetical), then unnamed (by photo count desc)
  const sorted = [...clusters].sort((a, b) => {
    const aName = a.name ? a.name.toLowerCase() : '';
    const bName = b.name ? b.name.toLowerCase() : '';
    if (aName && !bName) return -1;
    if (!aName && bName) return 1;
    if (aName && bName) return aName.localeCompare(bName);
    return b.photoCount - a.photoCount;
  });

  // Separate singles (unnamed 1-photo clusters) from the rest
  const singles = [];
  const regulars = [];
  for (const cluster of sorted) {
    const thumb = clusterThumbs.get(cluster.id);
    if (!thumb) continue;
    if (!cluster.name && cluster.photoCount === 1) {
      singles.push(cluster);
    } else {
      regulars.push(cluster);
    }
  }

  for (const cluster of regulars) {
    const thumb = clusterThumbs.get(cluster.id);

    const card = document.createElement('div');
    card.className = 'person-card' + (cluster.name ? ' named' : '') + (mergeSelected.has(cluster.id) ? ' selected' : '');
    card.dataset.clusterId = cluster.id;

    // Merge checkbox overlay
    const check = document.createElement('div');
    check.className = 'merge-check';
    check.textContent = mergeSelected.has(cluster.id) ? '\u2713' : '';
    card.appendChild(check);

    const img = document.createElement('img');
    img.className = 'face-thumb';
    img.src = thumb;
    img.alt = cluster.name || 'Unknown person';
    img.dataset.thumbPath = clusterThumbPaths.get(cluster.id) || '';
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'person-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'person-name';
    nameEl.textContent = cluster.name || 'Unknown';
    info.appendChild(nameEl);

    const countEl = document.createElement('div');
    countEl.className = 'person-count';
    countEl.textContent = cluster.photoCount + ' photo' + (cluster.photoCount !== 1 ? 's' : '');
    info.appendChild(countEl);

    card.appendChild(info);

    // Rename hint
    const hintEl = document.createElement('div');
    hintEl.className = 'rename-hint';
    hintEl.textContent = '\u270f\ufe0f tap to name';
    hintEl.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenameCluster(card, cluster.id, nameEl);
    });
    card.appendChild(hintEl);

    if (mergeMode) {
      card.addEventListener('click', () => {
        if (mergeSelected.has(cluster.id)) {
          mergeSelected.delete(cluster.id);
        } else {
          mergeSelected.add(cluster.id);
        }
        renderPeopleGrid();
      });
    } else {
      card.addEventListener('click', () => showPersonPhotos(cluster.id));
    }

    grid.appendChild(card);
  }

  // Add a "Singles" card grouping all unnamed 1-photo clusters
  if (singles.length > 0 && !mergeMode) {
    const card = document.createElement('div');
    card.className = 'person-card singles-card';

    // Mosaic of up to 4 thumbnails
    const mosaic = document.createElement('div');
    mosaic.className = 'singles-mosaic';
    const shown = singles.slice(0, 4);
    for (const s of shown) {
      const img = document.createElement('img');
      img.src = clusterThumbs.get(s.id);
      img.alt = 'Single';
      mosaic.appendChild(img);
    }
    card.appendChild(mosaic);

    const info = document.createElement('div');
    info.className = 'person-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'person-name';
    nameEl.textContent = 'Singles';
    info.appendChild(nameEl);
    const countEl = document.createElement('div');
    countEl.className = 'person-count';
    countEl.textContent = `${singles.length} people \u00b7 1 photo each`;
    info.appendChild(countEl);
    card.appendChild(info);

    card.addEventListener('click', () => showSinglesView(singles));
    grid.appendChild(card);
  }

  peopleView.appendChild(grid);

  // Wire up merge confirm button
  if (mergeMode) {
    const confirmBtn = document.getElementById('merge-confirm-btn');
    confirmBtn.textContent = `Merge Selected (${mergeSelected.size})`;
    confirmBtn.disabled = mergeSelected.size < 2;
    if (!confirmBtn.disabled) {
      confirmBtn.style.background = '#0061fe';
      confirmBtn.style.color = '#fff';
      confirmBtn.style.borderColor = '#0061fe';
    }
    confirmBtn.addEventListener('click', async () => {
      if (mergeSelected.size < 2) return;
      const ids = [...mergeSelected];
      const keepId = ids[0]; // first selected keeps the name
      for (let i = 1; i < ids.length; i++) {
        FaceScan.mergeClusters(keepId, ids[i]);
      }
      mergeMode = false;
      mergeSelected.clear();
      renderPeopleGrid();
      FaceScan.saveFaceData(storage);
    });
  }

  // Upgrade thumbnails if slider is above base size
  if (_peopleThumbSize > 128) {
    upgradePeopleGridThumbs(_peopleThumbSize);
  }
}

// ── Multi-select helpers for person detail view ──────────────────────────────
function togglePhotoSelection(photoPath, wrap) {
  if (selectedPhotoPaths.has(photoPath)) {
    selectedPhotoPaths.delete(photoPath);
    wrap.classList.remove('selected');
  } else {
    selectedPhotoPaths.add(photoPath);
    wrap.classList.add('selected');
  }
  updateBulkActionBar();
}

function updateBulkActionBar() {
  let bar = document.querySelector('.bulk-action-bar');
  if (selectedPhotoPaths.size === 0) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bulk-action-bar';
    document.body.appendChild(bar);
  }
  const n = selectedPhotoPaths.size;
  bar.innerHTML = '';

  const count = document.createElement('span');
  count.className = 'bulk-count';
  count.textContent = `${n} selected`;
  bar.appendChild(count);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.className = 'bulk-btn';
  selectAllBtn.textContent = 'Select All';
  selectAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.photo-cell-wrap').forEach(w => {
      const path = w.dataset.photoPath;
      if (path) { selectedPhotoPaths.add(path); w.classList.add('selected'); }
    });
    updateBulkActionBar();
  });
  bar.appendChild(selectAllBtn);

  const deselectBtn = document.createElement('button');
  deselectBtn.className = 'bulk-btn';
  deselectBtn.textContent = 'Deselect All';
  deselectBtn.addEventListener('click', () => {
    selectedPhotoPaths.clear();
    document.querySelectorAll('.photo-cell-wrap.selected').forEach(w => w.classList.remove('selected'));
    updateBulkActionBar();
  });
  bar.appendChild(deselectBtn);

  const spacer = document.createElement('div');
  spacer.className = 'bulk-spacer';
  bar.appendChild(spacer);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'bulk-btn danger';
  removeBtn.textContent = `Remove (${n})`;
  removeBtn.addEventListener('click', async () => {
    if (!peopleClusterId) return;
    for (const p of selectedPhotoPaths) {
      FaceScan.removePhotoFromCluster(peopleClusterId, p);
    }
    // Update UI immediately, save in background
    const removedPaths = [...selectedPhotoPaths];
    document.querySelectorAll('.photo-cell-wrap.selected').forEach(w => w.remove());
    selectedPhotoPaths.clear();
    updateBulkActionBar();
    syncAfterRemoval(removedPaths);
    const updated = FaceScan.getClusters().find(c => c.id === peopleClusterId);
    const sub = document.querySelector('.people-subtitle');
    if (updated && sub) {
      sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 click photos to select`;
    }
    scheduleFaceDataSave(true);
  });
  bar.appendChild(removeBtn);

  const moveBtn = document.createElement('button');
  moveBtn.className = 'bulk-btn primary';
  moveBtn.textContent = `Move (${n})`;
  moveBtn.addEventListener('click', () => {
    if (!peopleClusterId) return;
    showBulkReassignModal(peopleClusterId, [...selectedPhotoPaths]);
  });
  bar.appendChild(moveBtn);

  const dlBtn = document.createElement('button');
  dlBtn.className = 'bulk-btn download';
  dlBtn.textContent = `\u2B07 Download (${n})`;
  dlBtn.addEventListener('click', async () => {
    dlBtn.textContent = '\u23F3 Downloading\u2026';
    dlBtn.disabled = true;
    await downloadSelectedAsZip();
    dlBtn.textContent = `\u2B07 Download (${selectedPhotoPaths.size})`;
    dlBtn.disabled = false;
  });
  bar.appendChild(dlBtn);
}

function cleanupBulkSelection() {
  selectedPhotoPaths.clear();
  const bar = document.querySelector('.bulk-action-bar');
  if (bar) bar.remove();
}

function createPersonPhotoWrap(photoEntry, gridIdx, clusterId) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-cell-wrap';
  wrap.dataset.photoPath = photoEntry.path_lower;
  wrap.dataset.clusterId = clusterId;
  if (selectedPhotoPaths.has(photoEntry.path_lower)) wrap.classList.add('selected');

  // Selection checkbox (handled by delegated event on photoGrid)
  const checkbox = document.createElement('div');
  checkbox.className = 'select-checkbox';
  checkbox.textContent = '\u2713';
  wrap.appendChild(checkbox);

  const cell = document.createElement('div');
  cell.className = 'photo-cell';
  cell.dataset.idx = gridIdx;
  cell.dataset.thumbPath = photoEntry.path_lower;

  const cached = thumbCache[photoEntry.path_lower];
  if (cached) {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = photoEntry.name;
    cell.appendChild(img);
  }
  wrap.appendChild(cell);

  // Action bar (buttons handled by delegated event on photoGrid)
  const actionBar = document.createElement('div');
  actionBar.className = 'photo-action-bar';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'photo-action-btn';
  removeBtn.title = 'Remove from this person';
  removeBtn.textContent = '\u2716';
  removeBtn.dataset.action = 'remove';
  actionBar.appendChild(removeBtn);

  const moveBtn = document.createElement('button');
  moveBtn.className = 'photo-action-btn move-btn';
  moveBtn.title = 'Move to a different person';
  moveBtn.textContent = '\u27a1';
  moveBtn.dataset.action = 'move';
  actionBar.appendChild(moveBtn);

  const posterBtn = document.createElement('button');
  posterBtn.className = 'photo-action-btn poster-btn';
  posterBtn.title = 'Set as collection poster';
  posterBtn.textContent = '\u2b50';
  posterBtn.dataset.action = 'poster';
  actionBar.appendChild(posterBtn);

  wrap.appendChild(actionBar);
  return { wrap, cell };
}

// ── Delegated click handler for person photo grid ────────────────────────────
// One listener handles all clicks instead of 6+ listeners per photo cell.
photoGrid.addEventListener('click', async (e) => {
  if (!peopleClusterId) return;

  const wrap = e.target.closest('.photo-cell-wrap');
  if (!wrap) return;

  const photoPath = wrap.dataset.photoPath;
  const clusterId = wrap.dataset.clusterId;

  // Checkbox click
  if (e.target.closest('.select-checkbox')) {
    e.stopPropagation();
    togglePhotoSelection(photoPath, wrap);
    return;
  }

  // Action button clicks
  const actionBtn = e.target.closest('.photo-action-btn');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;

    if (action === 'remove') {
      FaceScan.removePhotoFromCluster(clusterId, photoPath);
      wrap.remove();
      syncAfterRemoval([photoPath]);
      const updated = FaceScan.getClusters().find(c => c.id === clusterId);
      const sub = document.querySelector('.people-subtitle');
      if (updated && sub) {
        sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 click photos to select`;
      }
      scheduleFaceDataSave(true);
    } else if (action === 'move') {
      showReassignModal(clusterId, photoPath, wrap);
    } else if (action === 'poster') {
      FaceScan.setClusterPoster(clusterId, photoPath);
      actionBtn.textContent = '\u2713';
      setTimeout(() => { actionBtn.textContent = '\u2b50'; }, 1000);
      scheduleFaceDataSave(true);
    }
    return;
  }

  // Photo cell click → lightbox
  const cell = e.target.closest('.photo-cell');
  if (cell && cell.dataset.idx !== undefined) {
    openLightbox(Number.parseInt(cell.dataset.idx, 10));
  }
});

// ── Singles view — grid of all unnamed 1-photo clusters ─────────────────────
function showSinglesView(singles) {
  peopleClusterId = '__singles__';
  peopleView.classList.remove('visible');
  photoGrid.style.display = 'none';
  loadMoreBtn.classList.remove('visible');

  // Remove any existing people-header from top-bars
  document.querySelectorAll('.people-header').forEach(h => h.remove());

  const header = document.createElement('div');
  header.className = 'people-header';

  const headerLeft = document.createElement('div');
  headerLeft.innerHTML = `
    <div class="people-title">\ud83d\udc64 Singles</div>
    <div class="people-subtitle">${singles.length} people with only 1 photo each</div>
  `;
  header.appendChild(headerLeft);

  const backBtn = document.createElement('button');
  backBtn.className = 'people-back';
  backBtn.textContent = '\u2190 Back to People';
  backBtn.addEventListener('click', () => {
    header.remove();
    singlesGrid.remove();
    showPeopleView();
  });
  header.appendChild(backBtn);

  document.getElementById('top-bars').appendChild(header);

  const singlesGrid = document.createElement('div');
  singlesGrid.className = 'people-grid singles-grid';

  for (const cluster of singles) {
    const thumb = getClusterThumb(cluster).thumb;
    if (!thumb) continue;

    const card = document.createElement('div');
    card.className = 'person-card';
    card.dataset.clusterId = cluster.id;

    const img = document.createElement('img');
    img.className = 'face-thumb';
    img.src = thumb;
    img.alt = 'Unknown person';
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'person-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'person-name';
    nameEl.textContent = 'Unknown';
    info.appendChild(nameEl);
    const countEl = document.createElement('div');
    countEl.className = 'person-count';
    countEl.textContent = '1 photo';
    info.appendChild(countEl);
    card.appendChild(info);

    // Rename hint
    const hintEl = document.createElement('div');
    hintEl.className = 'rename-hint';
    hintEl.textContent = '\u270f\ufe0f tap to name';
    hintEl.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenameCluster(card, cluster.id, nameEl);
    });
    card.appendChild(hintEl);

    card.addEventListener('click', () => showPersonPhotos(cluster.id));
    singlesGrid.appendChild(card);
  }

  // Insert the grid right after peopleView in the DOM
  peopleView.parentNode.insertBefore(singlesGrid, peopleView.nextSibling);
}

function showPersonPhotos(clusterId) {
  invalidateFilteredCache();
  peopleClusterId = clusterId;
  selectedPhotoPaths.clear();
  const cluster = FaceScan.getClusters().find(c => c.id === clusterId);
  if (!cluster) return;

  const clusterPhotoPaths = new Set(cluster.photos);

  peopleView.classList.remove('visible');
  document.querySelectorAll('.singles-grid').forEach(g => g.remove());
  photoGrid.style.display = '';
  photoGrid.innerHTML = '';
  loadMoreBtn.classList.remove('visible');
  document.querySelectorAll('.people-header').forEach(h => h.remove());
  const existingSliderRow = document.getElementById('cluster-size-slider-row');
  if (existingSliderRow) existingSliderRow.remove();
  photoGrid.style.removeProperty('--cell-size');

  // Header bar for person view
  const header = document.createElement('div');
  header.className = 'people-header';

  const headerLeftDiv = document.createElement('div');
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;gap:10px;';

  const titleEl = document.createElement('div');
  titleEl.className = 'people-title';
  titleEl.textContent = cluster.name || 'Unknown Person';
  titleRow.appendChild(titleEl);

  // Inline rename button
  const renameBtn = document.createElement('button');
  renameBtn.className = 'btn-people';
  renameBtn.style.cssText = 'font-size:10px;padding:3px 8px;';
  renameBtn.textContent = '\u270f\ufe0f Rename';
  renameBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.style.cssText = 'background:#0f0f10;border:1px solid #0061fe;border-radius:4px;color:#e8e6e0;font-size:14px;padding:2px 6px;width:200px;';
    input.value = cluster.name || '';
    input.placeholder = 'Enter name\u2026';
    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();
    const finish = () => {
      const newName = input.value.trim();
      FaceScan.renameCluster(clusterId, newName);
      titleEl.textContent = newName || 'Unknown Person';
      FaceScan.saveFaceData(storage);
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = cluster.name || ''; input.blur(); }
    });
  });
  titleRow.appendChild(renameBtn);

  // Re-cluster button for this specific collection
  const reclusterBtn = document.createElement('button');
  reclusterBtn.className = 'btn-people';
  reclusterBtn.style.cssText = 'font-size:10px;padding:3px 8px;';
  reclusterBtn.textContent = '\ud83d\udd00 Re-cluster';
  reclusterBtn.addEventListener('click', async () => {
    console.log('[recluster] button clicked, clusterId=', clusterId);
    if (!confirm('This will find outlier faces in this collection and move them to better-matching people. Continue?')) return;
    reclusterBtn.disabled = true;
    reclusterBtn.textContent = '\u23f3 Clustering\u2026';
    await new Promise(r => setTimeout(r, 50));
    try {
      const result = await FaceScan.reclusterCollection(clusterId);
      console.log('[recluster] result:', result);
      if (result.needsScan) {
        alert('Face scan data is missing for this collection. Use the "Rescan Faces" button first, then try Re-cluster.');
        reclusterBtn.textContent = '\ud83d\udd00 Re-cluster';
        reclusterBtn.disabled = false;
        return;
      }
      await FaceScan.saveFaceData(storage);
      if (result.moved === 0) {
        reclusterBtn.textContent = '\u2714 No outliers found';
        reclusterBtn.disabled = false;
        setTimeout(() => { reclusterBtn.textContent = '\ud83d\udd00 Re-cluster'; }, 2000);
      } else if (result.clusterId) {
        alert(`Moved ${result.moved} photo${result.moved !== 1 ? 's' : ''} out, kept ${result.kept}.`);
        showPersonPhotos(result.clusterId);
      } else {
        alert(`All ${result.moved} photos were moved to other collections.`);
        showPeopleView();
      }
    } catch (err) {
      console.error('[recluster] ERROR:', err);
      alert('Re-cluster failed: ' + err.message);
      reclusterBtn.textContent = '\ud83d\udd00 Re-cluster';
      reclusterBtn.disabled = false;
    }
  });
  titleRow.appendChild(reclusterBtn);

  // Rescan button — re-detect faces for this collection's photos
  const rescanBtn = document.createElement('button');
  rescanBtn.className = 'btn-people';
  rescanBtn.style.cssText = 'font-size:10px;padding:3px 8px;';
  rescanBtn.textContent = '\uD83D\uDD04 Rescan Faces';
  rescanBtn.addEventListener('click', async () => {
    if (!confirm(`This will re-download and re-detect faces for all ${cluster.photoCount} photos in this collection. This may take a while. Continue?`)) return;
    rescanBtn.disabled = true;
    reclusterBtn.disabled = true;
    rescanBtn.textContent = '\u23F3 0/' + cluster.photoCount;
    try {
      const result = await FaceScan.rescanCollection(clusterId, (done, total, faces) => {
        rescanBtn.textContent = `\u23F3 ${done}/${total} (${faces} faces)`;
      });
      alert(`Rescan complete: ${result.scanned} photos scanned, ${result.faces} faces found.`);
      showPersonPhotos(clusterId);
    } catch (err) {
      console.error('[rescan] ERROR:', err);
      alert('Rescan failed: ' + err.message);
      rescanBtn.textContent = '\uD83D\uDD04 Rescan Faces';
      rescanBtn.disabled = false;
      reclusterBtn.disabled = false;
    }
  });
  titleRow.appendChild(rescanBtn);

  // 🔗 Merge button
  const mergeBtn2 = document.createElement('button');
  mergeBtn2.className = 'btn-people';
  mergeBtn2.style.cssText = 'font-size:10px;padding:3px 8px;';
  mergeBtn2.textContent = '\uD83D\uDD17 Merge';
  mergeBtn2.addEventListener('click', () => showMergeIntoModal(clusterId));
  titleRow.appendChild(mergeBtn2);

  // ⬇ Download All button
  const downloadAllBtn = document.createElement('button');
  downloadAllBtn.className = 'btn-people';
  downloadAllBtn.style.cssText = 'font-size:10px;padding:3px 8px;';
  downloadAllBtn.textContent = '\u2B07 Download All';
  downloadAllBtn.addEventListener('click', () => downloadClusterAsZip(clusterId, downloadAllBtn));
  titleRow.appendChild(downloadAllBtn);

  headerLeftDiv.appendChild(titleRow);

  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'people-subtitle';
  subtitleEl.textContent = `${cluster.photoCount} photo${cluster.photoCount !== 1 ? 's' : ''} \u00b7 click photos to select`;
  headerLeftDiv.appendChild(subtitleEl);
  header.appendChild(headerLeftDiv);

  const backBtn = document.createElement('button');
  backBtn.className = 'people-back';
  backBtn.textContent = '\u2190 Back to People';
  backBtn.addEventListener('click', () => {
    cleanupBulkSelection();
    header.remove();
    const sr = document.getElementById('cluster-size-slider-row');
    if (sr) sr.remove();
    photoGrid.style.removeProperty('--cell-size');
    showPeopleView();
  });
  header.appendChild(backBtn);

  document.getElementById('top-bars').appendChild(header);

  // Size slider for cluster detail view
  const clusterSliderRow = document.createElement('div');
  clusterSliderRow.className = 'size-slider-row';
  clusterSliderRow.id = 'cluster-size-slider-row';
  clusterSliderRow.innerHTML = `
    <label>Size</label>
    <input type="range" min="80" max="300" step="10" value="${_clusterThumbSize}">
    <span class="size-value">${_clusterThumbSize}px</span>
  `;
  document.getElementById('top-bars').appendChild(clusterSliderRow);
  const cSlider = clusterSliderRow.querySelector('input[type="range"]');
  const cLabel = clusterSliderRow.querySelector('.size-value');
  cSlider.addEventListener('input', () => {
    const px = Number.parseInt(cSlider.value);
    _clusterThumbSize = px;
    cLabel.textContent = px + 'px';
    photoGrid.style.setProperty('--cell-size', px + 'px');
  });
  cSlider.addEventListener('change', () => {
    upgradeClusterDetailThumbs(_clusterThumbSize);
  });
  photoGrid.style.setProperty('--cell-size', _clusterThumbSize + 'px');

  // Filter to person's photos and display with selection + action overlays
  const personPhotos = photoIndex.filter(p => clusterPhotoPaths.has(p.path_lower));
  filteredIndex = personPhotos;
  displayCount = 0;

  const MONTH_NAMES = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  let lastYearMonth = null;
  const end = Math.min(DISPLAY_PAGE_PEOPLE, personPhotos.length);
  const needThumbPhotos = [];
  const needThumbCells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < end; i++) {
    const d = getPhotoDate(personPhotos[i]);
    let ym = null;
    if (d) {
      const dt = new Date(d);
      ym = dt.getFullYear() + '-' + dt.getMonth();
    }
    if (ym && ym !== lastYearMonth) {
      const dt = new Date(d);
      const div = document.createElement('div');
      div.className = 'year-divider';
      div.textContent = MONTH_NAMES[dt.getMonth()] + ' ' + dt.getFullYear();
      frag.appendChild(div);
      lastYearMonth = ym;
    }
    const { wrap, cell } = createPersonPhotoWrap(personPhotos[i], i, clusterId);
    if (!thumbCache[personPhotos[i].path_lower]) {
      cell.classList.add('loading');
      needThumbPhotos.push(personPhotos[i]);
      needThumbCells.push(cell);
    }
    frag.appendChild(wrap);
  }
  photoGrid.appendChild(frag);

  displayCount = end;
  statusBar.textContent = `Showing ${end} of ${personPhotos.length} photos for ${cluster.name || 'Unknown Person'}`;
  statusBar.classList.add('visible');

  if (displayCount < personPhotos.length) {
    loadMoreBtn.textContent = `Show more (${personPhotos.length - displayCount} remaining)`;
    loadMoreBtn.disabled = false;
    loadMoreBtn.classList.add('visible');
  } else {
    loadMoreBtn.classList.remove('visible');
  }

  if (needThumbPhotos.length > 0) {
    loadThumbnailsForCells(needThumbPhotos, needThumbCells);
  }

  // Upgrade thumbnails if slider is above base size
  if (_clusterThumbSize > 128) {
    upgradeClusterDetailThumbs(_clusterThumbSize);
  }
}

// ── New collection row for move modals ───────────────────────────────────
function createNewCollectionRow(modal, bg, fromClusterId, photoPaths, onDone) {
  const row = document.createElement('div');
  row.className = 'reassign-person-row new-collection-row';

  const icon = document.createElement('div');
  icon.className = 'new-collection-icon';
  icon.textContent = '+';
  row.appendChild(icon);

  const info = document.createElement('div');
  info.innerHTML = '<div class="rp-name">New Collection</div><div class="rp-count">Create a new person collection</div>';
  row.appendChild(info);

  row.addEventListener('click', () => {
    // Replace row content with name input
    row.innerHTML = '';
    row.classList.add('new-collection-input-row');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'new-collection-input';
    input.placeholder = 'Collection name (optional)';
    row.appendChild(input);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-sm';
    confirmBtn.style.cssText = 'padding:6px 14px;background:#0061fe;color:#fff;border-color:#0061fe;';
    confirmBtn.textContent = 'Create';
    confirmBtn.addEventListener('click', () => {
      const name = input.value.trim();
      const newCluster = FaceScan.createClusterFromPhotos(fromClusterId, photoPaths, name);
      if (newCluster) {
        bg.remove();
        onDone(newCluster);
        scheduleFaceDataSave(true);
      }
    });
    row.appendChild(confirmBtn);

    input.focus();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
      if (e.key === 'Escape') bg.remove();
    });
  });

  const separator = document.createElement('div');
  separator.className = 'reassign-separator';
  modal.appendChild(row);
  modal.appendChild(separator);
}

// ── Cluster list builder for modals (named first, search, limited unnamed) ──
function buildClusterListInModal(modal, clusters, onSelect) {
  const named = clusters.filter(c => c.name).sort((a, b) => a.name.localeCompare(b.name));
  const unnamed = clusters.filter(c => !c.name);
  const MAX_UNNAMED = 50;

  // Search box
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search collections\u2026';
  searchInput.style.cssText = 'width:100%;padding:6px 10px;margin-bottom:8px;border:1px solid #444;border-radius:6px;background:#1a1a1a;color:#eee;font-size:13px;box-sizing:border-box;';
  modal.appendChild(searchInput);

  const listContainer = document.createElement('div');
  modal.appendChild(listContainer);

  function renderList(filter) {
    listContainer.innerHTML = '';
    const lc = (filter || '').toLowerCase();

    const filteredNamed = lc ? named.filter(c => c.name.toLowerCase().includes(lc)) : named;
    const filteredUnnamed = lc
      ? unnamed.filter(c => c.id.toLowerCase().includes(lc))
      : unnamed.slice(0, MAX_UNNAMED);

    if (filteredNamed.length > 0) {
      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px;color:#888;padding:4px 0 2px;text-transform:uppercase;letter-spacing:0.5px;';
      label.textContent = 'Named Collections';
      listContainer.appendChild(label);
      for (const cluster of filteredNamed) {
        listContainer.appendChild(makeClusterRow(cluster, onSelect));
      }
    }

    if (filteredUnnamed.length > 0) {
      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px;color:#888;padding:8px 0 2px;text-transform:uppercase;letter-spacing:0.5px;';
      label.textContent = lc ? 'Unnamed Collections' : `Unnamed Collections (top ${MAX_UNNAMED})`;
      listContainer.appendChild(label);
      for (const cluster of filteredUnnamed) {
        listContainer.appendChild(makeClusterRow(cluster, onSelect));
      }
    }

    if (filteredNamed.length === 0 && filteredUnnamed.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#666;padding:12px;text-align:center;';
      empty.textContent = 'No matching collections';
      listContainer.appendChild(empty);
    }
  }

  function makeClusterRow(cluster, onClick) {
    const row = document.createElement('div');
    row.className = 'reassign-person-row';

    const img = document.createElement('img');
    const rThumb = getClusterThumb(cluster);
    if (rThumb.thumb) img.src = rThumb.thumb;
    row.appendChild(img);

    const info = document.createElement('div');
    info.innerHTML = `<div class="rp-name">${esc(cluster.name || 'Unknown')}</div><div class="rp-count">${cluster.photoCount} photos · ${cluster.id}</div>`;
    row.appendChild(info);

    row.addEventListener('click', () => onClick(cluster));
    return row;
  }

  searchInput.addEventListener('input', () => renderList(searchInput.value));
  renderList('');
  setTimeout(() => searchInput.focus(), 50);
}

// ── Merge Into Modal (from person detail view) ──────────────────────────
function showMergeIntoModal(currentClusterId) {
  const clusters = FaceScan.getClusters().filter(c => c.id !== currentClusterId);
  if (clusters.length === 0) { alert('No other collections to merge with.'); return; }

  const bg = document.createElement('div');
  bg.className = 'reassign-modal-bg';
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

  const modal = document.createElement('div');
  modal.className = 'reassign-modal';

  const title = document.createElement('h3');
  title.textContent = 'Merge another collection into this one\u2026';
  modal.appendChild(title);

  buildClusterListInModal(modal, clusters, (cluster) => {
    if (!confirm(`Merge "${cluster.name || 'Unknown'}" (${cluster.photoCount} photos) into this collection? This will remove "${cluster.name || 'Unknown'}" as a separate collection.`)) return;
    FaceScan.mergeClusters(currentClusterId, cluster.id);
    bg.remove();
    scheduleFaceDataSave(true);
    showPersonPhotos(currentClusterId);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-people';
  cancelBtn.style.cssText = 'margin-top:12px;width:100%;text-align:center;padding:8px;';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => bg.remove());
  modal.appendChild(cancelBtn);

  bg.appendChild(modal);
  document.body.appendChild(bg);
}

// ── Reassign Photo Modal ─────────────────────────────────────────────────
async function showReassignModal(fromClusterId, photoPath, photoWrapEl) {
  const clusters = FaceScan.getClusters().filter(c => c.id !== fromClusterId);

  const bg = document.createElement('div');
  bg.className = 'reassign-modal-bg';
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

  const modal = document.createElement('div');
  modal.className = 'reassign-modal';

  const title = document.createElement('h3');
  title.textContent = 'Move photo to\u2026';
  modal.appendChild(title);

  createNewCollectionRow(modal, bg, fromClusterId, [photoPath], () => {
    photoWrapEl.remove();
    syncAfterRemoval([photoPath]);
    const updated = FaceScan.getClusters().find(c => c.id === fromClusterId);
    if (updated) {
      const sub = document.querySelector('.people-subtitle');
      if (sub) sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 hover a photo for options`;
    }
  });

  buildClusterListInModal(modal, clusters, async (cluster) => {
    FaceScan.movePhotoToCluster(fromClusterId, cluster.id, photoPath);
    bg.remove();
    photoWrapEl.remove();
    syncAfterRemoval([photoPath]);
    const updated = FaceScan.getClusters().find(c => c.id === fromClusterId);
    if (updated) {
      const sub = document.querySelector('.people-subtitle');
      if (sub) sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 hover a photo for options`;
    }
    scheduleFaceDataSave(true);
  });

  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-people';
  cancelBtn.style.cssText = 'margin-top:12px;width:100%;text-align:center;padding:8px;';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => bg.remove());
  modal.appendChild(cancelBtn);

  bg.appendChild(modal);
  document.body.appendChild(bg);
}

// ── Bulk Reassign Modal (multi-select) ───────────────────────────────────
async function showBulkReassignModal(fromClusterId, photoPaths) {
  const clusters = FaceScan.getClusters().filter(c => c.id !== fromClusterId);

  const bg = document.createElement('div');
  bg.className = 'reassign-modal-bg';
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

  const modal = document.createElement('div');
  modal.className = 'reassign-modal';

  const title = document.createElement('h3');
  title.textContent = `Move ${photoPaths.length} photo${photoPaths.length !== 1 ? 's' : ''} to\u2026`;
  modal.appendChild(title);

  createNewCollectionRow(modal, bg, fromClusterId, photoPaths, () => {
    document.querySelectorAll('.photo-cell-wrap.selected').forEach(w => w.remove());
    selectedPhotoPaths.clear();
    updateBulkActionBar();
    syncAfterRemoval(photoPaths);
    const updated = FaceScan.getClusters().find(c => c.id === fromClusterId);
    const sub = document.querySelector('.people-subtitle');
    if (updated && sub) {
      sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 click photos to select`;
    }
  });

  buildClusterListInModal(modal, clusters, async (cluster) => {
    for (const p of photoPaths) {
      FaceScan.movePhotoToCluster(fromClusterId, cluster.id, p);
    }
    bg.remove();
    document.querySelectorAll('.photo-cell-wrap.selected').forEach(w => w.remove());
    selectedPhotoPaths.clear();
    updateBulkActionBar();
    syncAfterRemoval(photoPaths);
    const updated = FaceScan.getClusters().find(c => c.id === fromClusterId);
    const sub = document.querySelector('.people-subtitle');
    if (updated && sub) {
      sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 click photos to select`;
    }
    scheduleFaceDataSave(true);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-people';
  cancelBtn.style.cssText = 'margin-top:12px;width:100%;text-align:center;padding:8px;';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => bg.remove());
  modal.appendChild(cancelBtn);

  bg.appendChild(modal);
  document.body.appendChild(bg);
}

async function createFaceCrop(thumbDataUrl, box) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 140;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      // Scale box coordinates to thumbnail dimensions
      const imgW = img.naturalWidth;
      const imgH = img.naturalHeight;

      if (!box || !box.w) {
        // No box info, use center crop
        const minDim = Math.min(imgW, imgH);
        ctx.drawImage(img, (imgW - minDim) / 2, (imgH - minDim) / 2, minDim, minDim, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
        return;
      }

      // Add padding around face (30% on each side)
      const pad = Math.max(box.w, box.h) * 0.35;
      let sx = Math.max(0, box.x - pad);
      let sy = Math.max(0, box.y - pad);
      let sw = box.w + pad * 2;
      let sh = box.h + pad * 2;

      // Make square
      const maxSide = Math.max(sw, sh);
      sx -= (maxSide - sw) / 2;
      sy -= (maxSide - sh) / 2;
      sw = sh = maxSide;

      // Clamp to image bounds
      sx = Math.max(0, sx);
      sy = Math.max(0, sy);
      if (sx + sw > imgW) sw = imgW - sx;
      if (sy + sh > imgH) sh = imgH - sy;

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(thumbDataUrl);
    img.src = thumbDataUrl;
  });
}

function startRenameCluster(card, clusterId, nameEl) {
  const cluster = FaceScan.getClusters().find(c => c.id === clusterId);
  if (!cluster) return;

  const input = document.createElement('input');
  input.className = 'person-name-input';
  input.value = cluster.name || '';
  input.placeholder = 'Enter name…';

  nameEl.style.display = 'none';
  nameEl.parentNode.insertBefore(input, nameEl);
  input.focus();
  input.select();

  const finish = () => {
    const newName = input.value.trim();
    FaceScan.renameCluster(clusterId, newName);
    nameEl.textContent = newName || 'Unknown';
    nameEl.style.display = '';
    input.remove();
    card.classList.toggle('named', !!newName);
    FaceScan.saveFaceData(storage);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = cluster.name || ''; input.blur(); }
  });
}
// ── Start ─────────────────────────────────────────────────────────────────────
init();
