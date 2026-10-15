// Sandėlio logikos testai: node --test web/tests

import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCEL_COLUMNS, STATUS, backupDue, cleanVin, counts, duplicatesOf, excelSheets, folderOf, matches, mergePlan, specialFolders, vinHits, folderGroups, modelFromVin,
  pdfName, splitMakeModel, vinProblems,
} from "../js/sandelis/logic.js";
import { buildXlsx, excelDate } from "../js/sandelis/xlsx.js";
import { strFromU8, unzipSync } from "../vendor/fflate/fflate.mjs";

const record = (fields) => ({
  id: fields.vin || Math.random().toString(36), status: STATUS.IN, make: "", model: "", ...fields,
});

test("VIN: O, Q ir I virsta 0 ir 1, tarpai ir mažosios raidės sutvarkomi", () => {
  assert.equal(cleanVin(" sjnj12td3u2ooooo1 "), "SJNJ12TD3U2000001");
  assert.equal(cleanVin("SJN-J12 TD3 U2Q00001"), "SJNJ12TD3U2000001");
  assert.equal(cleanVin("VF7I"), "VF71");
});

test("VIN turi būti 17 ženklų", () => {
  assert.deepEqual(vinProblems("SJNJ12TD3U2000001"), []);
  assert.match(vinProblems("SJNJ12TD3U200001")[0], /16/);
  assert.match(vinProblems("")[0], /neįrašytas/);
});

test("paieška pagal paskutinius VIN ženklus, modelį ir gavėją", () => {
  const qashqai = record({ vin: "SJNJ12TD3U2000001", make: "NISSAN", model: "QASHQAI", given_to: "Jonas Jonaitis" });
  const kona = record({ vin: "KMHK381GFMU123456", make: "HYUNDAI", model: "KONA" });
  assert.ok(matches(qashqai, "000001"));
  assert.ok(matches(qashqai, "ooooo1"), "įvesta su O raidėmis vis tiek randa");
  assert.ok(!matches(kona, "000001"));
  assert.ok(matches(qashqai, "qashqai jonaitis"));
  assert.ok(!matches(kona, "qashqai"));
  assert.ok(matches(kona, ""));
});

test("dublikatai randami pagal VIN, bet ne pats su savimi", () => {
  const first = record({ id: "a", vin: "SJNJ12TD3U2000001" });
  const second = record({ id: "b", vin: "sjnj12td3u2000001" });
  const other = record({ id: "c", vin: "KMHK381GFMU123456" });
  assert.deepEqual(duplicatesOf([first, second, other], first).map((r) => r.id), ["b"]);
  assert.deepEqual(duplicatesOf([first, other], first), []);
});

test("skaičiai pagal būseną", () => {
  const list = [record({ id: 1 }), record({ id: 2, status: STATUS.OUT }), record({ id: 3, status: STATUS.REVIEW })];
  assert.deepEqual(counts(list), { all: 3, turimas: 1, atiduotas: 1, tikrinti: 1 });
});

test("Excel: trys lapai, datos kaip Excel datos, specialūs ženklai saugūs", () => {
  const list = [
    record({ id: "a", vin: "SJNJ12TD3U2000001", model: 'QASHQAI <"N-Connecta">', status: STATUS.OUT,
      added: "2026-10-01T08:00:00Z", given_date: "2026-10-07", given_to: "UAB „Autos“ & Co" }),
    record({ id: "b", vin: "KMHK381GFMU123456", model: "KONA", added: "2026-10-02T08:00:00Z" }),
    record({ id: "c", vin: "X", status: STATUS.REVIEW }),
  ];
  const sheets = excelSheets(list);
  assert.deepEqual(sheets.map((sheet) => [sheet.name, sheet.rows.length]), [["Turimi", 1], ["Atiduoti", 1], ["Visi", 2]]);
  const files = unzipSync(buildXlsx(sheets, EXCEL_COLUMNS));
  assert.ok(files["xl/workbook.xml"] && files["xl/styles.xml"] && files["xl/worksheets/sheet3.xml"]);
  const given = strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.ok(given.includes("QASHQAI &lt;&quot;N-Connecta&quot;&gt;"));
  assert.ok(given.includes("UAB „Autos“ &amp; Co"));
  assert.ok(given.includes(`<v>${excelDate("2026-10-07")}</v>`));
  assert.equal(excelDate("2026-10-07"), 46302);
});

test("PDF pavadinimas iš VIN ir modelio", () => {
  assert.equal(pdfName({ vin: "SJNJ12TD3U2000001", model: "QASHQAI" }), "SJNJ12TD3U2000001_QASHQAI.pdf");
  assert.equal(pdfName({ vin: "", model: "Juke / Hybrid" }), "be_VIN_Juke_Hybrid.pdf");
});

