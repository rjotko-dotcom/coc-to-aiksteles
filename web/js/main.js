// Sąsajos logika: failų priėmimas, laukų rodymas, pažymos sukūrimas.

import { readCertificate } from "./read.js";
import { warmUp } from "./ocr.js";
import {
  analyseTemplate, buildValues, fillTemplate, suggestedFilename, zipDocuments,
} from "./docx.js";
import {
  clearItems, clearTemplate, getTemplate, loadItems, saveItems, saveTemplate,
} from "./store.js";
import { VERSION } from "../version.js";

const FIELDS = [
  ["make", "Gamybinė markė", false],
  ["type_variant_version", "Tipas / Variantas / Versija", true],
  ["commercial_name", "Komercinis pavadinimas", false],
  ["vin", "Identifikavimo numeris (VIN)", true],
  ["approval_number", "Tipo patvirtinimo Nr.", true],
  ["approval_date", "Patvirtinimo suteikimo data", true],
  ["national_approval_number", "Nacionalinis patvirtinimo Nr.", true],
  ["colour", "Spalva", false],
  ["doc_date", "Pažymos data", true],
];

let items = [];
let rememberTimer = null;

/** Išsaugo darbo eilę įrenginyje (kad atnaujinus puslapį niekas nedingtų). */
function remember() {
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => saveItems(items), 400);
}

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function status(text, ok = false) {
  $("status").textContent = text;
  $("status").className = ok ? "status ok" : "status";
}

