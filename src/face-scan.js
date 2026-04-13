// ── Face Recognition Module v3 ────────────────────────────────────────────────
// Uses full-resolution images for accurate face embeddings.
// SSD MobileNetV1 detector + FaceLandmark68 for detection & alignment.
// ArcFace (InsightFace MobileFaceNet w600k) via ONNX Runtime for 512-dim embeddings.
// Chinese Whispers graph clustering for stable person grouping.

const FaceScan = (() => {
  const MODELS_PATH = './models';
  const ARCFACE_MODEL_PATH = './models/w600k_mbf.onnx';
  const FACE_DATA_KEY = 'faceDataStore_v3';
  const LEGACY_FACE_DATA_KEY = 'faceDataStore_v2';
  const DESCRIPTOR_DIM = 512;
  const DISTANCE_THRESHOLD = 0.55;  // Cosine distance threshold for same-person match
  const MIN_FACE_SIZE = 50;         // Minimum face width in pixels
  const MIN_DETECTION_SCORE = 0.6;  // Minimum detection confidence
  const CW_ITERATIONS = 50;         // Chinese Whispers iterations
  const ARCFACE_INPUT_SIZE = 112;   // ArcFace expects 112x112 aligned faces

  // ArcFace reference landmarks for 112x112 alignment (from InsightFace)
  const ARCFACE_REF_POINTS = [
    [38.2946, 51.6963],  // left eye
    [73.5318, 51.5014],  // right eye
    [56.0252, 71.7366],  // nose tip
    [41.5493, 92.3655],  // left mouth corner
    [70.7299, 92.2041],  // right mouth corner
  ];

  let modelsLoaded = false;
  let arcfaceSession = null;
  let faceData = {
    photos: {},      // photoPath -> [{ box, descriptor, score }]
    clusters: [],    // [{ id, name, samplePhoto, sampleBox, sampleDescriptor, photoCount, photos }]
    exclusions: [],  // [{ photoPath, clusterId }] — manual removals to prevent re-assignment
    legacyNames: null, // Temporary: photo→name map from v2 migration
    version: 3,
  };

  let scanQueue = [];
  let scanning = false;
  let onProgress = null;
  let onComplete = null;
  let scanAbort = false;
  let _imageDownloader = null;
  let _storageAdapter = null;
  let _serializedPhotos = {};  // Cache of already-serialized photo entries
  let _dirtyPhotos = new Set(); // Photos needing re-serialization

  // ── Model Loading ──────────────────────────────────────────────────────────
  async function loadModels() {
    if (modelsLoaded) return;
    // Configure ONNX Runtime WASM paths — absolute to avoid double-prefix
    // (ort.min.js lives in /lib/, so relative './lib/' resolves to /lib/lib/)
    ort.env.wasm.wasmPaths = '/lib/';
    ort.env.wasm.numThreads = 1;   // Avoid SharedArrayBuffer requirement in Tauri webview
    ort.env.wasm.proxy = false;     // Run inference on main thread (no proxy worker)
    // Face-api.js: detection + landmarks only (no recognition model)
    console.log('[FaceScan] Loading face-api.js detection models…');
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_PATH),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_PATH),
    ]);
    console.log('[FaceScan] face-api.js models loaded. Loading ArcFace ONNX…');
    // ArcFace ONNX model for 512-dim face embeddings
    arcfaceSession = await ort.InferenceSession.create(ARCFACE_MODEL_PATH, {
      executionProviders: ['wasm'],
    });
    console.log('[FaceScan] ArcFace ONNX session created. Models ready.');
    modelsLoaded = true;
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  async function loadFaceData(storageAdapter) {
    _storageAdapter = storageAdapter;

    // Try loading v3 data first
    const stored = await storageAdapter.get([FACE_DATA_KEY]);
    if (stored[FACE_DATA_KEY]) {
      faceData = stored[FACE_DATA_KEY];
      // Rebuild _serializedPhotos from stored data so subsequent saves don't
      // wipe already-scanned entries (only _dirtyPhotos get re-serialized).
      _serializedPhotos = {};
      for (const path in faceData.photos) {
        // Keep the raw stored form (Array descriptors) for serialization cache
        _serializedPhotos[path] = faceData.photos[path].map(f => ({
          box: f.box,
          descriptor: Array.isArray(f.descriptor) ? f.descriptor : Array.from(f.descriptor),
          score: f.score,
        }));
        // Convert descriptors to Float32Array for in-memory use
        for (const face of faceData.photos[path]) {
          if (face.descriptor && !(face.descriptor instanceof Float32Array)) {
            face.descriptor = new Float32Array(face.descriptor);
          }
        }
      }
      _dirtyPhotos.clear();
      if (!faceData.exclusions) faceData.exclusions = [];
      return faceData;
    }

    // V2 → V3 migration: preserve names, clear incompatible 128-dim descriptors
    const legacy = await storageAdapter.get([LEGACY_FACE_DATA_KEY]);
    if (legacy[LEGACY_FACE_DATA_KEY]) {
      const oldData = legacy[LEGACY_FACE_DATA_KEY];
      // Build photo → cluster name map to restore after re-scanning
      const legacyNames = {};
      for (const c of (oldData.clusters || [])) {
        if (c.name) {
          for (const p of c.photos) legacyNames[p] = c.name;
        }
      }
      faceData = {
        photos: {},   // Clear — 128-dim descriptors incompatible with 512-dim
        clusters: [],
        exclusions: oldData.exclusions || [],
        legacyNames: Object.keys(legacyNames).length > 0 ? legacyNames : null,
        version: 3,
      };
      await saveFaceData(storageAdapter);
      await storageAdapter.remove([LEGACY_FACE_DATA_KEY]);
      console.log('Migrated face data v2→v3. Preserved', Object.keys(legacyNames).length, 'name mappings. Rescan needed for ArcFace embeddings.');
      return faceData;
    }

    // No existing data
    if (!faceData.exclusions) faceData.exclusions = [];
    return faceData;
  }

  async function saveFaceData(storageAdapter) {
    // Incrementally serialize only new/changed photos
    for (const path of _dirtyPhotos) {
      _serializedPhotos[path] = faceData.photos[path].map(f => ({
        box: f.box,
        descriptor: Array.from(f.descriptor),
        score: f.score,
      }));
    }
    _dirtyPhotos.clear();
    // Remove any photos deleted from faceData
    for (const path in _serializedPhotos) {
      if (!(path in faceData.photos)) delete _serializedPhotos[path];
    }
    const serializable = {
      version: faceData.version,
      photos: _serializedPhotos,
      clusters: faceData.clusters,
      exclusions: faceData.exclusions || [],
      legacyNames: faceData.legacyNames || null,
    };
    // Yield to UI before the IPC call
    await new Promise(r => setTimeout(r, 0));
    await storageAdapter.set({ [FACE_DATA_KEY]: serializable });
  }

  // ── Image Downloader ───────────────────────────────────────────────────────
  function setImageDownloader(fn) {
    _imageDownloader = fn;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = src;
    });
  }

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

  // ── ArcFace Alignment & Embedding ──────────────────────────────────────────

  // Extract 5 key points from face-api.js 68-point landmarks
  function getLandmarks5(landmarks) {
    const pts = landmarks.positions;
    // Left eye center (average of points 36-41)
    let lx = 0, ly = 0;
    for (let i = 36; i <= 41; i++) { lx += pts[i].x; ly += pts[i].y; }
    lx /= 6; ly /= 6;
    // Right eye center (average of points 42-47)
    let rx = 0, ry = 0;
    for (let i = 42; i <= 47; i++) { rx += pts[i].x; ry += pts[i].y; }
    rx /= 6; ry /= 6;
    return [
      [lx, ly],                      // left eye
      [rx, ry],                      // right eye
      [pts[30].x, pts[30].y],       // nose tip
      [pts[48].x, pts[48].y],       // left mouth corner
      [pts[54].x, pts[54].y],       // right mouth corner
    ];
  }

  // Compute similarity transform (rotation + uniform scale + translation)
  // from source landmarks to destination reference points
  function estimateTransform(src, dst) {
    const n = src.length;
    let srcMx = 0, srcMy = 0, dstMx = 0, dstMy = 0;
    for (let i = 0; i < n; i++) {
      srcMx += src[i][0]; srcMy += src[i][1];
      dstMx += dst[i][0]; dstMy += dst[i][1];
    }
    srcMx /= n; srcMy /= n; dstMx /= n; dstMy /= n;

    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const sx = src[i][0] - srcMx, sy = src[i][1] - srcMy;
      const dx = dst[i][0] - dstMx, dy = dst[i][1] - dstMy;
      num1 += dx * sx + dy * sy;
      num2 += dx * sy - dy * sx;
      den += sx * sx + sy * sy;
    }
    const a = num1 / den, b = num2 / den;
    const tx = dstMx - a * srcMx + b * srcMy;
    const ty = dstMy - b * srcMx - a * srcMy;
    return { a, b, tx, ty };
  }

  // Align a face to 112x112 using similarity transform
  function alignFace(imgElement, landmarks) {
    const src5 = getLandmarks5(landmarks);
    const tfm = estimateTransform(src5, ARCFACE_REF_POINTS);
    const canvas = document.createElement('canvas');
    canvas.width = ARCFACE_INPUT_SIZE;
    canvas.height = ARCFACE_INPUT_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(tfm.a, tfm.b, -tfm.b, tfm.a, tfm.tx, tfm.ty);
    ctx.drawImage(imgElement, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  // Run ArcFace ONNX inference on an aligned 112x112 face canvas
  async function arcfaceEmbed(alignedCanvas) {
    const ctx = alignedCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE);
    const pixels = imageData.data;
    const npixels = ARCFACE_INPUT_SIZE * ARCFACE_INPUT_SIZE;
    const float32 = new Float32Array(3 * npixels);
    // NCHW format, normalize to [-1, 1]
    for (let i = 0; i < npixels; i++) {
      float32[i]                  = (pixels[i * 4]     - 127.5) / 127.5; // R
      float32[npixels + i]        = (pixels[i * 4 + 1] - 127.5) / 127.5; // G
      float32[2 * npixels + i]    = (pixels[i * 4 + 2] - 127.5) / 127.5; // B
    }
    const input = new ort.Tensor('float32', float32, [1, 3, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE]);
    const inputName = arcfaceSession.inputNames[0];
    const results = await arcfaceSession.run({ [inputName]: input });
    const outputName = arcfaceSession.outputNames[0];
    const raw = results[outputName].data;
    return l2Normalize(raw);
  }

  function l2Normalize(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    const result = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) result[i] = vec[i] / norm;
    return result;
  }

  // ── Distance Metric ────────────────────────────────────────────────────────
  // Cosine distance for L2-normalized ArcFace embeddings: 1 - dot(a,b)
  function cosineDistance(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  // ── Face Detection ─────────────────────────────────────────────────────────
  async function detectFaces(imgElement) {
    const input = downscaleForDetection(imgElement);
    const options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_SCORE,
    });
    // Detect + landmarks only — ArcFace replaces face-api recognition
    const detections = await faceapi
      .detectAllFaces(input, options)
      .withFaceLandmarks();

    const faces = [];
    for (const d of detections) {
      if (d.detection.box.width < MIN_FACE_SIZE || d.detection.box.height < MIN_FACE_SIZE) continue;
      const aligned = alignFace(input, d.landmarks);
      const descriptor = await arcfaceEmbed(aligned);
      faces.push({
        box: {
          x: Math.round(d.detection.box.x),
          y: Math.round(d.detection.box.y),
          w: Math.round(d.detection.box.width),
          h: Math.round(d.detection.box.height),
        },
        descriptor,
        score: d.detection.score,
      });
    }
    return faces;
  }

  // ── Scan a single photo using full-resolution download ─────────────────────
  async function scanPhotoFullRes(photoPath) {
    if (faceData.photos[photoPath]) return faceData.photos[photoPath];

    if (!_imageDownloader) {
      faceData.photos[photoPath] = [];
      _dirtyPhotos.add(photoPath);
      return [];
    }

    let blobUrl = null;
    try {
      blobUrl = await _imageDownloader(photoPath);
      const img = await loadImage(blobUrl);
      const faces = await detectFaces(img);
      faceData.photos[photoPath] = faces;
      _dirtyPhotos.add(photoPath);
      return faces;
    } catch (e) {
      // Re-throw auth errors so the scan loop can abort
      if (e.status === 401 || e.status === 403) throw e;
      console.warn('Face scan failed for', photoPath, e.message);
      faceData.photos[photoPath] = [];
      _dirtyPhotos.add(photoPath);
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
        .withFaceLandmarks();
      const faces = [];
      for (const d of detections) {
        if (d.detection.box.width < 30) continue;
        const aligned = alignFace(input, d.landmarks);
        const descriptor = await arcfaceEmbed(aligned);
        faces.push({
          box: {
            x: Math.round(d.detection.box.x),
            y: Math.round(d.detection.box.y),
            w: Math.round(d.detection.box.width),
            h: Math.round(d.detection.box.height),
          },
          descriptor,
          score: d.detection.score,
        });
      }
      faceData.photos[photoPath] = faces;
      _dirtyPhotos.add(photoPath);
      return faces;
    } catch (e) {
      faceData.photos[photoPath] = [];
      _dirtyPhotos.add(photoPath);
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
    const CLUSTER_INTERVAL = 5;
    const SAVE_INTERVAL = 50;

    while (scanQueue.length > 0 && !scanAbort) {
      const item = scanQueue.shift();
      if (faceData.photos[item.path]) { scanned++; continue; }

      let faces;
      try {
        if (item.fullRes && _imageDownloader) {
          faces = await scanPhotoFullRes(item.path);
        } else if (item.thumbDataUrl) {
          faces = await scanPhotoThumb(item.thumbDataUrl, item.path);
        } else {
          faceData.photos[item.path] = [];
          _dirtyPhotos.add(item.path);
          faces = [];
        }
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          console.error('[FaceScan] Auth error — aborting scan. Token may have expired.');
          scanQueue.length = 0;
          scanning = false;
          if (onComplete) onComplete(faceData.clusters);
          return;
        }
        throw e;
      }

      facesFound += faces.length;
      scanned++;
      photosSinceLastSave++;
      if (faces.length > 0) photosSinceLastCluster++;

      if (photosSinceLastCluster >= CLUSTER_INTERVAL) {
        incrementalCluster();
        photosSinceLastCluster = 0;
      }

      if (photosSinceLastSave >= SAVE_INTERVAL && _storageAdapter) {
        await saveFaceData(_storageAdapter);
        photosSinceLastSave = 0;
      }

      if (onProgress) {
        onProgress(scanned, totalQueued, facesFound, faceData.clusters);
      }

      await new Promise(r => setTimeout(r, 5));
    }

    // Final incremental cluster pass
    incrementalCluster();

    // After first scan completes, try to restore legacy names by photo overlap
    if (faceData.legacyNames && Object.keys(faceData.legacyNames).length > 0) {
      restoreLegacyNames();
    }

    scanning = false;
    if (onComplete) onComplete(faceData.clusters);
  }

  // Restore cluster names from v2→v3 migration by matching photo paths
  function restoreLegacyNames() {
    if (!faceData.legacyNames) return;
    for (const cluster of faceData.clusters) {
      if (cluster.name) continue; // Already named
      // Vote: which legacy name appears most for this cluster's photos?
      const nameVotes = {};
      for (const photoPath of cluster.photos) {
        const legacyName = faceData.legacyNames[photoPath];
        if (legacyName) {
          nameVotes[legacyName] = (nameVotes[legacyName] || 0) + 1;
        }
      }
      let bestName = '';
      let bestCount = 0;
      for (const name in nameVotes) {
        if (nameVotes[name] > bestCount) {
          bestCount = nameVotes[name];
          bestName = name;
        }
      }
      // Only assign if at least 2 photos match, or cluster is small
      if (bestName && (bestCount >= 2 || cluster.photos.length <= 3)) {
        cluster.name = bestName;
      }
    }
    // Auto-merge clusters that received the same legacy name (preserves prior manual merges)
    const nameMap = {};
    for (const cluster of faceData.clusters) {
      if (!cluster.name) continue;
      if (nameMap[cluster.name]) {
        // Merge this cluster into the first one with this name
        const keep = nameMap[cluster.name];
        const allPhotos = new Set([...keep.photos, ...cluster.photos]);
        keep.photos = [...allPhotos];
        keep.photoCount = allPhotos.size;
        recalcClusterCentroid(keep);
        cluster._remove = true;
      } else {
        nameMap[cluster.name] = cluster;
      }
    }
    faceData.clusters = faceData.clusters.filter(c => !c._remove);
    // Clear legacy names after restoration attempt
    faceData.legacyNames = null;
  }

  function abortScanning() {
    scanAbort = true;
    scanQueue = [];
  }

  // ── Clustering: Chinese Whispers ───────────────────────────────────────────

  function rebuildClusters() {
    const allFaces = [];
    for (const path in faceData.photos) {
      for (const face of faceData.photos[path]) {
        if (face.descriptor?.length === DESCRIPTOR_DIM && face.score >= MIN_DETECTION_SCORE) {
          allFaces.push({ path, face });
        }
      }
    }

    if (allFaces.length === 0) {
      faceData.clusters = [];
      return;
    }

    const n = allFaces.length;
    const neighbors = new Array(n);
    for (let i = 0; i < n; i++) neighbors[i] = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = cosineDistance(allFaces[i].face.descriptor, allFaces[j].face.descriptor);
        if (dist < DISTANCE_THRESHOLD) {
          neighbors[i].push(j);
          neighbors[j].push(i);
        }
      }
    }

    const labels = new Array(n);
    for (let i = 0; i < n; i++) labels[i] = i;

    for (let iter = 0; iter < CW_ITERATIONS; iter++) {
      let changed = false;
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }

      for (const i of order) {
        if (neighbors[i].length === 0) continue;
        const labelCounts = {};
        for (const nb of neighbors[i]) {
          const lbl = labels[nb];
          labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
        }
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

    const groups = {};
    for (let i = 0; i < n; i++) {
      const lbl = labels[i];
      if (!groups[lbl]) groups[lbl] = [];
      groups[lbl].push(allFaces[i]);
    }

    const oldClusters = faceData.clusters.slice();

    const clusters = [];
    for (const lbl in groups) {
      const members = groups[lbl];
      if (members.length < 1) continue;

      const photos = new Set(members.map(m => m.path));

      const bestMember = members.reduce((a, b) =>
        b.face.score > a.face.score ? b : a, members[0]);

      // Compute centroid and L2-normalize
      const centroid = new Float32Array(DESCRIPTOR_DIM);
      for (const m of members) {
        for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] += m.face.descriptor[i];
      }
      for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] /= members.length;
      const normCentroid = l2Normalize(centroid);

      // Try to match to an existing named cluster
      let id = 'face_' + Date.now() + '_' + clusters.length;
      let name = '';
      for (const old of oldClusters) {
        if (old.name && old.sampleDescriptor) {
          const oldDesc = old.sampleDescriptor instanceof Float32Array
            ? old.sampleDescriptor : new Float32Array(old.sampleDescriptor);
          const dist = cosineDistance(normCentroid, oldDesc);
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
        sampleDescriptor: Array.from(normCentroid),
        photoCount: photos.size,
        photos: [...photos],
      });
    }

    clusters.sort((a, b) => b.photoCount - a.photoCount);
    faceData.clusters = clusters;
  }

  function recalcClusterCentroid(cluster) {
    const descriptors = [];
    for (const photoPath of cluster.photos) {
      const faces = faceData.photos[photoPath];
      if (!faces) continue;
      for (const face of faces) {
        if (face.descriptor?.length === DESCRIPTOR_DIM && face.score >= MIN_DETECTION_SCORE) {
          descriptors.push(face.descriptor);
        }
      }
    }
    if (descriptors.length === 0) return;
    const centroid = new Float32Array(DESCRIPTOR_DIM);
    for (const d of descriptors) {
      for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] += d[i];
    }
    for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] /= descriptors.length;
    const normCentroid = l2Normalize(centroid);
    cluster.sampleDescriptor = Array.from(normCentroid);
  }

  // ── Incremental Clustering ─────────────────────────────────────────────────
  function incrementalCluster() {
    const assignedPhotos = new Set();
    for (const cluster of faceData.clusters) {
      for (const p of cluster.photos) assignedPhotos.add(p);
    }

    const newFaces = [];
    for (const path in faceData.photos) {
      if (assignedPhotos.has(path)) continue;
      for (const face of faceData.photos[path]) {
        if (face.descriptor?.length === DESCRIPTOR_DIM && face.score >= MIN_DETECTION_SCORE) {
          newFaces.push({ path, face });
        }
      }
    }

    if (newFaces.length === 0) return;

    const clusterCentroids = faceData.clusters.map(c => ({
      cluster: c,
      centroid: c.sampleDescriptor instanceof Float32Array
        ? c.sampleDescriptor : new Float32Array(c.sampleDescriptor),
    }));

    const exclusionMap = new Map();
    for (const ex of (faceData.exclusions || [])) {
      if (!exclusionMap.has(ex.photoPath)) exclusionMap.set(ex.photoPath, new Set());
      exclusionMap.get(ex.photoPath).add(ex.clusterId);
    }

    const unmatched = [];
    const clusterAdditions = new Map();
    for (const entry of newFaces) {
      const excluded = exclusionMap.get(entry.path);
      let bestCluster = null;
      let bestDist = DISTANCE_THRESHOLD;
      for (const { cluster, centroid } of clusterCentroids) {
        if (excluded && excluded.has(cluster.id)) continue;
        const dist = cosineDistance(entry.face.descriptor, centroid);
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = cluster;
        }
      }
      if (bestCluster) {
        if (!clusterAdditions.has(bestCluster.id)) {
          clusterAdditions.set(bestCluster.id, new Set());
        }
        clusterAdditions.get(bestCluster.id).add(entry.path);
      } else {
        unmatched.push(entry);
      }
    }

    for (const [clusterId, paths] of clusterAdditions) {
      const cluster = faceData.clusters.find(c => c.id === clusterId);
      if (!cluster) continue;
      const photoSet = new Set(cluster.photos);
      for (const p of paths) photoSet.add(p);
      cluster.photos = [...photoSet];
      cluster.photoCount = cluster.photos.length;
      recalcClusterCentroid(cluster);
    }

    if (unmatched.length > 0) {
      const n = unmatched.length;
      const neighbors = new Array(n);
      for (let i = 0; i < n; i++) neighbors[i] = [];

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dist = cosineDistance(unmatched[i].face.descriptor, unmatched[j].face.descriptor);
          if (dist < DISTANCE_THRESHOLD) {
            neighbors[i].push(j);
            neighbors[j].push(i);
          }
        }
      }

      const labels = new Array(n);
      for (let i = 0; i < n; i++) labels[i] = i;

      for (let iter = 0; iter < CW_ITERATIONS; iter++) {
        let changed = false;
        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (const i of order) {
          if (neighbors[i].length === 0) continue;
          const labelCounts = {};
          for (const nb of neighbors[i]) {
            const lbl = labels[nb];
            labelCounts[lbl] = (labelCounts[lbl] || 0) + 1;
          }
          let bestLabel = labels[i], bestCount = 0;
          for (const lbl in labelCounts) {
            if (labelCounts[lbl] > bestCount) {
              bestCount = labelCounts[lbl];
              bestLabel = parseInt(lbl);
            }
          }
          if (labels[i] !== bestLabel) { labels[i] = bestLabel; changed = true; }
        }
        if (!changed) break;
      }

      const groups = {};
      for (let i = 0; i < n; i++) {
        const lbl = labels[i];
        if (!groups[lbl]) groups[lbl] = [];
        groups[lbl].push(unmatched[i]);
      }

      for (const lbl in groups) {
        const members = groups[lbl];
        const photos = [...new Set(members.map(m => m.path))];
        const bestMember = members.reduce((a, b) =>
          b.face.score > a.face.score ? b : a, members[0]);

        const centroid = new Float32Array(DESCRIPTOR_DIM);
        for (const m of members) {
          for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] += m.face.descriptor[i];
        }
        for (let i = 0; i < DESCRIPTOR_DIM; i++) centroid[i] /= members.length;
        const normCentroid = l2Normalize(centroid);

        faceData.clusters.push({
          id: 'face_' + Date.now() + '_' + lbl,
          name: '',
          samplePhoto: bestMember.path,
          sampleBox: bestMember.face.box,
          sampleDescriptor: Array.from(normCentroid),
          photoCount: photos.length,
          photos,
        });
      }
    }

    faceData.clusters.sort((a, b) => b.photoCount - a.photoCount);
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

  function getFaceBox(photoPath) {
    const faces = faceData.photos[photoPath];
    if (!faces || faces.length === 0) return null;
    return faces.reduce((a, b) => b.score > a.score ? b : a, faces[0]).box;
  }

  async function clearFaceData(storageAdapter) {
    faceData = { photos: {}, clusters: [], exclusions: [], legacyNames: null, version: 3 };
    scanQueue = [];
    _serializedPhotos = {};
    _dirtyPhotos.clear();
    await storageAdapter.remove([FACE_DATA_KEY]);
  }

  async function resetScanData(storageAdapter) {
    faceData.photos = {};
    scanQueue = [];
    _serializedPhotos = {};
    _dirtyPhotos.clear();
    await saveFaceData(storageAdapter);
  }

  function mergeClusters(keepId, mergeId) {
    const keep = faceData.clusters.find(c => c.id === keepId);
    const merge = faceData.clusters.find(c => c.id === mergeId);
    if (!keep || !merge) return false;

    const allPhotos = new Set([...keep.photos, ...merge.photos]);
    keep.photos = [...allPhotos];
    keep.photoCount = allPhotos.size;
    recalcClusterCentroid(keep);

    faceData.clusters = faceData.clusters.filter(c => c.id !== mergeId);
    return true;
  }

  function removePhotoFromCluster(clusterId, photoPath) {
    const cluster = faceData.clusters.find(c => c.id === clusterId);
    if (!cluster) return false;

    cluster.photos = cluster.photos.filter(p => p !== photoPath);
    cluster.photoCount = cluster.photos.length;

    if (!faceData.exclusions) faceData.exclusions = [];
    const alreadyExcluded = faceData.exclusions.some(
      ex => ex.photoPath === photoPath && ex.clusterId === clusterId
    );
    if (!alreadyExcluded) {
      faceData.exclusions.push({ photoPath, clusterId });
    }

    if (cluster.photoCount === 0) {
      faceData.clusters = faceData.clusters.filter(c => c.id !== clusterId);
    }
    return true;
  }

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

  function deleteCluster(clusterId) {
    faceData.clusters = faceData.clusters.filter(c => c.id !== clusterId);
  }

  // Merge all clusters sharing the same name (for legacy migration or manual consolidation)
  function mergeByName() {
    const nameMap = {};
    let merged = 0;
    for (const cluster of faceData.clusters) {
      if (!cluster.name) continue;
      if (nameMap[cluster.name]) {
        const keep = nameMap[cluster.name];
        const allPhotos = new Set([...keep.photos, ...cluster.photos]);
        keep.photos = [...allPhotos];
        keep.photoCount = allPhotos.size;
        recalcClusterCentroid(keep);
        cluster._remove = true;
        merged++;
      } else {
        nameMap[cluster.name] = cluster;
      }
    }
    faceData.clusters = faceData.clusters.filter(c => !c._remove);
    return merged;
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
    resetScanData,
    rebuildClusters,
    mergeClusters,
    mergeByName,
    removePhotoFromCluster,
    movePhotoToCluster,
    deleteCluster,
  };
})();