test("kopijos suliejimas: nauji pridedami, vėliau keisti pakeičia, kiti paliekami", () => {
  const existing = [
    { id: "a", updated: "2026-10-01T10:00:00Z" },
    { id: "b", updated: "2026-10-05T10:00:00Z" },
  ];
  const incoming = [
    { id: "a", updated: "2026-10-03T10:00:00Z" },
    { id: "b", updated: "2026-10-02T10:00:00Z" },
    { id: "c", updated: "2026-10-02T10:00:00Z" },
  ];
  const plan = mergePlan(existing, incoming);
  assert.deepEqual(plan.add.map((r) => r.id), ["c"]);
  assert.deepEqual(plan.replace.map((r) => r.id), ["a"]);
  assert.equal(plan.skip, 1);
});

test("priminimas apie kopiją", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(backupDue(null, 0, now), false);
  assert.equal(backupDue(null, 5, now), true);
  assert.equal(backupDue("2026-10-08T12:00:00Z", 5, now), false);
  assert.equal(backupDue("2026-10-01T12:00:00Z", 5, now), true);
});

test("markė atskiriama nuo modelio", () => {
  assert.deepEqual(splitMakeModel("NISSAN", "NISSAN QASHQAI"), { make: "NISSAN", model: "QASHQAI" });
  assert.deepEqual(splitMakeModel("", "NISSANQASHQAI"), { make: "NISSAN", model: "QASHQAI" });
  assert.deepEqual(splitMakeModel("", "Hyundai Kona Electric"), { make: "HYUNDAI", model: "Kona Electric" });
  assert.deepEqual(splitMakeModel("", "NISSAN X-TRAIL"), { make: "NISSAN", model: "X-TRAIL" });
  assert.deepEqual(splitMakeModel("", "MINIVAN"), { make: "", model: "MINIVAN" });
  assert.deepEqual(splitMakeModel("MINI", "MINI COUNTRYMAN"), { make: "MINI", model: "COUNTRYMAN" });
  assert.deepEqual(splitMakeModel("NISSAN", "NISSAN"), { make: "NISSAN", model: "NISSAN" });
  assert.deepEqual(splitMakeModel("CITROEN", "C4"), { make: "CITROEN", model: "C4" });
});

test("aplankas: pagal modelį arba specialus", () => {
  assert.equal(folderOf({ model: "Qashqai" }), "QASHQAI");
  assert.equal(folderOf({ model: "" }), "Be modelio");
  assert.equal(folderOf({ model: "JUKE", folder: "Nėra moderoje" }), "Nėra moderoje");
  const list = [
    record({ id: 1, model: "JUKE", folder: "Nėra moderoje" }),
    record({ id: 2, model: "KONA", folder: "Nėra moderoje" }),
    record({ id: 3, model: "KONA", folder: "Nėra moderoje", status: STATUS.OUT }),
    record({ id: 4, model: "QASHQAI" }),
  ];
  assert.deepEqual(specialFolders(list, ["Bėdos"]), [{ name: "Bėdos", count: 0 }, { name: "Nėra moderoje", count: 2 }]);
  assert.ok(matches(list[0], "moderoje"));
  assert.ok(!matches(list[3], "moderoje"));
});


test("paieška pagal 4 paskutinius VIN ženklus", () => {
  const list = [
    record({ id: "a", vin: "SJNJ12TA9U2374201" }),
    record({ id: "b", vin: "SJNJ12TD1U2334201" }),
    record({ id: "c", vin: "SJNJ12TD1U2339775" }),
    record({ id: "d", vin: "" }),
  ];
  assert.deepEqual(vinHits(list, "4201").map((r) => r.id), ["a", "b"]);
  assert.deepEqual(vinHits(list, "2374201").map((r) => r.id), ["a"]);
  assert.deepEqual(vinHits(list, "2339").map((r) => r.id), ["c"], "jei pabaigoje nėra – bet kur");
  assert.deepEqual(vinHits(list, "420"), [], "per trumpa");
  assert.deepEqual(vinHits(list, "QASHQAI"), [], "ne VIN");
  assert.deepEqual(vinHits(list, "9999"), []);
});

test("aplankų lapai: tik turimi, sugrupuoti ir surūšiuoti", () => {
  const list = [
    record({ id: 1, vin: "B2", model: "QASHQAI" }),
    record({ id: 2, vin: "A1", model: "QASHQAI" }),
    record({ id: 3, vin: "C3", model: "JUKE", folder: "Nėra moderoje" }),
    record({ id: 4, vin: "D4", model: "LEAF", folder: "Nėra moderoje" }),
    record({ id: 5, vin: "E5", model: "QASHQAI", status: STATUS.OUT }),
    record({ id: 6, vin: "F6", model: "MICRA", status: STATUS.REVIEW }),
  ];
  const groups = folderGroups(list);
  assert.deepEqual(groups.map((g) => [g.name, g.special, g.records.map((r) => r.vin)]), [
    ["Nėra moderoje", true, ["C3", "D4"]],
    ["QASHQAI", false, ["A1", "B2"]],
  ]);
});

