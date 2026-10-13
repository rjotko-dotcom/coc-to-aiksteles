// Automobilio paveikslas pagal CoC: modelis ir karta – iš VIN, spalva – iš CoC
// 38 punkto. Paveikslai paruošti iš anksto (`tools/cars_prep.py`): iškirptas
// automobilis be dažų spalvos + dažų kaukė. Naršyklė tik nuspalvina dažus
// (išlaikydama šviesą ir šešėlius) – jokio interneto ir jokio AI.

import { cleanVin, modelFromVin } from "./logic.js";

/**
 * Turimi modeliai. `lmed` – vidutinis dažų šviesumas originalioje nuotraukoje
 * (nuo jo skaičiuojami šešėliai ir atspindžiai). Nuotraukos – Wikimedia Commons,
 * CC BY-SA 4.0: fonas pašalintas, dažai perdažomi (žr. `web/sandelis/cars/CREDITS.md`).
 */
export const CARS = {
  qashqai: { name: "Qashqai", generation: "J12", lmed: 81.5, w: 960, h: 502,
    author: "Alexander Migl", file: "Nissan Qashqai (J12) Automesse Ludwigsburg 2022 1X7A5875.jpg" },
  "x-trail": { name: "X-Trail", generation: "T33", lmed: 87.5, w: 960, h: 460,
    author: "Alexander-93", file: "Nissan X-Trail (T33) 1X7A7179.jpg" },
  juke: { name: "Juke", generation: "F16", lmed: 87.9, w: 960, h: 659,
    author: "Damian B Oh", file: "Nissan Juke N Design F16 Flame Red (1).jpg" },
  ariya: { name: "Ariya", generation: "FE0", lmed: 131.6, w: 960, h: 525,
    author: "Alexander Migl", file: "Nissan Ariya IMG 8787.jpg" },
  leaf: { name: "Leaf", generation: "ZE2", lmed: 120.7, w: 960, h: 520,
    author: "Alexander Migl", file: "Nissan Leaf (ZE2) Auto Zuerich 2025 DSC 3011.jpg" },
  micra: { name: "Micra", generation: "K15", lmed: 105.5, w: 960, h: 504,
    author: "Alexander Migl", file: "Nissan Micra EV IMG 4967.jpg" },
};

const NAMES = [
  ["qashqai", /QASHQAI|QASQAI|QASHOAI/], ["x-trail", /X\W?TRAIL/], ["juke", /JUKE/],
  ["ariya", /ARIYA/], ["leaf", /LEAF/], ["micra", /MICRA/],
];

/** Kurio modelio paveikslas tinka įrašui: pirmiausia pagal VIN, tada pagal modelio pavadinimą. */
export function carKeyOf(record) {
  const fromVin = modelFromVin(record.vin);
  const text = String(fromVin?.model || record.model || (record.coc || {}).commercial_name || "").toUpperCase();
  for (const [key, pattern] of NAMES) if (pattern.test(text)) return key;
  return null;
}

