// Sugeneruota `tools/build_sw.py` – ranka nekeisti.
//
// Kad programa veiktų be interneto, visi failai (įskaitant atpažinimo variklį
// ir kalbos duomenis) įrašomi į naršyklės talpyklą iškart po pirmo atidarymo.

const VERSION = "aikstele-14984afeedd6";
const ASSETS = [
  "./",
  "./app.css",
  "./blank-template.docx",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./index.html",
  "./js/coc.js",
  "./js/colors.js",
  "./js/docx.js",
  "./js/layout.js",
  "./js/main.js",
  "./js/ocr.js",
  "./js/read.js",
  "./js/refine.js",
  "./js/store.js",
  "./manifest.webmanifest",
  "./vendor/fflate/fflate.mjs",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
  "./vendor/tessdata/eng.traineddata.gz",
  "./vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "./vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
  "./vendor/tesseract/tesseract.min.js",
  "./vendor/tesseract/worker.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match("./index.html"));
    }),
  );
});
