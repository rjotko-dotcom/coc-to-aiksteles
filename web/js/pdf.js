// PDF atidarymas su vienu bendru pdf.js pagalbiniu procesu.
//
// Anksčiau kiekvienam lapui buvo paleidžiamas naujas pagalbinis procesas, o
// nutrūkus skaitymui jis likdavo neuždarytas. Per šimtą lapų jų prisikaupdavo
// tiek, kad naršyklė nebegalėjo paleisti naujo („Setting up fake worker
// failed“). Dabar visi PDF atidaromi per tą patį procesą, o jam sugedus –
// paleidžiamas naujas ir bandoma dar kartą.

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

let shared = null;

function sharedWorker() {
  if (!shared || shared.destroyed) shared = new pdfjs.PDFWorker({ name: "coc-pdf" });
  return shared;
}

/** Atidaro PDF (baitus). Uždaryti būtina – `pdf.destroy()`; procesas lieka kitiems. */
export async function openPdf(bytes) {
  const spare = bytes.slice(); // pdf.js pasiima buferį sau – antram bandymui reikia kopijos
  try {
    return await pdfjs.getDocument({ data: bytes, worker: sharedWorker() }).promise;
  } catch (error) {
    if (error && error.name === "PasswordException") throw error;
    try { shared?.destroy(); } catch { /* jau sugedęs */ }
    shared = null;
    return pdfjs.getDocument({ data: spare, worker: sharedWorker() }).promise;
  }
}
