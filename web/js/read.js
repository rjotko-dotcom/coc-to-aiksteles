// CoC PDF skaitymas naršyklėje: teksto sluoksnis arba atpažinimas (OCR).

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import { linesFromBoxes } from "./layout.js";
import { recognise } from "./ocr.js";
import { parseCocText } from "./coc.js";
import { refineValues } from "./refine.js";

pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

/** Kokia raiška piešiami puslapiai atpažinimui (PDF taškas = 1/72 colio).
 *  300 dpi – riba, žemiau kurios atpažinimas ima klysti smulkiame CoC šrifte. */
const OCR_DPI = 300;

/** Kiek ženklų turi turėti teksto sluoksnis, kad OCR nereikėtų. */
const TEXT_THRESHOLD = 200;

async function textLayerLines(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items
    .filter((item) => item.str && item.str.trim())
    .map((item) => {
      const x0 = item.transform[4];
      const height = item.height || Math.abs(item.transform[3]) || 8;
      return {
        y: viewport.height - item.transform[5],
        x0,
        x1: x0 + (item.width || item.str.length * height * 0.5),
        h: height,
        text: item.str,
      };
    });
  return linesFromBoxes(items);
}

/**
 * Vaizdą paverčia į juodą-baltą (Otsu slenkstis).
 *
 * Skenuoti liudijimai būna pilkšvi, o smulkūs ženklai – dvitaškiai, nuliai –
 * susilieja. Po binarizacijos atpažinimas kur kas tikslesnis.
 */
function binarise(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const grey = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    const value = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) | 0;
    grey[p] = value;
    histogram[value] += 1;
  }

  // Otsu: slenkstis, kuris labiausiai atskiria tamsius ir šviesius taškus.
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 128;
  for (let value = 0; value < 256; value += 1) {
    weightBackground += histogram[value];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;
    sumBackground += value * histogram[value];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = value;
    }
  }

  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    const value = grey[p] > threshold ? 255 : 0;
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
  }
  context.putImageData(image, 0, 0);
}

async function ocrPage(page, onProgress) {
  const viewport = page.getViewport({ scale: OCR_DPI / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;
  binarise(context, canvas.width, canvas.height);
  const lines = linesFromBoxes(await recognise(canvas, onProgress));
  return { lines, canvas };
}

/**
 * Perskaito CoC PDF ir grąžina atpažintus laukus.
 *
 * `onStatus(message)` praneša eigą: skenuotus liudijimus reikia atpažinti,
 * o tai trunka apie 15 sekundžių.
 */
export async function readCertificate(file, onStatus = () => {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;

  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    pages.push(await textLayerLines(page));
    page.cleanup();
  }
  let text = pages.map((lines) => lines.map((line) => line.text).join("\n")).join("\n");
  let ocrUsed = text.replace(/\s/g, "").length < TEXT_THRESHOLD;

  if (ocrUsed) {
    const canvases = [];
    const lines = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      onStatus(`Atpažįstamas ${number} iš ${pdf.numPages} puslapio…`);
      const page = await pdf.getPage(number);
      const result = await ocrPage(page, (status, progress) => {
        if (status === "recognizing text") {
          onStatus(`Atpažįstamas ${number} iš ${pdf.numPages} puslapio… ${Math.round(progress * 100)}%`);
        }
      });
      result.lines.forEach((line) => lines.push({ ...line, pageIndex: canvases.length }));
      canvases.push(result.canvas);
      page.cleanup();
    }

    let data = parseCocText(lines, { sourceFile: file.name, ocrUsed: true });
    onStatus("Tikslinami kodai…");
    if (await refineValues(data, lines, canvases)) {
      data = parseCocText(lines, { sourceFile: file.name, ocrUsed: true });
    }
    canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
    await pdf.destroy();
    return data;
  }

  await pdf.destroy();
  return parseCocText(text, { sourceFile: file.name, ocrUsed });
}
