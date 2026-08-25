// Sugeneruota `tools/build_sw.py` – ranka nekeisti.
//
// Kad programa veiktų be interneto, visi failai (įskaitant atpažinimo variklį
// ir kalbos duomenis) įrašomi į naršyklės talpyklą iškart po pirmo atidarymo.

const VERSION = "aikstele-594708ca37a1";
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
  "./vendor/ppocr/models/det.onnx",
  "./vendor/ppocr/models/keys.txt",
  "./vendor/ppocr/models/rec.onnx",
  "./vendor/ppocr/ort/ort-wasm-simd-threaded.mjs",
  "./vendor/ppocr/ort/ort-wasm-simd-threaded.wasm",
  "./vendor/ppocr/ppocr.js",
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

// Antraštės, be kurių naršyklė neleidžia dirbti keliomis gijomis. Su jomis
// atpažinimas paleidžiamas lygiagrečiai ir trunka kelis kartus trumpiau.
function isolate(response) {
  if (!response || !response.ok || response.type !== "basic") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return isolate(cached);
      return fetch(event.request).then((response) => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return isolate(response);
      }).catch(() => caches.match("./index.html").then(isolate));
    }),
  );
});
