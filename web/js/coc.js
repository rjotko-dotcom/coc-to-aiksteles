// Atitikties liudijimo (CoC) laukų atpažinimas iš teksto.
// Tas pats algoritmas kaip `app/coc_extract.py`.

import { toLithuanian } from "./colors.js";

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
/** Kandidatas po atpažinimo: gali turėti ir I, O, Q – jie vėliau pataisomi. */
const VIN_LOOSE_RE = /\b[A-Z0-9]{17}\b/g;

// e9*2018/858*11042*16, e4*2007/46*1522*01, e3*2007/46*0046*10
const APPROVAL_RE = /\b[eE]\d{1,2}\s*\*\s*[A-Za-z0-9]{0,4}\d{2,4}\s*\/\s*\d{1,3}\s*\*\s*\d{3,6}\s*\*\s*\d{1,3}\b/;

// Po atpažinimo žvaigždutė virsta „%“, „x“ ar „¥“, brūkšnys – „l“. Todėl
// numeris papildomai ieškomas laisviau ir tik tada sudėliojamas taisyklingai.
// Žvaigždutė virsta „%“, „x“, „×“ ar „+“, brūkšnys – „l“ arba „1“.
const STAR = "\\s*(?:[^A-Za-z0-9\\s]{1,2}|[xX])\\s*";
const APPROVAL_LOOSE_RE = new RegExp(
  "\\b([eE]\\s*\\d{1,2})" + STAR + "([A-Za-z]{0,4}\\d{2,4})\\s*[/|l1]\\s*(\\d{1,3})"
  + STAR + "(\\d{3,6})" + STAR + "(\\d{1,3})\\b",
);

const DATE_RE = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/;
const ISO_DATE_RE = /\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/;
const ITEM_CODE_RE = /^(\d+(?:\.\d+)*)\.?(?=\s|$)/;

/** Skirsnių numeriai vienodi visose kalbose – jais pasitikime pirmiausia. */
const CODE_KEYS = {
  "0.1": "make",
  "0.2": "type",
  "0.2.1": "commercial_name",
  "0.4": "category",
  "0.5": "manufacturer",
  "0.10": "vin",
  "0.11": "manufacture_date",
  "40": "colour",
};

/** Atsarginis variantas, kai skirsnio numerio nėra arba jo neatpažino OCR. */
const LABEL_KEYS = [
  ["variant", ["variant", "variante", "wariant"]],
  ["version", ["version", "versione", "versión", "wersja", "ausfuhrung"]],
  ["commercial_name", [
    "commercial name", "appellation commerciale", "handelsbezeichnung",
    "denominazione commerciale", "denominacion comercial", "nome commercial",
  ]],
  ["vin", [
    "vehicle identification number", "numero d'identification",
    "numero de identification", "fahrzeug-identifizierungsnummer",
    "numero di identificazione", "numero de identificacion",
  ]],
  ["manufacture_date", [
    "date of manufacture", "date de construction", "datum der herstellung",
    "data di costruzione", "fecha de fabricacion",
  ]],
  ["colour", ["colour", "color", "couleur", "farbe", "colore"]],
  ["category", ["category", "categorie", "categoria", "klasse", "kategorie"]],
  ["make", ["make", "marque", "marke", "marca"]],
  ["type", ["type", "typ", "tipo"]],
  ["manufacturer", [
    "name and address of the manufacturer", "company name and address",
    "raison sociale", "name und anschrift", "nome e indirizzo",
  ]],
];

/**
 * Pavadinimų žodžiai. Kai atpažinimas praleidžia dvitaškį („40. Colour of
 * vehicle Black“), reikšmė atskiriama nubraukiant šiuos žodžius po skirsnio
 * numerio – pirmas jiems nepriklausantis žodis jau yra reikšmė.
 */
const LABEL_WORDS = new Set([
  // anglų
  "make", "trade", "name", "names", "of", "the", "manufacturer", "manufacture",
  "type", "variant", "version", "commercial", "category", "vehicle", "vehicles",
  "identification", "number", "date", "colour", "color", "company", "address",
  "and", "s",
  // prancūzų
  "marque", "denomination", "commerciale", "du", "de", "la", "des", "le",
  "categorie", "vehicule", "numero", "d", "appellation", "appellations",
  "couleur", "raison", "sociale", "construction",
  // vokiečių / italų / ispanų
  "marke", "typ", "farbe", "fahrzeug", "nummer", "datum", "marca", "tipo",
  "colore", "veicolo", "fecha", "vehiculo",
]);

