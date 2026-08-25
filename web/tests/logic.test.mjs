// Naršyklės logikos testai: node --test web/tests
//
// Tikrinama tai, kas nepriklauso nuo naršyklės – eilučių atkūrimas, laukų
// atpažinimas, spalvos ir VIN. Dokumento pildymas remiasi naršyklės XML
// varikliu, todėl tikrinamas per patį puslapį.

import assert from "node:assert/strict";
import test from "node:test";

import { linesFromBoxes, splitIntoColumns } from "../js/layout.js";
import { parseCocText, repairVin, vinCheckDigitValid } from "../js/coc.js";
import { toLithuanian } from "../js/colors.js";

const box = (y, x0, x1, text, h = 20) => ({ y, x0, x1, h, text });

test("reikšmė toli dešinėje lieka toje pačioje eilutėje", () => {
  const lines = linesFromBoxes([
    box(100, 105, 150, "0.1."),
    box(100, 206, 700, "Make (Trade name of manufacturer)"),
    box(100, 973, 1120, ": NISSAN"),
  ]);
  assert.equal(lines[0].text, "0.1. Make (Trade name of manufacturer) : NISSAN");
});

test("dingęs dvitaškis atkuriamas pagal tarpą", () => {
  const [line] = linesFromBoxes([
    box(100, 105, 150, "0.2."),
    box(100, 206, 330, "Type"),
    box(100, 973, 1050, "J12"),
  ]);
  assert.equal(line.text, "0.2. Type : J12");
  assert.equal(line.value, "J12");
  assert.ok(line.valueBox);
});

test("trys stulpeliai nesumaišomi", () => {
  const items = [];
  const columns = [
    [20, 180, [["0.1. Make :", "Hyundai"], ["0.2. Type :", "OSE"], ["- Variant :", "F5E11"],
      ["- Version :", "E11B11"], ["0.4. Vehicle category :", "M1"], ["0.10. Vehicle ident. number :", "TMAJ38"]]],
    [300, 460, [["0.11. Date of manufacture :", "10.12.2020"], ["1. Number of axles :", "2"],
      ["4. Wheelbase :", "2600 mm"], ["5. Length :", "4205 mm"], ["13. Mass in running order :", "1760 kg"],
      ["40. Colour of vehicle :", "white"]]],
    [580, 740, [["16.2 Mass on each axle :", "1100 kg"], ["20. Engine manufacturer :", "MOBIS"],
      ["21. Engine code :", "EM16"], ["23. Pure electric :", "yes"], ["26. Fuel :", "Electricity"],
      ["29. Maximum speed :", "167 km/h"]]],
  ];
  for (const [xLabel, xValue, rows] of columns) {
    let y = 100;
    for (const [label, value] of rows) {
      items.push(box(y, xLabel, xLabel + 130, label, 10));
      items.push(box(y, xValue, xValue + 60, value, 10));
      y += 20;
    }
  }
  assert.equal(splitIntoColumns(items).length, 3);
  const texts = linesFromBoxes(items).map((line) => line.text);
  assert.ok(texts.includes("0.2. Type : OSE"));
  assert.ok(texts.includes("40. Colour of vehicle : white"));
});

test("Nissan liudijimas", () => {
  const data = parseCocText([
    "0.1. Make (Trade name of manufacturer) : NISSAN",
    "0.2. Type : J12",
    "Variant : D",
    "Version : D13",
    "0.2.1. Commercial Name : NISSAN QASHQAI",
    "0.10. Vehicle identification number : SJNJ12TD3U2000001",
    "Conforms in all respects to the type described in approval e9*2018/858*11042*16 granted on",
    "03/03/2026 and can be permanently registered",
    "40. Colour of the vehicle : Black",
  ].join("\n"));
  assert.equal(data.make, "NISSAN");
  assert.equal(data.type_variant_version, "J12/D/D13");
  assert.equal(data.commercial_name, "NISSAN QASHQAI");
  assert.equal(data.vin, "SJNJ12TD3U2000001");
  assert.equal(data.approval_number, "e9*2018/858*11042*16");
  assert.equal(data.approval_date, "03.03.2026");
  assert.equal(data.colour, "JUODA");
});

test("Hyundai liudijimas su „issued on“", () => {
  const data = parseCocText([
    "0.1. Make (Trade name of manufacture) : Hyundai",
    "0.2. Type : TQ",
    "variant : V3D72",
    "version : M53AZ1",
    "0.2.1. Commercial name : H-1,STAREX,GRAND STAREX",
    "0.4. Vehicle Category : N1",
    "Location of the vehicle identification number :",
    "Under the right front seat",
    "0.10. Vehicle identification number :",
    "conforms in all respects to the type described in",
    "approval e4*2007/46*0091*04",
    "issued on 06.05.2011 and",
    "40. Colour of vehicle : white",
  ].join("\n"));
  assert.equal(data.type_variant_version, "TQ/V3D72/M53AZ1");
  assert.equal(data.approval_number, "e4*2007/46*0091*04");
  assert.equal(data.approval_date, "06.05.2011");
  assert.equal(data.colour, "BALTA");
  assert.equal(data.vin, "", "žymens vieta nėra VIN");
});

