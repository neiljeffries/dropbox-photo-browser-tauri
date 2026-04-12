const { invoke } = window.__TAURI__.core;
const { openUrl } = window.__TAURI__.opener;

const IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','bmp','tiff','tif']);
const VID_EXTS = new Set(['mp4','mov','avi','mkv','webm']);
const MEDIA_EXTS = new Set([...IMG_EXTS, ...VID_EXTS]);
const THUMB_SIZE = 'w128h128';
const DISPLAY_PAGE = 250;
const ROOT_PATHS = [
  { path: '/camera uploads', label: 'Camera Uploads' },
  { path: '/ai stuff', label: 'AI Stuff' }
];
const HOME_PATH = '__home__';
const OAUTH_PORT = 17822;

let appKey = '';
let accessToken = '';
let currentPath = HOME_PATH;
let photoIndex = [];
let displayCount = 0;
let lightboxIdx = 0;
let allYears = [];
let filteredIndex = [];
let thumbCache = {};
let fetchGen = 0;
let folderCache = [];
const CACHE_KEY_PREFIX = 'folderCache_';
const THUMB_CACHE_KEY = 'thumbCacheStore';
let thumbCacheDirty = false;
let thumbSaveTimer = null;

// ── Storage adapter (wraps Tauri invoke) ──────────────────────────────────────
const storage = {
  async get(keys) {
    if (typeof keys === 'string') keys = [keys];
    if (keys === null) {
      // get all
      const all = await invoke('store_get_all');
      return all || {};
    }
    const result = {};
    for (const k of keys) {
      const val = await invoke('store_get', { key: k });
      if (val !== null && val !== undefined) result[k] = val;
    }
    return result;
  },
  async set(obj) {
    for (const [k, v] of Object.entries(obj)) {
      await invoke('store_set', { key: k, value: v });
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
}

function scheduleThumbSave() {
  thumbCacheDirty = true;
  if (thumbSaveTimer) return;
  thumbSaveTimer = setTimeout(async () => {
    thumbSaveTimer = null;
    if (thumbCacheDirty) {
      thumbCacheDirty = false;
      await storage.set({ [THUMB_CACHE_KEY]: thumbCache });
    }
  }, 2000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadThumbCache();
  await FaceScan.loadFaceData(storage);

  // Wire up full-resolution image downloader for face scanning
  FaceScan.setImageDownloader(async (path) => {
    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Dropbox-API-Arg': JSON.stringify({ path })
      }
    });
    if (!res.ok) throw new Error('Download failed ' + res.status);
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
      faceScanLabel.textContent = 'Face scan complete';
      faceScanCount.textContent = clusters.length + ' people found';
      faceScanFill.style.width = '100%';
      await FaceScan.saveFaceData(storage);
      setTimeout(() => faceScanBar.classList.remove('visible'), 4000);
      lastVisibleCount = -1;
      if (pendingPeopleRender) { clearTimeout(pendingPeopleRender); pendingPeopleRender = null; }
      if (peopleMode && !peopleClusterId) renderPeopleGrid();
    },
  });

  const stored = await storage.get(['appKey', 'accessToken']);
  appKey      = stored.appKey || '';
  accessToken = stored.accessToken || '';

  if (!appKey) { showScreen('setup'); return; }
  if (!accessToken) { showScreen('auth'); return; }

  setLoading('Connecting…');
  try {
    const info = await dbxFetch('https://api.dropboxapi.com/2/users/get_current_account', null, 'POST');
    $('account-name').textContent = info.name?.display_name || info.email || '';
    $('btn-logout').style.display = '';
    showHome();
  } catch(e) {
    if (e.status === 401) {
      accessToken = '';
      await storage.remove('accessToken');
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
  const res = await fetch(url, opts);
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
  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_batch', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entries })
  });
  if (!res.ok) throw new Error('Thumbnail batch failed ' + res.status);
  return res.json();
}

