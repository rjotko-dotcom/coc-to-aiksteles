// PDF atidarymas be atskiro pdf.js pagalbinio failo parsisiuntimo.
//
// pdf.js kiekvienam dokumentui paleisdavo pagalbinį procesą, kurio failą
// (`pdf.worker.min.mjs`) naršyklė turėdavo gauti iš naujo. Ilgos partijos metu
// tai kartais nepavykdavo („Setting up fake worker failed: Failed to fetch
// dynamically imported module“) ir lapas likdavo neperskaitytas. Dabar ta dalis
// įkeliama vieną kartą kartu su programa, o pdf.js ją naudoja tiesiogiai –
// jokio parsisiuntimo skaitant. Patys lapai maži (po vieną puslapį), todėl
// juos atidaryti lange užtrunka akimirką; sunkusis atpažinimas lieka foniniame
// procese.

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import * as pdfWorker from "../vendor/pdfjs/pdf.worker.min.mjs";

globalThis.pdfjsWorker = pdfWorker;
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

/** Atidaro PDF (baitus). Uždaryti būtina – `pdf.destroy()`. */
export function openPdf(bytes) {
  return pdfjs.getDocument({ data: bytes }).promise;
}
