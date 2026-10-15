// Sandėlio logika, nepriklausanti nuo naršyklės: VIN tvarkymas, paieška,
// ataskaita ir atsarginės kopijos suliejimas. Tikrinama `web/tests`.

import { vinCheckDigitValid } from "../coc.js";

/** Būsenos: ką tik nuskenuotas (dar nepatikrintas), turimas, atiduotas. */
export const STATUS = { REVIEW: "tikrinti", IN: "turimas", OUT: "atiduotas" };

/**
 * Suvienodina VIN taip, kaip jis rašomas.
 *
 * VIN abėcėlėje nėra I, O ir Q (ISO 3779) – jie visada yra 1 ir 0. Todėl
 * įvedus „O“ ar „I“ iškart pataisoma, o paieška randa ir taip įvestą numerį.
 */
export function cleanVin(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OQ]/g, "0")
    .replace(/I/g, "1");
}

/** Kas negerai su VIN: [] jei viskas tvarkoje, kitaip – pranešimai. */
export function vinProblems(vin) {
  const value = cleanVin(vin);
  if (!value) return ["VIN neįrašytas."];
  if (value.length !== 17) return [`VIN turi būti 17 ženklų, dabar ${value.length}.`];
  return [];
}

/**
 * Ar VIN verta sulyginti dar kartą.
 *
 * Europoje kontrolinis skaitmuo neprivalomas, todėl tai tik užuomina, o ne
 * klaida. Bet jei gamintojas jį naudoja (Nissan, Hyundai…), nesutapimas beveik
 * visada reiškia neteisingai perskaitytą ženklą.
 */
export const vinDoubtful = (vin) => cleanVin(vin).length === 17 && !vinCheckDigitValid(cleanVin(vin));

const fold = (text) => String(text || "")
  .normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .trim();

/**
 * Ar įrašas atitinka paieškos tekstą.
 *
 * VIN ieškoma bet kuria jo dalimi (dažniausiai – paskutiniais 6 ženklais),
 * kiti laukai – pagal žodžius: „qashqai jonas“ randa Jonui atiduotus Qashqai.
 */
export function matches(record, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const vin = record.vin || "";
  const text = fold([
    record.make, record.model, record.tvv, record.given_to, record.note, record.source_file, record.folder,
  ].join(" "));
  return words.every((word) => {
    const asVin = cleanVin(word);
    if (asVin.length >= 3 && vin.includes(asVin)) return true;
    return text.includes(word);
  });
}

const BRANDS = [
  "ALFA ROMEO", "AUDI", "BMW", "BYD", "CITROEN", "CITROËN", "CUPRA", "DACIA", "DS", "FIAT", "FORD", "HONDA",
  "HYUNDAI", "IVECO", "JEEP", "KIA", "LAND ROVER", "LEXUS", "MAZDA", "MERCEDES-BENZ", "MG", "MINI", "MITSUBISHI",
  "NISSAN", "OPEL", "PEUGEOT", "POLESTAR", "RENAULT", "SEAT", "SKODA", "ŠKODA", "SMART", "SUBARU", "SUZUKI",
  "TESLA", "TOYOTA", "VOLKSWAGEN", "VOLVO", "VW",
];

/**
 * Atskiria markę nuo modelio.
 *
 * CoC komerciniame pavadinime dažnai būna ir markė („NISSAN QASHQAI“), o
 * atpažinimas kartais praleidžia tarpą („NISSANQASHQAI“). Sąraše patogiau
 * markė atskirai, modelis atskirai. Be tarpo skeliama tik ilgesnė markė –
 * kad „MINIVAN“ netaptų „MINI“ + „VAN“.
 */
export function splitMakeModel(make, model) {
  const name = String(model || "").trim();
  const known = String(make || "").trim();
  for (const brand of [known, ...BRANDS].filter(Boolean)) {
    if (!name.toUpperCase().startsWith(brand.toUpperCase())) continue;
    const rest = name.slice(brand.length);
    const spaced = /^[\s-]/.test(rest);
    const tail = rest.replace(/^[\s-]+/, "");
    if (!tail || (!spaced && brand.length < 5)) continue;
    return { make: known || name.slice(0, brand.length).toUpperCase(), model: tail };
  }
  return { make: known, model: name };
}

