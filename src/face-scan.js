// ── Face Recognition Module v2 ────────────────────────────────────────────────
// Uses full-resolution images for accurate face embeddings.
// SSD MobileNetV1 detector + 128-dim face recognition descriptors.
// Chinese Whispers graph clustering for stable person grouping.

const FaceScan = (() => {
  const MODELS_PATH = './models';
  const FACE_DATA_KEY = 'faceDataStore_v2';
  const DISTANCE_THRESHOLD = 0.45;  // Stricter threshold for same-person match
  const MIN_FACE_SIZE = 50;         // Minimum face width in pixels
  const MIN_DETECTION_SCORE = 0.6;  // Minimum detection confidence
  const CW_ITERATIONS = 50;         // Chinese Whispers iterations

  let modelsLoaded = false;
  let faceData = {
    photos: {},    // photoPath -> [{ box, descriptor, score }]
    clusters: [],  // [{ id, name, samplePhoto, sampleBox, sampleDescriptor, photoCount, photos }]
    version: 2,
  };

  let scanQueue = [];
  let scanning = false;
  let onProgress = null;
  let onComplete = null;
  let scanAbort = false;
  let _imageDownloader = null;  // Set by app.js to fetch full-res images
  let _storageAdapter = null;   // Captured for auto-save during scanning

  // ── Model Loading ──────────────────────────────────────────────────────────
  async function loadModels() {
    if (modelsLoaded) return;
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_PATH),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_PATH),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_PATH),
    ]);
    modelsLoaded = true;
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  async function loadFaceData(storageAdapter) {
    _storageAdapter = storageAdapter;
    const stored = await storageAdapter.get([FACE_DATA_KEY]);
    if (stored[FACE_DATA_KEY]) {
      faceData = stored[FACE_DATA_KEY];
      for (const path in faceData.photos) {
        for (const face of faceData.photos[path]) {
          if (face.descriptor && !(face.descriptor instanceof Float32Array)) {
            face.descriptor = new Float32Array(face.descriptor);
          }
        }
      }
    }
    return faceData;
  }

  async function saveFaceData(storageAdapter) {
    const serializable = {
      version: faceData.version,
      photos: {},
      clusters: faceData.clusters,
    };
    for (const path in faceData.photos) {
      serializable.photos[path] = faceData.photos[path].map(f => ({
        box: f.box,
        descriptor: Array.from(f.descriptor),
        score: f.score,
      }));
    }
    await storageAdapter.set({ [FACE_DATA_KEY]: serializable });
  }

  // ── Image Downloader ───────────────────────────────────────────────────────
  function setImageDownloader(fn) {
    _imageDownloader = fn;
  }

  // Load a blob URL image into an HTMLImageElement
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = src;
    });
  }

  // Downscale to max dimension for speed while keeping good face resolution
  function downscaleForDetection(img, maxDim = 1200) {
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w <= maxDim && h <= maxDim) return img;

    const scale = maxDim / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // ── Face Detection ─────────────────────────────────────────────────────────
  async function detectFaces(imgElement) {
    const input = downscaleForDetection(imgElement);
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_SCORE,
    });
    const detections = await faceapi
      .detectAllFaces(input, options)
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detections
      .filter(d => d.detection.box.width >= MIN_FACE_SIZE && d.detection.box.height >= MIN_FACE_SIZE)
      .map(d => ({
        box: {
          x: Math.round(d.detection.box.x),
          y: Math.round(d.detection.box.y),
          w: Math.round(d.detection.box.width),
          h: Math.round(d.detection.box.height),
        },
        descriptor: d.descriptor,
        score: d.detection.score,
      }));
  }

  // ── Scan a single photo using full-resolution download ─────────────────────
  async function scanPhotoFullRes(photoPath) {
    if (faceData.photos[photoPath]) return faceData.photos[photoPath];

    if (!_imageDownloader) {
      faceData.photos[photoPath] = [];
      return [];
    }

    let blobUrl = null;
    try {
      blobUrl = await _imageDownloader(photoPath);
      const img = await loadImage(blobUrl);
      const faces = await detectFaces(img);
      faceData.photos[photoPath] = faces;
      return faces;
    } catch (e) {
      console.warn('Face scan failed for', photoPath, e.message);
      faceData.photos[photoPath] = [];
      return [];
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  // Scan from thumbnail data URL (fallback/fast mode)
  async function scanPhotoThumb(dataUrl, photoPath) {
    if (faceData.photos[photoPath]) return faceData.photos[photoPath];
    try {
      const img = await loadImage(dataUrl);
      const input = downscaleForDetection(img);
      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: MIN_DETECTION_SCORE });
      const detections = await faceapi
        .detectAllFaces(input, options)
        .withFaceLandmarks()
        .withFaceDescriptors();
      const faces = detections
        .filter(d => d.detection.box.width >= 30) // Lower threshold for thumbs
        .map(d => ({
          box: {
            x: Math.round(d.detection.box.x),
            y: Math.round(d.detection.box.y),
            w: Math.round(d.detection.box.width),
            h: Math.round(d.detection.box.height),
          },
          descriptor: d.descriptor,
          score: d.detection.score,
        }));
      faceData.photos[photoPath] = faces;
      return faces;
    } catch (e) {
      faceData.photos[photoPath] = [];
      return [];
    }
  }

  // ── Batch Scanning ─────────────────────────────────────────────────────────
  function queuePhotosForScan(photoPaths, useFullRes = true) {
    for (const path of photoPaths) {
      if (!faceData.photos[path]) {
        scanQueue.push({ path, fullRes: useFullRes });
      }
    }
    if (!scanning) startScanning();
  }

  function queueThumbsForScan(photoThumbPairs) {
    for (const item of photoThumbPairs) {
      if (!faceData.photos[item.path]) {
        scanQueue.push({ path: item.path, fullRes: false, thumbDataUrl: item.thumbDataUrl });
      }
    }
    if (!scanning) startScanning();
  }

  async function startScanning() {
    if (scanning) return;
    scanning = true;
    scanAbort = false;

    try {
      await loadModels();
    } catch (e) {
      console.error('Failed to load face models:', e);
      scanning = false;
      return;
    }

    const totalQueued = scanQueue.length;
    let scanned = 0;
    let facesFound = 0;
    let photosSinceLastCluster = 0;
    let photosSinceLastSave = 0;
    const CLUSTER_INTERVAL = 5; // Rebuild clusters every N photos that had faces
    const SAVE_INTERVAL = 20;   // Auto-save every N scanned photos

    while (scanQueue.length > 0 && !scanAbort) {
      const item = scanQueue.shift();
      if (faceData.photos[item.path]) { scanned++; continue; }

      let faces;
      if (item.fullRes && _imageDownloader) {
        faces = await scanPhotoFullRes(item.path);
      } else if (item.thumbDataUrl) {
        faces = await scanPhotoThumb(item.thumbDataUrl, item.path);
      } else {
        faceData.photos[item.path] = [];
        faces = [];
      }

      facesFound += faces.length;
      scanned++;
      photosSinceLastSave++;
      if (faces.length > 0) photosSinceLastCluster++;

      // Periodically rebuild clusters so results appear live
      if (photosSinceLastCluster >= CLUSTER_INTERVAL) {
        rebuildClusters();
        photosSinceLastCluster = 0;
      }

      // Periodically save so progress survives app close
      if (photosSinceLastSave >= SAVE_INTERVAL && _storageAdapter) {
        await saveFaceData(_storageAdapter);
        photosSinceLastSave = 0;
      }

      if (onProgress) {
        onProgress(scanned, totalQueued, facesFound, faceData.clusters);
      }

      // Yield to UI thread every photo
      await new Promise(r => setTimeout(r, 5));
    }

    // Final cluster rebuild
    rebuildClusters();

    scanning = false;
    if (onComplete) onComplete(faceData.clusters);
  }

  function abortScanning() {
    scanAbort = true;
    scanQueue = [];
  }

  // ── Clustering: Chinese Whispers ───────────────────────────────────────────
  function euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  function rebuildClusters() {
    // Collect all valid face descriptors
    const allFaces = [];
    for (const path in faceData.photos) {
      for (const face of faceData.photos[path]) {
        if (face.descriptor?.length === 128 && face.score >= MIN_DETECTION_SCORE) {
          allFaces.push({ path, face });
        }
      }
    }

    if (allFaces.length === 0) {
      faceData.clusters = [];
      return;
    }

    // Build adjacency lists: connect faces within threshold
    const n = allFaces.length;
    const neighbors = new Array(n);
    for (let i = 0; i < n; i++) neighbors[i] = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = euclideanDistance(allFaces[i].face.descriptor, allFaces[j].face.descriptor);
        if (dist < DISTANCE_THRESHOLD) {
          neighbors[i].push(j);
          neighbors[j].push(i);
        }
      }
    }

    // Chinese Whispers: each node starts with unique label
    const labels = new Array(n);
    for (let i = 0; i < n; i++) labels[i] = i;

    for (let iter = 0; iter < CW_ITERATIONS; iter++) {
      let changed = false;
      // Process nodes in random order
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }

      for (const i of order) {
        if (neighbors[i].length === 0) continue;

        // Count neighbor labels
        const labelCounts = {};
        for (const nb of neighbors[i]) {
          const lbl = labels[nb];
          labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
        }

        // Pick most frequent label
        let bestLabel = labels[i];
        let bestCount = 0;
        for (const lbl in labelCounts) {
          if (labelCounts[lbl] > bestCount) {
            bestCount = labelCounts[lbl];
            bestLabel = parseInt(lbl);
          }
        }

        if (labels[i] !== bestLabel) {
          labels[i] = bestLabel;
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Group faces by label
    const groups = {};
    for (let i = 0; i < n; i++) {
      const lbl = labels[i];
      if (!groups[lbl]) groups[lbl] = [];
      groups[lbl].push(allFaces[i]);
    }

    // Preserve old cluster names by matching centroids
    const oldClusters = faceData.clusters.slice();

    // Build cluster objects
    const clusters = [];
    for (const lbl in groups) {
      const members = groups[lbl];
      if (members.length < 1) continue;

      const photos = new Set(members.map(m => m.path));

      // Pick the best sample: highest detection score
      const bestMember = members.reduce((a, b) =>
        b.face.score > a.face.score ? b : a, members[0]);

      // Compute centroid for name matching
      const centroid = new Float32Array(128);
      for (const m of members) {
        for (let i = 0; i < 128; i++) centroid[i] += m.face.descriptor[i];
      }
      for (let i = 0; i < 128; i++) centroid[i] /= members.length;

      // Try to match to an existing named cluster
      let id = 'face_' + Date.now() + '_' + clusters.length;
      let name = '';
      for (const old of oldClusters) {
        if (old.name && old.sampleDescriptor) {
          const oldDesc = old.sampleDescriptor instanceof Float32Array
            ? old.sampleDescriptor : new Float32Array(old.sampleDescriptor);
          const dist = euclideanDistance(centroid, oldDesc);
          if (dist < DISTANCE_THRESHOLD) {
            id = old.id;
            name = old.name;
            break;
          }
        }
      }

      clusters.push({
        id,
        name,
        samplePhoto: bestMember.path,
        sampleBox: bestMember.face.box,
        sampleDescriptor: Array.from(centroid),
        photoCount: photos.size,
        photos: [...photos],
      });
    }

    // Sort by photo count descending
    clusters.sort((a, b) => b.photoCount - a.photoCount);
    faceData.clusters = clusters;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function setCallbacks({ progress, complete }) {
    if (progress) onProgress = progress;
    if (complete) onComplete = complete;
  }

  function getClusters() {
    return faceData.clusters;
  }

  function getPhotosForCluster(clusterId) {
    const cluster = faceData.clusters.find(c => c.id === clusterId);
    return cluster ? cluster.photos : [];
  }

  function renameCluster(clusterId, name) {
    const cluster = faceData.clusters.find(c => c.id === clusterId);
    if (cluster) cluster.name = name;
  }

  function getScannedCount() {
    return Object.keys(faceData.photos).length;
  }

  function isScanning() {
    return scanning;
  }

  function getFaceData() {
    return faceData;
  }

  // Return the best face box for a photo (highest score)
  function getFaceBox(photoPath) {
    const faces = faceData.photos[photoPath];
    if (!faces || faces.length === 0) return null;
    return faces.reduce((a, b) => b.score > a.score ? b : a, faces[0]).box;
  }

  async function clearFaceData(storageAdapter) {
    faceData = { photos: {}, clusters: [], version: 2 };
    scanQueue = [];
    await storageAdapter.remove([FACE_DATA_KEY]);
  }

  // Merge a cluster into another (manual correction)
  function mergeClusters(keepId, mergeId) {
    const keep = faceData.clusters.find(c => c.id === keepId);
    const merge = faceData.clusters.find(c => c.id === mergeId);
    if (!keep || !merge) return false;

    const allPhotos = new Set([...keep.photos, ...merge.photos]);
    keep.photos = [...allPhotos];
    keep.photoCount = allPhotos.size;

    faceData.clusters = faceData.clusters.filter(c => c.id !== mergeId);
    return true;
  }

  // Split a single photo out of a cluster (manual correction)
  function removePhotoFromCluster(clusterId, photoPath) {
    const cluster = faceData.clusters.find(c => c.id === clusterId);
    if (!cluster) return false;

    cluster.photos = cluster.photos.filter(p => p !== photoPath);
    cluster.photoCount = cluster.photos.length;

    if (cluster.photoCount === 0) {
      faceData.clusters = faceData.clusters.filter(c => c.id !== clusterId);
    }
    return true;
  }

  // Move a photo from one cluster to another (manual correction)
  function movePhotoToCluster(fromClusterId, toClusterId, photoPath) {
    const removed = removePhotoFromCluster(fromClusterId, photoPath);
    if (!removed) return false;
    const target = faceData.clusters.find(c => c.id === toClusterId);
    if (!target) return false;
    if (!target.photos.includes(photoPath)) {
      target.photos.push(photoPath);
      target.photoCount = target.photos.length;
    }
    return true;
  }

  // Delete a cluster entirely (does not remove face data from photos)
  function deleteCluster(clusterId) {
    faceData.clusters = faceData.clusters.filter(c => c.id !== clusterId);
  }

  return {
    loadModels,
    loadFaceData,
    saveFaceData,
    setImageDownloader,
    scanPhotoFullRes,
    scanPhotoThumb,
    queuePhotosForScan,
    queueThumbsForScan,
    abortScanning,
    setCallbacks,
    getClusters,
    getPhotosForCluster,
    renameCluster,
    getScannedCount,
    isScanning,
    getFaceData,
    getFaceBox,
    clearFaceData,
    rebuildClusters,
    mergeClusters,
    removePhotoFromCluster,
    movePhotoToCluster,
    deleteCluster,
  };
})();
