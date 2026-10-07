// Sandėlio logikos testai: node --test web/tests

import assert from "node:assert/strict";
import test from "node:test";

import {
  STATUS, backupDue, cleanVin, counts, duplicatesOf, matches, mergePlan, pdfName, toCsv, vinProblems,
} from "../js/sandelis/logic.js";

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

test("CSV Excel'iui: kabliataškiai, BOM, kabutės", () => {
  const csv = toCsv([record({ vin: "SJNJ12TD3U2000001", model: 'QASHQAI "N-Connecta"', status: STATUS.OUT,
    given_date: "2026-10-07", given_to: "UAB; Autos" })]);
  assert.ok(csv.startsWith("﻿\"VIN\";"));
  assert.ok(csv.includes('"QASHQAI ""N-Connecta"""'));
  assert.ok(csv.includes('"2026.10.07";"UAB; Autos"'));
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