/**
 * Kuriame fiziniame aplanke guli liudijimas.
 *
 * Dauguma CoC sudėti į aplankus pagal modelį – tada aplankas yra pats modelis.
 * Bet yra ir specialūs aplankai (pvz. „Nėra moderoje“), kuriuose kartu guli
 * skirtingi modeliai: tokio aplanko pavadinimas įrašomas `record.folder` ir
 * modelis jo nebekeičia.
 */
/** Žinomi modeliai: koks bebūtų užrašas CoC („Micra“, „MICRA EV“, „NISSAN MICRA“), modelis vienas. */
const MODEL_NAMES = [
  ["QASHQAI", /QASH?Q?AI|QASHOAI/], ["X-TRAIL", /X\W?TRA[I1L]L/], ["JUKE", /JUKE/], ["ARIYA", /ARIYA/],
  ["LEAF", /LEAF/], ["MICRA", /MICRA|M[I1L]CRA/], ["TOWNSTAR", /TOWNSTAR/], ["NOTE", /\bNOTE\b/],
  ["NAVARA", /NAVARA/], ["PRIMASTAR", /PRIMASTAR/], ["INTERSTAR", /INTERSTAR/],
];

/** Vienodas modelio pavadinimas aplankams: pagal pavadinimą, o neatpažinus – pagal VIN. */
export function canonicalModel(text, vin = "") {
  const upper = String(text || "").trim().toUpperCase();
  for (const [name, pattern] of MODEL_NAMES) if (pattern.test(upper)) return name;
  const fromVin = modelFromVin(vin);
  if (fromVin) return fromVin.model;
  return upper.replace(/^NISSAN\s+/, "").replace(/\s+/g, " ");
}

export function folderOf(record) {
  const special = String(record.folder || "").trim();
  if (special) return special;
  return canonicalModel(record.model, record.vin) || "Be modelio";
}

/** Ar liudijimas guli specialiame (ne modelio) aplanke. */
export const inSpecialFolder = (record) => Boolean(String(record.folder || "").trim());

/** Specialių aplankų sąrašas su kiekiais (tik turimi CoC), abėcėlės tvarka. */
export function specialFolders(records, extra = []) {
  const totals = new Map(extra.filter(Boolean).map((name) => [name, 0]));
  for (const record of records) {
    if (!inSpecialFolder(record)) continue;
    const name = record.folder.trim();
    totals.set(name, (totals.get(name) || 0) + (record.status === STATUS.IN ? 1 : 0));
  }
  return [...totals].map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "lt"));
}

/**
 * CoC, kurių VIN atitinka paieškos tekstą (pakanka 4 paskutinių ženklų).
 *
 * Pirmiausia ieškoma VIN pabaigoje – taip dažniausiai ir sakoma („…2374201“
 * arba „4201“); jei nieko nėra, bet kurioje VIN vietoje. Grąžina [] ir tada,
 * kai tekstas nepanašus į VIN dalį (per trumpas ar be skaitmenų).
 */
export function vinHits(records, query) {
  const text = String(query || "").trim();
  const part = cleanVin(text);
  if (/\s/.test(text) || part.length < 4 || !/\d/.test(part)) return [];
  const withVin = records.filter((record) => record.vin);
  const atEnd = withVin.filter((record) => record.vin.endsWith(part));
  return atEnd.length ? atEnd : withVin.filter((record) => record.vin.includes(part));
}

/**
 * Turimi CoC, sugrupuoti pagal fizinį aplanką – aplanko lapui spausdinti.
 * Aplankai abėcėlės tvarka, juose – pagal modelį ir VIN.
 */
