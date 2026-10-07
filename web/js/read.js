// CoC PDF skaitymas naršyklėje: teksto sluoksnis arba atpažinimas (OCR).

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import { linesFromBoxes } from "./layout.js";
import { recognise } from "./ocr.js";
import { parseCocText } from "./coc.js";
import { refineValues } from "./refine.js";

// Keliai skaičiuojami nuo šio failo, o ne nuo puslapio – tą patį skaitytuvą
// naudoja ir sandėlio puslapis kitame kataloge.
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

/** Kokia raiška piešiami puslapiai atpažinimui (PDF taškas = 1/72 colio).
 *  PP-OCR smulkų CoC šriftą patikimai perskaito ir iš 200 dpi. */
const OCR_DPI = 200;

/** Kiek ženklų turi turėti teksto sluoksnis, kad OCR nereikėtų. */
const TEXT_THRESHOLD = 200;

/** Laukai, be kurių pažymos užpildyti negalima – dėl jų verta bandyti dar kartą. */
const REQUIRED = ["make", "type", "commercial_name", "vin", "approval_number", "approval_date", "colour"];

/** Didesnė raiška antram bandymui, kai kažko trūksta. */
const RETRY_DPI = 300;

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

/** Iškerpa vietą puslapyje į atskirą drobę. */
function crop(canvas, box) {
  const pad = Math.max(2, Math.round((box.y1 - box.y0) * 0.18));
  const x = Math.max(0, Math.round(box.x0) - pad);
  const y = Math.max(0, Math.round(box.y0) - pad);
  const width = Math.min(canvas.width - x, Math.round(box.x1 - box.x0) + pad * 2);
  const height = Math.min(canvas.height - y, Math.round(box.y1 - box.y0) + pad * 2);
  if (width < 6 || height < 6) return null;

  const out = document.createElement("canvas");
  const scale = Math.min(4, Math.max(1.5, 72 / height));
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  const context = out.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, out.width, out.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, x, y, width, height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Kelias iškarpas sudeda vieną po kita.
 *
 * Tipas, variantas ir versija liudijime yra trys atskiros eilutės, o pažymoje
 * – vienas laukas, todėl ir tikrinti patogiau visas kartu.
 */
function stack(pieces) {
  const parts = pieces.filter(Boolean);
  if (!parts.length) return null;
  const width = Math.max(...parts.map((piece) => piece.width));
  const height = parts.reduce((sum, piece) => sum + piece.height, 0);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const context = out.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  let top = 0;
  for (const piece of parts) {
    context.drawImage(piece, 0, top);
    top += piece.height;
    piece.width = 0;
    piece.height = 0;
  }
  const url = out.toDataURL("image/jpeg", 0.75);
  out.width = 0;
  out.height = 0;
  return url;
}

/**
 * Iškarpa eilutei, kurioje rastas laukas.
 *
 * Kerpamas būtent tas atpažinimo fragmentas, kuriame yra reikšmė – kitaip į
 * iškarpą patenka ir gretima eilutė.
 */
function pieceFor(lines, canvases, index, value) {
  const line = lines[index];
  if (!line || line.pageIndex === undefined) return null;
  const canvas = canvases[line.pageIndex];
  if (!canvas || !canvas.width) return null;

  const compact = (text) => (text || "").replace(/\s+/g, "").toUpperCase();
  const wanted = compact(value);
  const parts = line.parts || [];
  const match = wanted && parts.find((part) => compact(part.text).includes(wanted));
  const box = match || (parts.length === 1 ? parts[0] : line.valueBox || line.box);
  if (!box) return null;
  return crop(canvas, box);
}

/** Eilutės numeris, kurioje matomas ieškomas tekstas. */
function findLine(lines, needle) {
  if (!needle) return -1;
  const compact = needle.replace(/\s+/g, "");
  return lines.findIndex((line) => line.text.replace(/\s+/g, "").includes(compact));
}

/**
 * Kiekvienam laukui prideda iškarpą iš liudijimo.
 *
 * Iš jų sąsajoje matyti, iš kur paimta kiekviena reikšmė – patikrinti galima
 * nė neatsidarius paties liudijimo.
 */
function addSnippets(data, lines, canvases) {
  data.snippets = {};
  const sources = data.sources || {};

  for (const [key, index] of Object.entries(sources)) {
    if (["type", "variant", "version"].includes(key)) continue;
    // Spalva ir data pažymoje rašomos jau perdirbtos („Black“ -> „JUODA“,
    // „07/05/2026“ -> „07.05.2026“), o liudijime reikia rasti originalą.
    const needle = key === "colour" ? data.colour_raw
      : key === "manufacture_date" ? data.manufacture_date.replace(/\./g, "/")
      : data[key];
    const url = stack([pieceFor(lines, canvases, index, needle)]);
    if (url) data.snippets[key] = url;
  }

  const identity = ["type", "variant", "version"]
    .filter((key) => sources[key] !== undefined)
    .map((key) => pieceFor(lines, canvases, sources[key], data[key]));
  const combined = stack(identity);
  if (combined) data.snippets.type_variant_version = combined;

  for (const [key, needle] of [
    ["approval_number", data.approval_number],
    ["approval_date", data.approval_date],
  ]) {
    let index = findLine(lines, needle);
    if (index < 0 && key === "approval_date" && data.approval_date) {
      // Data dažnai atsiduria kitoje eilutėje nei numeris.
      index = findLine(lines, data.approval_date.replace(/\./g, "/"));
    }
    if (index < 0) continue;
    const wanted = key === "approval_number" ? needle : needle.replace(/\./g, "/");
    const url = stack([pieceFor(lines, canvases, index, wanted)]);
    if (url) data.snippets[key] = url;
  }
  return data;
}

/** `top` – kokią puslapio dalį nuo viršaus skaityti (1 – visą). */
async function ocrPage(page, dpi = OCR_DPI, top = 1) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  // Kas netelpa į drobę, tiesiog nepiešiama – atpažinimas trunka trumpiau.
  canvas.height = Math.round(viewport.height * top);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;
  const lines = linesFromBoxes(await recognise(canvas));
  return { lines, canvas };
}

