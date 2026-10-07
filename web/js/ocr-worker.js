// Atpažinimas foniniame procese (Web Worker).
//
// PP-OCR vieno lapo atpažinimas trunka 5–20 s ir visą tą laiką užima
// procesorių. Pagrindiniame lange tai „užšaldo“ puslapį (Chrome net siūlo jį
// uždaryti), todėl variklis paleidžiamas čia, o langas lieka gyvas.
//
// Variklis parašytas naršyklės langui: jam reikia `document`, `Image` ir
// `<canvas>`. Foniniame procese jų nėra, todėl pateikiami pakaitalai su
// `OffscreenCanvas` – piešimo API ta pati.

/* eslint-env worker */
self.window = self;

/** Puslapių vaizdai, atsiųsti iš lango (be PNG kodavimo – tiesiog paveikslėlis). */
const bitmaps = new Map();

class WorkerImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.width = 0;
    this.height = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.complete = false;
    this.crossOrigin = "";
    this.ready = Promise.resolve();
  }

  set src(value) {
    this._src = value;
    this.ready = (async () => {
      let bitmap = bitmaps.get(value);
      if (!bitmap) bitmap = await createImageBitmap(await (await fetch(value)).blob());
      this.bitmap = bitmap;
      this.width = this.naturalWidth = bitmap.width;
      this.height = this.naturalHeight = bitmap.height;
      this.complete = true;
      if (this.onload) this.onload();
    })().catch((error) => {
      if (this.onerror) this.onerror(error);
      throw error;
    });
  }

  get src() { return this._src; }

  decode() { return this.ready; }
}

self.Image = WorkerImage;
self.HTMLImageElement = WorkerImage;
self.HTMLCanvasElement = OffscreenCanvas;
self.document = {
  createElement(tag) {
    if (tag === "canvas") return new OffscreenCanvas(1, 1);
    throw new Error(`Foniniame procese negalima sukurti <${tag}>`);
  },
  body: { append() {}, appendChild() {} },
};

// Variklis piešia `Image` į drobę – vietoj jo piešiamas tikras paveikslėlis.
const drawImage = OffscreenCanvasRenderingContext2D.prototype.drawImage;
OffscreenCanvasRenderingContext2D.prototype.drawImage = function draw(image, ...rest) {
  return drawImage.call(this, image instanceof WorkerImage ? image.bitmap : image, ...rest);
};

let engine = null;

async function start({ bundle, models, wasmPaths, threads }) {
  importScripts(bundle);
  const ort = self.__ort;
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = "error";
  engine = await self.GutenOcr.create({ models });
}

let counter = 0;

async function detect(bitmap) {
  const key = `bitmap:${counter += 1}`;
  bitmaps.set(key, bitmap);
  try {
    const result = await engine.detect(key);
    return (result || []).map((entry) => ({ text: entry.text, box: entry.box }));
  } finally {
    bitmaps.delete(key);
    bitmap.close();
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "start") await start(data);
    const result = type === "detect" ? await detect(data.bitmap) : true;
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
