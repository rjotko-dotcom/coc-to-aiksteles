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

/** Atpažįsta vieną puslapio vaizdą ir grąžina fragmentus su koordinatėmis. */
export async function recognise(canvas) {
  const engine = await getEngine();
  const result = await engine.detect(canvas.toDataURL("image/png"));
  return (result || [])
    .filter((entry) => entry && entry.text && entry.text.trim() && entry.box)
    .map(fromBox);
}

/** Perskaito vieną iškarpą ir grąžina jos tekstą (naudojama tikslinant). */
export async function recogniseLine(canvas) {
  const engine = await getEngine();
  const result = await engine.detect(canvas.toDataURL("image/png"));
  return (result || []).map((entry) => entry.text).join(" ").trim();
}

/** Iš anksto paruošia variklį (kad pirmas failas nelauktų). */
export function warmUp() {
  return getEngine().then(() => true).catch(() => false);
}

/** Ar jau veikia keliomis gijomis (rodoma sąsajoje). */
export const threadsEnabled = () => self.crossOriginIsolated === true;