/** Kiek privalomų laukų rasta (pagal tai renkamės geresnį bandymą). */
const score = (data, required = REQUIRED) => required.filter((key) => data[key]).length;

async function readWithOcr(pdf, file, dpi, onStatus, label, top = 1) {
  const canvases = [];
  const lines = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    onStatus(`${label}${number} iš ${pdf.numPages} puslapio…`);
    const page = await pdf.getPage(number);
    const result = await ocrPage(page, dpi, top);
    result.lines.forEach((line) => lines.push({ ...line, pageIndex: canvases.length }));
    canvases.push(result.canvas);
    page.cleanup();
  }

  let data = parseCocText(lines, { sourceFile: file.name, ocrUsed: true });
  if (await refineValues(data, lines, canvases)) {
    data = parseCocText(lines, { sourceFile: file.name, ocrUsed: true });
  }
  addSnippets(data, lines, canvases);
  return { data, canvases };
}

/**
 * Perskaito CoC PDF ir grąžina atpažintus laukus.
 *
 * `onStatus(message)` praneša eigą: skenuotus liudijimus reikia atpažinti,
 * o tai trunka apie 15 sekundžių.
 *
 * `required` – laukai, dėl kurių verta skaityti antrą kartą didesne raiška.
 * Sandėlyje skenuojama tik pirma liudijimo pusė, todėl ten užtenka VIN ir
 * modelio – kitaip kiekvienas lapas be spalvos būtų skaitomas du kartus.
 *
 * `top` – skaityti tik viršutinę puslapio dalį (pvz. 0.6). Sandėlis taip
 * pirmiausia ieško VIN ir modelio, o viso lapo imasi tik jei jų ten nėra.
 * `retry: false` – neskaityti antrą kartą didesne raiška (tam greitam bandymui).
 */
export async function readCertificate(file, onStatus = () => {}, { required = REQUIRED, top = 1, retry = true } = {}) {
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
    let best = await readWithOcr(pdf, file, OCR_DPI, onStatus, "Atpažįstamas ", top);

    // Jei kažko trūksta, tas pats liudijimas perskaitomas didesne raiška.
    if (retry && score(best.data, required) < required.length) {
      const second = await readWithOcr(pdf, file, RETRY_DPI, onStatus, "Skaitoma dar kartą, tiksliau: ", top);
      if (score(second.data, required) > score(best.data, required)) {
        best.canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
        best = second;
      } else {
        second.canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
      }
    }

    best.canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
    await pdf.destroy();
    return best.data;
  }

  await pdf.destroy();
  return parseCocText(text, { sourceFile: file.name, ocrUsed });
}