/**
 * Modelių pavadinimai, pagal kuriuos taisoma vieno ženklo atpažinimo klaida
 * („QASHQATI“ -> „QASHQAI“). Sąrašas sąmoningai trumpas: taisoma tik tada, kai
 * skiriasi lygiai vienas ženklas, todėl svetimo pavadinimo jis nesugadins.
 */
const KNOWN_MODELS = new Set([
  // Nissan
  "QASHQAI", "JUKE", "X-TRAIL", "XTRAIL", "MICRA", "LEAF", "ARIYA", "NOTE",
  "TOWNSTAR", "INTERSTAR", "PRIMASTAR", "NAVARA", "PULSAR", "PATHFINDER",
  // Hyundai
  "KONA", "KAUAI", "TUCSON", "IONIQ", "BAYON", "STAREX", "ELANTRA", "SANTAFE",
  // Citroën / Stellantis
  "BERLINGO", "JUMPER", "JUMPY", "RELAY", "DISPATCH", "SPACETOURER",
  // markės
  "NISSAN", "HYUNDAI", "CITROEN", "TOYOTA", "RENAULT", "DACIA", "PEUGEOT",
]);

/** Etiketės apie žymens *vietą*, o ne apie patį numerį. */
const PLACE_WORDS = ["location", "emplacement", "anbringung", "posizione", "lugar"];

/** Pilno pločio (CJK) ženklai, kuriuos OCR kartais grąžina vietoj įprastų. */
const OCR_REPLACEMENTS = {
  "：": ":", "（": "(", "）": ")", "，": ",", "．": ".",
  "－": "-", "＊": "*", "／": "/", "　": " ",
};

export function normaliseOcrText(text) {
  return (text || "").replace(/[：（），．－＊／　]/g, (ch) => OCR_REPLACEMENTS[ch]);
}

