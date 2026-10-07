// Sandėlio sąsaja: skenų priėmimas, patikra, paieška, atidavimas, kopijos.

import { readCertificate } from "../read.js";
import { warmUp } from "../ocr.js";
import { buildValues, fillTemplate, suggestedFilename, zipDocuments } from "../docx.js";
import { getTemplate } from "../store.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "../../vendor/fflate/fflate.mjs";
import { VERSION } from "../../version.js";
import {
  addRecord, allRecords, askPersistence, deleteRecord, getMeta, getPdf, saveRecord, setMeta, usageMb,
} from "./db.js";
import { splitPages, thumbnail } from "./split.js";
import { buildXlsx } from "./xlsx.js";
import * as disk from "./folder.js";
import {
  EXCEL_COLUMNS, STATUS, backupDue, cleanVin, counts, duplicatesOf, excelSheets, folderOf, inSpecialFolder, matches,
  mergePlan, newestFirst, pdfName, showDate, specialFolders, splitMakeModel, statusName, todayIso, vinDoubtful,
  vinProblems,
} from "./logic.js";

/** Kiek eilučių rodyti iš karto – didelis sąrašas kitaip stabdytų puslapį. */
const PAGE = 200;

/** Laukai, kurių sandėliui reikia iš kiekvieno lapo. */
const NEEDED = ["vin", "commercial_name"];

/**
 * Kokią lapo dalį nuo viršaus skaityti pirmiausia. VIN ir modelis CoC
 * pirmoje pusėje yra viršutinėje dalyje, todėl dažniausiai visko perskaityti
 * nebereikia – lapas apdorojamas maždaug trečdaliu greičiau.
 */
const QUICK_TOP = 0.6;

let records = [];
let tab = STATUS.IN;
let shown = PAGE;
const selected = new Set();
let detailId = null;
let giveIds = [];
let animateRows = true;
/** Aplankų filtras: "" – visi, MODEL_FOLDERS – tik modelių aplankai, kitaip – specialaus aplanko vardas. */
let folderFilter = "";
const MODEL_FOLDERS = "\u0000modeliai";
/** Sukurti, bet dar tušti specialūs aplankai (kad nedingtų iš sąrašo). */
let savedFolders = [];

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const byId = (id) => records.find((record) => record.id === id);
const now = () => new Date().toISOString();
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Pagalbiniai: pranešimai, klausimai, atsisiuntimas
// ---------------------------------------------------------------------------

function toast(text, kind = "ok") {
  const box = document.createElement("div");
  box.className = `toast ${kind}`;
  box.innerHTML = `${icon(kind === "ok" ? "check" : kind === "err" ? "x" : "clock")}<span>${esc(text)}</span>`;
  $("toasts").appendChild(box);
  setTimeout(() => {
    box.classList.add("out");
    box.addEventListener("animationend", () => box.remove(), { once: true });
  }, kind === "err" ? 6000 : 3200);
}

/** Klausimas savo lange (vietoj naršyklės `confirm`). Grąžina true / false. */
function ask(title, text = "", okLabel = "Gerai", danger = false) {
  return new Promise((resolve) => {
    $("ask-title").textContent = title;
    $("ask-text").textContent = text;
    $("ask-ok").textContent = okLabel;
    $("ask-ok").className = danger ? "btn danger" : "btn primary";
    const dialog = $("ask");
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
    $("ask-ok").focus();
  });
}

function download(bytes, filename, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function openPdf(id) {
  const bytes = await getPdf(id);
  if (!bytes) { toast("Šio liudijimo PDF nerastas.", "err"); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function update(record, changes) {
  Object.assign(record, changes, { updated: now() });
  await saveRecord(record);
  scheduleSync();
}

// ---------------------------------------------------------------------------
// Duomenų aplankas kompiuteryje (išlieka išvalius Chrome)
// ---------------------------------------------------------------------------

/** "none" – nepasirinktas, "ok" – rašoma, "permission" – reikia paspausti „Leisti“. */
let store = { handle: null, state: "none", saved: null, busy: false, again: false };
let syncTimer = null;

function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (store.state !== "ok") return;
  if (store.busy) { store.again = true; return; }
  store.busy = true;
  try {
    await disk.save(store.handle, records, {
      getPdf, xlsx: buildXlsx(excelSheets(records), EXCEL_COLUMNS),
    });
    store.saved = new Date();
  } catch (error) {
    // Dažniausiai – Chrome atšaukė leidimą (pvz. po perkrovimo). Užteks paspausti „Leisti“.
    store.state = await disk.hasPermission(store.handle) ? "ok" : "permission";
    if (store.state === "ok") toast(`Nepavyko įrašyti į aplanką: ${error.message || error}`, "err");
  } finally {
    store.busy = false;
    renderBackupState();
    if (store.again) { store.again = false; scheduleSync(300); }
  }
}

/** Įkelia aplanke esančius įrašus, kurių naršyklėje nėra (arba kurie ten senesni). */
async function mergeFromFolder(handle) {
  const data = await disk.load(handle);
  if (!data) return null;
  const plan = mergePlan(records, data.records);
  for (const record of plan.add) await addRecord(record, await data.pdf(record.id));
  for (const record of plan.replace) await saveRecord(record);
  records = await allRecords();
  return plan;
}

async function connectFolder(restoreOnly = false) {
  if (!disk.supported()) {
    toast("Ši naršyklė aplanko pasirinkti neleidžia – naudokite Chrome arba Edge.", "err");
    return;
  }
  let handle;
  try {
    handle = await disk.pickFolder();
  } catch {
    return; // atšaukė pasirinkimą
  }
  if (!await disk.hasPermission(handle, true)) { toast("Be leidimo į aplanką rašyti negalima.", "warn"); return; }
  const plan = await mergeFromFolder(handle);
  if (restoreOnly && !plan) {
    toast(`Aplanke „${handle.name}“ sandėlio duomenų nerasta.`, "warn");
    return;
  }
  store = { ...store, handle, state: "ok" };
  await setMeta("folderHandle", handle);
  animateRows = true;
  render();
  await syncNow();
  if (plan && (plan.add.length || plan.replace.length)) {
    toast(`Atkurta iš aplanko: ${plan.add.length} nauj., ${plan.replace.length} atnaujint.`);
    runQueue();
  } else {
    toast(`Duomenys bus saugomi aplanke „${handle.name}“.`);
  }
}

async function allowFolder() {
  if (!await disk.hasPermission(store.handle, true)) return;
  store.state = "ok";
  const plan = await mergeFromFolder(store.handle);
  if (plan && plan.add.length) render();
  await syncNow();
  toast(`Saugojimas į aplanką „${store.handle.name}“ vėl veikia.`);
}

async function loadFolderState() {
  const handle = await getMeta("folderHandle").catch(() => null);
  if (!handle || !disk.supported()) return;
  store.handle = handle;
  store.state = await disk.hasPermission(handle) ? "ok" : "permission";
}

// ---------------------------------------------------------------------------
// Skenų priėmimas ir atpažinimas
// ---------------------------------------------------------------------------

let queueRunning = false;
const session = { done: 0, times: [] };

const allFolders = () => specialFolders(records, savedFolders);

async function rememberFolder(name) {
  const clean = String(name || "").trim();
  if (!clean || savedFolders.includes(clean)) return;
  savedFolders = [...savedFolders, clean];
  await setMeta("folders", savedFolders);
}

/**
 * Paklausia, į kurį aplanką dedami įkeliami CoC.
 * Grąžina "" (pagal modelį), specialaus aplanko vardą arba null (atšaukta).
 */
async function chooseFolder(fileCount) {
  const last = (await getMeta("lastFolder").catch(() => "")) || "";
  const folders = allFolders();
  const options = [{ value: "", label: "Pagal modelį", note: "kiekvienas CoC – savo modelio aplanke" },
    ...folders.map((folder) => ({ value: folder.name, label: folder.name, note: `${folder.count} turimi`, special: true }))];
  const chosen = options.some((option) => option.value === last) ? last : "";
  $("folder-count").textContent = fileCount === 1 ? "1 failas" : `${fileCount} failai`;
  $("folder-choices").innerHTML = options.map((option) => `
    <label class="choice ${option.special ? "special" : ""}">
      <input type="radio" name="folder" value="${esc(option.value)}" ${option.value === chosen ? "checked" : ""}>
      ${icon(option.special ? "folder" : "file")}<span>${esc(option.label)}</span><small>${esc(option.note)}</small>
    </label>`).join("");
  $("folder-new").value = "";
  return new Promise((resolve) => {
    const dialog = $("folder-dialog");
    dialog.returnValue = "";
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue !== "ok") { resolve(null); return; }
      const typed = $("folder-new").value.trim();
      const picked = typed || (document.querySelector("#folder-choices input:checked")?.value ?? "");
      await rememberFolder(picked);
      await setMeta("lastFolder", picked);
      resolve(picked);
    }, { once: true });
    dialog.showModal();
  });
}

