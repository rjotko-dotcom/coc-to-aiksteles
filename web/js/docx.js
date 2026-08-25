// Pažymos („aikštelės“) Word dokumento pildymas naršyklėje.
// Tas pats algoritmas kaip `app/aikstele_docx.py`, tik dirbama tiesiai su
// .docx viduje esančiu XML: failas išpakuojamas, pataisomas ir supakuojamas.

import { unzipSync, zipSync, strToU8, strFromU8 } from "../vendor/fflate/fflate.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** (raktas, pažymos pavadinimas, CoC skirsnis, RL skiltis) */
export const PAZYMA_ROWS = [
  ["make", "Gamybinė markė (gamintojo prekės pavadinimas)", "0.1", "D.1"],
  ["type_variant_version", "Tipas/Variantas/Versija", "0.2", "D.2"],
  ["commercial_name", "Komercinis pavadinimas", "0.2.1", "D.3"],
  ["vin", "Transporto priemonės identifikavimo numeris", "0.10", "E"],
  ["approval_number", "Tipo patvirtinimo Nr.", "", "K"],
  ["approval_date", "Tipo patvirtinimo numerio suteikimo data", "", ""],
  ["national_approval_number", "Nacionalinis patvirtinimo numeris", "", "K1"],
  ["colour", "Transporto priemonės spalva", "40", "R"],
];