async function dbxGetFullImage(path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
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
  let allEntries = [];
  try {
    let data = await dbxFetch('https://api.dropboxapi.com/2/files/list_folder', {
      path: path || '',
      recursive: false,
      include_media_info: true,
      limit: 2000
    });
    allEntries.push(...data.entries);

    while (data.has_more) {
      if (gen !== fetchGen) return;
      setLoading(`Scanning folder… ${allEntries.length} items found`);
      data = await dbxFetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
        cursor: data.cursor
      });
      allEntries.push(...data.entries);
    }
  } catch(e) {
    setLoading('Error: ' + e.message);
    return;
  }
  if (gen !== fetchGen) return;

  await saveFolderCache(path, allEntries);
  renderFolderData(path, allEntries, Date.now());
}

function renderFolderData(path, allEntries, cacheTimestamp) {
  folderCache = allEntries.filter(e => e['.tag'] === 'folder');
  photoIndex = allEntries.filter(isMedia);
  sortPhotosNewest(photoIndex);

  showScreen('browse');

  folderList.innerHTML = '';
  $('btn-up').style.display = (path && !isRootPath(path)) ? '' : 'none';
  for (const f of folderCache) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    li.innerHTML = `<span class="folder-icon">📁</span><span class="folder-name">${esc(f.name)}</span><span class="chevron">›</span>`;
    li.addEventListener('click', () => browseFolder(f.path_lower));
    folderList.appendChild(li);
  }

  buildYearSlider();

  photoGrid.innerHTML = '';
  displayCount = 0;
  showMorePhotos();

  if (cacheTimestamp) {
    statusBar.textContent += ` · cached ${formatCacheAge(cacheTimestamp)}`;
  }
}

// ── Display windowing ─────────────────────────────────────────────────────────
function getFilteredPhotos() {
  const slider = $('year-slider');
  const selectedIdx = parseInt(slider.value);
  const selectedYear = selectedIdx === 0 ? null : allYears[selectedIdx - 1];

  if (selectedYear) {
    return photoIndex.filter(p => {
      const d = getPhotoDate(p);
      return d && new Date(d).getFullYear() === selectedYear;
    });
  }
  return photoIndex;
}

