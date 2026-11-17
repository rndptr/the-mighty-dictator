/* Classic worker: upstream glue publishes createCactus rather than an ESM export. */
let engine;
let loaded = false;
let loadedBit = 0;
let busy = false;
const decoder = new TextDecoder();

function progress(id, value) { self.postMessage({ id, type: 'progress', value }); }
async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function acquire(file, cache, id, offset, total) {
  let response = cache ? await cache.match(file.url) : undefined;
  let hit = Boolean(response);
  const valid = async bytes => bytes.byteLength === file.bytes && await digest(bytes) === file.sha256;
  if (response) {
    const bytes = await response.arrayBuffer();
    progress(id, { phase: 'verifying', detail: `Checking cached ${file.role}`, loaded: offset, total });
    if (await valid(bytes)) return { bytes, hit };
    await cache.delete(file.url); response = undefined; hit = false;
  }
  response = await fetch(file.url, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`Cannot fetch ${file.role} (HTTP ${response.status}). Prepare the pinned assets with the Docker tools service; see docs/container-usage.md.`);
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > file.bytes) { await reader.cancel(); throw new Error(`${file.role} exceeds its locked size.`); }
    chunks.push(value);
    progress(id, { phase: 'downloading', detail: `Downloading ${file.role}`, loaded: offset + count, total });
  }
  const bytes = new Uint8Array(count);
  let cursor = 0;
  for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
  progress(id, { phase: 'verifying', detail: `Verifying ${file.role}`, loaded: offset + count, total });
  if (!await valid(bytes)) throw new Error(`${file.role} integrity check failed. No unverified code or weights were loaded.`);
  let cacheWarning;
  if (cache) {
    try { await cache.put(file.url, new Response(bytes, { headers: { 'Content-Type': file.role === 'wasm' ? 'application/wasm' : 'application/octet-stream' } })); }
    catch { cacheWarning = 'Browser storage is full or unavailable. This session works, but some assets were not cached.'; }
  }
  return { bytes: bytes.buffer, hit, cacheWarning };
}

function allocate(bytes) {
  const pointer = engine._malloc(bytes.byteLength);
  if (!pointer) throw new Error('WASM memory allocation failed. Try a smaller image or close other tabs.');
  engine.HEAPU8.set(new Uint8Array(bytes), pointer);
  return pointer;
}
function lastError() { return engine.UTF8ToString(engine._cactus_last_error()) || 'Cactus returned an unspecified error.'; }

async function load(value, id) {
  const start = performance.now();
  let cache; let cacheWarning;
  try { cache = await caches.open(value.cacheName); }
  catch { cacheWarning = 'Persistent browser caching is unavailable; assets will be held for this session only.'; }
  let offset = 0; let cacheHits = 0;
  const total = value.assets.reduce((sum, file) => sum + file.bytes, 0);
  // Keep acquired binary buffers inside this worker, never the UI thread.
  const acquired = {};
  for (const file of value.assets) {
    const result = await acquire(file, cache, id, offset, total);
    acquired[file.role] = result.bytes;
    if (result.hit) cacheHits++;
    cacheWarning = result.cacheWarning || cacheWarning;
    offset += file.bytes;
  }
  progress(id, { phase: 'initializing', detail: 'Initializing Cactus WASM', loaded: total, total });
  const glueURL = URL.createObjectURL(new Blob([acquired.glue], { type: 'text/javascript' }));
  try { importScripts(glueURL); } finally { URL.revokeObjectURL(glueURL); }
  engine = await self.createCactus({ wasmBinary: new Uint8Array(acquired.wasm) });
  const pointer = allocate(acquired.model);
  try {
    // Emscripten builds may legalize uint64 to low/high arguments, or use BigInt.
    const code = engine._cactus_load.length === 3
      ? engine._cactus_load(pointer, acquired.model.byteLength, 0)
      : engine._cactus_load(pointer, BigInt(acquired.model.byteLength));
    if (code < 0) throw new Error(lastError());
    if (!(engine._cactus_models() & value.modelBit)) throw new Error('The archive did not load the selected model family.');
  } finally { engine._free(pointer); }
  loaded = true;
  loadedBit = value.modelBit;
  return { loadMs: performance.now() - start, cacheHits, cacheWarning };
}

