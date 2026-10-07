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
export function folderOf(record) {
  const special = String(record.folder || "").trim();
  if (special) return special;
  return String(record.model || "").trim().toUpperCase() || "Be modelio";
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

/** Excel stulpeliai (žr. `xlsx.js`). */
export const EXCEL_COLUMNS = [
  { title: "VIN", get: (r) => r.vin, width: 22, kind: "mono" },
  { title: "Markė", get: (r) => r.make, width: 14 },
  { title: "Modelis", get: (r) => r.model, width: 22 },
  { title: "Tipas/Variantas/Versija", get: (r) => r.tvv, width: 24 },
  { title: "Aplankas", get: (r) => folderOf(r), width: 20 },
  { title: "Būsena", get: (r) => statusName(r.status), width: 12 },
  { title: "Įkelta", get: (r) => localDay(r.added), width: 12, kind: "date" },
  { title: "Atiduota", get: (r) => r.given_date, width: 12, kind: "date" },
  { title: "Kam atiduota", get: (r) => r.given_to, width: 26 },
  { title: "Pastaba", get: (r) => r.note, width: 30 },
  { title: "Failas", get: (r) => r.source_file, width: 24 },
];

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
