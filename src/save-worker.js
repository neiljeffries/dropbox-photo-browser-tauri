// Web Worker — serializes large objects to JSON off the main thread.
// Receives: { id, key, value }
// Responds: { id, key, json } or { id, error }
self.onmessage = (e) => {
  const { id, key, value } = e.data;
  try {
    const json = JSON.stringify(value);
    self.postMessage({ id, key, json });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
