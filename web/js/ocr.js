// Skenuotų liudijimų atpažinimas naršyklėje.
//
// Naudojamas PP-OCR (PaddleOCR modeliai per ONNX Runtime) – tas pats variklis,
// kuris veikia ir vietinėje Python versijoje. Jis smulkų CoC šriftą skaito kur
// kas tiksliau nei Tesseract: dvitaškiai, nuliai ir raidė „J“ nebesusipainioja.
//
// Visi failai – variklis ir modeliai – guli šalia puslapio, todėl atpažinimas
// veikia ir be interneto, o vaizdai niekur nesiunčiami.

// Keliai – nuo šio failo, kad variklis veiktų ir iš sandėlio puslapio.
const asset = (path) => new URL(`../vendor/ppocr/${path}`, import.meta.url).href;
const BUNDLE = asset("ppocr.js");
const MODELS = {
  detectionPath: asset("models/det.onnx"),
  recognitionPath: asset("models/rec.onnx"),
  dictionaryPath: asset("models/keys.txt"),
};

let enginePromise = null;

function loadBundle() {
  return new Promise((resolve, reject) => {
    if (window.GutenOcr) { resolve(); return; }
    const script = document.createElement("script");
    script.src = BUNDLE;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Nepavyko įkelti atpažinimo variklio."));
    document.head.appendChild(script);
  });
}

/** Variklis paruošiamas vieną kartą – kitiems failams nebereikia laukti. */
function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      await loadBundle();
      const ort = window.__ort;
      // Kelias nurodomas pilnas: kitaip vykdymo aplinka jį pridėtų prie savo
      // scenarijaus adreso ir gautųsi „vendor/ppocr/vendor/ppocr/…“.
      ort.env.wasm.wasmPaths = asset("ort/");
      ort.env.wasm.numThreads = threadCount();
      ort.env.logLevel = "error";
      return window.GutenOcr.create({ models: MODELS });
    })();
  }
  return enginePromise;
}

/**
 * Kiek gijų naudoti.
 *
 * Kelios gijos leidžiamos tik tada, kai puslapis „kryžmiškai izoliuotas“
 * (`crossOriginIsolated`) – to pasiekiama per aptarnaujantį failą `sw.js`.
 */
function threadCount() {
  if (!self.crossOriginIsolated) return 1;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}

/** Iš PP-OCR keturkampio gaunamas fragmentas su koordinatėmis. */
function fromBox(entry) {
  const xs = entry.box.map((point) => point[0]);
  const ys = entry.box.map((point) => point[1]);
  return {
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    text: entry.text,
  };
}

// --- Foninis procesas -------------------------------------------------------
//
// Atpažinimas užima procesorių po kelias sekundes iš eilės. Pagrindiniame lange
// tai „užšaldo“ puslapį, todėl pirmiausia bandoma foniniame procese
// (`ocr-worker.js`). Jei jo paleisti nepavyksta, skaitoma kaip anksčiau – lange.

const pending = new Map();
let sequence = 0;

function call(worker, message, transfer = []) {
  return new Promise((resolve, reject) => {
    sequence += 1;
    pending.set(sequence, { resolve, reject, worker });
    worker.postMessage({ ...message, id: sequence }, transfer);
  });
}

/**
 * Kiek lapų skaityti vienu metu.
 *
 * Vienas lapas vienu metu išnaudoja tik dalį procesoriaus, todėl keli
 * foniniai procesai lygiagrečiai apdoroja partiją kelis kartus greičiau.
 * Daugiau nei trijų nereikia – kiekvienas užima ~200 MB atminties.
 */
export function parallelism() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(3, Math.floor(cores / 2)));
}

/** Gijos vienam foniniam procesui – kad visi kartu neviršytų branduolių skaičiaus. */
function workerThreads() {
  if (!self.crossOriginIsolated) return 1;
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, Math.floor((cores - 1) / parallelism())));
}