export function folderGroups(records) {
  const groups = new Map();
  for (const record of records) {
    if (record.status !== STATUS.IN) continue;
    const name = folderOf(record);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(record);
  }
  return [...groups].map(([name, items]) => ({
    name,
    special: items.some(inSpecialFolder),
    records: items.sort((a, b) => String(a.model || "").localeCompare(String(b.model || ""), "lt")
      || String(a.vin || "").localeCompare(String(b.vin || ""))),
  })).sort((a, b) => a.name.localeCompare(b.name, "lt"));
}

/**
 * Nissan modelio kodai VIN'e (4–6 ženklai, pvz. SJN**J12**…) – kartu ir karta.
 * Tikrinta su tikrais CoC: SJNJ12… Qashqai, JN1T33… X-Trail, SJNF16… Juke,
 * SJNZE2… Leaf, VNVK15… Micra.
 */
export const NISSAN_CODES = {
  J10: { model: "QASHQAI", generation: "J10" },
  J11: { model: "QASHQAI", generation: "J11" },
  J12: { model: "QASHQAI", generation: "J12" },
  T31: { model: "X-TRAIL", generation: "T31" },
  T32: { model: "X-TRAIL", generation: "T32" },
  T33: { model: "X-TRAIL", generation: "T33" },
  F15: { model: "JUKE", generation: "F15" },
  F16: { model: "JUKE", generation: "F16" },
  ZE0: { model: "LEAF", generation: "ZE0" },
  ZE1: { model: "LEAF", generation: "ZE1" },
  ZE2: { model: "LEAF", generation: "ZE2" },
  K13: { model: "MICRA", generation: "K13" },
  K14: { model: "MICRA", generation: "K14" },
  K15: { model: "MICRA", generation: "K15" },
  FE0: { model: "ARIYA", generation: "FE0" },
};

/** Modelis ir karta iš VIN (null, jei kodas nežinomas). */
export function modelFromVin(vin) {
  const value = cleanVin(vin);
  if (value.length < 9) return null;
  // Dažniausiai kodas yra 4–6 ženkluose; kai kuriuose VIN – kiek toliau (iki 9-o).
  for (let start = 3; start <= 6; start += 1) {
    const hit = NISSAN_CODES[value.slice(start, start + 3)];
    if (hit) return { make: "NISSAN", ...hit };
  }
  return null;
}

/** Rūšiavimas: naujausi viršuje. */
export const newestFirst = (a, b) => String(b.added || "").localeCompare(String(a.added || ""));

/** Kiek kokių įrašų yra. */
export function counts(records) {
  const result = { all: records.length, [STATUS.REVIEW]: 0, [STATUS.IN]: 0, [STATUS.OUT]: 0 };
  for (const record of records) result[record.status] = (result[record.status] || 0) + 1;
  return result;
}

/** Kiti įrašai su tuo pačiu VIN. */
export function duplicatesOf(records, record) {
  const vin = cleanVin(record.vin);
  if (vin.length < 11) return [];
  return records.filter((other) => other.id !== record.id && cleanVin(other.vin) === vin);
}

export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Diena pagal vietinį laiką.
 *
 * Įkėlimo laikas saugomas UTC (`2026-10-06T22:30:00Z`), o Lietuvoje tai jau
 * spalio 7-oji – vien nukirpus datą ji būtų diena per anksti.
 */
export function localDay(value) {
  const text = String(value || "");
  if (!text.includes("T")) return text.slice(0, 10);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 10) : todayIso(date);
}

/** `2026-10-07` → `2026.10.07` (taip datas rašome lietuviškai). */
export const showDate = (iso) => localDay(iso).replace(/-/g, ".");

/** PDF failo pavadinimas: `SJNJ12TD3U2000001_QASHQAI.pdf`. */
export function pdfName(record) {
  const safe = (text) => String(text || "").trim().replace(/[^\p{L}\p{N}-]+/gu, "_").replace(/^_+|_+$/g, "");
  const parts = [safe(cleanVin(record.vin)) || "be_VIN", safe(record.model)].filter(Boolean);
  return `${parts.join("_")}.pdf`;
}

