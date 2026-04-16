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

let peopleMode = false;         // true when People view is active
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
  thumbSaveTimer = setTimeout(async () => {
    thumbSaveTimer = null;
    if (thumbCacheDirty) {
      thumbCacheDirty = false;
      await storage.set({ [THUMB_CACHE_KEY]: thumbCache });
    }
  }, 180000);
}

// ── Debounced face-data save (avoids multi-second IPC serialization on every action) ──
let _faceSaveTimer = null;
let _faceSaveInProgress = false;
let _faceSavePendingAgain = false;

function scheduleFaceDataSave() {
  if (_faceSaveTimer) clearTimeout(_faceSaveTimer);
  // If a save is already in flight, just flag that we need another round
  if (_faceSaveInProgress) { _faceSavePendingAgain = true; return; }
  _faceSaveTimer = setTimeout(() => {
    _faceSaveTimer = null;
    // Wait for idle so we don't block the user mid-click
    (typeof requestIdleCallback === 'function' ? requestIdleCallback : setTimeout)(() => _doFaceSave());
  }, 180000);
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

// ── Manual save button ──────────────────────────────────────────────────────
$('btn-save').addEventListener('click', async () => {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = '💾 Saving…';
  try {
    // Save both thumb cache and face data, then reset auto-save timers
    if (thumbCacheDirty) {
      thumbCacheDirty = false;
      await storage.set({ [THUMB_CACHE_KEY]: thumbCache });
    }
    if (thumbSaveTimer) { clearTimeout(thumbSaveTimer); thumbSaveTimer = null; }
    await _doFaceSave();
    // Reset face save timer (cancels any pending scheduled save)
    if (_faceSaveTimer) { clearTimeout(_faceSaveTimer); _faceSaveTimer = null; }
    btn.textContent = '💾 Saved!';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = '💾 Save'; btn.classList.remove('saved'); }, 1500);
  } catch (e) {
    console.error('[Save] Manual save failed:', e);
    btn.textContent = '💾 Save';
  } finally {
    btn.disabled = false;
  }
});

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
    return { thumb: thumbCache[cluster.posterPhoto], hasAny: true };
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
  return { thumb: best ? thumbCache[best] : null, hasAny };
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
}

$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-prev').addEventListener('click', () => openLightbox(lightboxIdx - 1));
$('lightbox-next').addEventListener('click', () => openLightbox(lightboxIdx + 1));
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', e => {
  if (!lightbox.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft')  openLightbox(lightboxIdx - 1);
  if (e.key === 'ArrowRight') openLightbox(lightboxIdx + 1);
});

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

async function showPeopleView() {
  peopleMode = true;
  peopleClusterId = null;
  cleanupBulkSelection();
  mergeMode = false;
  mergeSelected.clear();
  btnPeople.classList.add('active');

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
  peopleClusterId = null;
  cleanupBulkSelection();
  btnPeople.classList.remove('active');

  // Restore photoIndex to the folder-specific version
  if (savedPhotoIndex !== null) {
    photoIndex = savedPhotoIndex;
    savedPhotoIndex = null;
  }

  peopleView.classList.remove('visible');
  peopleView.innerHTML = '';
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
  const unscanned = totalImages - scannedCount;

  // Pre-compute thumbs for all clusters in a single pass
  const clusterThumbs = new Map();
  let visibleCount = 0;
  for (const c of clusters) {
    const result = getClusterThumb(c);
    if (result.thumb) { clusterThumbs.set(c.id, result.thumb); visibleCount++; }
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
    } else {
      // "Rescan All" — re-detect faces on all photos, keeping clusters/names/exclusions
      if (scannedCount > 0) {
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

  for (const cluster of sorted) {
    // Use pre-computed thumb — skip clusters with no cached thumbnail
    const thumb = clusterThumbs.get(cluster.id);
    if (!thumb) continue;

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
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'person-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'person-name';
    nameEl.textContent = cluster.name || 'Unknown';
    info.appendChild(nameEl);

    const idEl = document.createElement('div');
    idEl.className = 'person-count';
    idEl.style.fontSize = '9px';
    idEl.style.opacity = '0.5';
    idEl.textContent = cluster.id;
    info.appendChild(idEl);

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
    scheduleFaceDataSave();
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
      scheduleFaceDataSave();
    } else if (action === 'move') {
      showReassignModal(clusterId, photoPath, wrap);
    } else if (action === 'poster') {
      FaceScan.setClusterPoster(clusterId, photoPath);
      actionBtn.textContent = '\u2713';
      setTimeout(() => { actionBtn.textContent = '\u2b50'; }, 1000);
      scheduleFaceDataSave();
    }
    return;
  }

  // Photo cell click → lightbox
  const cell = e.target.closest('.photo-cell');
  if (cell && cell.dataset.idx !== undefined) {
    openLightbox(Number.parseInt(cell.dataset.idx, 10));
  }
});

function showPersonPhotos(clusterId) {
  invalidateFilteredCache();
  peopleClusterId = clusterId;
  selectedPhotoPaths.clear();
  const cluster = FaceScan.getClusters().find(c => c.id === clusterId);
  if (!cluster) return;

  const clusterPhotoPaths = new Set(cluster.photos);

  peopleView.classList.remove('visible');
  photoGrid.style.display = '';
  photoGrid.innerHTML = '';
  loadMoreBtn.classList.remove('visible');
  document.querySelectorAll('.people-header').forEach(h => h.remove());

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
    showPeopleView();
  });
  header.appendChild(backBtn);

  document.getElementById('top-bars').appendChild(header);

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
        scheduleFaceDataSave();
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
    scheduleFaceDataSave();
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
    scheduleFaceDataSave();
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
    scheduleFaceDataSave();
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