/** Pagaminimo metai iš CoC („12.05.2025“ → 2025), jei perskaityti. */
export function yearOf(record) {
  const match = String((record.coc || {}).manufacture_date || "").match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

/** Karta iš VIN (J12, T33…) – jei VIN jos nerodo, „“. */
export const generationOf = (record) => modelFromVin(cleanVin(record.vin))?.generation || "";

/** Dažų atspalviai (metalikas – šiek tiek tamsesnis už „gryną“ spalvą). */
const PAINT = {
  BALTA: [232, 232, 228], JUODA: [20, 20, 22], PILKA: [104, 108, 112], "SIDABRINĖ": [168, 172, 176],
  "MĖLYNA": [26, 62, 140], RAUDONA: [158, 14, 26], "ŽALIA": [38, 84, 58], GELTONA: [222, 176, 24],
  RUDA: [104, 66, 42], "ORANŽINĖ": [210, 92, 24], "VIOLETINĖ": [84, 48, 112], "ROŽINĖ": [206, 118, 146],
  "AUKSINĖ": [176, 142, 72], "SMĖLIO": [190, 170, 134],
};

/** Spalvos taškas sąraše ir pažymoje rodomam pavadinimui. */
export function paintOf(record) {
  const coc = record.coc || {};
  const name = String(coc.colour || "").split("/")[0].trim().toUpperCase();
  const base = PAINT[name];
  if (!base) return null;
  const raw = String(coc.colour_raw || "").toUpperCase();
  // Patikslinimas pagal gamintojo pavadinimą („Dark Grey“, „Light Blue“…).
  let factor = 1;
  if (/DARK|DUNKEL|FONC|SCUR|TAMS|INK|DEEP|GUN/.test(raw)) factor = 0.62;
  else if (/LIGHT|HELL|CLAIR|CHIAR|ŠVIES|SKY/.test(raw)) factor = 1.35;
  const rgb = base.map((value) => Math.round(factor > 1 ? value + (255 - value) * (factor - 1) : value * factor));
  return { name: coc.colour, rgb };
}

/** Nuoroda į nuotraukos puslapį Commons (autorystei nurodyti). */
export const creditUrl = (car) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(car.file.replace(/ /g, "_"))}`;

export const cssColour = (paint) => (paint ? `rgb(${paint.rgb.join(" ")})` : "");

// ---------------------------------------------------------------------------
// Dažymas (naršyklėje)
// ---------------------------------------------------------------------------

const sources = new Map();
const painted = new Map();

function load(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`nepavyko įkelti ${url}`));
    image.src = url;
  });
}

function source(key) {
  if (!sources.has(key)) {
    const base = new URL(`../../sandelis/cars/${key}`, import.meta.url).href;
    sources.set(key, Promise.all([load(`${base}.webp`), load(`${base}-mask.webp`)]));
  }
  return sources.get(key);
}

/**
 * Nuspalvina dažus: šviesumas lyginamas su vidutiniu dažų šviesumu – tamsiau
 * už vidurkį tampa šešėliu, šviesiau – atspindžiu (link baltos).
 */
function paintPixels(pixels, mask, lmed, rgb) {
  const [tr, tg, tb] = rgb;
  const light = (0.299 * tr + 0.587 * tg + 0.114 * tb) > 150;
  const dark = (0.299 * tr + 0.587 * tg + 0.114 * tb) < 40;
  const span = 255 / lmed - 1;
  for (let i = 0; i < pixels.length; i += 4) {
    const w = mask[i] / 255;
    if (w < 0.004 || pixels[i + 3] === 0) continue;
    const r = pixels[i]; const g = pixels[i + 1]; const b = pixels[i + 2];
    let k = (0.299 * r + 0.587 * g + 0.114 * b) / lmed;
    // Šviesūs dažai šešėlius rodo švelniau, tamsūs – ryškesnius atspindžius.
    if (light) k = Math.min(1.06, 0.7 + 0.3 * k);
    let nr; let ng; let nb;
    if (k <= 1) { nr = tr * k; ng = tg * k; nb = tb * k; } else {
      const up = Math.min(1, (k - 1) / span) * (dark ? 0.8 : 1);
      nr = tr + (255 - tr) * up; ng = tg + (255 - tg) * up; nb = tb + (255 - tb) * up;
    }
    pixels[i] = r + (nr - r) * w;
    pixels[i + 1] = g + (ng - g) * w;
    pixels[i + 2] = b + (nb - b) * w;
  }
}

/**
 * Nuspalvinto automobilio paveikslo adresas (blob:). `width` – pikseliais;
 * rezultatas įsimenamas, todėl tas pats modelis ir spalva dažomi tik kartą.
 */
export function carImage(key, paint, width = 960) {
  const car = CARS[key];
  if (!car) return Promise.resolve(null);
  const id = `${key}|${paint ? paint.rgb.join(",") : "-"}|${width}`;
  if (!painted.has(id)) {
    painted.set(id, (async () => {
      const [image, mask] = await source(key);
      const w = Math.min(width, car.w);
      const h = Math.round(car.h * (w / car.w));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (paint) {
        context.drawImage(mask, 0, 0, w, h);
        const maskData = context.getImageData(0, 0, w, h).data;
        context.clearRect(0, 0, w, h);
        context.drawImage(image, 0, 0, w, h);
        const data = context.getImageData(0, 0, w, h);
        paintPixels(data.data, maskData, car.lmed, paint.rgb);
        context.putImageData(data, 0, 0);
      } else {
        context.drawImage(image, 0, 0, w, h);
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      return URL.createObjectURL(blob);
    })().catch((error) => { painted.delete(id); throw error; }));
  }
  return painted.get(id);
}