function download(bytes, filename) {
  const types = {
    ".zip": "application/zip",
    ".csv": "text/csv;charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const suffix = filename.slice(filename.lastIndexOf("."));
  const url = URL.createObjectURL(new Blob([bytes], { type: types[suffix] || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Rezultatų rodymas
// ---------------------------------------------------------------------------

function render() {
  const box = $("results");
  box.innerHTML = "";
  items.forEach((item, index) => {
    const card = document.createElement("section");
    card.className = "panel";
    if (item.error) {
      card.innerHTML = `<div class="fileline"><strong>${esc(item.source_file)}</strong></div>
        <div class="banner err">Nepavyko perskaityti: ${esc(item.error)}</div>`;
      box.appendChild(card);
      return;
    }
    const warnings = (item.warnings || []).length
      ? `<div class="banner warn">${item.warnings.map(esc).join("<br>")}</div>` : "";
    const meta = [
      item.category ? `kategorija ${esc(item.category)}` : "",
      item.manufacture_date ? `pagaminta ${esc(item.manufacture_date)}` : "",
      item.colour_raw ? `spalva liudijime: ${esc(item.colour_raw)}` : "",
      item.ocr_used ? "nuskaityta OCR" : "teksto sluoksnis",
    ].filter(Boolean).join(" · ");
    card.innerHTML = `
      <div class="fileline">
        <strong>${esc(item.source_file)}</strong>
        <span>${meta}</span>
      </div>
      ${warnings}
      ${Object.keys(item.snippets || {}).length
        ? `<p class="note" style="margin:-4px 0 12px">Po kiekvienu laukeliu – ta pati vieta liudijime. Sulyginkite ir taisykite čia pat.</p>`
        : ""}
      <div class="grid">
        ${FIELDS.map(([key, label, mono]) => `
          <div>
            <label for="f-${index}-${key}">${esc(label)}</label>
            <input type="text" id="f-${index}-${key}" data-index="${index}" data-key="${key}"
                   class="${mono ? "code" : ""}" value="${esc(item[key] || "")}"
                   autocomplete="off" spellcheck="false">
            ${(item.snippets || {})[key]
              ? `<div class="snippet-box"><img class="snippet ${key === "type_variant_version" ? "snippet--stack" : ""}" src="${item.snippets[key]}"
                   alt="Ta pati vieta liudijime" loading="lazy"></div>`
              : ""}
          </div>`).join("")}
      </div>`;
    box.appendChild(card);
  });
  // Reikšmės liudijime rašomos dešinėje, todėl iškarpą iškart pastumiame ten.
  box.querySelectorAll(".snippet-box").forEach((frame) => {
    const image = frame.querySelector("img");
    const scroll = () => { frame.scrollLeft = frame.scrollWidth; };
    if (image.complete) scroll(); else image.addEventListener("load", scroll, { once: true });
  });

  box.querySelectorAll("input[data-key]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const element = event.target;
      items[Number(element.dataset.index)][element.dataset.key] = element.value;
      remember();
    });
  });
  $("actions").classList.toggle("hidden", !items.some((item) => !item.error));
}

// ---------------------------------------------------------------------------
// Failų priėmimas
// ---------------------------------------------------------------------------

async function handleFiles(fileList) {
  const files = [...fileList].filter((file) => file.name.toLowerCase().endsWith(".pdf"));
  if (!files.length) { status("Pasirinkite PDF failus."); return; }

  // Anksčiau nuskaityti liudijimai paliekami – taip galima pilti po kelis.
  render();
  for (const [position, file] of files.entries()) {
    const prefix = files.length > 1 ? `(${position + 1}/${files.length}) ` : "";
    status(`${prefix}Skaitoma ${file.name}…`);
    try {
      const data = await readCertificate(file, (message) => status(prefix + message));
      items.push({ ...data, doc_date: today() });
    } catch (error) {
      items.push({ source_file: file.name, error: error.message || String(error) });
    }
    render();
    remember();
  }
  const ok = items.filter((item) => !item.error).length;
  status(`Perskaityta ${ok} iš ${items.length}. Patikrinkite laukus ir spauskite „Generuoti“.`, ok > 0);
}

// ---------------------------------------------------------------------------
// Pažymos sukūrimas
// ---------------------------------------------------------------------------

async function templateBytes() {
  const stored = await getTemplate();
  if (stored) return { bytes: stored.bytes, own: true };
  const response = await fetch("./blank-template.docx");
  return { bytes: new Uint8Array(await response.arrayBuffer()), own: false };
}

async function generate() {
  const ready = items.filter((item) => !item.error);
  if (!ready.length) return;
  $("genstatus").textContent = "Formuojama…";
  try {
    const template = await templateBytes();
    const documents = [];
    const warnings = [];
    for (const item of ready) {
      const values = buildValues(item, item.doc_date);
      const result = fillTemplate(template.bytes, values);
      warnings.push(...result.warnings);
      documents.push([suggestedFilename(values), result.bytes]);
    }
    if (documents.length === 1) download(documents[0][1], documents[0][0]);
    else download(zipDocuments(documents), "aiksteles.zip");

    const note = template.own ? "" : " Naudotas įprastas blankas – savo galite įkelti nustatymuose.";
    $("genstatus").textContent = (warnings.length ? `Parsiųsta. Dėmesio: ${warnings.join("; ")}` : "Parsiųsta.") + note;
  } catch (error) {
    $("genstatus").textContent = "Klaida: " + (error.message || error);
  }
}

/**
 * Ataskaita apie visą eilę: ką kiekviename liudijime pavyko nuskaityti.
 *
 * Naudinga pasitikrinti visus failus iš karto lentelėje, o radus klaidų –
 * atsiųsti šį failą taisymui. Jame yra tik nuskaityti laukai, be pačių
 * liudijimų ir be paveikslėlių.
 */
function reportCsv() {
  const columns = ["source_file", ...FIELDS.map(([key]) => key), "ocr_used", "warnings"];
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = items.map((item) => columns.map((column) => {
    if (column === "warnings") return escape((item.warnings || []).join(" | "));
    if (column === "ocr_used") return escape(item.ocr_used ? "OCR" : "tekstas");
    return escape(item[column]);
  }).join(","));
  return "\uFEFF" + [columns.join(","), ...rows].join("\r\n");
}

// ---------------------------------------------------------------------------
// Šablonas
// ---------------------------------------------------------------------------

function renderTemplateReport(analysis) {
  const box = $("tplreport");
  if (!analysis) { box.innerHTML = ""; return; }
  const found = Object.keys(analysis.recognised || {}).length;
  const missing = analysis.missing || [];
  let html = missing.length
    ? `<div class="banner warn">Atpažinta ${found} iš 8 eilučių. Neatpažinta:
       <strong>${missing.map(esc).join(", ")}</strong>. Šias reikšmes teks įrašyti ranka
       arba įdėti žymeklį (pvz. <code>{{colour}}</code>) į reikiamą langelį.</div>`
    : `<div class="banner ok">Šablonas suprastas: atpažintos visos ${found} iš 8 eilučių.</div>`;
  if (analysis.date_boxes) html += `<p class="note">Rasti datos langeliai – data bus įrašyta automatiškai.</p>`;
  if ((analysis.placeholders || []).length) {
    html += `<p class="note">Žymekliai: ${esc(analysis.placeholders.join(", "))}.</p>`;
  }
  box.innerHTML = html;
}

async function uploadTemplate(file) {
  if (!file) { $("tplstatus").textContent = "Pasirinkite failą."; return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const analysis = analyseTemplate(bytes);
    await saveTemplate(file.name, bytes);
    $("tplstatus").textContent = `Šablonas įkeltas: ${file.name}. Lieka šiame įrenginyje.`;
    renderTemplateReport(analysis);
  } catch (error) {
    $("tplstatus").textContent = "Nepavyko perskaityti šablono: " + (error.message || error);
    renderTemplateReport(null);
  }
}

async function showTemplateState() {
  const stored = await getTemplate();
  $("tplstatus").textContent = stored
    ? `Įkeltas Jūsų šablonas: ${stored.name}. Pažymos formuojamos jo pagrindu.`
    : "Šablonas neįkeltas – bus naudojamas įprastas pažymos blankas.";
}

// ---------------------------------------------------------------------------
// Įvykiai
// ---------------------------------------------------------------------------

$("drop").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", (event) => handleFiles(event.target.files));
["dragenter", "dragover"].forEach((type) =>
  $("drop").addEventListener(type, (event) => { event.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((type) =>
  $("drop").addEventListener(type, (event) => { event.preventDefault(); $("drop").classList.remove("over"); }));
$("drop").addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

$("generate").addEventListener("click", generate);
$("report").addEventListener("click", () => {
  if (!items.length) { $("genstatus").textContent = "Nėra ką aprašyti."; return; }
  download(new TextEncoder().encode(reportCsv()), "aiksteles-ataskaita.csv");
  $("genstatus").textContent = "Ataskaita parsiųsta.";
});

$("clear").addEventListener("click", () => {
  items = [];
  $("files").value = "";
  $("genstatus").textContent = "";
  clearItems();
  status("Duomenys išvalyti.");
  render();
});

$("tplupload").addEventListener("click", () => uploadTemplate($("tplfile").files[0]));
$("tplcheck").addEventListener("click", async () => {
  const stored = await getTemplate();
  if (!stored) { $("tplstatus").textContent = "Šablonas neįkeltas."; renderTemplateReport(null); return; }
  renderTemplateReport(analyseTemplate(stored.bytes));
});
$("tpldelete").addEventListener("click", async () => {
  await clearTemplate();
  renderTemplateReport(null);
  await showTemplateState();
});

async function restore() {
  const stored = await loadItems();
  if (!stored.length) return;
  items = stored;
  render();
  status(`Atkurta ${items.length} anksčiau nuskaityt(a)s liudijimas(-ai). Norėdami pradėti iš naujo, spauskite „Išvalyti duomenis“.`, true);
}

restore();
showTemplateState();
warmUp();

/**
 * Parodo, kuri versija veikia, ir ar serveryje jau yra naujesnė.
 *
 * Programa įrašoma į įrenginį, kad veiktų be interneto, todėl po atnaujinimo
 * naršyklė kurį laiką dar rodo senąją. Be šito nesimato, kuri versija kalta.
 */
async function checkVersion() {
  $("version").textContent = `versija ${VERSION.replace("aikstele-", "")}`;
  try {
    const response = await fetch("./version.js?patikra", { cache: "no-store" });
    const text = await response.text();
    const latest = (text.match(/VERSION = "([^"]+)"/) || [])[1];
    if (latest && latest !== VERSION) {
      $("update").hidden = false;
    }
  } catch {
    // neprisijungus naujesnės versijos tiesiog nepatikrinsime
  }
}

$("update-now").addEventListener("click", async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
  window.location.reload();
});

checkVersion();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
      // Kelių gijų režimas įsijungia tik tada, kai puslapį jau aptarnauja
      // `sw.js` – po pirmo įdiegimo vieną kartą persikrauname.
      if (!self.crossOriginIsolated && navigator.serviceWorker.controller === null
          && !items.length && !sessionStorage.getItem("perkrauta")) {
        sessionStorage.setItem("perkrauta", "1");
        setTimeout(() => window.location.reload(), 500);
      }
    } catch {
      // be aptarnaujančio failo programa vis tiek veikia, tik neveiks neprisijungus
    }
  });
}
