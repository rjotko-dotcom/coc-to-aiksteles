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
    record.make, record.model, record.tvv, record.given_to, record.note, record.source_file,
  ].join(" "));
  return words.every((word) => {
    const asVin = cleanVin(word);
    if (asVin.length >= 3 && vin.includes(asVin)) return true;
    return text.includes(word);
  });
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

/** `2026-10-07` → `2026.10.07` (taip datas rašome lietuviškai). */
export const showDate = (iso) => (iso ? String(iso).slice(0, 10).replace(/-/g, ".") : "");

export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

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

/**
 * Lentelė Excel'iui.
 *
 * Skyriklis – kabliataškis: lietuviškame Excel'yje kablelis yra dešimtainis
 * ženklas, todėl kableliais atskirtas failas atsidarytų viename stulpelyje.
 */
export function toCsv(records) {
  const columns = [
    ["VIN", (r) => r.vin],
    ["Markė", (r) => r.make],
    ["Modelis", (r) => r.model],
    ["Tipas/Variantas/Versija", (r) => r.tvv],
    ["Būsena", (r) => statusName(r.status)],
    ["Įkelta", (r) => showDate(r.added)],
    ["Atiduota", (r) => showDate(r.given_date)],
    ["Kam atiduota", (r) => r.given_to],
    ["Pastaba", (r) => r.note],
    ["Failas", (r) => r.source_file],
  ];
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [columns.map(([name]) => cell(name)).join(";")];
  for (const record of records) lines.push(columns.map(([, get]) => cell(get(record))).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
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