test("Citroën liudijimas prancūziškai", () => {
  const data = parseCocText([
    "0.1. Marque (dénomination commerciale du constructeur) : CITROEN",
    "0.2. Type : Y",
    "Variante : CTMFC",
    "Version : HY",
    "0.2.1. Appellation(s) commerciale(s) : RELAY",
    "0.4. Catégorie de véhicule : N1",
    "0.10. Numéro d'identification du véhicule : VF7YCTMF012000004",
    "0.11. Date de construction du véhicule : 30/07/2015",
    "est conforme au type décrit dans la réception e3*2007/46*0046*10",
    "délivrée le 04/02/2014 et peut être immatriculé",
    "40. Couleur du véhicule : blanc",
  ].join("\n"));
  assert.equal(data.make, "CITROEN");
  assert.equal(data.type_variant_version, "Y/CTMFC/HY");
  assert.equal(data.commercial_name, "RELAY");
  assert.equal(data.vin, "VF7YCTMF012000004");
  assert.equal(data.approval_date, "04.02.2014");
  assert.equal(data.colour, "BALTA");
});

test("pavadinimas atpažįstamas tik nuo pradžios", () => {
  const data = parseCocText([
    "21. Engine code as marked on the engine : ZR15",
    "0.2.2.1 Allowed Parameter values for multistage type approval : x",
    "26.1. vehicle fuel type : Mono fuel",
  ].join("\n"));
  assert.equal(data.make, "", "„as marked“ nėra markė");
  assert.equal(data.type, "", "„type approval“ ir „fuel type“ nėra tipas");
});

test("spalvos", () => {
  assert.equal(toLithuanian("SOLID WHITE (326)"), "BALTA");
  assert.equal(toLithuanian("GREY/BLACK"), "PILKA/JUODA");
  assert.equal(toLithuanian("blanc"), "BALTA");
  assert.equal(toLithuanian("weiß"), "BALTA");
  assert.equal(toLithuanian("nesamone"), "");
});

test("VIN kontrolinis skaitmuo", () => {
  assert.ok(vinCheckDigitValid("SJNJ12TD3U2000001"));
  assert.ok(!vinCheckDigitValid("SJNJ12TD1U2361797"));
});

test("VIN pataisomas po atpažinimo", () => {
  // I ir O VIN abėcėlėje neegzistuoja – tai atpažinimo klaidos.
  assert.equal(repairVin("SINJ12TD3U2000001"), "SJNJ12TD3U2000001");
  assert.equal(repairVin("SJNF16FA7U2O00002"), "SJNF16FA7U2000002");
  assert.equal(repairVin("PERTRUMPAS"), "");
});

test("VIN paimamas iš failo pavadinimo, kai liudijime neįskaitomas", () => {
  const data = parseCocText("0.1. Make : NISSAN\n",
    { sourceFile: "SJNJ12TD3U2371076.pdf", ocrUsed: true });
  assert.equal(data.vin, "SJNJ12TD3U2371076");
  assert.ok(data.warnings.some((w) => w.includes("failo pavadinimo")));
});

test("failo pavadinimo VIN turi praeiti kontrolinį skaitmenį", () => {
  const data = parseCocText("0.1. Make : NISSAN\n", { sourceFile: "SJNJ12TD9U2371076.pdf" });
  assert.equal(data.vin, "");
});

test("nesutampantis failo pavadinimas pažymimas", () => {
  const data = parseCocText("0.10. Vehicle identification number : SJNJ12TD3U2000001\n",
    { sourceFile: "SJNJ12TD3U2371076.pdf" });
  assert.equal(data.vin, "SJNJ12TD3U2000001");
  assert.ok(data.warnings.some((w) => w.includes("nesutampa su failo")));
});

test("patvirtinimo numeris sudėliojamas iš iškraipyto teksto", () => {
  const data = parseCocText(
    "type described in approval e9%2018/858%11042%16 granted on 03/03/2026 and\n",
    { ocrUsed: true },
  );
  assert.equal(data.approval_number, "e9*2018/858*11042*16");
  assert.equal(data.approval_date, "03.03.2026");
});

test("markė pataisoma pagal komercinį pavadinimą", () => {
  const data = parseCocText(
    "0.1. Make : HISSAN\n0.2.1. Commercial Name : NISSAN QASHQAI\n", { ocrUsed: true },
  );
  assert.equal(data.make, "NISSAN");
  const other = parseCocText(
    "0.1. Make : DACIA\n0.2.1. Commercial Name : NISSAN QASHQAI\n", { ocrUsed: true },
  );
  assert.equal(other.make, "DACIA", "skiriasi daugiau nei vienu ženklu – neliečiama");
});

test("eilutė be dvitaškio vis tiek perskaitoma", () => {
  const data = parseCocText([
    "0.1. Make (Trade name of manufacturer) NISSAN",
    "0.2. Type J12",
    "0.2.1 Commercial Name NISSAN QASHQAI",
    "0.10. Vehicle identification number SJNJ12TD3U2000001",
    "0.4. Vehicle category M1",
    "40. Colour of vehicle Black",
  ].join("\n"), { ocrUsed: true });
  assert.equal(data.make, "NISSAN");
  assert.equal(data.type, "J12");
  assert.equal(data.commercial_name, "NISSAN QASHQAI");
  assert.equal(data.vin, "SJNJ12TD3U2000001");
  assert.equal(data.colour, "JUODA");
});

test("eilutei be dvitaškio reikia žinomo skirsnio", () => {
  const data = parseCocText("35. Fitted tyre wheel combination 215/55R18 92V\n");
  assert.equal(data.make, "");
  assert.equal(data.colour, "");
});