function showMorePhotos() {
  const photos = getFilteredPhotos();
  filteredIndex = photos;
  const end = Math.min(displayCount + DISPLAY_PAGE, photos.length);
  const needThumbPhotos = [];
  const needThumbCells = [];

  let lastYear = null;
  if (displayCount > 0) {
    const prevD = getPhotoDate(photos[displayCount - 1]);
    lastYear = prevD ? new Date(prevD).getFullYear() : null;
  }

  const slider = $('year-slider');
  const selectedIdx = parseInt(slider.value);
  const showDividers = selectedIdx === 0;

  for (let i = displayCount; i < end; i++) {
    const d = getPhotoDate(photos[i]);
    const yr = d ? new Date(d).getFullYear() : null;
    if (showDividers && yr && yr !== lastYear) {
      const div = document.createElement('div');
      div.className = 'year-divider';
      div.textContent = yr;
      photoGrid.appendChild(div);
      lastYear = yr;
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
    photoGrid.appendChild(cell);
  }

  displayCount = end;
  updateStatus();

  if (displayCount < photos.length) {
    loadMoreBtn.textContent = `Show more (${photos.length - displayCount} remaining)`;
    loadMoreBtn.disabled = false;
    loadMoreBtn.classList.add('visible');
  } else {
    loadMoreBtn.classList.remove('visible');
  }

  if (needThumbPhotos.length > 0) {
    loadThumbnailsForCells(needThumbPhotos, needThumbCells);
  }
}

function resetAndShowPhotos() {
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

function sortPhotosNewest(arr) {
  arr.sort((a, b) => getPhotoTimestamp(b) - getPhotoTimestamp(a));
}

function buildYearSlider() {
  const years = new Set();
  for (const p of photoIndex) {
    const d = getPhotoDate(p);
    if (d) years.add(new Date(d).getFullYear());
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
          thumbCache[slice[j].path_lower] = dataUrl;
          if (!isVideo(slice[j])) {
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

async function openLightbox(idx) {
  if (idx < 0 || idx >= filteredIndex.length) return;
  lightboxIdx = idx;
  lightbox.classList.add('open');

  const entry = filteredIndex[idx];
  const path = entry.path_lower;
  const video = isVideo(entry);
  lightboxName.textContent = entry.name;

  const lightboxVid = $('lightbox-vid');
  if (video) {
    lightboxImg.style.display = 'none';
    lightboxVid.style.display = '';
    lightboxVid.src = '';
    lightboxVid.poster = thumbCache[path] || '';
    try {
      const url = await dbxGetFullImage(path);
      lightboxVid.src = url;
      lightboxVid.dataset.blobUrl = url;
      lightboxVid.play().catch(() => {});
    } catch(e) {
      lightboxName.textContent = 'Failed to load video';
      return;
    }
  } else {
    lightboxVid.style.display = 'none';
    lightboxVid.pause();
    lightboxVid.src = '';
    lightboxImg.style.display = '';
    lightboxImg.style.opacity = '0.4';
    if (!fullUrlCache[path]) {
      try {
        fullUrlCache[path] = await dbxGetFullImage(path);
      } catch(e) {
        lightboxName.textContent = 'Failed to load image';
        return;
      }
    }
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
  await storage.remove(['accessToken', 'appKey']);
  appKey = ''; accessToken = '';
  showScreen('setup');
});

async function startAuth() {
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const state = Math.random().toString(36).slice(2);
  await storage.set({ oauthState: state });

  const authUrl = `https://www.dropbox.com/oauth2/authorize?` +
    `client_id=${encodeURIComponent(appKey)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  $('auth-error').textContent = '';

  // Start the local OAuth listener in Rust, then open the browser
  const listenPromise = invoke('oauth_listen', { port: OAUTH_PORT });
  await openUrl(authUrl);

  try {
    const resultPath = await listenPromise;
    // resultPath looks like "/token?access_token=...&state=..."
    const params = new URLSearchParams(resultPath.split('?')[1] || '');
    const token = params.get('access_token');
    const retState = params.get('state');

    const stored = await storage.get(['oauthState']);
    if (retState !== stored.oauthState) throw new Error('State mismatch');
    if (!token) throw new Error('No token returned');

    accessToken = token;
    await storage.set({ accessToken });
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
  await storage.remove(['accessToken']);
  accessToken = '';
  showScreen('auth');
  $('btn-logout').style.display = 'none';
  $('account-name').textContent = 'Not connected';
});
loadMoreBtn.addEventListener('click', () => showMorePhotos());

// ── Infinite scroll ───────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const photos = getFilteredPhotos();
  if (displayCount >= photos.length) return;
  const scrollBottom = window.scrollY + window.innerHeight;
  const docHeight = document.body.scrollHeight;
  if (docHeight - scrollBottom < 400) {
    showMorePhotos();
  }
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
  // Queue all image photos in current folder for full-res scanning
  const imagePaths = photoIndex
    .filter(p => !isVideo(p))
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

function showPeopleView() {
  peopleMode = true;
  peopleClusterId = null;
  mergeMode = false;
  mergeSelected.clear();
  btnPeople.classList.add('active');

  photoGrid.style.display = 'none';
  folderList.style.display = 'none';
  loadMoreBtn.classList.remove('visible');
  $('year-slider-bar').classList.remove('visible');
  statusBar.classList.remove('visible');

  peopleView.classList.add('visible');
  renderPeopleGrid();
}

function exitPeopleMode() {
  peopleMode = false;
  peopleClusterId = null;
  btnPeople.classList.remove('active');

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
  const visibleClusters = clusters.filter(c => c.photos.some(p => thumbCache[p]));
  const scannedCount = FaceScan.getScannedCount();
  const totalImages = photoIndex.filter(p => !isVideo(p)).length;
  const unscanned = totalImages - scannedCount;
  peopleView.innerHTML = '';

  // Header with scan + merge buttons
  const header = document.createElement('div');
  header.className = 'people-header';

  const headerLeft = document.createElement('div');
  headerLeft.innerHTML = `
    <div class="people-title">\ud83d\udc64 People</div>
    <div class="people-subtitle">${visibleClusters.length} ${visibleClusters.length === 1 ? 'person' : 'people'} found \u00b7 ${scannedCount} of ${totalImages} photos scanned</div>
  `;
  header.appendChild(headerLeft);

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;gap:8px;align-items:center;';

  if (totalImages > 0) {
    const scanBtn = document.createElement('button');
    scanBtn.className = 'btn-primary';
    scanBtn.style.cssText = 'font-size:11px;padding:6px 12px;';
    if (FaceScan.isScanning()) {
      scanBtn.textContent = '\u23f9 Stop Scan';
      scanBtn.addEventListener('click', () => {
        FaceScan.abortScanning();
        scanBtn.textContent = '\ud83d\udd0d Scan Faces';
      });
    } else {
      scanBtn.textContent = unscanned > 0
        ? `\ud83d\udd0d Scan ${unscanned > 0 ? unscanned + ' ' : ''}Faces`
        : '\ud83d\udd04 Rescan All';
      scanBtn.addEventListener('click', () => {
        if (unscanned === 0) {
          FaceScan.clearFaceData(storage).then(() => startFaceScanForCurrentFolder());
        } else {
          startFaceScanForCurrentFolder();
        }
        renderPeopleGrid();
      });
    }
    headerRight.appendChild(scanBtn);
  }

  // Merge toggle button (only when 2+ visible clusters exist)
  if (visibleClusters.length >= 2) {
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

  if (visibleClusters.length === 0) {
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

  for (const cluster of clusters) {
    // Find any photo in this cluster that has a cached thumbnail
    let thumb = null;
    let faceBox = null;
    if (thumbCache[cluster.samplePhoto]) {
      thumb = thumbCache[cluster.samplePhoto];
      faceBox = cluster.sampleBox;
    } else {
      for (const p of cluster.photos) {
        if (thumbCache[p]) {
          thumb = thumbCache[p];
          faceBox = FaceScan.getFaceBox(p);
          break;
        }
      }
    }
    // Skip clusters with no cached thumbnail — don't show blank placeholders
    if (!thumb) continue;

    const card = document.createElement('div');
    card.className = 'person-card' + (mergeSelected.has(cluster.id) ? ' selected' : '');
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
      await FaceScan.saveFaceData(storage);
      mergeMode = false;
      mergeSelected.clear();
      renderPeopleGrid();
    });
  }
}

function showPersonPhotos(clusterId) {
  peopleClusterId = clusterId;
  const cluster = FaceScan.getClusters().find(c => c.id === clusterId);
  if (!cluster) return;

  const clusterPhotoPaths = new Set(cluster.photos);

  peopleView.classList.remove('visible');
  photoGrid.style.display = '';
  photoGrid.innerHTML = '';
  loadMoreBtn.classList.remove('visible');

  // Header bar for person view
  const header = document.createElement('div');
  header.className = 'people-header';
  header.style.padding = '12px 16px';

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
    const finish = async () => {
      const newName = input.value.trim();
      FaceScan.renameCluster(clusterId, newName);
      await FaceScan.saveFaceData(storage);
      titleEl.textContent = newName || 'Unknown Person';
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = cluster.name || ''; input.blur(); }
    });
  });
  titleRow.appendChild(renameBtn);
  headerLeftDiv.appendChild(titleRow);

  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'people-subtitle';
  subtitleEl.textContent = `${cluster.photoCount} photo${cluster.photoCount !== 1 ? 's' : ''} \u00b7 hover a photo for options`;
  headerLeftDiv.appendChild(subtitleEl);
  header.appendChild(headerLeftDiv);

  const backBtn = document.createElement('button');
  backBtn.className = 'people-back';
  backBtn.textContent = '\u2190 Back to People';
  backBtn.addEventListener('click', () => {
    header.remove();
    showPeopleView();
  });
  header.appendChild(backBtn);

  photoGrid.before(header);

  // Filter to person's photos and display with action overlays
  const personPhotos = photoIndex.filter(p => clusterPhotoPaths.has(p.path_lower));
  filteredIndex = personPhotos;
  displayCount = 0;

  const end = Math.min(DISPLAY_PAGE, personPhotos.length);
  for (let i = 0; i < end; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'photo-cell-wrap';

    const cell = document.createElement('div');
    cell.className = 'photo-cell';
    cell.dataset.idx = i;
    cell.addEventListener('click', () => openLightbox(Number.parseInt(cell.dataset.idx, 10)));

    const cached = thumbCache[personPhotos[i].path_lower];
    if (cached) {
      const img = document.createElement('img');
      img.src = cached;
      img.alt = personPhotos[i].name;
      cell.appendChild(img);
    }
    wrap.appendChild(cell);

    // Action bar: remove from person / move to different person
    const actionBar = document.createElement('div');
    actionBar.className = 'photo-action-bar';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'photo-action-btn';
    removeBtn.title = 'Remove from this person';
    removeBtn.textContent = '\u2716';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      FaceScan.removePhotoFromCluster(clusterId, personPhotos[i].path_lower);
      await FaceScan.saveFaceData(storage);
      wrap.remove();
      // Update subtitle count
      const updated = FaceScan.getClusters().find(c => c.id === clusterId);
      if (updated) {
        subtitleEl.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 hover a photo for options`;
      }
    });
    actionBar.appendChild(removeBtn);

    const moveBtn = document.createElement('button');
    moveBtn.className = 'photo-action-btn move-btn';
    moveBtn.title = 'Move to a different person';
    moveBtn.textContent = '\u27a1';
    moveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showReassignModal(clusterId, personPhotos[i].path_lower, wrap);
    });
    actionBar.appendChild(moveBtn);

    wrap.appendChild(actionBar);
    photoGrid.appendChild(wrap);
  }

  displayCount = end;
  statusBar.textContent = `Showing ${end} of ${personPhotos.length} photos for ${cluster.name || 'Unknown Person'}`;
  statusBar.classList.add('visible');
}