/** Pagal ką atpažįstamos šablono eilutės (tikrinama iš eilės). */
const ROW_MATCHERS = [
  ["national_approval_number", ["nacionalinis patvirtinimo numeris", "nacionalinis"]],
  ["approval_date", ["suteikimo data", "patvirtinimo data"]],
  ["approval_number", ["tipo patvirtinimo nr", "tipo patvirtinimo numeris"]],
  ["vin", ["identifikavimo numeris", "vin"]],
  ["commercial_name", ["komercinis pavadinimas"]],
  ["type_variant_version", ["tipas/variantas/versija", "tipas / variantas", "tipas"]],
  ["make", ["gamybine marke", "marke"]],
  ["colour", ["spalva"]],
];

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Normalizuoja tekstą palyginimui: be diakritikų, mažosiomis. */
function fold(text) {
  return (text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^a-z0-9 /]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kodų palyginimui: „K.1“ ir „K1“ arba „0.2.1 “ laikomi tuo pačiu. */
function code(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const kids = (element, name) =>
  [...element.children].filter((child) => child.namespaceURI === W && child.localName === name);

const descendants = (element, name) => [...element.getElementsByTagNameNS(W, name)];

function cellText(cell) {
  return descendants(cell, "t").map((node) => node.textContent).join("").trim();
}

function setCellText(cell, value) {
  const paragraphs = kids(cell, "p");
  if (!paragraphs.length) return;
  paragraphs.slice(1).forEach((extra) => extra.remove());
  const paragraph = paragraphs[0];
  const texts = descendants(paragraph, "t");
  if (texts.length) {
    texts[0].textContent = value;
    texts[0].setAttributeNS(XML_NS, "xml:space", "preserve");
    texts.slice(1).forEach((node) => { node.textContent = ""; });
  } else {
    const doc = cell.ownerDocument;
    const run = doc.createElementNS(W, "w:r");
    const text = doc.createElementNS(W, "w:t");
    text.setAttributeNS(XML_NS, "xml:space", "preserve");
    text.textContent = value;
    run.appendChild(text);
    paragraph.appendChild(run);
  }
}

/** Suranda, kurioje eilutėje koks pažymos laukas. */
function matchRows(rows) {
  const matched = [];
  rows.forEach((row, index) => {
    const cells = kids(row, "tc");
    if (cells.length < 2) return;
    const label = fold(cellText(cells[0]));
    if (!label) return;
    for (const [key, needles] of ROW_MATCHERS) {
      if (matched.some(([, found]) => found === key)) continue;
      if (needles.some((needle) => label.includes(fold(needle)))) {
        matched.push([index, key]);
        return;
      }
    }
  });
  return matched;
}

const ROW_CODES = Object.fromEntries(
  PAZYMA_ROWS.map(([key, , section, rl]) => [key, [section, rl]]),
);

/**
 * Nustato, kuriame stulpelyje rašomos reikšmės.
 *
 * Vien pagal tuščius langelius spręsti negalima – blankas dažnai būna
 * ankstesnės pažymos kopija su likusiais duomenimis. Todėl atmetami
 * stulpeliai su CoC skirsnių numeriais (0.1, 0.2, 40…) ir RL kodais
 * (D.1, E, K, R…), o iš likusių renkamasi tas, kurio antraštė tuščia.
 */
function findValueColumn(rows, matched) {
  if (!matched.length) return null;
  const cellsByRow = new Map(matched.map(([index]) => [index, kids(rows[index], "tc")]));
  const width = Math.min(...[...cellsByRow.values()].map((cells) => cells.length));
  if (width < 2) return null;

  const matchedIndexes = new Set(matched.map(([index]) => index));
  let header = null;
  if (!matchedIndexes.has(0) && rows.length) {
    const headerCells = kids(rows[0], "tc");
    if (headerCells.length >= width) header = headerCells;
  }

  let best = null;
  let bestScore = null;
  for (let column = 1; column < width; column += 1) {
    let sections = 0;
    let rlCodes = 0;
    let empty = 0;
    for (const [index, key] of matched) {
      const text = code(cellText(cellsByRow.get(index)[column]));
      const [section, rl] = ROW_CODES[key] || ["", ""];
      if (!text) { empty += 1; continue; }
      if (section && text === code(section)) sections += 1;
      if (rl && text === code(rl)) rlCodes += 1;
    }
    if (sections >= 2 || rlCodes >= 2) continue;

    let score = 0;
    if (header) {
      const headerText = fold(cellText(header[column]));
      if (["skirsnis", "skiltis", "rl"].some((word) => headerText.includes(word))) continue;
      if (!headerText) score += 10;
    }
    score += empty;
    if (bestScore === null || score > bestScore) {
      best = column;
      bestScore = score;
    }
  }
  return best;
}

function findDateBoxes(doc) {
  for (const table of descendants(doc.documentElement, "tbl")) {
    const rows = kids(table, "tr");
    if (rows.length !== 1) continue;
    const cells = kids(rows[0], "tc");
    if (cells.length >= 8 && cells.length <= 12 && cells.every((cell) => cellText(cell).length <= 1)) {
      return cells;
    }
  }
  return null;
}

/** Įrašo datą į langelius, išsaugant šablone esančius skirtukus. */
function fillDateBoxes(doc, docDate) {
  const digits = [...(docDate || "")].filter((ch) => ch >= "0" && ch <= "9");
  if (digits.length !== 8) return false;
  const cells = findDateBoxes(doc);
  if (!cells) return false;

  const existing = cells.map(cellText);
  const separators = new Set(
    existing.map((text, index) => (text && !/^\d$/.test(text) ? index : -1)).filter((i) => i >= 0),
  );
  const free = cells.map((_, index) => index).filter((index) => !separators.has(index));

  if (free.length === 8) {
    free.forEach((index, position) => setCellText(cells[index], digits[position]));
    return true;
  }
  if (!separators.size && cells.length === 10) {
    const stamped = `${digits.slice(0, 4).join("")}-${digits.slice(4, 6).join("")}-${digits.slice(6).join("")}`;
    cells.forEach((cell, index) => setCellText(cell, stamped[index]));
    return true;
  }
  return false;
}

function replacePlaceholders(doc, values) {
  let replaced = false;
  for (const paragraph of descendants(doc.documentElement, "p")) {
    const texts = descendants(paragraph, "t");
    if (!texts.length) continue;
    const full = texts.map((node) => node.textContent).join("");
    if (!full.includes("{{")) continue;
    const updated = full.replace(PLACEHOLDER_RE, (match, key) =>
      (key in values ? String(values[key] ?? "") : match));
    if (updated === full) continue;
    texts[0].textContent = updated;
    texts[0].setAttributeNS(XML_NS, "xml:space", "preserve");
    texts.slice(1).forEach((node) => { node.textContent = ""; });
    replaced = true;
  }
  return replaced;
}

function parseXml(bytes) {
  return new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
}

function serialiseXml(doc) {
  return strToU8(new XMLSerializer().serializeToString(doc));
}

/** Iš CoC duomenų paruošia visas dokumento reikšmes. */
export function buildValues(data, docDate = "") {
  const values = { ...data };
  if (!values.type_variant_version) {
    values.type_variant_version = [values.type, values.variant, values.version]
      .filter(Boolean).join("/");
  }
  values.doc_date = docDate || new Date().toISOString().slice(0, 10);
  values.national_approval_number = values.national_approval_number || "";
  return values;
}

/**
 * Užpildo Jūsų pažymos šabloną. Grąžina { bytes, warnings }.
 *
 * Eilutė „Nr.“ neliečiama – numerį įrašo pats vartotojas.
 */
export function fillTemplate(templateBytes, values) {
  const files = unzipSync(new Uint8Array(templateBytes));
  const doc = parseXml(files["word/document.xml"]);
  const warnings = [];

  let replacedAny = replacePlaceholders(doc, values);
  const headerParts = Object.keys(files).filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name));
  for (const name of headerParts) {
    const part = parseXml(files[name]);
    if (replacePlaceholders(part, values)) {
      files[name] = serialiseXml(part);
      replacedAny = true;
    }
  }

  const filled = new Set();
  for (const table of descendants(doc.documentElement, "tbl")) {
    const rows = kids(table, "tr");
    const matched = matchRows(rows);
    if (matched.length < 2) continue;
    const column = findValueColumn(rows, matched);
    if (column === null) continue;
    for (const [index, key] of matched) {
      const cells = kids(rows[index], "tc");
      if (column >= cells.length) continue;
      // Rašome ir tuščią reikšmę: blankas gali būti ankstesnės pažymos kopija,
      // o senos mašinos duomenys jokiu būdu negali likti.
      setCellText(cells[column], String(values[key] ?? ""));
      filled.add(key);
    }
  }

  fillDateBoxes(doc, values.doc_date);

  const expected = PAZYMA_ROWS.filter(([key]) => values[key]).map(([key]) => key);
  const missing = expected.filter((key) => !filled.has(key));
  if (missing.length && !replacedAny) {
    const names = Object.fromEntries(PAZYMA_ROWS.map(([key, name]) => [key, name]));
    warnings.push("Šablone nerastos eilutės: " + missing.map((key) => names[key]).join(", "));
  }

  files["word/document.xml"] = serialiseXml(doc);
  return { bytes: zipSync(files, { level: 6 }), warnings };
}

