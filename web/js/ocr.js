// Skenuotų liudijimų atpažinimas naršyklėje (Tesseract, WebAssembly).
//
// Visi failai – variklis, modelis ir kalbos duomenys – guli šalia puslapio,
// todėl atpažinimas veikia ir be interneto, o vaizdai niekur nesiunčiami.

const WORKER_PATH = "./vendor/tesseract/worker.min.js";
const CORE_PATH = "./vendor/tesseract/core";
const LANG_PATH = "./vendor/tessdata";

/** Viso puslapio skaitymas: stulpelio režimas atpažįsta formą tiksliausiai. */
const PAGE_PARAMS = {
  tessedit_pageseg_mode: "4",
  tessedit_char_whitelist: "",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

/** Vienos reikšmės skaitymas: kodai rašomi tik didžiosiomis ir skaitmenimis. */
const LINE_PARAMS = {
  tessedit_pageseg_mode: "7",
  tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*/-.",
  preserve_interword_spaces: "1",
  user_defined_dpi: "300",
};

let workerPromise = null;
let currentParams = null;

async function withParams(worker, params) {
  if (currentParams === params) return;
  await worker.setParameters(params);
  currentParams = params;
}

/** Variklis paleidžiamas vieną kartą – kitiems failams nebereikia laukti. */
function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker("eng", 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      gzip: true,
      logger: (message) => {
        if (onProgress && message.status && typeof message.progress === "number") {
          onProgress(message.status, message.progress);
        }
      },
    });
  }
  return workerPromise;
}

/** Iš Tesseract rezultato surenka žodžius su koordinatėmis. */
function wordsFrom(data) {
  const words = [];
  const push = (word) => {
    if (!word || !word.text || !word.text.trim() || !word.bbox) return;
    const { x0, y0, x1, y1 } = word.bbox;
    words.push({
      y: (y0 + y1) / 2,
      x0,
      x1,
      h: y1 - y0,
      text: word.text,
    });
  };

  if (Array.isArray(data.words) && data.words.length) {
    data.words.forEach(push);
    return words;
  }
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        (line.words || []).forEach(push);
      }
    }
  }
  return words;
}

/** Atpažįsta vieną puslapio vaizdą ir grąžina fragmentus su koordinatėmis. */
export async function recognise(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  await withParams(worker, PAGE_PARAMS);
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  return wordsFrom(data);
}

/** Perskaito vieną iškarpą kaip vieną eilutę su griežta abėcėle. */
export async function recogniseLine(canvas) {
  const worker = await getWorker();
  await withParams(worker, LINE_PARAMS);
  const { data } = await worker.recognize(canvas, {}, { text: true });
  return (data.text || "").replace(/\n/g, " ").trim();
}

/** Iš anksto paruošia variklį (kad pirmas failas nelauktų). */
export function warmUp(onProgress) {
  return getWorker(onProgress).then(() => true).catch(() => false);
}