function run(value) {
  if (!loaded) throw new Error('The model is not ready.');
  if (value.task === 'image.describe' && (loadedBit !== 4 || value.rgb.byteLength !== value.width * value.height * 3)) throw new Error('Invalid RGB image request.');
  if (value.task === 'audio.transcribe' && (loadedBit !== 2 || value.pcm.byteLength % 4 || !value.pcm.byteLength || value.pcm.byteLength > 16000 * 30 * 4)) throw new Error('Audio must be 1–30 seconds of mono 16 kHz float samples.');
  if (value.task === 'text.complete' && (loadedBit !== 1 || !value.text || value.text.length > 16000 || !Array.isArray(value.tools))) throw new Error('Invalid Needle input.');
  let rgb = 0; let output = 0;
  const capacity = 16 * 1024 * 1024;
  try {
    if (value.task === 'image.describe') rgb = allocate(value.rgb);
    if (value.task === 'audio.transcribe') {
      const samples = new Float32Array(value.pcm);
      if (!samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)) throw new Error('Audio samples must be finite and in [-1, 1].');
      rgb = allocate(value.pcm);
    }
    output = engine._malloc(capacity);
    if (!output) throw new Error('Unable to allocate the result buffer.');
    engine.HEAPU8[output] = 0;
    const start = performance.now();
    let code;
    if (value.task === 'image.describe') {
      code = engine.ccall('cactus_describe', 'number',
        ['number', 'number', 'number', 'string', 'string', 'string', 'number', 'number'],
        [rgb, value.width, value.height, JSON.stringify(value.options), 'en', null, output, capacity]);
    } else if (value.task === 'audio.transcribe') {
      code = engine.ccall('cactus_transcribe', 'number',
        ['number', 'number', 'string', 'string', 'number', 'number', 'number'],
        [rgb, value.pcm.byteLength / 4, value.language || null, value.keywords || null, Number(value.timestamps), output, capacity]);
    } else if (value.task === 'text.complete') {
      // Each experiment starts from a fresh schema/conversation. No proposed
      // tool call is executed by this workbench.
      engine._cactus_reset();
      const initialized = engine.ccall('cactus_init', 'number', ['string', 'string', 'string'], [value.system || '', JSON.stringify(value.tools), null]);
      if (initialized < 0) throw new Error(lastError());
      code = engine.ccall('cactus_complete', 'number', ['string', 'number', 'number', 'number', 'number', 'number'],
        [value.text, 0, 0, value.maxTokens, output, capacity]);
    } else throw new Error('Unsupported task.');
    const inferenceMs = performance.now() - start;
    if (code < 0) throw new Error(lastError());
    if (code >= capacity) throw new Error('Result exceeded the output buffer. Lower object/text limits.');
    const slice = engine.HEAPU8.subarray(output, output + capacity);
    const end = slice.indexOf(0);
    if (end < 0) throw new Error('Cactus returned an unterminated output buffer.');
    const rawText = decoder.decode(slice.subarray(0, end));
    let raw; const warnings = [];
    try { raw = JSON.parse(rawText); }
    catch {
      // Known upstream issue: non-finite score literals can invalidate JSON.
      // Match whole strings first to leave their content untouched. Preserve
      // the exact engine response separately; never conceal this conversion.
      const normalized = rawText.replace(/"(?:\\.|[^"\\])*"|-?(?:nan|inf|NaN|Infinity)\b/g,
        token => token.startsWith('"') ? token : 'null');
      raw = JSON.parse(normalized);
      warnings.push('Non-finite model literals were converted to null. Exact output is preserved in rawText.');
    }
    return { raw, rawText, warnings, inferenceMs };
  } finally { if (rgb) engine._free(rgb); if (output) engine._free(output); }
}

self.onmessage = async ({ data: { id, type, value } }) => {
  if (busy) { self.postMessage({ id, type: 'error', message: 'The worker is already busy.' }); return; }
  busy = true;
  try {
    const result = type === 'load' ? await load(value, id) : type === 'run' ? run(value) : (() => { throw new Error('Unknown worker request.'); })();
    self.postMessage({ id, type: 'result', value: result });
  } catch (error) { self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { busy = false; }
};