const STATUS_NAMES = {
  [STATUS.REVIEW]: "Netikrintas", [STATUS.IN]: "Turimas", [STATUS.OUT]: "Atiduotas",
};
export const statusName = (status) => STATUS_NAMES[status] || status;

/** Excel stulpeliai (žr. `xlsx.js`). `codes` – aplankų kodai (`assignFolderCodes`). */
export function excelColumns(codes = {}) {
  return [
    { title: "VIN", get: (r) => r.vin, width: 22, kind: "mono" },
    { title: "Markė", get: (r) => r.make, width: 14 },
    { title: "Modelis", get: (r) => r.model, width: 22 },
    { title: "Tipas/Variantas/Versija", get: (r) => r.tvv, width: 24 },
    { title: "Spalva", get: (r) => (r.coc || {}).colour, width: 14 },
    { title: "Aplanko kodas", get: (r) => (r.status === STATUS.IN ? r.binder || codes[folderOf(r)] || "" : ""), width: 10 },
    { title: "Aplankas", get: (r) => folderOf(r), width: 20 },
    { title: "Būsena", get: (r) => statusName(r.status), width: 12 },
    { title: "Įkelta", get: (r) => localDay(r.added), width: 12, kind: "date" },
    { title: "Atiduota", get: (r) => r.given_date, width: 12, kind: "date" },
    { title: "Kam atiduota", get: (r) => r.given_to, width: 26 },
    { title: "Pastaba", get: (r) => r.note, width: 30 },
    { title: "Failas", get: (r) => r.source_file, width: 24 },
  ];
}
export const EXCEL_COLUMNS = excelColumns();

/** Visi aplankai (modelių ir specialūs), kuriuose yra ar buvo CoC. */
export function folderNames(records, extra = []) {
  const names = new Set();
  for (const record of records) names.add(folderOf(record));
  for (const name of extra) if (String(name || "").trim()) names.add(String(name).trim());
  return [...names].sort((a, b) => a.localeCompare(b, "lt"));
}

const CODE_RE = /^([A-Z]+)-(\d+)$/;