async function spawn() {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined"
      || typeof createImageBitmap === "undefined") return null;
  const worker = new Worker(new URL("./ocr-worker.js", import.meta.url));
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    for (const [id, job] of pending) {
      if (job.worker !== worker) continue;
      pending.delete(id);
      job.reject(new Error(event.message || "Foninis procesas sustojo."));
    }
  };
  await call(worker, {
    type: "start", bundle: BUNDLE, models: MODELS, wasmPaths: asset("ort/"), threads: workerThreads(),
  });
  return worker;
}

// Foninių procesų telkinys: kiekvienas vienu metu skaito vieną vaizdą.
const slots = [];
const waiting = [];
let firstWorker = null;
let poolGrown = false;

function release(slot) {
  const next = waiting.shift();
  if (next) next(slot);
  else slot.busy = false;
}

function addSlot(worker) {
  const slot = { worker, busy: true };
  slots.push(slot);
  release(slot);
}

function getWorker() {
  if (!firstWorker) {
    firstWorker = spawn().then((worker) => {
      if (worker) addSlot(worker);
      return worker;
    }).catch(() => null);
  }
  return firstWorker;
}

/** Likę procesai paleidžiami tik tada, kai jų prireikia. */
function growPool() {
  if (poolGrown) return;
  poolGrown = true;
  for (let i = 1; i < parallelism(); i += 1) {
    spawn().then((worker) => { if (worker) addSlot(worker); }).catch(() => {});
  }
}

function acquire() {
  const free = slots.find((slot) => !slot.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve) => waiting.push((slot) => { slot.busy = true; resolve(slot); }));
}

/**
 * Ilgiausiai tiek laukiama vieno vaizdo – tik tikram užstrigimui pagauti.
 * Lėtesniame kompiuteryje visas lapas didesne raiška skaitomas ir ilgiau nei
 * minutę, todėl riba sąmoningai didelė.
 */
const DETECT_TIMEOUT = 5 * 60_000;

class OcrTimeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new OcrTimeout("Atpažinimas užtruko per ilgai.")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Užstrigęs ar sugedęs procesas išjungiamas, o vietoj jo paleidžiamas naujas. */
function replace(slot) {
  slot.worker.terminate();
  for (const [id, job] of pending) {
    if (job.worker !== slot.worker) continue;
    pending.delete(id);
    job.reject(new Error("Foninis procesas paleistas iš naujo."));
  }
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
  spawn().then((worker) => { if (worker) addSlot(worker); }).catch(() => {});
}

/** Atpažįsta drobę: foniniame procese, o nepavykus – lange. */
async function detect(canvas) {
  if (await getWorker()) {
    growPool();
    const slot = await acquire();
    let healthy = true;
    try {
      const bitmap = await createImageBitmap(canvas);
      return await withTimeout(call(slot.worker, { type: "detect", bitmap }, [bitmap]), DETECT_TIMEOUT);
    } catch (error) {
      healthy = false;
      replace(slot);
      // Užstrigus lange nebandome – tada užšaltų visas puslapis.
      if (error instanceof OcrTimeout) throw error;
    } finally {
      if (healthy) release(slot);
    }
  }
  const engine = await getEngine();
  return engine.detect(canvas.toDataURL("image/png"));
}

/** Ar atpažinimas vyksta foniniame procese (langas tada nestringa). */
export async function inBackground() {
  return Boolean(await getWorker());
}

/** Atpažįsta vieną puslapio vaizdą ir grąžina fragmentus su koordinatėmis. */
export async function recognise(canvas) {
  const result = await detect(canvas);
  return (result || [])
    .filter((entry) => entry && entry.text && entry.text.trim() && entry.box)
    .map(fromBox);
}

/** Perskaito vieną iškarpą ir grąžina jos tekstą (naudojama tikslinant). */
export async function recogniseLine(canvas) {
  const result = await detect(canvas);
  return (result || []).map((entry) => entry.text).join(" ").trim();
}

/** Iš anksto paruošia variklį (kad pirmas failas nelauktų). */
export function warmUp() {
  return getWorker().then((worker) => worker || getEngine()).then(() => true).catch(() => false);
}

/** Ar jau veikia keliomis gijomis (rodoma sąsajoje). */
export const threadsEnabled = () => self.crossOriginIsolated === true;