function fold(text) {
  return (text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/^[-–—•*\s]+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Datą suvienodina į DD.MM.YYYY (kaip rašoma pažymoje). */
export function normaliseDate(value) {
  if (!value) return "";
  const m = DATE_RE.exec(value);
  if (m) return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
  const iso = ISO_DATE_RE.exec(value);
  if (iso) return `${iso[3].padStart(2, "0")}.${iso[2].padStart(2, "0")}.${iso[1]}`;
  return value.trim();
}

const VIN_VALUES = {
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Ar VIN kontrolinis skaitmuo (9-as ženklas) teisingas (ISO 3779). */
export function vinCheckDigitValid(vin) {
  const value = (vin || "").toUpperCase();
  if (value.length !== 17) return false;
  let total = 0;
  for (let i = 0; i < 17; i += 1) {
    const digit = VIN_VALUES[value[i]];
    if (digit === undefined) return false;
    total += digit * VIN_WEIGHTS[i];
  }
  const remainder = total % 11;
  return value[8] === (remainder === 10 ? "X" : String(remainder));
}

/** Ženklai, kurių VIN niekada neturi, ir ką OCR jais dažniausiai pakeičia. */
const VIN_CONFUSIONS = { I: ["1", "J"], O: ["0", "D"], Q: ["0", "O"] };

/** Pirmieji trys ženklai – gamintojo kodas, ten laukiame raidžių. */
function options(character, index) {
  const list = VIN_CONFUSIONS[character] || [character];
  if (index >= 3) return list;
  return [...list].sort((a, b) => Number(/[A-Z]/.test(b)) - Number(/[A-Z]/.test(a)));
}

/**
 * Pataiso VIN, kurį iškraipė atpažinimas.
 *
 * VIN abėcėlėje nėra nei I, nei O, nei Q – jei tokie ženklai atsirado, tai
 * atpažinimo klaida. Variantai tikrinami kontroliniu skaitmeniu (ISO 3779),
 * todėl pataisymas nėra spėjimas: priimamas tik toks, kuris sutampa.
 */
export function repairVin(token) {
  const value = (token || "").toUpperCase();
  if (value.length !== 17) return "";
  if (vinCheckDigitValid(value)) return value;

  const spots = [...value].map((ch, index) => (VIN_CONFUSIONS[ch] ? index : -1)).filter((i) => i >= 0);
  if (!spots.length || spots.length > 4) return "";

  const candidates = [value];
  for (const index of spots) {
    const next = [];
    for (const candidate of candidates) {
      for (const replacement of options(candidate[index], index)) {
        next.push(candidate.slice(0, index) + replacement + candidate.slice(index + 1));
      }
    }
    candidates.length = 0;
    candidates.push(...next);
  }
  return candidates.find((candidate) => vinCheckDigitValid(candidate)) || "";
}

/**
 * VIN iš failo pavadinimo, jei jis ten yra ir kontrolinis skaitmuo sutampa.
 *
 * Gamintojų portalai liudijimus dažnai pavadina VIN numeriu, todėl tai
 * patikimas atsarginis šaltinis, kai skenuotame liudijime numeris neįskaitomas.
 */
export function vinFromFilename(name) {
  const stem = (name || "").replace(/\.[^.]*$/, "").toUpperCase();
  for (const candidate of stem.match(/[A-HJ-NPR-Z0-9]{17}/g) || []) {
    if (vinCheckDigitValid(candidate)) return candidate;
  }
  return "";
}

/** Kiek ženklų skiriasi du žodžiai (Levenšteino atstumas). */
function distance(first, second) {
  let previous = [...Array(second.length + 1).keys()];
  for (let i = 1; i <= first.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= second.length; j += 1) {
      current.push(Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[second.length];
}

/** Pataiso vieno ženklo klaidas žinomuose modelių pavadinimuose. */
export function tidyModelNames(text) {
  if (!text) return text;
  return text.split(/\s+/).map((word) => {
    const stripped = word.replace(/^[,.;:()]+|[,.;:()]+$/g, "");
    if (stripped.length < 4 || KNOWN_MODELS.has(stripped.toUpperCase())) return word;
    for (const model of KNOWN_MODELS) {
      if (Math.abs(model.length - stripped.length) <= 1
          && distance(model, stripped.toUpperCase()) === 1) {
        return word.replace(stripped, model);
      }
    }
    return word;
  }).join(" ");
}

/**
 * Pataiso vieno ženklo klaidą markėje pagal komercinį pavadinimą.
 *
 * „HISSAN“ ir „NISSAN QASHQAI“ skiriasi vienu ženklu, o komercinis pavadinimas
 * paprastai prasideda ta pačia marke – tai patikimesnis šaltinis nei atskirai
 * atpažintas trumpas žodis.
 */
function makeFromCommercialName(make, commercialName) {
  if (!make || !commercialName) return make;
  const first = commercialName.split(/\s+/)[0];
  if (make.length < 4 || first.length < 4 || make.toUpperCase() === first.toUpperCase()) return make;
  return distance(make.toUpperCase(), first.toUpperCase()) === 1 ? first : make;
}

/** Galimos transporto priemonių kategorijos. */
const CATEGORIES = new Set([
  ...["M", "N", "O"].flatMap((letter) => ["1", "2", "3", "4"].map((n) => letter + n)),
  ...["1", "2", "3", "4", "5", "6", "7"].map((n) => "L" + n),
]);

/** Iš „PML“ ar „'MI“ padaro „M1“ – atpažinimas painioja 1 su I ir L. */
export function tidyCategory(value) {
  if (!value) return value;
  const text = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  for (let index = 0; index < text.length - 1; index += 1) {
    const letter = text[index];
    const digit = { I: "1", L: "1", O: "0" }[text[index + 1]] || text[index + 1];
    if (CATEGORIES.has(letter + digit)) return letter + digit;
  }
  return value;
}

function clean(value) {
  const text = value.replace(/\s+/g, " ").trim();
  return ["-", "--", "---", "N/A", "n/a"].includes(text) ? "" : text;
}

function keyFor(code, label) {
  for (const key of ["variant", "version"]) {
    const needles = LABEL_KEYS.find(([name]) => name === key)[1];
    if (needles.some((needle) => label.startsWith(needle))) return key;
  }
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  // Pavadinimas turi prasidėti raktažodžiu: kitaip „as marked on the engine“
  // taptų marke, o „multistage type approval“ – tipu.
  for (const [key, needles] of LABEL_KEYS) {
    if (needles.some((needle) => label.startsWith(needle))) return key;
  }
  return null;
}

/**
 * Atskiria reikšmę eilutėje be dvitaškio.
 *
 * Atpažinimas dvitaškio kartais nepamato visai. Tada pasikliaujame skirsnio
 * numeriu ir nubraukiame pavadinimo žodžius: „40. Colour of vehicle Black“ ->
 * („40 Colour of vehicle“, „Black“).
 */
function splitWithoutColon(line) {
  const stripped = line.trim();
  const codeMatch = ITEM_CODE_RE.exec(stripped);
  if (!codeMatch || !CODE_KEYS[codeMatch[1]]) return null;

  let rest = stripped.slice(codeMatch[0].length).trim().replace(/^\([^)]*\)\s*/, "");
  const skipped = [];
  while (rest) {
    const words = rest.split(/\s+/);
    const first = fold(words[0]).replace(/^[().,;:]+|[().,;:]+$/g, "");
    if (!first || !LABEL_WORDS.has(first)) break;
    skipped.push(words.shift());
    rest = words.join(" ").replace(/^\([^)]*\)\s*/, "");
  }
  if (!skipped.length || !rest) return null;
  return { label: `${codeMatch[1]} ${skipped.join(" ")}`, value: rest };
}

function splitLabelValue(line) {
  const at = line.indexOf(":");
  if (at < 0) return splitWithoutColon(line);
  return { label: line.slice(0, at).trim(), value: line.slice(at + 1) };
}

export function typeVariantVersion(data) {
  return [data.type, data.variant, data.version].filter(Boolean).join("/");
}

/**
 * Iš liudijimo teksto sudaro duomenų objektą.
 *
 * `input` – tekstas arba eilučių objektai iš `layout.js`. Antruoju atveju
 * `data.sources` parodo, kurioje eilutėje rastas kiekvienas laukas – to reikia
 * tikslinančiam atpažinimui.
 */
export function parseCocText(input, { sourceFile = "", ocrUsed = false } = {}) {
  const rawLines = typeof input === "string"
    ? input.split("\n").map((text) => ({ text }))
    : input;
  const lines = rawLines.map((line) => ({ ...line, text: normaliseOcrText(line.text) }));
  const text = lines.map((line) => line.text).join("\n");
  const flat = text.replace(/\s+/g, " ");
  const data = {
    source_file: sourceFile,
    ocr_used: ocrUsed,
    make: "", type: "", variant: "", version: "", commercial_name: "",
    vin: "", manufacture_date: "", category: "", manufacturer: "",
    approval_number: "", approval_date: "", national_approval_number: "",
    colour_raw: "", colour: "", warnings: [],
    sources: {},
  };
  let colourByCode = "";

  for (const [index, entry] of lines.entries()) {
    const line = entry.text.trim();
    if (!line) continue;

    const split = splitLabelValue(line);
    if (!split) continue;
    const label = split.label;
    const value = clean(split.value);
    if (!value) continue;

    const codeMatch = ITEM_CODE_RE.exec(label.replace(/^[-–—•\s]+/, ""));
    const code = codeMatch ? codeMatch[1] : "";
    const textLabel = fold(codeMatch ? label.slice(label.indexOf(codeMatch[1]) + codeMatch[1].length) : label);

    const key = keyFor(code, textLabel);
    // Spalva laikoma originaliame lauke, todėl bendras patikrinimas jos
    // nepagauna ir be šito vėlesnė eilutė perrašytų jau rastą.
    const taken = key === "colour" ? data.colour_raw || colourByCode : data[key];
    if (!key || taken) continue;
    data.sources[key] = index;

    if (key === "vin") {
      if (PLACE_WORDS.some((word) => textLabel.includes(word))) continue;
      const compact = value.replace(/\s/g, "").toUpperCase();
      const exact = compact.match(VIN_RE);
      if (exact) {
        data.vin = exact[0];
      } else {
        const repaired = (compact.match(VIN_LOOSE_RE) || [])
          .map(repairVin).find(Boolean);
        if (!repaired) continue;
        data.vin = repaired;
        data.warnings.push(
          `VIN pataisytas po atpažinimo (${compact.match(VIN_LOOSE_RE)[0]} → ${repaired}) – sutampa kontrolinis skaitmuo, bet vis tiek sulyginkite.`,
        );
      }
    } else if (key === "manufacture_date") {
      data.manufacture_date = normaliseDate(value);
    } else if (key === "colour") {
      const named = ["colour", "color", "couleur", "farbe", "colore"]
        .some((word) => textLabel.includes(word));
      if (code === "40" && !named) colourByCode = colourByCode || value;
      else data.colour_raw = value;
    } else {
      data[key] = value;
    }
  }

  if (!data.colour_raw && colourByCode) data.colour_raw = colourByCode;
  data.colour = toLithuanian(data.colour_raw);

  // Tipo patvirtinimas: frazė skiriasi pagal kalbą („granted on“, „issued on“,
  // „délivrée le“), todėl remiamės numeriu, o datos ieškome iškart po jo.
  const approval = APPROVAL_RE.exec(flat);
  const loose = approval ? null : APPROVAL_LOOSE_RE.exec(flat);
  if (approval || loose) {
    let end;
    if (approval) {
      data.approval_number = approval[0].replace(/\s+/g, "");
      end = approval.index + approval[0].length;
    } else {
      const parts = loose.slice(1, 6).map((group) => group.replace(/\s/g, ""));
      data.approval_number = `${parts[0]}*${parts[1]}/${parts[2]}*${parts[3]}*${parts[4]}`;
      end = loose.index + loose[0].length;
      data.warnings.push(
        `Tipo patvirtinimo Nr. „${data.approval_number}“ sudėliotas iš neaiškiai atpažinto teksto – sulyginkite su liudijimu.`,
      );
    }
    const date = DATE_RE.exec(flat.slice(end, end + 120));
    if (date) data.approval_date = normaliseDate(date[0]);
  }

  const fileVin = vinFromFilename(sourceFile);
  if (!data.vin && fileVin) {
    data.vin = fileVin;
    data.warnings.push(
      `VIN „${fileVin}“ paimtas iš failo pavadinimo (liudijime jo atpažinti nepavyko) – kontrolinis skaitmuo sutampa, bet sulyginkite.`,
    );
  } else if (data.vin && fileVin && data.vin !== fileVin) {
    data.warnings.push(
      `Dėmesio: liudijime rastas VIN „${data.vin}“ nesutampa su failo pavadinimu („${fileVin}“).`,
    );
  }

  if (!data.vin) {
    for (const candidate of flat.match(VIN_RE) || []) {
      if (/[A-Z]/.test(candidate) && /\d/.test(candidate)) {
        data.vin = candidate;
        data.warnings.push("VIN rastas ne pagal 0.10 skirsnį, o pagal formatą – patikrinkite.");
        break;
      }
    }
  }

  const required = [
    ["make", "Gamybinė markė (0.1)"],
    ["type", "Tipas (0.2)"],
    ["commercial_name", "Komercinis pavadinimas (0.2.1)"],
    ["vin", "Identifikavimo numeris (0.10)"],
    ["approval_number", "Tipo patvirtinimo Nr."],
    ["approval_date", "Tipo patvirtinimo datos"],
  ];
  for (const [field, human] of required) {
    if (!data[field]) data.warnings.push(`Nerasta: ${human}`);
  }
  data.category = tidyCategory(data.category);
  const fixedName = tidyModelNames(data.commercial_name);
  if (fixedName !== data.commercial_name) {
    data.warnings.push(`Komercinis pavadinimas pataisytas iš „${data.commercial_name}“ į „${fixedName}“.`);
    data.commercial_name = fixedName;
  }

  const corrected = makeFromCommercialName(data.make, data.commercial_name);
  if (corrected !== data.make) {
    data.warnings.push(`Markė pataisyta iš „${data.make}“ į „${corrected}“ pagal komercinį pavadinimą.`);
    data.make = corrected;
  }

  if (data.vin && ocrUsed && !vinCheckDigitValid(data.vin)) {
    data.warnings.push(
      `VIN „${data.vin}“ kontrolinis skaitmuo nesutampa – po atpažinimo būtinai sulyginkite su liudijimu.`,
    );
  }
  if (ocrUsed) {
    data.warnings.push(
      "CoC skenuotas – duomenys atpažinti automatiškai. Prieš spausdindami sulyginkite VIN ir spalvą su liudijimu.",
    );
  }
  if (data.colour_raw && !data.colour) {
    data.warnings.push(`Spalva „${data.colour_raw}“ neatpažinta – įrašykite lietuvišką pavadinimą.`);
  } else if (!data.colour_raw) {
    data.warnings.push("Nerasta: spalva (40) – gali būti kitoje liudijimo pusėje.");
  }

  data.type_variant_version = typeVariantVersion(data);
  return data;
}