test("modelis ir karta iš VIN (tikri Nissan VIN)", () => {
  assert.deepEqual(modelFromVin("SJNJ12TA9U2374201"), { make: "NISSAN", model: "QASHQAI", generation: "J12" });
  assert.equal(modelFromVin("JN1T33TB7U0062538").model, "X-TRAIL");
  assert.equal(modelFromVin("SJNF16FA2U2194020").model, "JUKE");
  assert.equal(modelFromVin("SJNZE2TB8U1005299").generation, "ZE2");
  assert.equal(modelFromVin("VNVK1500X76353558").model, "MICRA");
  assert.equal(modelFromVin("WVWZZZ1KZAW000001"), null);
  assert.equal(modelFromVin(""), null);
});

test("aplankų kodai: nauji gauna kitą laisvą, esami nesikeičia", async () => {
  const { assignFolderCodes, cleanFolderCode, folderNames } = await import("../js/sandelis/logic.js");
  const codes = assignFolderCodes(["JUKE", "QASHQAI", "Nėra moderoje"], { QASHQAI: "A-03" });
  assert.deepEqual(codes, { QASHQAI: "A-03", JUKE: "A-04", "Nėra moderoje": "A-05" });
  assert.deepEqual(assignFolderCodes(["A"], { B: "A-01" }), { B: "A-01", A: "A-02" });
  assert.equal(cleanFolderCode(" b7 "), "B-07");
  assert.equal(cleanFolderCode("a-12"), "A-12");
  assert.deepEqual(folderNames([{ model: "Juke" }, { model: "Leaf", folder: "Nėra moderoje" }], ["Tuščias"]),
    ["JUKE", "Nėra moderoje", "Tuščias"]);
});

test("automobilio paveikslas: modelis iš VIN, spalva iš CoC", async () => {
  const { carKeyOf, paintOf, generationOf, yearOf } = await import("../js/sandelis/cars.js");
  assert.equal(carKeyOf({ vin: "JN1T33TB7U0062538", model: "" }), "x-trail");
  assert.equal(carKeyOf({ vin: "", model: "QASHQAI" }), "qashqai");
  assert.equal(carKeyOf({ vin: "", model: "NOTE" }), null);
  assert.equal(generationOf({ vin: "SJNZE2TB8U1005299" }), "ZE2");
  assert.equal(yearOf({ coc: { manufacture_date: "12.05.2025" } }), 2025);
  assert.deepEqual(paintOf({ coc: { colour: "PILKA/JUODA" } }).rgb, [104, 108, 112]);
  assert.ok(paintOf({ coc: { colour: "PILKA", colour_raw: "Dark Grey" } }).rgb[0] < 104);
  assert.equal(paintOf({ coc: {} }), null);
});

test("keli VIN iš karto: kurie yra, kurių nėra", async () => {
  const { vinList, bulkCheck, STATUS } = await import("../js/sandelis/logic.js");
  assert.deepEqual(vinList("SJNJ12TA9U2000101\nJN1T33TB7U0062538, 2538; sjnj12ta9u2000101 abc 12"),
    ["SJNJ12TA9U2000101", "JN1T33TB7U0062538"]);
  assert.deepEqual(vinList("a1 x 1234 00501"), ["00501"]);
  const records = [
    { id: "a", vin: "SJNJ12TA9U2000101", status: STATUS.IN },
    { id: "b", vin: "JN1T33TB7U0062538", status: STATUS.OUT },
    { id: "c", vin: "VNVK1500X76000501", status: STATUS.IN },
  ];
  const result = bulkCheck(records, ["SJNJ12TA9U2000101", "JN1T33TB7U0062538", "SJNJ12TA9U2999999", "00501"]);
  assert.deepEqual(result.map((r) => r.state), ["in", "out", "none", "in"]);
  assert.equal(result[3].hits[0].id, "c");
});

test("spalvos nuotrauka: derinys su juodu stogu, pagrindinė spalva, perdažymas", async () => {
  const { colourSlug, shotFor } = await import("../js/sandelis/cars.js");
  assert.equal(colourSlug("ŽALIA/JUODA"), "zalia-juoda");
  assert.equal(colourSlug("SIDABRINĖ"), "sidabrine");
  assert.equal(shotFor("x-trail", "ŽALIA/JUODA"), "x-trail-zalia-juoda");
  assert.equal(shotFor("x-trail", "RUDA/JUODA"), "x-trail-ruda");
  assert.equal(shotFor("qashqai", "MĖLYNA"), "x-trail-melyna");
  assert.equal(shotFor("x-trail", ""), "x-trail-pilka");
  assert.equal(shotFor("x-trail", "GELTONA"), null);
});

