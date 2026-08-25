// Sąsajos logika: failų priėmimas, laukų rodymas, pažymos sukūrimas.

import { readCertificate } from "./read.js";
import { warmUp } from "./ocr.js";
import {
  analyseTemplate, buildValues, fillTemplate, suggestedFilename, zipDocuments,
} from "./docx.js";
import { clearTemplate, getTemplate, saveTemplate } from "./store.js";

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
  const url = URL.createObjectURL(new Blob([bytes], {
    type: filename.endsWith(".zip")
      ? "application/zip"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
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
      <div class="grid">
        ${FIELDS.map(([key, label, mono]) => `
          <div>
            <label for="f-${index}-${key}">${esc(label)}</label>
            <input type="text" id="f-${index}-${key}" data-index="${index}" data-key="${key}"
                   class="${mono ? "code" : ""}" value="${esc(item[key] || "")}"
                   autocomplete="off" spellcheck="false">
          </div>`).join("")}
      </div>`;
    box.appendChild(card);
  });
  box.querySelectorAll("input[data-key]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const element = event.target;
      items[Number(element.dataset.index)][element.dataset.key] = element.value;
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

  items = [];
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
$("clear").addEventListener("click", () => {
  items = [];
  $("files").value = "";
  $("genstatus").textContent = "";
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

showTemplateState();
warmUp();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
      // Kelių gijų režimas įsijungia tik tada, kai puslapį jau aptarnauja
      // `sw.js` – po pirmo įdiegimo vieną kartą persikrauname.
      if (!self.crossOriginIsolated && navigator.serviceWorker.controller === null
          && !sessionStorage.getItem("perkrauta")) {
        sessionStorage.setItem("perkrauta", "1");
        setTimeout(() => window.location.reload(), 500);
      }
    } catch {
      // be aptarnaujančio failo programa vis tiek veikia, tik neveiks neprisijungus
    }
  });
}