// ── Reassign Photo Modal ─────────────────────────────────────────────────
async function showReassignModal(fromClusterId, photoPath, photoWrapEl) {
  const clusters = FaceScan.getClusters().filter(c => c.id !== fromClusterId);
  if (clusters.length === 0) return;

  const bg = document.createElement('div');
  bg.className = 'reassign-modal-bg';
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

  const modal = document.createElement('div');
  modal.className = 'reassign-modal';

  const title = document.createElement('h3');
  title.textContent = 'Move photo to\u2026';
  modal.appendChild(title);

  for (const cluster of clusters) {
    const row = document.createElement('div');
    row.className = 'reassign-person-row';

    const img = document.createElement('img');
    const rThumb = thumbCache[cluster.samplePhoto];
    if (rThumb) {
      img.src = rThumb;
    }
    row.appendChild(img);

    const info = document.createElement('div');
    info.innerHTML = `<div class="rp-name">${esc(cluster.name || 'Unknown')}</div><div class="rp-count">${cluster.photoCount} photos</div>`;
    row.appendChild(info);

    row.addEventListener('click', async () => {
      FaceScan.movePhotoToCluster(fromClusterId, cluster.id, photoPath);
      await FaceScan.saveFaceData(storage);
      bg.remove();
      photoWrapEl.remove();
      // Update subtitle
      const updated = FaceScan.getClusters().find(c => c.id === fromClusterId);
      if (updated) {
        const sub = document.querySelector('.people-subtitle');
        if (sub) sub.textContent = `${updated.photoCount} photo${updated.photoCount !== 1 ? 's' : ''} \u00b7 hover a photo for options`;
      }
    });

    modal.appendChild(row);
  }

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

  const finish = async () => {
    const newName = input.value.trim();
    FaceScan.renameCluster(clusterId, newName);
    await FaceScan.saveFaceData(storage);
    nameEl.textContent = newName || 'Unknown';
    nameEl.style.display = '';
    input.remove();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = cluster.name || ''; input.blur(); }
  });
}
// ── Start ─────────────────────────────────────────────────────────────────────
init();