test("aplankai po 20: skirstymas, nauji, atsilaisvinusi vieta", async () => {
  const { planBinders, binderContents, STATUS } = await import("../js/sandelis/logic.js");
  const make = (n, model, extra = {}) => Array.from({ length: n }, (_, i) => ({
    id: `${model}${i}`, model, vin: `${model}${String(i).padStart(4, "0")}`, status: STATUS.IN, added: `2026-01-${String(i % 28 + 1).padStart(2, "0")}`, ...extra,
  }));
  const qashqai = make(28, "QASHQAI");
  const juke = make(5, "JUKE");
  let { binders, assign } = planBinders([...qashqai, ...juke], [], { codes: { QASHQAI: "A-10", JUKE: "A-02" } });
  assert.deepEqual(binders.map((b) => `${b.code}:${b.group}`), ["A-02:JUKE", "A-10:QASHQAI", "A-11:QASHQAI"]);
  const count = (code) => Object.values(assign).filter((c) => c === code).length;
  assert.equal(count("A-10"), 20); assert.equal(count("A-11"), 8); assert.equal(count("A-02"), 5);
  // pritaikom, atiduodam du iš A-10, pridedam 3 naujus
  const all = [...qashqai, ...juke].map((r) => ({ ...r, binder: assign[r.id] }));
  const inA10 = all.filter((r) => r.binder === "A-10");
  inA10[0].status = STATUS.OUT; inA10[1].status = STATUS.OUT;
  const fresh = make(3, "QASHQAI").map((r, i) => ({ ...r, id: `new${i}`, vin: `NEW${i}`, added: "2026-05-01" }));
  ({ binders, assign } = planBinders([...all, ...fresh], binders));
  assert.equal(assign[inA10[0].id], "");
  assert.deepEqual(fresh.map((r) => assign[r.id]), ["A-10", "A-10", "A-11"]);
  assert.equal(assign[inA10[5].id], "A-10", "esami nepajuda");
  const view = binderContents(all.map((r) => ({ ...r, binder: assign[r.id] })), binders);
  assert.deepEqual(view.map((b) => [b.code, b.index, b.of]), [["A-02", 1, 1], ["A-10", 1, 2], ["A-11", 2, 2]]);
  // perrūšiavimas: 30 qashqai → 20 + 10, kodai lieka
  const re = planBinders(all.map((r) => ({ ...r, binder: assign[r.id] })), binders, { reorganize: true });
  assert.deepEqual(re.binders.map((b) => b.code), ["A-02", "A-10", "A-11"]);
});

test("specialūs aplankai neskaidomi po 20", async () => {
  const { planBinders, STATUS } = await import("../js/sandelis/logic.js");
  const recs = Array.from({ length: 27 }, (_, i) => ({ id: `k${i}`, model: i % 2 ? "JUKE" : "QASHQAI", vin: `V${i}`, status: STATUS.IN, folder: "Kazieras" }));
  const { binders, assign } = planBinders(recs, [], { codes: { Kazieras: "A-05" } });
  assert.deepEqual(binders, [{ code: "A-05", group: "Kazieras" }]);
  assert.ok(Object.values(assign).every((c) => c === "A-05"));
});

test("anksčiau padalintas specialus aplankas sujungiamas", async () => {
  const { planBinders, STATUS } = await import("../js/sandelis/logic.js");
  const recs = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, model: "JUKE", vin: `V${i}`, status: STATUS.IN, folder: "Audrius", binder: i < 20 ? "A-06" : "A-12" }));
  const { binders, assign } = planBinders(recs, [{ code: "A-06", group: "Audrius" }, { code: "A-12", group: "Audrius" }]);
  assert.deepEqual(binders, [{ code: "A-06", group: "Audrius" }]);
  assert.ok(Object.values(assign).every((c) => c === "A-06"));
});

test("be automatinio skirstymo: modelių CoC lieka be aplanko, rankiniai išlieka", async () => {
  const { planBinders, STATUS } = await import("../js/sandelis/logic.js");
  const recs = [
    { id: "a", model: "QASHQAI", vin: "1", status: STATUS.IN, binder: "" },
    { id: "b", model: "QASHQAI", vin: "2", status: STATUS.IN, binder: "A-20" },
    { id: "c", model: "JUKE", vin: "3", status: STATUS.IN, folder: "Olifeja", binder: "A-05" },
  ];
  const { binders, assign } = planBinders(recs, [{ code: "A-20", group: "QASHQAI" }, { code: "A-05", group: "Olifeja" }], { auto: false });
  assert.deepEqual(assign, { a: "", b: "A-20", c: "A-05" });
  assert.equal(binders.length, 2);
});