async function handleFiles(fileList) {
  const candidates = [...fileList].filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (!candidates.length) { toast("Pasirinkite PDF failą.", "warn"); return; }

  // Tas pats PDF antrą kartą? Atpažįstama pagal turinį, ne pavadinimą.
  const files = [];
  for (const file of candidates) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await fileHash(bytes);
    const earlier = records.filter((record) => record.file_hash === hash);
    if (earlier.length && !await ask(
      "Šis PDF jau įkeltas",
      `„${file.name}“ jau buvo įkeltas ${showDate(earlier[0].added)} (${earlier.length} lap.).\nĮkėlus dar kartą, atsiras dublikatai.`,
      "Vis tiek įkelti",
    )) continue;
    files.push({ file, bytes, hash });
  }
  if (!files.length) return;

  const folder = await chooseFolder(files.length);
  if (folder === null) return;
  askPersistence();

  let added = 0;
  for (const { file, bytes: fileBytes, hash } of files) {
    let pages;
    try {
      pages = await splitPages(fileBytes);
    } catch (error) {
      toast(`Nepavyko atidaryti ${file.name}: ${error.message || error}`, "err");
      continue;
    }
    const batch = now();
    const batchId = crypto.randomUUID();
    for (const [index, bytes] of pages.entries()) {
      const record = {
        id: crypto.randomUUID(),
        status: STATUS.REVIEW,
        ocr: "laukia",
        vin: "", make: "", model: "", tvv: "",
        coc: {},
        folder,
        batch: batchId,
        file_hash: hash,
        source_file: file.name,
        page: index + 1,
        pages: pages.length,
        added: batch,
        updated: batch,
        given_date: "", given_to: "", note: "",
      };
      try {
        record.thumb = await thumbnail(bytes);
      } catch {
        record.thumb = "";
      }
      await addRecord(record, bytes);
      records.push(record);
      scheduleSync();
      added += 1;
      // Skaityti pradedama iškart, kol kiti lapai dar karpomi.
      renderReview();
      renderCounts();
      runQueue();
    }
  }
  render();
  if (added) {
    toast(`Įkelta lapų: ${added}. VIN ir modeliai skaitomi…`);
    $("review").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  }
}

/** PDF turinio atspaudas (SHA-256) – tam pačiam failui atpažinti. */
async function fileHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Kiek reikiamų laukų rasta. */
const found = (data) => NEEDED.filter((key) => data[key]).length;

/**
 * Perskaito vieną lapą: pirmiausia tik viršutinę dalį, o jei VIN ar modelio
 * ten nėra – visą lapą (prireikus ir didesne raiška).
 */
async function readPage(file, onStatus) {
  const quick = await readCertificate(file, onStatus, { required: NEEDED, top: QUICK_TOP, retry: false });
  if (found(quick) === NEEDED.length || !quick.ocr_used) return quick;
  const full = await readCertificate(file, onStatus, { required: NEEDED });
  const best = found(full) >= found(quick) ? full : quick;
  if (found(best) > 0) return best;
  // Nieko nerasta – gal lapas įdėtas į skenerį aukštyn kojom? Tada tik pranešame
  // (PDF lieka toks, koks nuskenuotas), bet VIN ir modelį vis tiek pasiūlome.
  const flipped = await readCertificate(file, onStatus, { required: NEEDED, top: QUICK_TOP, retry: false, rotation: 180 });
  return found(flipped) > 0 ? { ...flipped, upside_down: true } : best;
}

/** Atpažįsta laukiančius lapus po vieną. Tęsiama ir po puslapio perkrovimo. */
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const waiting = records.filter((record) => record.ocr === "laukia")
        .sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.page - b.page);
      if (!waiting.length) break;
      const record = waiting[0];
      const started = performance.now();
      await update(record, { ocr: "skaitoma" });
      renderCard(record);
      renderProgress(waiting.length, record);
      try {
        const bytes = await getPdf(record.id);
        const file = new File([bytes], `${record.source_file} (${record.page} lapas).pdf`, { type: "application/pdf" });
        const data = await readPage(file, (message) => { $("progress-text").textContent = message; });
        const changes = {
          coc: {
            approval_number: data.approval_number, approval_date: data.approval_date,
            commercial_name: data.commercial_name, colour: data.colour, colour_raw: data.colour_raw, category: data.category,
            manufacture_date: data.manufacture_date, manufacturer: data.manufacturer,
          },
          snippets: {
            vin: (data.snippets || {}).vin || "",
            model: (data.snippets || {}).commercial_name || "",
          },
          ocr: "baigta",
          upside_down: Boolean(data.upside_down),
        };
        // Ką žmogus jau spėjo įrašyti pats, atpažinimas neperrašo.
        if (!record.touched) {
          Object.assign(changes, {
            vin: cleanVin(data.vin), ...splitMakeModel(data.make, data.commercial_name), tvv: data.type_variant_version,
          });
        }
        await update(record, changes);
      } catch (error) {
        await update(record, { ocr: "klaida", ocr_error: error.message || String(error) });
      }
      session.done += 1;
      session.times.push(performance.now() - started);
      if (byId(record.id)) renderCard(record);
      renderCounts();
      renderConfirmClean();
    }
  } finally {
    queueRunning = false;
    renderProgress(0);
    if (session.done) {
      const review = records.filter((record) => record.status === STATUS.REVIEW).length;
      if (review) toast(`Perskaityta. Patikrinkite ${review} lap. ir patvirtinkite.`);
      const flipped = records.filter((record) => record.status === STATUS.REVIEW && record.upside_down).length;
      if (flipped) toast(`${flipped} lap. nuskenuoti aukštyn kojom – jie pažymėti patikroje.`, "warn");
      session.done = 0;
      session.times = [];
    }
  }
}