/** Patikrina šabloną: ką programa jame atpažįsta ir ko trūksta. */
export function analyseTemplate(templateBytes) {
  const files = unzipSync(new Uint8Array(templateBytes));
  const doc = parseXml(files["word/document.xml"]);
  const names = Object.fromEntries(PAZYMA_ROWS.map(([key, name]) => [key, name]));

  const recognised = {};
  const unrecognised = [];
  let valueColumn = null;

  for (const table of descendants(doc.documentElement, "tbl")) {
    const rows = kids(table, "tr");
    const matched = matchRows(rows);
    if (matched.length < 2) continue;
    const column = findValueColumn(rows, matched);
    if (column === null) continue;
    if (valueColumn === null) valueColumn = column;

    const matchedIndexes = new Set(matched.map(([index]) => index));
    for (const [index, key] of matched) {
      const cells = kids(rows[index], "tc");
      if (column < cells.length && !(names[key] in recognised)) {
        recognised[names[key]] = cellText(cells[0]);
      }
    }
    rows.forEach((row, index) => {
      if (matchedIndexes.has(index)) return;
      const cells = kids(row, "tc");
      if (!cells.length) return;
      const texts = cells.map((cell) => fold(cellText(cell)));
      if (texts.some((text) => text.includes("skirsnis") || text.includes("skiltis"))) return;
      const label = cellText(cells[0]);
      if (label && label.length < 120) unrecognised.push(label);
    });
  }

  const allText = descendants(doc.documentElement, "t").map((node) => node.textContent).join("\n");
  const placeholders = [...new Set([...allText.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
  const covered = new Set([
    ...Object.keys(recognised),
    ...placeholders.map((key) => names[key]).filter(Boolean),
  ]);

  return {
    value_column: valueColumn,
    recognised,
    unrecognised_rows: unrecognised,
    placeholders,
    missing: PAZYMA_ROWS.map(([, name]) => name).filter((name) => !covered.has(name)),
    date_boxes: findDateBoxes(doc) !== null,
  };
}

/** Failo pavadinimas iš VIN, pvz. `aikstele_SJNJ12TD3U2000001.docx`. */
export function suggestedFilename(values) {
  const vin = (values.vin || "be_vin").trim().replace(/\s/g, "");
  return `aikstele_${vin}.docx`;
}

/** Kelias pažymas supakuoja į vieną ZIP failą. */
export function zipDocuments(documents) {
  const files = {};
  const used = new Set();
  for (const [name, bytes] of documents) {
    let unique = name;
    let counter = 2;
    while (used.has(unique)) {
      unique = name.replace(/\.docx$/, `_${counter}.docx`);
      counter += 1;
    }
    used.add(unique);
    files[unique] = bytes;
  }
  return zipSync(files, { level: 6 });
}
