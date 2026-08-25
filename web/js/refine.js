// Tikslinantis atpažinimas: pakartotinis kodų perskaitymas.
//
// Skaitant visą puslapį, dvitaškis prilimpa prie reikšmės ir „: J12“ virsta
// „PJl2“. Todėl svarbiausios reikšmės perskaitomos dar kartą – po vieną, iš
// padidinto iškarpos vaizdo ir tik didžiosiomis raidėmis bei skaitmenimis.

import { recogniseLine } from "./ocr.js";
import { repairVin, vinCheckDigitValid } from "./coc.js";

/** Laukai, kurių reikšmės yra kodai (be mažųjų raidžių ir be teksto). */
const CODE_FIELDS = {
  type: /^[A-Z0-9][A-Z0-9\-/.]*$/,
  variant: /^[A-Z0-9][A-Z0-9\-/.]*$/,
  version: /^[A-Z0-9][A-Z0-9\-/.]*$/,
  vin: /^[A-HJ-NPR-Z0-9]{17}$/,
  approval_number: /^[eE]\d{1,2}\*[A-Za-z0-9]*\d{2,4}\/\d{1,3}\*\d{3,6}\*\d{1,3}$/,
};

/** Ar reikšmė tinkamos formos. */
function accepts(key, value) {
  if (!value) return false;
  if (key === "vin") return vinCheckDigitValid(value) || Boolean(repairVin(value));
  return CODE_FIELDS[key].test(value);
}

/** Ar reikšmė atrodo įtartinai (yra šiukšlių ten, kur turi būti kodas). */
function needsRefining(key, value) {
  if (!value) return false;
  return !accepts(key, value.trim());
}

/**
 * Nuvalo kodo reikšmę nuo atpažinimo šiukšlių.
 *
 * Prilipęs dvitaškis virsta atskiru ženklu prieš reikšmę („1 J12“, „* D“),
 * todėl paliekamas paskutinis prasmingas žodis.
 */
function tidyCode(text, key) {
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9\-/.*]+/g, " ").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  if (key === "approval_number") return tokens.find((token) => token.includes("*")) || "";
  if (key === "vin") return tokens.map((token) => token.replace(/[^A-Z0-9]/g, "")).sort((a, b) => b.length - a.length)[0] || "";
  return tokens[tokens.length - 1].replace(/^[*.\-/]+|[*]+$/g, "");
}

/** Iškerpa reikšmės vietą ir padidina – smulkiam šriftui to labai trūksta. */
function crop(canvas, box, scale = 3) {
  const pad = Math.round((box.y1 - box.y0) * 0.35);
  const x = Math.max(0, Math.round(box.x0) - pad);
  const y = Math.max(0, Math.round(box.y0) - pad);
  const width = Math.min(canvas.width - x, Math.round(box.x1 - box.x0) + pad * 2);
  const height = Math.min(canvas.height - y, Math.round(box.y1 - box.y0) + pad * 2);
  if (width < 4 || height < 4) return null;

  const out = document.createElement("canvas");
  out.width = width * scale;
  out.height = height * scale;
  const context = out.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, x, y, width, height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Perskaito iš naujo tuos laukus, kurių reikšmės atrodo iškraipytos.
 *
 * Grąžina pataisytas eilutes – iš jų duomenys parsinami dar kartą, kad
 * įspėjimai (pvz. dėl VIN kontrolinio skaitmens) atitiktų galutines reikšmes.
 */
export async function refineValues(data, lines, canvases) {
  let changed = false;
  for (const key of Object.keys(CODE_FIELDS)) {
    if (!needsRefining(key, data[key])) continue;
    const index = data.sources[key];
    if (index === undefined) continue;
    const line = lines[index];
    if (!line || !line.valueBox || line.pageIndex === undefined) continue;
    const canvas = canvases[line.pageIndex];
    if (!canvas) continue;

    const piece = crop(canvas, line.valueBox);
    let text = "";
    if (piece) {
      text = tidyCode(await recogniseLine(piece), key);
      piece.width = 0;
      piece.height = 0;
    }
    // Jei pakartotinis skaitymas nepadėjo, bandome sutvarkyti tai, kas jau yra.
    if (!accepts(key, text)) text = tidyCode(data[key], key);
    if (!accepts(key, text) || text === data[key]) continue;

    if (key === "vin" && !vinCheckDigitValid(text)) text = repairVin(text) || text;
    line.text = `${line.label ?? ""} : ${text}`;
    line.value = text;
    changed = true;
  }
  return changed;
}