function renderProgress(left, record = null) {
  const box = $("progress");
  if (!left) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const total = session.done + left;
  $("progress-title").textContent = `Skaitomas ${session.done + 1} lapas iš ${total}`;
  $("progress-text").textContent = record ? `${record.source_file} · ${record.page} lapas` : "";
  $("progress-bar").style.width = `${Math.max(4, (session.done / total) * 100)}%`;
  const recent = session.times.slice(-5);
  if (recent.length) {
    const seconds = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length / 1000) * left);
    $("progress-eta").textContent = seconds > 90 ? `liko ~${Math.round(seconds / 60)} min.` : `liko ~${seconds} s`;
  } else {
    $("progress-eta").textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Patikra
// ---------------------------------------------------------------------------

/** Pastaba apie VIN: [rūšis, tekstas]. */
function vinHint(record) {
  const vin = cleanVin(record.vin);
  if (record.ocr === "laukia" || record.ocr === "skaitoma") return ["", ""];
  const problems = vinProblems(vin);
  if (problems.length) return ["err", problems[0]];
  const twins = duplicatesOf(records, record);
  if (twins.length) {
    const twin = twins[0];
    const where = twin.status === STATUS.OUT
      ? `atiduotas ${showDate(twin.given_date)}${twin.given_to ? ` – ${twin.given_to}` : ""}`
      : statusName(twin.status).toLowerCase();
    return ["err", `Toks VIN jau yra (${where}). Gal lapas nuskenuotas dukart?`];
  }
  if (vinDoubtful(vin)) return ["warn", "Kontrolinis skaitmuo nesutampa – sulyginkite ženklą po ženklo."];
  return ["ok", "17 ženklų, formatas tinka"];
}

/** Ar lapą galima patvirtinti neperžiūrint (viskas rasta, jokių įspėjimų). */
const isClean = (record) => record.status === STATUS.REVIEW && record.ocr === "baigta" && !record.upside_down
  && vinHint(record)[0] === "ok" && String(record.model || "").trim();

function hintHtml(kind, text) {
  if (!kind) return "";
  return `${icon(kind === "ok" ? "check" : kind === "warn" ? "clock" : "x")}${esc(text)}`;
}

/** Aplanko pasirinkimas patikros kortelėje. */
function folderSelect(record) {
  const current = String(record.folder || "").trim();
  const names = allFolders().map((folder) => folder.name);
  if (current && !names.includes(current)) names.push(current);
  return `<select data-field="folder" aria-label="Aplankas">
    <option value="" ${current ? "" : "selected"}>Modelio aplankas</option>
    ${names.map((name) => `<option value="${esc(name)}" ${name === current ? "selected" : ""}>${esc(name)}</option>`).join("")}
  </select>`;
}

function cardHtml(record) {
  const busy = record.ocr === "laukia" || record.ocr === "skaitoma";
  const [kind, hint] = vinHint(record);
  const snippet = (record.snippets || {}).vin;
  const state = busy
    ? `<span class="state"><span class="spinner"></span>${record.ocr === "skaitoma" ? "Skaitoma…" : "Laukia eilėje"}</span>`
    : record.upside_down ? `<span class="state warn">${icon("undo")}Aukštyn kojom</span>`
    : isClean(record) ? `<span class="state ok">${icon("check")}Paruošta patvirtinti</span>`
      : record.ocr === "klaida" ? `<span class="state err">${icon("x")}Neperskaityta</span>`
        : `<span class="state warn">${icon("clock")}Patikrinkite</span>`;
  const loading = busy && !record.touched ? "loading" : "";
  return `
    <button type="button" class="thumb" data-open="${record.id}" title="Atidaryti PDF">
      ${record.thumb ? `<img src="${record.thumb}" alt="${record.page} lapas">` : "<span>Peržiūros nėra – atidaryti PDF</span>"}
    </button>
    <div class="rfields">
      <div class="rhead">
        <div><b>${esc(record.source_file)}</b> <small>· ${record.page} iš ${record.pages} lapo</small></div>
        <div class="right">${folderSelect(record)}${state}</div>
      </div>
      ${record.upside_down ? `<div class="alert warn">${icon("undo")}<span>Šis lapas nuskenuotas <b>aukštyn kojom</b>. VIN ir modelis perskaityti apvertus – sulyginkite su lapu.</span></div>` : ""}
      ${record.ocr === "klaida" ? `<div class="alert">Automatiškai perskaityti nepavyko (${esc(record.ocr_error)}). Įrašykite ranka.</div>` : ""}
      ${snippet ? `<div class="snippet-box"><img src="${snippet}" alt="VIN vieta liudijime"></div>` : ""}
      <div class="vin">
        <label for="r-${record.id}-vin">VIN</label>
        <input type="text" class="mono ${loading}" id="r-${record.id}-vin" data-field="vin" value="${esc(record.vin)}"
               maxlength="24" autocomplete="off" spellcheck="false">
        <div class="hint ${kind}">${hintHtml(kind, hint)}</div>
      </div>
      <div>
        <label for="r-${record.id}-make">Markė</label>
        <input type="text" class="${loading}" id="r-${record.id}-make" data-field="make" value="${esc(record.make)}" autocomplete="off">
      </div>
      <div>
        <label for="r-${record.id}-model">Modelis</label>
        <input type="text" class="${loading}" id="r-${record.id}-model" data-field="model" value="${esc(record.model)}" autocomplete="off">
      </div>
      <div class="ractions">
        <button type="button" class="btn primary sm" data-confirm="${record.id}">${icon("check")}Patvirtinti</button>
        <button type="button" class="btn sm" data-open="${record.id}">${icon("eye")}PDF</button>
        <button type="button" class="btn danger sm" data-remove="${record.id}">${icon("trash")}Ištrinti lapą</button>
        ${record.pages > 1 ? `<button type="button" class="btn danger sm ghost-danger" data-remove-scan="${record.id}">${icon("trash")}Ištrinti visą skeną</button>` : ""}
      </div>
    </div>`;
}

/** Perpiešia vieną kortelę, neprarandant žymeklio laukelyje. */
function renderCard(record) {
  const card = document.querySelector(`.rcard[data-id="${record.id}"]`);
  if (!card || record.status !== STATUS.REVIEW) { render(); return; }
  const focused = document.activeElement && card.contains(document.activeElement) ? document.activeElement : null;
  const field = focused && focused.dataset.field;
  const caret = focused && focused.selectionStart;
  card.innerHTML = cardHtml(record);
  if (field) {
    const input = card.querySelector(`[data-field="${field}"]`);
    input.focus();
    try { input.setSelectionRange(caret, caret); } catch { /* ne teksto laukas */ }
  }
}

function reviewList() {
  return records.filter((record) => record.status === STATUS.REVIEW)
    .sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.page - b.page);
}

function renderReview() {
  const review = reviewList();
  $("review").classList.toggle("hidden", !review.length);
  $("review-count").textContent = review.length ? `· ${review.length}` : "";
  const list = $("review-list");
  const existing = new Map([...list.children].map((card) => [card.dataset.id, card]));
  const wanted = new Set(review.map((record) => record.id));
  for (const [id, card] of existing) if (!wanted.has(id) && !card.classList.contains("leaving")) card.remove();
  let previous = null;
  for (const record of review) {
    let card = existing.get(record.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "rcard";
      card.dataset.id = record.id;
      card.innerHTML = cardHtml(record);
    }
    if (previous ? previous.nextSibling !== card : list.firstChild !== card) {
      list.insertBefore(card, previous ? previous.nextSibling : list.firstChild);
    }
    previous = card;
  }
  renderConfirmClean();
}