/** Švarus aplanko kodas: „a1“ → „A-01“, „b-7“ → „B-07“; kitaip – didžiosiomis kaip įvesta. */
export function cleanFolderCode(text) {
  const value = String(text || "").trim().toUpperCase().replace(/\s+/g, "");
  const match = value.match(/^([A-Z]+)-?(\d+)$/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}` : value;
}

/**
 * Trumpi aplankų kodai (A-01, A-02…), kad aplanką lentynoje rastumėte iš karto.
 * Jau turimi kodai nekeičiami; naujiems aplankams duodamas kitas laisvas numeris.
 */
export function assignFolderCodes(names, codes = {}) {
  const result = { ...codes };
  const used = new Set(Object.values(result));
  let next = 1;
  for (const code of used) {
    const match = CODE_RE.exec(code);
    if (match && match[1] === "A") next = Math.max(next, Number(match[2]) + 1);
  }
  for (const name of names) {
    if (result[name]) continue;
    let code;
    do { code = `A-${String(next).padStart(2, "0")}`; next += 1; } while (used.has(code));
    result[name] = code;
    used.add(code);
  }
  return result;
}

/** Excel lapai: turimi, atiduoti ir visi kartu (nepatikrinti neįtraukiami). */
export function excelSheets(records) {
  const ready = records.filter((r) => r.status !== STATUS.REVIEW).sort(newestFirst);
  return [
    { name: "Turimi", rows: ready.filter((r) => r.status === STATUS.IN) },
    { name: "Atiduoti", rows: ready.filter((r) => r.status === STATUS.OUT)
      .sort((a, b) => String(b.given_date).localeCompare(String(a.given_date))) },
    { name: "Visi", rows: ready },
  ];
}

/**
 * Ką įrašyti iš atsarginės kopijos.
 *
 * Įrašas, kurio dar nėra, pridedamas; esamas pakeičiamas tik tada, kai kopijoje
 * jis buvo keistas vėliau. Taip kopiją galima įkelti ir į jau pildomą sąrašą –
 * nieko neprarandant ir nieko nedubliuojant.
 */
export function mergePlan(existing, incoming) {
  const byId = new Map(existing.map((record) => [record.id, record]));
  const plan = { add: [], replace: [], skip: 0 };
  for (const record of incoming) {
    if (!record || !record.id) continue;
    const current = byId.get(record.id);
    if (!current) plan.add.push(record);
    else if (String(record.updated || "") > String(current.updated || "")) plan.replace.push(record);
    else plan.skip += 1;
  }
  return plan;
}

/** Kada paskutinį kartą daryta kopija – ir ar jau laikas priminti. */
export function backupDue(lastBackup, recordCount, now = new Date(), days = 7) {
  if (!recordCount) return false;
  if (!lastBackup) return true;
  return now - new Date(lastBackup) > days * 24 * 3600 * 1000;
}

/**
 * VIN sąrašas iš įklijuoto teksto (po vieną eilutėje, per kablelį ar tarpą).
 * Imami tik į VIN dalį panašūs žodžiai: bent 5 ženklai ir bent vienas skaitmuo.
 * Pasikartojantys praleidžiami.
 */
export function vinList(text) {
  const seen = new Set();
  const list = [];
  for (const word of String(text || "").split(/[\s,;|]+/)) {
    const vin = cleanVin(word);
    if (vin.length < 5 || !/\d/.test(vin) || seen.has(vin)) continue;
    seen.add(vin);
    list.push(vin);
  }
  return list;
}

/**
 * Kelių VIN patikra iš karto: kiekvienam – rasti CoC (pilnas VIN – tik tikslus
 * atitikmuo, trumpesnis – VIN pabaiga, kaip įprastoje paieškoje).
 */
export function bulkCheck(records, vins) {
  const withVin = records.filter((record) => record.vin);
  return vins.map((query) => {
    const hits = query.length === 17
      ? withVin.filter((record) => cleanVin(record.vin) === query)
      : vinHits(withVin, query);
    const order = { [STATUS.IN]: 0, [STATUS.REVIEW]: 1, [STATUS.OUT]: 2 };
    hits.sort((a, b) => order[a.status] - order[b.status]);
    const best = hits[0] || null;
    const state = !best ? "none" : best.status === STATUS.IN ? "in" : best.status === STATUS.OUT ? "out" : "review";
    return { query, hits, state };
  });
}

// ---------------------------------------------------------------------------
// Fiziniai aplankai (įmautės) po 20 CoC
// ---------------------------------------------------------------------------

/** Kiek CoC telpa į vieną aplanką. */
export const BINDER_SIZE = 20;

const codeNumber = (code) => {
  const match = /^A-(\d+)$/.exec(String(code || ""));
  return match ? Number(match[1]) : 0;
};
const byCode = (a, b) => codeNumber(a.code) - codeNumber(b.code) || String(a.code).localeCompare(String(b.code));

/** Rūšiavimas aplanko viduje (ir perrūšiuojant): pagal VIN. */
const inBinderOrder = (a, b) => String(a.vin || "").localeCompare(String(b.vin || "")) || String(a.added || "").localeCompare(String(b.added || ""));

/**
 * Kuriame aplanke (įmautėje) guli kiekvienas turimas CoC.
 *
 * Aplankai – pagal modelį, po `size` CoC. Specialūs aplankai (pvz. žmonių vardais)
 * neskaidomi: visas aplankas – vienas, kad ir kiek jame būtų, modeliai maišosi. Atiduotas
 * CoC vietą atlaisvina; naujas dedamas į pirmą tos grupės aplanką, kuriame yra
 * vietos, o jei visi pilni – sukuriamas naujas su kitu laisvu kodu.
 * `reorganize` – perrūšiuoti viską iš naujo (pagal VIN), paliekant esamus kodus.
 * `codes` – senieji grupių kodai (pirmas grupės aplankas gauna jį).
 * `auto: false` – modelių CoC be aplanko taip ir paliekami (žmogus juos sudeda pats).
 *
 * Grąžina { binders: [{ code, group }], assign: { įrašo id: kodas arba "" } }.
 */
export function planBinders(records, binders = [], { size = BINDER_SIZE, reorganize = false, codes = {}, auto = true } = {}) {
  // Seni aplankai galėjo būti pavadinti pagal netikslų užrašą („MICRA EV“) – suvienodinama.
  const specials = new Set(records.filter(inSpecialFolder).map((record) => String(record.folder).trim()));
  const list = binders.map((binder) => ({ ...binder, group: specials.has(binder.group) ? binder.group : canonicalModel(binder.group) }));
  codes = Object.fromEntries(Object.entries(codes).map(([group, code]) => [specials.has(group) ? group : canonicalModel(group), code]));
  const used = new Set(list.map((binder) => binder.code));
  let next = Math.max(0, ...list.map((binder) => codeNumber(binder.code)), ...Object.values(codes).map(codeNumber)) + 1;
  const create = (group) => {
    let code = codes[group];
    if (!code || used.has(code)) {
      do { code = `A-${String(next).padStart(2, "0")}`; next += 1; } while (used.has(code));
    }
    used.add(code);
    const binder = { code, group };
    list.push(binder);
    return binder;
  };

  const assign = {};
  const groups = new Map();
  for (const record of records) {
    if (record.status !== STATUS.IN) { assign[record.id] = ""; continue; }
    const group = folderOf(record);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(record);
  }

  for (const [group, members] of groups) {
    const own = () => list.filter((binder) => binder.group === group).sort(byCode);
    if (members.some(inSpecialFolder)) {
      // Specialus aplankas – visada vienas (jei anksčiau buvo padalintas – sujungiamas).
      const [keep, ...extra] = own();
      const target = keep || create(group);
      for (const binder of extra) list.splice(list.indexOf(binder), 1);
      for (const record of members) assign[record.id] = target.code;
      continue;
    }
    const limit = size;
    const filled = new Map();
    const put = (record, binder) => {
      assign[record.id] = binder.code;
      filled.set(binder.code, (filled.get(binder.code) || 0) + 1);
    };
    const waiting = [];
    if (reorganize) {
      waiting.push(...[...members].sort(inBinderOrder));
    } else {
      const valid = new Set(own().map((binder) => binder.code));
      // Tie, kurie jau guli savo aplanke, ten ir lieka (kol telpa).
      for (const record of [...members].sort((a, b) => String(a.added || "").localeCompare(String(b.added || "")))) {
        const code = record.binder;
        if (valid.has(code) && (filled.get(code) || 0) < limit) put(record, { code });
        else waiting.push(record);
      }
      waiting.sort(inBinderOrder);
    }
    for (const record of waiting) {
      if (!auto && !reorganize) { assign[record.id] = ""; continue; }
      let binder = own().find((item) => (filled.get(item.code) || 0) < limit);
      if (!binder) binder = create(group);
      put(record, binder);
    }
  }
  list.sort(byCode);
  return { binders: list, assign };
}

/**
 * Aplankų turinys: kiekvienam aplankui – grupė, eilės numeris grupėje
 * („2 iš 3“) ir jame esantys turimi CoC (pagal VIN).
 */
export function binderContents(records, binders) {
  const byBinder = new Map(binders.map((binder) => [binder.code, []]));
  for (const record of records) {
    if (record.status === STATUS.IN && record.binder && byBinder.has(record.binder)) byBinder.get(record.binder).push(record);
  }
  const perGroup = new Map();
  for (const binder of binders) perGroup.set(binder.group, [...(perGroup.get(binder.group) || []), binder.code]);
  return [...binders].sort(byCode).map((binder) => {
    const siblings = perGroup.get(binder.group);
    const items = byBinder.get(binder.code);
    return {
      ...binder,
      special: items.some(inSpecialFolder),
      index: siblings.indexOf(binder.code) + 1,
      of: siblings.length,
      records: items.sort(inBinderOrder),
    };
  });
}
