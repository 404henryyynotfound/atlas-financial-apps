/* Meridian AI — private, on-device language model runtime.
   WebLLM runs entirely in the browser through WebGPU. There is no API key,
   no provider quota and no portfolio data sent to a server. */
const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm@0.2.89';
const WORKER_URL = new URL('./webllm.worker.js', import.meta.url);

let engine = null;
let worker = null;
let enginePromise = null;
let activeModelId = '';
let lastError = '';
let progressHandler = null;
let webgpuReady = null;

export function supportsAI() {
  if (typeof navigator === 'undefined' || !navigator.gpu || typeof Worker === 'undefined') return false;
  return webgpuReady !== false;
}

/* A browser can expose navigator.gpu without having a usable adapter. Check
   once so the UI can show a clear fallback before a model download starts. */
export async function detectAI() {
  if (typeof navigator === 'undefined' || !navigator.gpu || typeof Worker === 'undefined') {
    webgpuReady = false;
    return false;
  }
  if (webgpuReady !== null) return webgpuReady;
  try {
    webgpuReady = !!(await navigator.gpu.requestAdapter());
  } catch {
    webgpuReady = false;
  }
  return webgpuReady;
}

export function setProgressHandler(fn) { progressHandler = fn; }
export function activeModel() { return activeModelId; }
export function isLoaded() { return !!engine && !!activeModelId; }
export function error() { return lastError; }

function report(progress) {
  if (!progressHandler) return;
  progressHandler({
    percent: Math.round(Number(progress?.progress || 0) * 100),
    text: String(progress?.text || 'Preparing the local model…'),
  });
}

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker(WORKER_URL, { type: 'module' });
  worker.onerror = (event) => {
    lastError = event.message || 'The AI worker could not start.';
  };
  return worker;
}

export async function unload() {
  if (engine && typeof engine.unload === 'function') {
    try { await engine.unload(); } catch { /* worker may already be gone */ }
  }
  if (worker) { worker.terminate(); worker = null; }
  engine = null;
  enginePromise = null;
  activeModelId = '';
}

export async function load(modelId) {
  if (!(await detectAI())) {
    throw new Error('WebGPU is unavailable. Try the latest Chrome or Edge with hardware acceleration enabled.');
  }
  if (engine && activeModelId === modelId) return engine;
  if (enginePromise) return enginePromise;
  if (engine || worker) await unload();

  activeModelId = modelId;
  lastError = '';
  report({ progress: 0.01, text: 'Downloading the AI runtime…' });

  enginePromise = (async () => {
    const webllm = await import(WEBLLM_CDN);
    const nextWorker = createWorker();
    const nextEngine = await webllm.CreateWebWorkerMLCEngine(nextWorker, modelId, {
      initProgressCallback: report,
    });
    engine = nextEngine;
    activeModelId = modelId;
    report({ progress: 1, text: 'Model ready. Everything runs on this device.' });
    return engine;
  })().catch(err => {
    lastError = err?.message || String(err) || 'The local model could not be loaded.';
    if (worker) { worker.terminate(); worker = null; }
    activeModelId = '';
    enginePromise = null;
    throw err;
  });

  return enginePromise;
}

export async function chat({ messages, onToken }) {
  const model = engine;
  if (!model) throw new Error('Load a local model before starting a conversation.');

  const request = {
    messages,
    temperature: 0.35,
    top_p: 0.9,
    max_tokens: 700,
  };

  let full = '';
  const stream = await model.chat.completions.create({ ...request, stream: true });
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (delta) {
      full += delta;
      onToken?.(delta, full);
    }
  }

  if (!full) {
    const result = await model.chat.completions.create(request);
    full = result?.choices?.[0]?.message?.content || '';
    if (full) onToken?.(full, full);
  }
  return full;
}

export async function stop() {
  if (!engine || typeof engine.interruptGenerate !== 'function') return false;
  try { await engine.interruptGenerate(); return true; } catch { return false; }
}
