// Skeneriu nuskenuoto PDF karpymas: kiekvienas puslapis – atskiras CoC.
//
// Puslapiai nukopijuojami tokie, kokie yra (pdf-lib), o ne perpiešiami: failas
// lieka tokios pat kokybės ir dydžio, kaip atsiuntė skeneris.

import { PDFDocument } from "../../vendor/pdf-lib/pdf-lib.esm.min.js";
import * as pdfjs from "../../vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

/** Išskaido PDF į atskirus vieno puslapio PDF. Grąžina [Uint8Array]. */
export async function splitPages(bytes) {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = [];
  for (let index = 0; index < source.getPageCount(); index += 1) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [index]);
    single.addPage(page);
    pages.push(await single.save());
  }
  return pages;
}

/** Mažas puslapio paveikslėlis sąrašui (JPEG duomenų adresas). */
export async function thumbnail(bytes, width = 360) {
  // pdf.js pasiima buferį sau, todėl duodame kopiją – originalas dar reikalingas.
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: context, viewport }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.7);
    canvas.width = 0;
    canvas.height = 0;
    return url;
  } finally {
    await pdf.destroy();
  }
}