function renderConfirmClean() {
  const clean = records.filter(isClean).length;
  const button = $("confirm-clean");
  button.hidden = clean < 2;
  button.querySelector("span").textContent = `Patvirtinti visus paruoštus (${clean})`;
}

/** Kortelė išslysta, o tada pasitraukia iš sąrašo. */
function animateOut(id) {
  const card = document.querySelector(`.rcard[data-id="${id}"]`);
  if (!card || reduceMotion()) { card?.remove(); return; }
  card.style.height = `${card.offsetHeight}px`;
  card.classList.add("leaving");
  setTimeout(() => {
    card.style.transition = "height .3s var(--ease), margin .3s var(--ease), padding .3s var(--ease)";
    Object.assign(card.style, { height: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px", borderWidth: "0px" });
    setTimeout(() => card.remove(), 320);
  }, 220);
}

async function confirmRecord(id, quiet = false) {
  const record = byId(id);
  if (!record) return false;
  const vin = cleanVin(record.vin);
  const problems = vinProblems(vin);
  if (!quiet && problems.length && !await ask("VIN atrodo neteisingas", `${problems[0]}\nVis tiek patvirtinti?`, "Patvirtinti")) return false;
  if (!quiet && duplicatesOf(records, record).length
      && !await ask("Toks VIN jau yra", "Šis VIN jau yra sąraše. Vis tiek pridėti dar vieną?", "Pridėti")) return false;
  const next = quiet ? null : nextReviewAfter(id);
  // Peržiūros paveikslėlių sąraše nebereikia – jie tik didintų duomenis.
  await update(record, { vin, status: STATUS.IN, thumb: "", snippets: {} });
  animateOut(id);
  if (!quiet) {
    render();
    if (next) document.getElementById(`r-${next}-vin`)?.focus();
    else $("q").focus();
  }
  return true;
}

async function confirmClean() {
  const clean = records.filter(isClean);
  for (const record of clean) await confirmRecord(record.id, true);
  render();
  toast(`Patvirtinta: ${clean.length}.`);
}

function nextReviewAfter(id) {
  const cards = [...document.querySelectorAll("#review-list .rcard:not(.leaving)")];
  const index = cards.findIndex((card) => card.dataset.id === id);
  const next = cards[index + 1] || cards[index - 1];
  return next ? next.dataset.id : null;
}

/** Visi to paties įkelto PDF lapai (seniems įrašams – pagal failą ir įkėlimo laiką). */
const batchOf = (record) => record.batch || `${record.source_file}|${record.added}`;
const scanOf = (record) => records.filter((other) => batchOf(other) === batchOf(record));

async function removeScan(id) {
  const record = byId(id);
  if (!record) return;
  const pages = scanOf(record);
  const done = pages.filter((page) => page.status !== STATUS.REVIEW);
  const text = `„${record.source_file}“, įkeltas ${showDate(record.added)}: bus ištrinti visi ${pages.length} lap. ir jų PDF.`
    + (done.length ? `\nDėmesio: ${done.length} iš jų jau patvirtinti arba atiduoti – jie irgi bus ištrinti.` : "");
  if (!await ask("Ištrinti visą skeną?", text, "Ištrinti visą skeną", true)) return;
  for (const page of pages) {
    await deleteRecord(page.id);
    if (store.state === "ok") disk.removePdf(store.handle, page.id);
    selected.delete(page.id);
    animateOut(page.id);
  }
  const gone = new Set(pages.map((page) => page.id));
  records = records.filter((other) => !gone.has(other.id));
  scheduleSync();
  render();
  toast(`Ištrintas skenas: ${pages.length} lap.`);
}

async function removeRecord(id) {
  const record = byId(id);
  if (!record) return;
  const label = record.vin || `${record.source_file}, ${record.page} lapas`;
  if (!await ask("Ištrinti liudijimą?", `${label}\nBus ištrintas ir jo PDF.`, "Ištrinti", true)) return;
  await deleteRecord(id);
  if (store.state === "ok") disk.removePdf(store.handle, id);
  scheduleSync();
  records = records.filter((other) => other.id !== id);
  selected.delete(id);
  animateOut(id);
  render();
  toast("Ištrinta.");
}

// ---------------------------------------------------------------------------
// Skaičiai
// ---------------------------------------------------------------------------

function renderCounts() {
  const n = counts(records);
  const ready = n.all - n[STATUS.REVIEW];
  $("nav-in").textContent = n[STATUS.IN] || "";
  $("nav-out").textContent = n[STATUS.OUT] || "";
  $("nav-review").textContent = n[STATUS.REVIEW] || "";
  $("t-in").textContent = n[STATUS.IN];
  $("t-out").textContent = n[STATUS.OUT];
  $("t-all").textContent = ready;

  $("greeting").textContent = records.length ? `Turime ${n[STATUS.IN]} CoC` : "Pradėkime nuo pirmo skeno";
  $("summary").textContent = records.length
    ? [n[STATUS.REVIEW] ? `${n[STATUS.REVIEW]} laukia patikros` : "", `${n[STATUS.OUT]} atiduota`]
      .filter(Boolean).join(" · ")
    : "";
  $("empty").classList.toggle("hidden", records.length > 0);
}

// ---------------------------------------------------------------------------
// Sąrašas ir paieška
// ---------------------------------------------------------------------------

/** Aiškus atsakymas į klausimą „ar turime šitą CoC?“. */
function renderAnswer(query) {
  const box = $("answer");
  const vin = cleanVin(query);
  if (/\s/.test(query.trim()) || vin.length < 5) { box.innerHTML = ""; return; }
  const hits = records.filter((record) => (record.vin || "").includes(vin));
  const list = (items) => items.slice(0, 3).map((record) =>
    `<b>${esc(record.vin)}</b> ${esc([record.make, record.model].filter(Boolean).join(" "))}`).join(", ");
  let html = "";
  if (!hits.length) {
    if (/\d/.test(vin)) {
      html = `<div class="answer no"><span class="mark">${icon("x")}</span>
        <div><b>Neturime.</b> <span>CoC su VIN, kuriame yra „${esc(vin)}“, sąraše nėra.</span></div></div>`;
    }
  } else {
    const have = hits.filter((record) => record.status === STATUS.IN);
    const review = hits.filter((record) => record.status === STATUS.REVIEW);
    const gone = hits.filter((record) => record.status === STATUS.OUT);
    if (have.length === 1) {
      const [one] = have;
      html = `<div class="answer ok"><span class="mark">${icon("check")}</span>
        <div><b>Turime.</b> <span>${list(have)}</span>
          <span class="where">${icon("folder")} Aplanke <b>${esc(folderOf(one))}</b></span></div>
        <div class="actions">
          <button type="button" class="btn primary sm" data-give="${one.id}">${icon("send")}Atiduoti</button>
          <button type="button" class="btn sm" data-detail="${one.id}">Atidaryti</button></div></div>`;
    } else if (have.length) {
      const folders = [...new Set(have.map(folderOf))].join(", ");
      html = `<div class="answer ok"><span class="mark">${icon("check")}</span>
        <div><b>Turime ${have.length}.</b> <span>${list(have)}${have.length > 3 ? ` ir dar ${have.length - 3}` : ""}</span>
          <span class="where">${icon("folder")} Aplankuose <b>${esc(folders)}</b></span></div></div>`;
    } else if (review.length) {
      html = `<div class="answer warn"><span class="mark">${icon("scan")}</span>
        <div><b>Yra, bet dar nepatikrintas.</b> <span>${list(review)}</span>
          <span class="where">${icon("folder")} Aplanke <b>${esc(folderOf(review[0]))}</b></span></div></div>`;
    } else {
      const last = gone.sort((a, b) => String(b.given_date).localeCompare(String(a.given_date)))[0];
      html = `<div class="answer warn"><span class="mark">${icon("send")}</span>
        <div><b>Atiduotas ${esc(showDate(last.given_date))}${last.given_to ? ` – ${esc(last.given_to)}` : ""}.</b>
        <span>${list([last])}</span></div></div>`;
    }
  }
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

function vinCell(vin) {
  if (!vin) return `<span class="muted">VIN nėra</span>`;
  return `${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b>`;
}

function inFolderFilter(record) {
  if (!folderFilter) return true;
  if (folderFilter === MODEL_FOLDERS) return !inSpecialFolder(record);
  return String(record.folder || "").trim() === folderFilter;
}

function visibleRecords() {
  const query = $("q").value;
  if (query.trim()) {
    return records.filter((record) => record.status !== STATUS.REVIEW && matches(record, query)).sort(newestFirst);
  }
  const pool = records.filter(inFolderFilter);
  if (tab === "visi") return pool.filter((record) => record.status !== STATUS.REVIEW).sort(newestFirst);
  const list = pool.filter((record) => record.status === tab);
  if (tab === STATUS.OUT) {
    return list.sort((a, b) => String(b.given_date).localeCompare(String(a.given_date)) || newestFirst(a, b));
  }
  return list.sort(newestFirst);
}

function moveIndicator() {
  const active = document.querySelector("#tabs button.on");
  const indicator = $("seg-indicator");
  if (!active) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

function renderTable() {
  const query = $("q").value.trim();
  const list = visibleRecords();
  $("tabs").classList.toggle("searching", Boolean(query));
  document.querySelectorAll("#tabs button").forEach((button) => button.classList.toggle("on", button.dataset.tab === tab));
  moveIndicator();

  const rows = list.slice(0, shown).map((record, index) => {
    const statusText = record.status === STATUS.OUT
      ? `<span class="pill out">Atiduotas ${esc(showDate(record.given_date))}</span>
         ${record.given_to ? `<small>${esc(record.given_to)}</small>` : ""}`
      : `<span class="pill ${record.status}">${esc(statusName(record.status))}</span>`;
    const action = record.status === STATUS.OUT
      ? `<button type="button" class="btn sm" data-return="${record.id}">${icon("undo")}Grąžinti</button>`
      : `<button type="button" class="btn sm" data-give="${record.id}">${icon("send")}Atiduoti</button>`;
    const sub = [record.make, record.note].filter(Boolean).join(" · ");
    return `<tr data-row="${record.id}" class="${selected.has(record.id) ? "selected" : ""} ${animateRows && index < 30 ? "enter" : ""}" style="--i:${index}">
      <td class="check"><input type="checkbox" data-select="${record.id}" ${selected.has(record.id) ? "checked" : ""}
          aria-label="Pažymėti ${esc(record.vin)}"></td>
      <td class="vin">${vinCell(record.vin)}</td>
      <td><div class="model"><span class="model-icon">${icon("file")}</span>
        <div><b>${esc(record.model || "—")}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div></div></td>
      <td>${inSpecialFolder(record)
        ? `<span class="folder special">${icon("folder")}${esc(record.folder)}</span>`
        : `<span class="folder">${icon("folder")}${esc(folderOf(record))}</span>`}</td>
      <td class="date hide-sm">${esc(showDate(record.added))}</td>
      <td class="status-cell">${statusText}</td>
      <td class="actions">${action}</td>
    </tr>`;
  });
  animateRows = false;
  $("rows").innerHTML = rows.join("") || `<tr class="empty-row"><td colspan="7">${
    query ? "Nieko nerasta." : records.length ? "Šiame sąraše tuščia." : "Dar nėra nė vieno liudijimo – įmeskite nuskenuotą PDF."
  }</td></tr>`;

  const more = list.length - shown;
  $("list-note").innerHTML = more > 0
    ? `Rodoma ${shown} iš ${list.length}. <button type="button" class="btn sm" data-action="more">Rodyti daugiau</button>`
    : query ? `Rasta: ${list.length} · ieškoma visuose sąrašuose ir aplankuose` : "";

  const visibleIds = list.slice(0, shown).map((record) => record.id);
  $("check-all").checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  renderBulk();
}

function renderBulk() {
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  $("bulk").classList.toggle("on", selected.size > 0);
  if (selected.size) $("bulk-count").textContent = `Pažymėta: ${selected.size}`;
}

function renderFolders() {
  const folders = allFolders();
  if (folderFilter && folderFilter !== MODEL_FOLDERS && !folders.some((folder) => folder.name === folderFilter)) folderFilter = "";
  $("folder-filter").innerHTML = [
    `<option value="">Visi aplankai</option>`,
    `<option value="${MODEL_FOLDERS}">Tik modelių aplankai</option>`,
    ...folders.map((folder) => `<option value="${esc(folder.name)}">${esc(folder.name)} (${folder.count})</option>`),
  ].join("");
  $("folder-filter").value = folderFilter;
  $("folder-filter").closest(".folder-filter").classList.toggle("on", Boolean(folderFilter));
  $("folder-nav").innerHTML = folders.length
    ? folders.map((folder) => `<button type="button" class="nav ${folderFilter === folder.name ? "on-folder" : ""}"
        data-folder="${esc(folder.name)}">${icon("folder")}${esc(folder.name)}<span class="badge">${folder.count || ""}</span></button>`).join("")
    : `<p class="nav-empty">Dar nėra. Sukursite įkeldami skeną.</p>`;
  $("folders").innerHTML = folders.map((folder) => `<option value="${esc(folder.name)}">`).join("");
}

function setFolderFilter(value) {
  folderFilter = value;
  if ($("q").value) { $("q").value = ""; renderAnswer(""); }
  animateRows = true;
  renderFolders();
  renderTable();
}

function renderRecipients() {
  const names = [...new Set(records.map((record) => (record.given_to || "").trim()).filter(Boolean))].sort();
  $("recipients").innerHTML = names.map((name) => `<option value="${esc(name)}">`).join("");
}

function render() {
  renderCounts();
  renderReview();
  renderTable();
  renderAnswer($("q").value);
  renderRecipients();
  renderFolders();
  renderBackupState();
  highlightNav();
}

// ---------------------------------------------------------------------------
// Atidavimas
// ---------------------------------------------------------------------------

function openGive(ids) {
  giveIds = ids.filter((id) => byId(id));
  if (!giveIds.length) return;
  const first = byId(giveIds[0]);
  $("give-title").textContent = giveIds.length === 1
    ? `${first.model || "Liudijimas"} · …${(first.vin || "").slice(-6)}`
    : `${giveIds.length} liudijimai`;
  $("g-date").value = todayIso();
  $("g-to").value = "";
  $("g-note").value = "";
  $("give").showModal();
  $("g-to").focus();
}

async function give() {
  const changes = { status: STATUS.OUT, given_date: $("g-date").value || todayIso(), given_to: $("g-to").value.trim() };
  const note = $("g-note").value.trim();
  for (const id of giveIds) {
    const record = byId(id);
    if (record) await update(record, note ? { ...changes, note } : changes);
  }
  toast(giveIds.length === 1 ? `Atiduota: ${changes.given_to}.` : `Atiduota ${giveIds.length} CoC: ${changes.given_to}.`);
  giveIds.forEach((id) => selected.delete(id));
  giveIds = [];
  animateRows = true;
  render();
}

async function returnRecords(ids) {
  const list = ids.map(byId).filter((record) => record && record.status === STATUS.OUT);
  if (!list.length) return;
  const ok = await ask(
    list.length === 1 ? "Grąžinti į turimus?" : `Grąžinti ${list.length} CoC į turimus?`,
    "Atidavimo data ir gavėjas bus ištrinti.", "Grąžinti",
  );
  if (!ok) return;
  for (const record of list) await update(record, { status: STATUS.IN, given_date: "", given_to: "" });
  animateRows = true;
  render();
  toast(`Grąžinta: ${list.length}.`);
}

// ---------------------------------------------------------------------------
// Liudijimo langas
// ---------------------------------------------------------------------------

const DETAIL_FIELDS = {
  "d-vin": "vin", "d-make": "make", "d-model": "model", "d-tvv": "tvv",
  "d-status": "status", "d-given-date": "given_date", "d-given-to": "given_to", "d-note": "note",
  "d-folder": "folder",
};
const COC_FIELDS = {
  "d-approval": "approval_number", "d-approval-date": "approval_date",
  "d-national": "national_approval_number", "d-colour": "colour",
};

function detailVinHint() {
  const draft = { ...byId(detailId), vin: $("d-vin").value };
  const [kind, text] = vinHint(draft);
  $("d-vin-hint").className = `hint ${kind}`;
  $("d-vin-hint").innerHTML = hintHtml(kind, text);
}

function detailFolderHint() {
  const special = $("d-folder").value.trim();
  $("d-folder-hint").className = "hint";
  $("d-folder-hint").innerHTML = `${icon("folder")}Guli aplanke: ${esc(special || folderOf({ model: $("d-model").value }))}`;
}

async function openDetail(id) {
  const record = byId(id);
  if (!record) return;
  detailId = id;
  $("detail-title").textContent = [record.make, record.model].filter(Boolean).join(" ") || "Liudijimas";
  $("detail-pill").className = `pill ${record.status}`;
  $("detail-pill").textContent = record.status === STATUS.OUT
    ? `Atiduotas ${showDate(record.given_date)}` : statusName(record.status);
  for (const [input, key] of Object.entries(DETAIL_FIELDS)) $(input).value = record[key] || "";
  for (const [input, key] of Object.entries(COC_FIELDS)) $(input).value = (record.coc || {})[key] || "";
  $("detail-meta").textContent = [
    `Įkelta ${showDate(record.added)} iš „${record.source_file}“ (${record.page} lapas)`,
    record.updated && record.updated !== record.added ? `keista ${showDate(record.updated)}` : "",
  ].filter(Boolean).join(" · ");
  detailVinHint();
  detailFolderHint();
  $("detail-preview").removeAttribute("src");
  $("detail").showModal();
  try {
    const bytes = await getPdf(id);
    if (bytes && detailId === id) $("detail-preview").src = await thumbnail(bytes, 900);
  } catch {
    // peržiūra nebūtina – PDF vis tiek galima atsidaryti
  }
}

async function saveDetail() {
  const record = byId(detailId);
  if (!record) return;
  const changes = {};
  for (const [input, key] of Object.entries(DETAIL_FIELDS)) changes[key] = $(input).value.trim();
  changes.vin = cleanVin(changes.vin);
  changes.coc = { ...(record.coc || {}) };
  for (const [input, key] of Object.entries(COC_FIELDS)) changes.coc[key] = $(input).value.trim();
  if (changes.status === STATUS.OUT && !changes.given_date) changes.given_date = todayIso();
  if (changes.status !== STATUS.REVIEW) Object.assign(changes, { thumb: "", snippets: {} });
  await rememberFolder(changes.folder);
  await update(record, changes);
  render();
  toast("Išsaugota.");
}

// ---------------------------------------------------------------------------
// PDF, pažymos, Excel
// ---------------------------------------------------------------------------

async function downloadPdfs(ids) {
  const list = ids.map(byId).filter(Boolean);
  if (!list.length) return;
  if (list.length === 1) {
    download(await getPdf(list[0].id), pdfName(list[0]), "application/pdf");
    return;
  }
  const files = {};
  for (const record of list) {
    let name = pdfName(record);
    for (let n = 2; files[name]; n += 1) name = pdfName(record).replace(/\.pdf$/, `_${n}.pdf`);
    files[name] = await getPdf(record.id);
  }
  download(zipSync(files, { level: 0 }), `coc_${todayIso()}.zip`, "application/zip");
  toast(`Atsisiųsta PDF: ${list.length}.`);
}

async function templateBytes() {
  const stored = await getTemplate();
  if (stored) return stored.bytes;
  const response = await fetch(new URL("../../blank-template.docx", import.meta.url));
  return new Uint8Array(await response.arrayBuffer());
}

function pazymaValues(record) {
  const coc = record.coc || {};
  // Pažymoje – pilnas komercinis pavadinimas, kaip CoC („NISSAN QASHQAI“),
  // nebent modelis po to buvo pataisytas ranka.
  const original = coc.commercial_name && splitMakeModel(record.make, coc.commercial_name).model === record.model;
  return buildValues({
    ...coc,
    make: record.make, commercial_name: original ? coc.commercial_name : record.model, type_variant_version: record.tvv,
    vin: record.vin, national_approval_number: coc.national_approval_number || "",
  }, todayIso());
}

async function makePazymos(ids) {
  const list = ids.map(byId).filter(Boolean);
  if (!list.length) return;
  const missing = list.filter((record) => !(record.coc || {}).colour || !(record.coc || {}).approval_number);
  if (missing.length && !await ask(
    "Trūksta pažymos duomenų",
    `${missing.length === 1 ? "Šiame liudijime" : `${missing.length} liudijimuose`} nėra spalvos arba tipo patvirtinimo Nr. `
      + "(jie dažnai būna kitoje CoC pusėje). Pažymoje tie laukai liks tušti.",
    "Vis tiek generuoti",
  )) return;
  const template = await templateBytes();
  const documents = list.map((record) => {
    const values = pazymaValues(record);
    return [suggestedFilename(values), fillTemplate(template, values).bytes];
  });
  const type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (documents.length === 1) download(documents[0][1], documents[0][0], type);
  else download(zipDocuments(documents), "aiksteles.zip", "application/zip");
  toast(documents.length === 1 ? "Pažyma sugeneruota." : `Sugeneruota pažymų: ${documents.length}.`);
}

function exportExcel(subset = null) {
  const source = subset ? subset.map(byId).filter(Boolean) : records;
  const sheets = excelSheets(source);
  if (!sheets[2].rows.length) { toast("Nėra ką eksportuoti.", "warn"); return; }
  download(buildXlsx(sheets, EXCEL_COLUMNS), `coc-sandelis_${todayIso()}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  toast(`Excel failas paruoštas (${sheets[2].rows.length} CoC).`);
}

// ---------------------------------------------------------------------------
// Atsarginė kopija
// ---------------------------------------------------------------------------

async function backup() {
  if (!records.length) { toast("Kol kas nėra ko kopijuoti.", "warn"); return; }
  const files = { "sandelis.json": strToU8(JSON.stringify({ version: 1, saved: now(), records }, null, 1)) };
  for (const record of records) {
    const bytes = await getPdf(record.id);
    if (bytes) files[`pdf/${record.id}.pdf`] = bytes;
  }
  // PDF jau suspausti – spaudžiant dar kartą tik gaištamas laikas.
  download(zipSync(files, { level: 0 }), `coc-sandelis_${todayIso()}.zip`, "application/zip");
  await setMeta("lastBackup", now());
  toast(`Kopija atsisiųsta (${records.length} įraš.). Laikykite ją ne šiame kompiuteryje.`);
  renderBackupState();
}

async function restore(file) {
  if (!file) return;
  try {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!files["sandelis.json"]) throw new Error("tai ne sandėlio kopija");
    const incoming = JSON.parse(strFromU8(files["sandelis.json"])).records || [];
    const plan = mergePlan(records, incoming);
    for (const record of plan.add) await addRecord(record, files[`pdf/${record.id}.pdf`] || null);
    for (const record of plan.replace) await saveRecord(record);
    records = await allRecords();
    scheduleSync(0);
    animateRows = true;
    render();
    toast(`Kopija įkelta: pridėta ${plan.add.length}, atnaujinta ${plan.replace.length}, jau buvo ${plan.skip}.`);
    runQueue();
  } catch (error) {
    toast(`Nepavyko įkelti kopijos: ${error.message || error}`, "err");
  }
}

async function renderBackupState() {
  const card = $("backup-card");
  const ready = records.filter((record) => record.status !== STATUS.REVIEW).length;
  const button = $("store-btn");
  card.classList.remove("ok", "due");
  if (store.state === "ok") {
    card.classList.add("ok");
    $("store-title").textContent = `Saugoma: ${store.handle.name}`;
    $("backup-text").textContent = store.saved
      ? `Įrašyta ${store.saved.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}. Išvalius Chrome duomenys liks aplanke.`
      : "Kiekvienas pakeitimas įrašomas į aplanką kompiuteryje.";
    button.dataset.action = "folder-connect";
    button.querySelector("span").textContent = "Keisti aplanką";
  } else if (store.state === "permission") {
    card.classList.add("due");
    $("store-title").textContent = "Reikia leidimo";
    $("backup-text").textContent = `Chrome prašo patvirtinti, kad galima toliau saugoti į aplanką „${store.handle.name}“.`;
    button.dataset.action = "folder-allow";
    button.querySelector("span").textContent = "Leisti";
  } else {
    const last = await getMeta("lastBackup").catch(() => null);
    card.classList.toggle("due", ready > 0 && backupDue(last, ready));
    $("store-title").textContent = "Duomenų aplankas";
    $("backup-text").textContent = disk.supported()
      ? "Duomenys kol kas tik naršyklėje. Pasirinkite aplanką kompiuteryje – tada išvalius Chrome niekas nedings."
      : last ? `Paskutinė kopija – ${showDate(last)}.` : "Duomenys tik šioje naršyklėje – darykite kopiją.";
    button.dataset.action = disk.supported() ? "folder-connect" : "backup";
    button.querySelector("span").textContent = disk.supported() ? "Pasirinkti aplanką" : "Atsisiųsti kopiją";
  }
  $("restore-step").classList.toggle("hidden", !disk.supported());
  const usage = await usageMb();
  $("usage").textContent = usage !== null ? `Naršyklėje užimama: ${usage < 1 ? "<1" : usage.toFixed(0)} MB` : "";
}

// ---------------------------------------------------------------------------
// Įvykiai
// ---------------------------------------------------------------------------

$("files").addEventListener("change", (event) => { handleFiles(event.target.files); event.target.value = ""; });

// Failą galima nuvilkti bet kur į langą.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  $("drop-overlay").classList.add("on");
});
window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-overlay").classList.remove("on");
});
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop-overlay").classList.remove("on");
  handleFiles(event.dataTransfer.files);
});

// Patikros kortelės
const saveTimers = {};
$("review-list").addEventListener("input", (event) => {
  const input = event.target;
  const card = input.closest(".rcard");
  if (!card || !input.dataset.field) return;
  if (input.dataset.field === "folder") return;
  const record = byId(card.dataset.id);
  if (!record) return;
  record[input.dataset.field] = input.value;
  record.touched = true;
  input.classList.remove("loading");
  if (input.dataset.field === "vin") {
    const [kind, text] = vinHint(record);
    const hint = card.querySelector(".hint");
    hint.className = `hint ${kind}`;
    hint.innerHTML = hintHtml(kind, text);
  }
  clearTimeout(saveTimers[record.id]);
  saveTimers[record.id] = setTimeout(() => { update(record, {}); renderConfirmClean(); }, 400);
});
$("review-list").addEventListener("change", (event) => {
  if (event.target.dataset.field === "folder") {
    const record = byId(event.target.closest(".rcard").dataset.id);
    if (record) { record.folder = event.target.value; update(record, {}); }
    return;
  }
  // VIN pataisomas išėjus iš laukelio: mažosios raidės, tarpai, O → 0, I → 1.
  if (event.target.dataset.field !== "vin") return;
  const cleaned = cleanVin(event.target.value);
  if (cleaned !== event.target.value) {
    event.target.value = cleaned;
    event.target.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
$("review-list").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.dataset.field) return;
  event.preventDefault();
  confirmRecord(event.target.closest(".rcard").dataset.id);
});
$("review-list").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.open) openPdf(target.dataset.open);
  if (target.dataset.confirm) confirmRecord(target.dataset.confirm);
  if (target.dataset.remove) removeRecord(target.dataset.remove);
  if (target.dataset.removeScan) removeScan(target.dataset.removeScan);
});

// Paieška ir sąrašas
let searchTimer = null;
$("q").addEventListener("input", () => {
  shown = PAGE;
  renderAnswer($("q").value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { animateRows = true; renderTable(); }, 120);
});
$("q").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { $("q").value = ""; $("q").dispatchEvent(new Event("input")); }
  if (event.key === "Enter") {
    const first = visibleRecords()[0];
    if (first && $("q").value.trim()) openDetail(first.id);
  }
});
document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector("dialog[open]");
  if (event.key === "/" && !typing) { event.preventDefault(); focusSearch(); }
});

function focusSearch() {
  $("sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
  $("q").focus();
  $("q").select();
}

function setTab(next) {
  tab = next;
  shown = PAGE;
  if ($("q").value) { $("q").value = ""; renderAnswer(""); }
  animateRows = true;
  renderTable();
}

document.querySelectorAll("#tabs button").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));

$("rows").addEventListener("click", (event) => {
  const box = event.target.closest("[data-select]");
  if (box) {
    if (box.checked) selected.add(box.dataset.select); else selected.delete(box.dataset.select);
    box.closest("tr").classList.toggle("selected", box.checked);
    renderBulk();
    return;
  }
  const button = event.target.closest("button");
  if (button?.dataset.give) { openGive([button.dataset.give]); return; }
  if (button?.dataset.return) { returnRecords([button.dataset.return]); return; }
  const row = event.target.closest("tr[data-row]");
  if (row) openDetail(row.dataset.row);
});
$("folder-filter").addEventListener("change", (event) => setFolderFilter(event.target.value));
$("folder-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  $("sidebar").classList.remove("open");
  setTab(STATUS.IN);
  setFolderFilter(folderFilter === button.dataset.folder ? "" : button.dataset.folder);
  $("list").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
});
$("answer").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.give) openGive([button.dataset.give]);
  if (button?.dataset.detail) openDetail(button.dataset.detail);
});
$("check-all").addEventListener("change", (event) => {
  const ids = visibleRecords().slice(0, shown).map((record) => record.id);
  ids.forEach((id) => (event.target.checked ? selected.add(id) : selected.delete(id)));
  renderTable();
});

// Šoninis meniu
document.querySelectorAll(".sidebar [data-nav]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  $("sidebar").classList.remove("open");
  if (link.dataset.tab) setTab(link.dataset.tab);
  const target = link.dataset.nav === "top" ? null : $(link.dataset.nav);
  if (target && target.classList.contains("hidden")) { toast("Patikrinti nėra ko – viskas patvirtinta."); return; }
  if (target) target.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  else window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
}));

/** Šoniniame meniu paryškinama ta vieta, kurią šiuo metu matote. */
function highlightNav() {
  const spots = ["review", "list"].map((id) => $(id)).filter((element) => !element.classList.contains("hidden"));
  let current = "top";
  for (const element of spots) if (element.getBoundingClientRect().top < window.innerHeight * 0.4) current = element.id;
  document.querySelectorAll(".sidebar [data-nav]").forEach((link) => {
    const on = link.dataset.nav === current && (current !== "list" || link.dataset.tab === tab);
    link.classList.toggle("on", on);
  });
}
window.addEventListener("scroll", () => requestAnimationFrame(highlightNav), { passive: true });

// Mygtukai su data-action
const ACTIONS = {
  upload: () => $("files").click(),
  backup,
  restore: () => $("restore-file").click(),
  excel: () => exportExcel(),
  "excel-selected": () => exportExcel([...selected]),
  menu: () => $("sidebar").classList.toggle("open"),
  "focus-search": focusSearch,
  "confirm-clean": confirmClean,
  more: () => { shown += PAGE; renderTable(); },
  "give-selected": () => openGive([...selected]),
  "return-selected": () => returnRecords([...selected]),
  "pdf-selected": () => downloadPdfs([...selected]),
  "pazyma-selected": () => makePazymos([...selected]),
  "clear-selection": () => { selected.clear(); renderTable(); },
  "give-cancel": () => $("give").close(),
  "folder-cancel": () => $("folder-dialog").close(),
  "folder-connect": () => connectFolder(),
  "folder-restore": () => connectFolder(true),
  "folder-allow": allowFolder,
  "open-pdf": () => openPdf(detailId),
  "detail-close": () => $("detail").close(),
  "detail-pdf": () => downloadPdfs([detailId]),
  "detail-pazyma": async () => { await saveDetail(); makePazymos([detailId]); },
  "detail-delete": async () => {
    const id = detailId;
    $("detail").close();
    await removeRecord(id);
  },
};
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button && ACTIONS[button.dataset.action]) ACTIONS[button.dataset.action]();
});
document.addEventListener("click", (event) => {
  // Paspaudus šalia atidaryto meniu (telefone), jis užsidaro.
  if ($("sidebar").classList.contains("open") && !event.target.closest(".sidebar, .menu-btn")) {
    $("sidebar").classList.remove("open");
  }
});
$("restore-file").addEventListener("change", (event) => { restore(event.target.files[0]); event.target.value = ""; });

$("give-form").addEventListener("submit", (event) => {
  if (event.submitter && event.submitter.value === "give") give();
});
$("detail-form").addEventListener("submit", (event) => {
  if (!event.submitter || event.submitter.value === "save") saveDetail();
});
$("d-vin").addEventListener("input", detailVinHint);
$("d-folder").addEventListener("input", detailFolderHint);
$("d-model").addEventListener("input", detailFolderHint);
$("d-vin").addEventListener("change", () => { $("d-vin").value = cleanVin($("d-vin").value); detailVinHint(); });
$("d-status").addEventListener("change", () => {
  if ($("d-status").value === STATUS.OUT && !$("d-given-date").value) $("d-given-date").value = todayIso();
});
$("detail-preview").addEventListener("click", () => openPdf(detailId));
$("detail").addEventListener("close", () => { detailId = null; });
// Paspaudus už lango ribų, langas užsidaro.
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) dialog.close();
}));

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(moveIndicator, 150);
});

// ---------------------------------------------------------------------------
// Paleidimas
// ---------------------------------------------------------------------------

async function start() {
  savedFolders = (await getMeta("folders").catch(() => null)) || [];
  await loadFolderState();
  try {
    records = await allRecords();
  } catch (error) {
    toast(`Nepavyko atidaryti duomenų: ${error.message || error}`, "err");
    records = [];
  }
  // Puslapį uždarius vidury skaitymo, tas lapas skaitomas iš naujo.
  for (const record of records) if (record.ocr === "skaitoma") record.ocr = "laukia";
  render();
  requestAnimationFrame(moveIndicator);
  // Aplankas papildomas tuo, ko jame galbūt dar nėra (pvz. po atnaujinimo).
  if (store.state === "ok") scheduleSync(0);
  else if (store.state === "permission") toast("Spauskite „Leisti“ kairėje, kad duomenys vėl būtų saugomi aplanke.", "warn");
  renderBackupState();
  if (records.some((record) => record.ocr === "laukia")) runQueue();
  else warmUp();
  if (records.length) askPersistence();
}

start();
if (document.fonts) document.fonts.ready.then(moveIndicator);

/** Ar serveryje yra naujesnė versija (kaip ir pažymų puslapyje). */
async function checkVersion() {
  $("version").textContent = `· versija ${VERSION.replace("aikstele-", "")}`;
  try {
    const response = await fetch(new URL("../../version.js", import.meta.url), { cache: "no-store" });
    const latest = ((await response.text()).match(/VERSION = "([^"]+)"/) || [])[1];
    if (latest && latest !== VERSION) $("update").classList.remove("hidden");
  } catch {
    // neprisijungus nepatikrinsime
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
      // Tas pats aptarnaujantis failas kaip ir pažymų puslapio: jis talpina
      // visą svetainę, todėl abu puslapiai veikia be interneto.
      await navigator.serviceWorker.register("../sw.js", { scope: "../" });
      if (!self.crossOriginIsolated && navigator.serviceWorker.controller === null
          && !records.length && !sessionStorage.getItem("perkrauta")) {
        sessionStorage.setItem("perkrauta", "1");
        setTimeout(() => window.location.reload(), 500);
      }
    } catch {
      // be jo programa veikia, tik ne neprisijungus
    }
  });
}
