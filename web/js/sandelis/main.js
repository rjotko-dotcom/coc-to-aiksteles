// Sandėlio sąsaja: skenų priėmimas, patikra, paieška, atidavimas, kopijos.

import { readCertificate } from "../read.js";
import { inBackground, parallelism as ocrParallelism, warmUp } from "../ocr.js";
import { analyseTemplate, buildValues, fillTemplate, suggestedFilename, zipDocuments } from "../docx.js";
import { getTemplate, saveTemplate } from "../store.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "../../vendor/fflate/fflate.mjs";
import { VERSION } from "../../version.js";
import {
  addRecord, allRecords, askPersistence, deleteRecord, getMeta, getPdf, saveRecord, setMeta, usageMb,
} from "./db.js";
import { splitPages, thumbnail } from "./split.js";
import { buildXlsx } from "./xlsx.js";
import { printBinderLabels, printFolderSheets, printMoveSheet } from "./print.js";
import * as disk from "./folder.js";
import { CARS, carImage, carKeyOf, cssColour, generationOf, imageSize, paintOf, yearOf } from "./cars.js";
import {
  STATUS, BINDER_SIZE, assignFolderCodes, backupDue, binderContents, bulkCheck, planBinders, vinList, cleanFolderCode, excelColumns, folderNames, folderGroups, cleanVin, counts, duplicatesOf, excelSheets, folderOf, inSpecialFolder, matches,
  localDay, mergePlan, newestFirst, modelFromVin, pdfName, showDate, specialFolders, splitMakeModel, statusName, todayIso, vinDoubtful, vinHits,
  vinProblems,
} from "./logic.js";

/** Kiek eilučių rodyti iš karto – didelis sąrašas kitaip stabdytų puslapį. */
const PAGE = 60;

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
/** Filtras pagal vieną aplanką (įmautę): BINDER_PREFIX + kodas. */
const BINDER_PREFIX = "\u0000aplankas:";
/** Sukurti, bet dar tušti specialūs aplankai (kad nedingtų iš sąrašo). */
let savedFolders = [];
/** Seni grupių kodai: { „X-TRAIL“: „A-01“, … } – pirmas grupės aplankas gauna jį. */
let folderCodes = {};
/** Fiziniai aplankai (įmautės) po 20 CoC: [{ code: "A-10", group: "QASHQAI" }]. */
let binders = [];
/** Šablonas pasikeitė – įrašyti ir į duomenų aplanką. */
let templateDirty = false;
/** Kuris CoC rodomas automobilio skydelyje. */
let stageId = null;

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

/**
 * Atsisiuntimai: programos lange Chrome atsisiuntimų juostos nesimato, todėl
 * paskutiniai failai rodomi čia – su galimybe atidaryti dar kartą.
 */
const downloads = [];
let downloadsTimer = null;

const fileKind = (name) => (/\.pdf$/i.test(name) ? "pdf" : /\.docx$/i.test(name) ? "doc" : /\.xlsx$/i.test(name) ? "sheet" : "zip");
const fileSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function saveFile(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.position = "fixed";
  link.style.top = "0";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function download(bytes, filename, type = "application/octet-stream", meta = {}) {
  // Kai pasirinktas duomenų aplankas, failas įrašomas tiesiai į jį
  // („atsisiuntimai“) – be Chrome atsisiuntimų lango.
  let where = "";
  if (store.state === "ok") {
    try {
      filename = await disk.saveDownload(store.handle, filename, bytes);
      where = `${store.handle.name}/${disk.DOWNLOADS_DIR}`;
    } catch {
      where = "";
    }
  }
  if (!where) saveFile(bytes, filename, type);
  downloads.unshift({ id: `${Date.now()}-${Math.random()}`, bytes, filename, type, at: new Date(), where, ...meta });
  // Atmintyje laikomi tik paskutiniai failai (ir ne per dideli kartu).
  let total = 0;
  downloads.forEach((item, index) => {
    total += item.bytes ? item.bytes.length : 0;
    if (index >= 8 || total > 80 * 1024 * 1024) item.bytes = null;
  });
  downloads.splice(12);
  showDownloads(true);
}

function showDownloads(auto = false) {
  const tray = $("downloads");
  $("downloads-badge").textContent = downloads.length || "";
  if (!downloads.length) { tray.hidden = true; return; }
  $("downloads-list").innerHTML = downloads.map((item) => {
    const kind = fileKind(item.filename);
    const time = item.at.toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" });
    const open = !item.bytes ? `<span class="muted-inline">atsisiųsta</span>`
      : kind === "pdf" && item.recordId
        ? `<button type="button" class="btn sm" data-dl-view="${item.id}">${icon("eye")}Peržiūrėti</button>`
        : `<button type="button" class="btn sm" data-dl-open="${item.id}" title="Atsisiunčia dar kartą – jei Chrome nustatyta „Visada atidaryti šio tipo failus“, failas iškart atsidarys">${icon("arrow")}Atidaryti</button>`;
    return `<li><span class="dl-icon ${kind}">${icon(kind === "doc" ? "doc" : kind === "sheet" ? "sheet" : "file")}</span>
      <span class="dl-name"><b title="${esc(item.filename)}">${esc(item.filename)}</b><small>${item.bytes ? fileSize(item.bytes.length) + " · " : ""}${time}${item.where ? ` · ${icon("folder")}${esc(item.where)}` : ""}</small></span>
      ${open}</li>`;
  }).join("");
  $("dl-hint").innerHTML = store.state === "ok"
    ? `Failai įrašomi į duomenų aplanką „${esc(store.handle.name)}“ → „${disk.DOWNLOADS_DIR}“ – be Chrome atsisiuntimų lango.`
    : `Failai išsaugomi aplanke „Atsisiuntimai“ (<kbd>Ctrl</kbd>+<kbd>J</kbd>). Pasirinkus duomenų aplanką (☰ meniu), failai bus įrašomi į jį ir Chrome langas nebeiššoks.`;
  tray.hidden = false;
  tray.classList.remove("pop"); void tray.offsetWidth; tray.classList.add("pop");
  clearTimeout(downloadsTimer);
  if (auto) downloadsTimer = setTimeout(() => { if (!tray.matches(":hover")) tray.hidden = true; }, 12000);
}

let viewer = { id: null, url: "" };

/** PDF peržiūra pačioje programoje (be naujo Chrome skirtuko). */
async function openPdf(id) {
  const bytes = await getPdf(id);
  if (!bytes) { toast("Šio liudijimo PDF nerastas.", "err"); return; }
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  const record = byId(id);
  viewer = { id, url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) };
  $("viewer-title").textContent = record ? [displayModel(record), record.vin].filter(Boolean).join(" · ") : "Dokumentas";
  $("viewer-frame").src = `${viewer.url}#view=FitH`;
  $("viewer").showModal();
}

function closeViewer() {
  $("viewer").close();
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
    const template = templateDirty ? (await getTemplate())?.bytes || null : null;
    await disk.save(store.handle, records, {
      getPdf, xlsx: buildXlsx(excelSheets(records), excelColumns(folderCodes)), settings: { folderCodes, binders }, template,
    });
    if (template) templateDirty = false;
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
  await mergeSettings(data.settings);
  // Šablonas iš aplanko – jei naršyklėje jo nebėra (pvz. išvalius Chrome).
  if (!await getTemplate()) {
    const template = await data.template();
    if (template) await saveTemplate(disk.TEMPLATE_FILE, template);
  } else {
    templateDirty = true;
  }
  return plan;
}

/** Aplankų kodai iš aplanko ar kopijos: esami čia nekeičiami, trūkstami pridedami. */
async function mergeSettings(settings = {}) {
  if (!binders.length && Array.isArray(settings.binders) && settings.binders.length) {
    binders = settings.binders;
    await setMeta("binders", binders);
  }
  const incoming = settings.folderCodes || {};
  const merged = { ...incoming, ...folderCodes };
  if (JSON.stringify(merged) === JSON.stringify(folderCodes)) return;
  folderCodes = merged;
  await setMeta("folderCodes", folderCodes);
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
  // Jei anksčiau įkelta tik dalis lapų (pvz. uždarius langą), pridedami tik trūkstami.
  const jobs = [];
  for (const file of candidates) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await fileHash(bytes);
    let pages;
    try {
      pages = await splitPages(bytes);
    } catch (error) {
      toast(`Nepavyko atidaryti ${file.name}: ${error.message || error}`, "err");
      continue;
    }
    const earlier = records.filter((record) => record.file_hash === hash);
    const have = new Set(earlier.map((record) => record.page));
    const missing = pages.map((_, index) => index + 1).filter((number) => !have.has(number));
    // „Nerodyti“ paspaustas ar lapas ištrintas sąmoningai – trūkstamų lapų nebepridedame.
    if (earlier.length && missing.length && !ignoredScans.includes(hash)) {
      jobs.push({ file, hash, pages, numbers: missing, resume: earlier[0] });
      continue;
    }
    if (earlier.length && !await ask(
      "Šis PDF jau įkeltas",
      `„${file.name}“ jau buvo įkeltas ${showDate(earlier[0].added)} (visi ${pages.length} lap.).\nĮkėlus dar kartą, atsiras dublikatai.`,
      "Vis tiek įkelti",
    )) continue;
    jobs.push({ file, hash, pages, numbers: pages.map((_, index) => index + 1), resume: null });
  }
  if (!jobs.length) return;

  // Aplanko klausiama tik dėl naujų skenų – papildomi lapai eina ten, kur jų skenas.
  let folder = "";
  if (jobs.some((job) => !job.resume)) {
    folder = await chooseFolder(jobs.filter((job) => !job.resume).length);
    if (folder === null) return;
  }
  askPersistence();

  // Pirma visi lapai įrašomi į įrenginį (greita), tik paskui peržiūros ir skaitymas.
  // Taip net uždarius langą vidury darbo nė vienas lapas nedingsta.
  const fresh = [];
  for (const job of jobs) {
    const batch = job.resume ? job.resume.added : now();
    const batchId = job.resume ? (job.resume.batch || crypto.randomUUID()) : crypto.randomUUID();
    for (const number of job.numbers) {
      const record = {
        id: crypto.randomUUID(),
        status: STATUS.REVIEW,
        ocr: "laukia",
        vin: "", make: "", model: "", tvv: "",
        coc: {},
        folder: job.resume ? (job.resume.folder || "") : folder,
        batch: batchId,
        file_hash: job.hash,
        source_file: job.file.name,
        page: number,
        pages: job.pages.length,
        added: batch,
        updated: now(),
        given_date: "", given_to: "", note: "",
        thumb: "",
      };
      await addRecord(record, job.pages[number - 1]);
      records.push(record);
      fresh.push([record, job.pages[number - 1]]);
    }
    if (job.resume) toast(`„${job.file.name}“: pridėti trūkstami ${job.numbers.length} lap. iš ${job.pages.length}.`);
  }
  scheduleSync();
  render();
  runQueue();
  toast(`Įkelta lapų: ${fresh.length}. VIN ir modeliai skaitomi…`);
  openReview();

  // Peržiūros paveikslėliai – kai lapai jau saugūs.
  for (const [record, bytes] of fresh) {
    if (!byId(record.id) || record.status !== STATUS.REVIEW) continue;
    try {
      record.thumb = await thumbnail(bytes);
      await saveRecord(record);
      renderCard(record);
    } catch {
      // be peržiūros – PDF vis tiek galima atsidaryti
    }
  }
}

/** Skenai, iš kurių įkelta tik dalis lapų (pvz. langas uždarytas vidury įkėlimo). */
const scanKey = (record) => record.file_hash || batchOf(record);

/** Skenai, apie kuriuos „nepilnai įkelta“ nebeprimenama (paspausta „Nerodyti“ arba lapas ištrintas sąmoningai). */
let ignoredScans = [];

async function ignoreScan(key) {
  if (!key || ignoredScans.includes(key)) return;
  ignoredScans = [...ignoredScans, key];
  await setMeta("ignoredScans", ignoredScans);
}

function incompleteScans() {
  const scans = new Map();
  for (const record of records) {
    if (!record.pages || record.pages < 2) continue;
    const key = scanKey(record);
    if (ignoredScans.includes(key)) continue;
    const entry = scans.get(key) || { key, name: record.source_file, total: record.pages, pages: new Set() };
    entry.pages.add(record.page);
    scans.set(key, entry);
  }
  return [...scans.values()].filter((scan) => scan.pages.size < scan.total);
}

/** PDF turinio atspaudas (SHA-256) – tam pačiam failui atpažinti. */
async function fileHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ar laukelį žmogus jau įrašė pats (seniems įrašams – `touched` reiškė visus). */
const typedByHand = (record, key) => Boolean(record.touched || (record.typed || {})[key]);

/**
 * Lapo juostos (dalimis nuo aukščio), kuriose Nissan CoC pirmoje pusėje yra
 * viskas, ko reikia pažymai: 0.1 markė, 0.2 tipas/variantas/versija ir 0.2.1
 * modelis (~0,07–0,10); 0.10 VIN, 0.11 pagaminimo data ir tipo patvirtinimo
 * Nr. su data (~0,345–0,39); 40 spalva (~0,94). Išmatuota su tikrais X-Trail,
 * Leaf ir Micra lapais; paraštė palieka vietos šiek tiek paslinktam skenui.
 * Neradus VIN, skaitoma didesnė lapo dalis.
 */
const VIN_BANDS = [[0.035, 0.135], [0.315, 0.405], [0.905, 0.97]];

/** Ilgiausias vieno lapo skaitymas (su visais bandymais). */
const PAGE_TIMEOUT = 20 * 60_000;
const PAGE_TIMEOUT_TEXT = "lapas skaitomas per ilgai";

/** Kiek reikiamų laukų rasta. */
const found = (data) => NEEDED.filter((key) => data[key]).length;

/**
 * Perskaito vieną lapą: pirmiausia tik viršutinę dalį, o jei VIN ar modelio
 * ten nėra – visą lapą (prireikus ir didesne raiška).
 */
async function readPage(file, onStatus, job = {}) {
  const stop = () => { if (job.cancelled) throw new Error("atšaukta"); };
  // Pirmiausia – tik dvi siauros juostos, kuriose Nissan CoC visada yra markė,
  // modelis ir VIN. Tai ~4 kartus greičiau nei skaityti didelę lapo dalį.
  const banded = await readCertificate(file, onStatus, { required: NEEDED, bands: VIN_BANDS, retry: false });
  if (banded.vin || !banded.ocr_used) return banded;
  stop();
  const quick = await readCertificate(file, onStatus, { required: NEEDED, top: QUICK_TOP, retry: false });
  // VIN – svarbiausia. Jį radus lapas laikomas perskaitytu: modelis, jei jo nėra,
  // įrašomas ranka (iš failo pavadinimo neimamas – partijoje gali būti įvairių). Visas lapas (ir didesne
  // raiška) skaitomas tik tada, kai nerastas pats VIN – tai keli kartai ilgiau.
  if (quick.vin || !quick.ocr_used) return quick;
  stop();
  const full = await readCertificate(file, onStatus, { required: ["vin"] });
  const best = full.vin || found(full) >= found(quick) ? full : quick;
  if (found(best) > 0) return best;
  stop();
  // Nieko nerasta – gal lapas įdėtas į skenerį aukštyn kojom? Tada tik pranešame
  // (PDF lieka toks, koks nuskenuotas), bet VIN ir modelį vis tiek pasiūlome.
  const flipped = await readCertificate(file, onStatus, { required: NEEDED, top: QUICK_TOP, retry: false, rotation: 180 });
  return found(flipped) > 0 ? { ...flipped, upside_down: true } : best;
}

/** Atpažįsta laukiančius lapus po vieną. Tęsiama ir po puslapio perkrovimo. */
let activeLanes = 0;

/**
 * Paleidžia skaitymą. Galima kviesti bet kada – jei laukiančių lapų atsirado
 * daugiau, prijungiama papildoma „juosta“ (iki tiek, kiek leidžia kompiuteris).
 */
async function runQueue() {
  const lanes = await parallelism();
  session.lanes = lanes;
  while (activeLanes < lanes && records.some((record) => record.ocr === "laukia")) {
    activeLanes += 1;
    queueRunning = true;
    readLane().finally(laneFinished);
  }
}

function laneFinished() {
  activeLanes -= 1;
  if (activeLanes > 0) return;
  queueRunning = false;
  renderProgress();
  if (!session.done) return;
  const review = records.filter((record) => record.status === STATUS.REVIEW).length;
  if (review) toast(`Perskaityta. Patikrinkite ${review} lap. ir patvirtinkite.`);
  if (session.refreshed) {
    const still = records.filter((record) => record.status !== STATUS.REVIEW && pazymaMissing(record).length).length;
    toast(`Perskaityta iš naujo: ${session.refreshed}.${still ? ` Kai kurių laukų vis tiek trūksta (${still} CoC) – įrašykite ranka.` : " Visi pažymos duomenys yra."}`, still ? "warn" : "ok");
    session.refreshed = 0;
    render();
  }
  const flipped = records.filter((record) => record.status === STATUS.REVIEW && record.upside_down).length;
  if (flipped) toast(`${flipped} lap. nuskenuoti aukštyn kojom – jie pažymėti patikroje.`, "warn");
  session.done = 0;
  session.times = [];
}

/** Kiek lapų skaityti vienu metu (jei foninis procesas neveikia – po vieną). */
async function parallelism() {
  return await inBackground() ? ocrParallelism() : 1;
}

/** Viena skaitymo „juosta“: ima kitą laukiantį lapą, kol jų nebelieka. */
async function readLane() {
  for (;;) {
    const record = records.filter((item) => item.ocr === "laukia")
      .sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.page - b.page)[0];
    if (!record) return;
    // Pažymima iškart (dar prieš laukiant), kad kita juosta to paties lapo nepaimtų.
    record.ocr = "skaitoma";
    const started = performance.now();
    await update(record, { ocr: "skaitoma" });
    renderCard(record);
    renderProgress(record);
    try {
      const bytes = await getPdf(record.id);
      const file = new File([bytes], `${record.source_file} (${record.page} lapas).pdf`, { type: "application/pdf" });
      // Jei lapas skaitomas per ilgai, jis paliekamas įrašyti ranka – eilė nestovi.
      const job = {};
      let timer;
      const data = await Promise.race([
        readPage(file, () => {}, job),
        new Promise((_, reject) => {
          timer = setTimeout(() => { job.cancelled = true; reject(new Error(PAGE_TIMEOUT_TEXT)); }, PAGE_TIMEOUT);
        }),
      ]).finally(() => clearTimeout(timer));
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
      // Ką žmogus jau spėjo įrašyti pats, atpažinimas neperrašo – pildomi tik kiti laukeliai.
      const readValues = {
        vin: cleanVin(data.vin), ...splitMakeModel(data.make, data.commercial_name), tvv: data.type_variant_version,
      };
      // Modelio (ar markės) lape neperskaityta – Nissan VIN'e yra modelio kodas (J12 → QASHQAI).
      const fromVin = modelFromVin(readValues.vin);
      if (fromVin && !readValues.model) readValues.model = fromVin.model;
      if (fromVin && !readValues.make) readValues.make = fromVin.make;
      if (record.refresh) {
        // Jau patvirtintas CoC skaitomas iš naujo: pildomi tik tušti laukai –
        // tai, kas patvirtinta ar pataisyta ranka, lieka kaip buvo.
        const coc = { ...(record.coc || {}) };
        for (const [key, value] of Object.entries(changes.coc)) if (!String(coc[key] || "").trim() && value) coc[key] = value;
        const filled = { coc, ocr: "baigta", refresh: false };
        for (const [key, value] of Object.entries(readValues)) if (!String(record[key] || "").trim() && value) filled[key] = value;
        await update(record, filled);
        session.refreshed = (session.refreshed || 0) + 1;
      } else {
        for (const [key, value] of Object.entries(readValues)) {
          if (!typedByHand(record, key)) changes[key] = value;
        }
        await update(record, changes);
      }
    } catch (error) {
      const message = error.message || String(error);
      // Atsitiktinė klaida (pvz. nepavyko atidaryti PDF) – lapas grąžinamas į
      // eilės galą vieną kartą; tik antrą kartą nepavykus prašoma įrašyti ranka.
      const attempts = (record.ocr_attempts || 0) + 1;
      if (attempts < 2 && message !== PAGE_TIMEOUT_TEXT) {
        await update(record, { ocr: "laukia", ocr_attempts: attempts });
      } else {
        await update(record, record.refresh
          ? { ocr: "baigta", refresh: false, ocr_attempts: 0 }
          : { ocr: "klaida", ocr_error: message, ocr_attempts: attempts });
      }
    }
    session.done += 1;
    session.times.push(performance.now() - started);
    if (byId(record.id)) renderCard(record);
    renderCounts();
    renderConfirmClean();
    renderProgress();
  }
}

function renderProgress(record = null) {
  const box = $("progress");
  const reading = records.filter((item) => item.ocr === "skaitoma").length;
  const left = records.filter((item) => item.ocr === "laukia").length + reading;
  if (!left) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const total = session.done + left;
  const lanes = session.lanes || 1;
  $("progress-title").textContent = `Perskaityta ${session.done} iš ${total} lap.`;
  if (record) {
    $("progress-text").textContent = lanes > 1
      ? `Skaitoma po ${lanes} lapus vienu metu · ${record.source_file}`
      : `${record.source_file} · ${record.page} lapas`;
  }
  $("progress-bar").style.width = `${Math.max(4, (session.done / total) * 100)}%`;
  const recent = session.times.slice(-6);
  if (recent.length) {
    const perPage = recent.reduce((a, b) => a + b, 0) / recent.length / 1000 / lanes;
    const seconds = Math.round(perPage * left);
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
  const loading = (key) => (busy && !typedByHand(record, key) ? "loading" : "");
  const hintText = busy ? 'placeholder="Skaitoma… arba įrašykite patys"' : "";
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
      ${record.ocr === "klaida" ? `<div class="alert retry">Automatiškai perskaityti nepavyko (${esc(record.ocr_error)}).
        Įrašykite ranka arba <button type="button" class="btn sm" data-retry="${record.id}">${icon("undo")}Skaityti dar kartą</button></div>` : ""}
      ${snippet ? `<div class="snippet-box"><img src="${snippet}" alt="VIN vieta liudijime"></div>` : ""}
      <div class="vin">
        <label for="r-${record.id}-vin">VIN</label>
        <input type="text" class="mono ${loading("vin")}" id="r-${record.id}-vin" data-field="vin" value="${esc(record.vin)}" ${hintText}
               maxlength="24" autocomplete="off" spellcheck="false">
        <div class="hint ${kind}">${hintHtml(kind, hint)}</div>
      </div>
      <div>
        <label for="r-${record.id}-make">Markė</label>
        <input type="text" class="${loading("make")}" id="r-${record.id}-make" data-field="make" value="${esc(record.make)}" autocomplete="off">
      </div>
      <div>
        <label for="r-${record.id}-model">Modelis</label>
        <input type="text" class="${loading("model")}" id="r-${record.id}-model" data-field="model" value="${esc(record.model)}" autocomplete="off">
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
  if (!review.length) $("review").classList.remove("open");
  renderRail();
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

/** Neperskaitytus lapus grąžina į skaitymo eilę. */
/**
 * Patvirtintus CoC perskaito iš naujo (pvz. trūksta pažymos duomenų) –
 * užpildomi tik tušti laukai. Nepatvirtinti skaitomi iš naujo kaip įprasta.
 */
async function rereadRecords(ids) {
  const list = ids.map(byId).filter((record) => record && !["laukia", "skaitoma"].includes(record.ocr));
  if (!list.length) return;
  const review = list.filter((record) => record.status === STATUS.REVIEW).map((record) => record.id);
  for (const record of list) {
    if (record.status === STATUS.REVIEW) continue;
    await update(record, { ocr: "laukia", refresh: true, ocr_error: "", ocr_attempts: 0 });
  }
  if (review.length) await retryReading(review);
  else toast(list.length === 1 ? "CoC skaitomas iš naujo – užpildysiu trūkstamus laukus." : `Iš naujo skaitoma CoC: ${list.length}.`);
  renderStage();
  renderRereadCount();
  runQueue();
}

/** Kiek patvirtintų CoC trūksta pažymos duomenų (meniu mygtukui). */
function renderRereadCount() {
  const missing = records.filter((record) => record.status !== STATUS.REVIEW && pazymaMissing(record).length).length;
  $("reread-count").textContent = missing ? `trūksta ${missing} CoC` : "visko užtenka";
  $("reread-nav").classList.toggle("warn", missing > 0);
}

async function retryReading(ids) {
  for (const id of ids) {
    const record = byId(id);
    if (!record || record.status !== STATUS.REVIEW) continue;
    await update(record, { ocr: "laukia", ocr_error: "", ocr_attempts: 0 });
    renderCard(record);
  }
  renderConfirmClean();
  runQueue();
  toast(ids.length === 1 ? "Lapas skaitomas dar kartą." : `Dar kartą skaitoma lapų: ${ids.length}.`);
}

function renderConfirmClean() {
  const clean = records.filter(isClean).length;
  const failed = records.filter((record) => record.status === STATUS.REVIEW && record.ocr === "klaida");
  $("retry-failed").hidden = failed.length === 0;
  $("retry-failed").querySelector("span").textContent = `Skaityti neperskaitytus dar kartą (${failed.length})`;
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
  applyBinders();
  if (!quiet && record.binder) toast(`Dėkite į aplanką ${record.binder} (${folderOf(record)}) – jame ${binderFill(binderCount(record.binder), inSpecialFolder(record))}.`);
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
  // Lapas ištrintas sąmoningai – skenas dėl to nebelaikomas „nepilnai įkeltu“.
  if (record.pages > 1) await ignoreScan(scanKey(record));
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
  $("rail-review").textContent = n[STATUS.REVIEW] || "";
  renderLastScan();
}

// ---------------------------------------------------------------------------
// Sąrašas ir paieška
// ---------------------------------------------------------------------------

/** Vienos eilutės aprašas: VIN (su paryškinta rasta dalimi) ir modelis. */
function vinLabel(record, part) {
  const vin = record.vin || "";
  const at = part ? vin.lastIndexOf(part) : -1;
  const shown = at >= 0
    ? `${esc(vin.slice(0, at))}<mark>${esc(vin.slice(at, at + part.length))}</mark>${esc(vin.slice(at + part.length))}`
    : esc(vin);
  return `<b class="mono-vin">${shown}</b> ${esc([record.make, record.model].filter(Boolean).join(" "))}`;
}

function statusLine(record) {
  if (record.status === STATUS.OUT) {
    return `<span class="pill out">Atiduotas ${esc(showDate(record.given_date))}</span>${
      record.given_to ? ` <span class="muted-inline">${esc(record.given_to)}</span>` : ""}`;
  }
  return `<span class="pill ${record.status}">${esc(statusName(record.status))}</span>`;
}

function answerButtons(record) {
  const give = record.status === STATUS.IN
    ? `<button type="button" class="btn primary sm" data-give="${record.id}">${icon("send")}Atiduoti</button>` : "";
  return `${give}<button type="button" class="btn sm" data-detail="${record.id}">Atidaryti</button>`;
}

/** Keli VIN paieškos laukelyje (įklijuotas sąrašas) – tada tikrinami visi iš karto. */
const bulkVins = (query = $("q").value) => {
  const list = vinList(query);
  return list.length >= 2 ? list : null;
};
let bulkResult = [];
/** Kelių VIN sąraše pažymėti turimi CoC (atiduoti vienam žmogui). */
const bulkPicked = new Set();

const BULK_STATE = {
  in: ["turimas", "Turime"], out: ["out", "Atiduotas"], review: ["tikrinti", "Netikrintas"], none: ["none", "Neturime"],
};

/** Kelių VIN atsakymas: santrauka ir kiekvieno VIN eilutė. */
function renderBulkAnswer(vins) {
  bulkResult = bulkCheck(records, vins);
  const haveIds = bulkResult.filter((row) => row.state === "in").map((row) => row.hits[0].id);
  for (const id of [...bulkPicked]) if (!haveIds.includes(id)) bulkPicked.delete(id);
  const picked = bulkPicked.size;
  const count = (state) => bulkResult.filter((row) => row.state === state).length;
  const have = count("in"); const none = count("none");
  const rows = bulkResult.map((row) => {
    const record = row.hits[0];
    const [cls, label] = BULK_STATE[row.state];
    const name = record ? folderOf(record) : "";
    const extra = record && row.state === "out"
      ? `${esc(shortDate(record.given_date))}${record.given_to ? ` · ${esc(record.given_to)}` : ""}` : "";
    // Atiduotas CoC aplanke nebeguli – vietoje aplanko rodoma, kam atiduotas.
    const pick = row.state === "in"
      ? `<input type="checkbox" data-pick="${record.id}" ${bulkPicked.has(record.id) ? "checked" : ""} aria-label="Pažymėti ${esc(row.query)}">`
      : "";
    return `<li class="b-${row.state} ${record && bulkPicked.has(record.id) ? "picked" : ""}">
      <span class="b-pick">${pick}</span>
      <span class="b-vin">${esc(row.query)}${row.hits.length > 1 ? ` <small>(${row.hits.length} CoC)</small>` : ""}</span>
      <span class="b-state"><i class="dot ${cls}"></i>${label}${extra ? `<small>${extra}</small>` : ""}</span>
      <span class="b-model">${record ? esc(displayModel(record)) : "—"}</span>
      <span class="b-folder">${record && row.state !== "out" ? `${icon("folder")}${esc(binderOfRecord(record) || name)}` : ""}</span>
      <span class="b-act">${record ? `
        <button type="button" class="icon-btn sm" data-detail="${record.id}" title="Atidaryti" aria-label="Atidaryti">${icon("eye")}</button>
        ${record.status === STATUS.IN ? `<button type="button" class="icon-btn sm give" data-give="${record.id}" title="Atiduoti" aria-label="Atiduoti">${icon("send")}</button>`
          : record.status === STATUS.OUT ? `<button type="button" class="icon-btn sm" data-return="${record.id}" title="Grąžinti į turimus" aria-label="Grąžinti">${icon("undo")}</button>` : ""}` : ""}</span>
    </li>`;
  }).join("");
  return `<div class="answer bulk-answer ${none ? "warn" : "ok"}">
    <div class="bulk-head">
      <b>Patikrinta ${bulkResult.length} VIN: turime ${have}${count("out") ? ` · atiduota ${count("out")}` : ""}${count("review") ? ` · netikrinta ${count("review")}` : ""} · neturime ${none}</b>
      <span class="bulk-actions">
        ${have ? `<label class="pick-all"><input type="checkbox" data-bulk="pick-all" ${picked === have ? "checked" : ""}>Visi turimi</label>
          <button type="button" class="btn primary sm" data-bulk="give" ${picked ? "" : "disabled"}>${icon("send")}Atiduoti pažymėtus${picked ? ` (${picked})` : ""}</button>
          <button type="button" class="btn sm" data-bulk="binder" ${picked ? "" : "disabled"}>${icon("folder")}Į aplanką</button>
          <button type="button" class="btn sm" data-bulk="select">${icon("check")}Pažymėti sąraše</button>
          <button type="button" class="btn sm" data-bulk="pazyma">${icon("doc")}Pažymos turimiems</button>` : ""}
        ${none ? `<button type="button" class="btn sm" data-bulk="copy">${icon("file")}Kopijuoti neturimus</button>` : ""}
        <button type="button" class="icon-btn sm" data-bulk="clear" aria-label="Išvalyti">${icon("x")}</button>
      </span>
    </div>
    <ul class="bulk-list">${rows}</ul>
  </div>`;
}

/** Aiškus atsakymas į klausimą „ar turime šitą CoC?“ (pakanka 4 paskutinių VIN ženklų). */
function renderAnswer(query) {
  const box = $("answer");
  const many = bulkVins(query);
  if (many) {
    const html = renderBulkAnswer(many);
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    return;
  }
  bulkResult = [];
  const part = cleanVin(query);
  const hits = vinHits(records, query);
  let html = "";
  if (!hits.length) {
    if (!/\s/.test(query.trim()) && part.length >= 4 && /\d/.test(part)) {
      html = `<div class="answer no"><span class="mark">${icon("x")}</span>
        <div><b>Neturime.</b> <span>CoC su VIN, kuriame yra „${esc(part)}“, sąraše nėra.</span></div></div>`;
    }
  } else if (hits.length === 1) {
    const [one] = hits;
    const kind = one.status === STATUS.IN ? "ok" : "warn";
    const title = one.status === STATUS.IN ? "Turime."
      : one.status === STATUS.REVIEW ? "Yra, bet dar nepatikrintas."
        : `Atiduotas ${esc(showDate(one.given_date))}${one.given_to ? ` – ${esc(one.given_to)}` : ""}.`;
    html = `<div class="answer ${kind}"><span class="mark">${icon(one.status === STATUS.IN ? "check" : one.status === STATUS.OUT ? "send" : "scan")}</span>
      <div><b>${title}</b> <span>${vinLabel(one, part)}</span>
        ${one.status === STATUS.OUT ? "" : `<span class="where">${icon("folder")} Aplanke ${binderOfRecord(one) ? `<b class="code">${esc(binderOfRecord(one))}</b> ` : ""}<b>${esc(folderOf(one))}</b></span>`}</div>
      <div class="actions">${answerButtons(one)}</div></div>`;
  } else {
    // Keli CoC su tokia VIN pabaiga – parodomi visi, kad išsirinktumėte.
    const have = hits.filter((record) => record.status === STATUS.IN).length;
    const order = { [STATUS.IN]: 0, [STATUS.REVIEW]: 1, [STATUS.OUT]: 2 };
    const sorted = [...hits].sort((a, b) => order[a.status] - order[b.status] || a.vin.localeCompare(b.vin));
    const shown = sorted.slice(0, 12);
    html = `<div class="answer ${have ? "ok" : "warn"} many"><span class="mark">${icon(have ? "check" : "list")}</span>
      <div class="options">
        <b>Rasta ${hits.length} CoC su „${esc(part)}“${have ? ` (turime ${have})` : ""} – kurio ieškote?</b>
        <ul>${shown.map((record) => `
          <li><span class="opt-main">${vinLabel(record, part)}</span>
            <span class="opt-where">${record.status === STATUS.OUT ? "" : folderChip(record)}</span>
            <span class="opt-status">${statusLine(record)}</span>
            <span class="opt-actions">${answerButtons(record)}</span></li>`).join("")}</ul>
        ${hits.length > shown.length ? `<span class="where">Ir dar ${hits.length - shown.length} – įveskite daugiau VIN ženklų.</span>` : ""}
      </div></div>`;
  }
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

/**
 * Kiekvienam turimam CoC – aplankas (po 20). Naujiems parenkamas pirmas tos
 * grupės aplankas su laisva vieta; atiduoti vietą atlaisvina. Pakeisti įrašai
 * išsaugomi. Grąžina pakeistų įrašų sąrašą [{ record, from, to }].
 */
function applyBinders(reorganize = false) {
  const first = !binders.length;
  const plan = planBinders(records, binders, { codes: folderCodes, reorganize });
  const moved = [];
  for (const record of records) {
    const to = plan.assign[record.id] ?? "";
    const from = record.binder || "";
    if (from === to) continue;
    // Iš kur perkelti: ankstesnis aplankas, o pirmą kartą – senas grupės aplankas.
    const was = from || folderCodes[folderOf(record)] || "";
    record.binder = to;
    record.updated = now();
    saveRecord(record).catch(() => {});
    if (to && was !== to) moved.push({ record, from: was, to });
  }
  const changedBinders = JSON.stringify(plan.binders) !== JSON.stringify(binders);
  if (changedBinders) {
    binders = plan.binders;
    setMeta("binders", binders).catch(() => {});
  }
  if (moved.length || changedBinders) scheduleSync();
  // Pirmą kartą suskirsčius – priminimas atsispausdinti perkėlimo sąrašą ir lipdukus.
  if (first && binders.length) setMeta("bindersNotice", true).then(() => { bindersNotice = true; renderIncomplete(); }).catch(() => {});
  return moved;
}
let bindersNotice = false;

/** Aplanko kodas: CoC aplankas arba (senas) grupės kodas. */
const codeOf = (name) => binders.find((binder) => binder.group === name)?.code || folderCodes[name] || "";
const binderOfRecord = (record) => record.binder || "";
const binderCount = (code) => records.filter((record) => record.status === STATUS.IN && record.binder === code).length;
/** „12/20“ modelio aplankui, „12 CoC“ – specialiam (jis neribojamas). */
const binderFill = (count, special) => (special ? `${count} CoC` : `${count}/${BINDER_SIZE}`);

/** Aplanko žymė: kodas + pavadinimas. */
function folderChip(record) {
  const name = folderOf(record);
  const code = binderOfRecord(record) || codeOf(name);
  return `<span class="folder ${inSpecialFolder(record) ? "special" : ""}">${code ? `<b class="code">${esc(code)}</b>` : icon("folder")}${esc(name)}</span>`;
}

/** Spalvos taškas ir pavadinimas. */
function colourTag(record) {
  const paint = paintOf(record);
  const name = (record.coc || {}).colour;
  if (!name) return "";
  return `<span class="colour-tag"><i style="${paint ? `--paint:${cssColour(paint)}` : ""}"></i>${esc(name)}</span>`;
}

const MONTHS = ["saus.", "vas.", "kov.", "bal.", "geg.", "birž.", "liep.", "rugp.", "rugs.", "spal.", "lapkr.", "gruod."];

/** „2026-10-13“ → „13 spal.“ (kitais metais – su metais). */
function shortDate(iso) {
  const day = localDay(iso);
  const match = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return showDate(iso);
  const text = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
  return match[1] === todayIso().slice(0, 4) ? text : `${text} ${match[1]}`;
}

/** Modelio pavadinimas sąrašui: „Qashqai“, „X-Trail“. */
function displayModel(record) {
  const car = CARS[carKeyOf(record)];
  if (car) return car.name;
  const model = String(record.model || "").trim();
  return model ? model.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (ch) => ch.toUpperCase()) : "—";
}

/** Mažas automobilio paveikslėlis eilutėje (nuspalvinamas po atvaizdavimo). */
/** Jau nuspalvintos miniatiūros – kad perpiešiant sąrašą jos atsirastų iš karto. */
const thumbUrls = new Map();
const thumbKey = (record) => `${carKeyOf(record) || ""}|${(record.coc || {}).colour || ""}|${(paintOf(record)?.rgb || []).join(",")}`;

function thumbHtml(record) {
  const key = carKeyOf(record);
  const ready = thumbUrls.get(thumbKey(record));
  if (ready) return `<span class="car-thumb"><img alt="" src="${ready}" decoding="async"></span>`;
  return `<span class="car-thumb" data-car="${key || ""}" data-id="${record.id}"><img alt="" hidden></span>`;
}

function hydrateThumbs(root = document) {
  root.querySelectorAll(".car-thumb[data-id]").forEach((box) => {
    const record = byId(box.dataset.id);
    const image = box.querySelector("img");
    if (!record || image.dataset.ready === box.dataset.id) return;
    image.dataset.ready = box.dataset.id;
    carImage(box.dataset.car, paintOf(record), 240, (record.coc || {}).colour).then((url) => {
      if (url) thumbUrls.set(thumbKey(record), url);
      if (!url || image.dataset.ready !== box.dataset.id) return;
      image.src = url;
      image.hidden = false;
    }).catch(() => {});
  });
}

function vinCell(vin) {
  if (!vin) return `<span class="muted">VIN nėra</span>`;
  return `${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b>`;
}

function inFolderFilter(record) {
  if (!folderFilter) return true;
  if (folderFilter === MODEL_FOLDERS) return !inSpecialFolder(record);
  if (folderFilter.startsWith(BINDER_PREFIX)) return record.binder === folderFilter.slice(BINDER_PREFIX.length);
  return folderOf(record) === folderFilter;
}

function visibleRecords() {
  const query = $("q").value;
  if (bulkVins(query)) {
    const ids = new Set(bulkCheck(records, bulkVins(query)).flatMap((row) => row.hits.map((record) => record.id)));
    return records.filter((record) => ids.has(record.id)).sort(newestFirst);
  }
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
    const generation = generationOf(record);
    const paint = paintOf(record);
    const vin = record.vin || "";
    const status = record.status === STATUS.OUT
      ? `<i class="dot out"></i><span>Atiduotas<small>${esc(shortDate(record.given_date))}</small></span>`
      : `<i class="dot ${record.status}"></i><span>${esc(statusName(record.status))}</span>`;
    const name = folderOf(record);
    return `<div data-row="${record.id}" class="lrow ${selected.has(record.id) ? "selected" : ""} ${record.id === stageId ? "staged" : ""} ${animateRows && index < 30 ? "enter" : ""}" style="--i:${index}">
      <label class="doc-check" title="Pažymėti"><input type="checkbox" data-select="${record.id}" ${selected.has(record.id) ? "checked" : ""}
          aria-label="Pažymėti ${esc(vin)}"><svg><use href="#i-pdf"/></svg></label>
      ${thumbHtml(record)}
      <div class="lrow-main">
        <b>${esc(displayModel(record))}${generation ? ` <em class="gen">${esc(generation)}</em>` : ""}${paint ? ` <i class="paint-dot" style="--paint:${cssColour(paint)}" title="${esc(record.coc.colour)}"></i>` : ""}</b>
        <span class="lrow-vin">${vin ? `${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b>` : "VIN nėra"}</span>
      </div>
      ${record.status === STATUS.OUT
        ? `<div class="lrow-folder given" title="${esc(record.given_to || "")}">${icon("send")}<span>${esc(record.given_to || "—")}</span></div>`
        : `<div class="lrow-folder" title="${esc(name)}">${icon("folder")}<span>${esc(binderOfRecord(record) || name)}${
        inSpecialFolder(record) && binderOfRecord(record) ? `<small>${esc(name)}</small>` : ""}</span></div>`}
      <div class="lrow-status">${status}</div>
      <button type="button" class="kebab" data-menu="${record.id}" aria-label="Veiksmai">${icon("dots")}</button>
    </div>`;
  });
  animateRows = false;
  $("rows").innerHTML = rows.join("") || `<div class="empty-row">${
    query ? "Nieko nerasta." : records.length ? "Šiame sąraše tuščia." : ""
  }</div>`;

  const more = list.length - shown;
  $("list-note").innerHTML = more > 0
    ? `Rodoma ${shown} iš ${list.length}. <button type="button" class="btn sm" data-action="more" id="more-btn">Rodyti daugiau</button>`
    : query ? `Rasta: ${list.length} · ieškoma visuose sąrašuose ir aplankuose` : "";

  const visibleIds = list.slice(0, shown).map((record) => record.id);
  $("check-all").checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  renderBulk();
  hydrateThumbs($("rows"));
  fitRows();
  const moreButton = $("more-btn");
  if (moreButton) moreObserver.observe(moreButton);
  // Skydelyje – pasirinktas CoC; jei jo sąraše nebėra, pirmas sąrašo.
  if (!stageId || !list.some((record) => record.id === stageId)) setStage(list[0]?.id || null, false);
  else renderStage();
}

// ---------------------------------------------------------------------------
// Automobilio skydelis
// ---------------------------------------------------------------------------

const PAZYMA_NEEDS = [
  ["make", "markės", (r) => r.make], ["tvv", "tipo", (r) => r.tvv], ["model", "modelio", (r) => r.model],
  ["vin", "VIN", (r) => r.vin], ["approval_number", "patvirtinimo Nr.", (r) => (r.coc || {}).approval_number],
  ["approval_date", "patvirtinimo datos", (r) => (r.coc || {}).approval_date], ["colour", "spalvos", (r) => (r.coc || {}).colour],
];

const PAZYMA_LABELS = {
  make: ["Markė", ""], tvv: ["Tipas / Variantas / Versija", "pvz. T33/B/B20"], model: ["Modelis", ""], vin: ["VIN", ""],
  approval_number: ["Tipo patvirtinimo Nr.", "e13*2018/858*00293*07"], approval_date: ["Patvirtinimo data", "DD.MM.MMMM"],
  colour: ["Spalva", "pvz. PILKA arba ŽALIA/JUODA"],
};
const COC_KEYS = new Set(["approval_number", "approval_date", "colour"]);
const missingKeys = (record) => PAZYMA_NEEDS.filter(([, , get]) => !String(get(record) || "").trim()).map(([key]) => key);
const missingRecords = () => records.filter((record) => record.status !== STATUS.REVIEW && missingKeys(record).length);

/** Langas su CoC, kuriems trūksta pažymos duomenų – juos galima įrašyti ranka. */
function openMissing() {
  const list = missingRecords();
  $("sidebar").classList.remove("open");
  if (!list.length) { toast("Visų CoC pažymos duomenys jau yra."); return; }
  $("missing-count").textContent = `${list.length} CoC`;
  $("missing-list").innerHTML = list.map((record) => {
    const keys = missingKeys(record);
    const busy = ["laukia", "skaitoma"].includes(record.ocr);
    return `<div class="mrow" data-id="${record.id}">
      <div class="mrow-head">
        ${thumbHtml(record)}
        <div class="mrow-name"><b>${esc(displayModel(record))}</b><span class="mono-vin">${esc(record.vin || "VIN nėra")}</span>
          <small>${esc(record.source_file || "")}${record.page ? ` · ${record.page} lapas` : ""}${busy ? " · skaitoma…" : ""}</small></div>
        <button type="button" class="btn sm" data-missing-pdf="${record.id}">${icon("eye")}PDF</button>
      </div>
      <div class="mrow-fields">${keys.map((key) => `
        <label>${esc(PAZYMA_LABELS[key][0])}
          <input type="text" class="${key === "colour" ? "" : "mono"}" data-mkey="${key}" placeholder="${esc(PAZYMA_LABELS[key][1])}"
            ${key === "colour" ? 'list="lt-colours"' : ""} autocomplete="off" spellcheck="false"></label>`).join("")}</div>
    </div>`;
  }).join("");
  hydrateThumbs($("missing-list"));
  if (!$("missing").open) $("missing").showModal();
}

async function saveMissing() {
  let saved = 0;
  for (const row of $("missing-list").querySelectorAll(".mrow")) {
    const record = byId(row.dataset.id);
    if (!record) continue;
    const changes = {};
    const coc = { ...(record.coc || {}) };
    const typed = { ...(record.typed || {}) };
    let any = false;
    for (const input of row.querySelectorAll("[data-mkey]")) {
      let value = input.value.trim();
      if (!value) continue;
      const key = input.dataset.mkey;
      if (key === "vin") value = cleanVin(value);
      if (key === "colour" || key === "make" || key === "model") value = value.toUpperCase();
      if (COC_KEYS.has(key)) coc[key] = value; else changes[key] = value;
      typed[key] = true;
      any = true;
    }
    if (!any) continue;
    await update(record, { ...changes, coc, typed });
    saved += 1;
  }
  render();
  toast(saved ? `Išsaugota: ${saved} CoC.` : "Nieko neįrašyta.", saved ? "ok" : "warn");
  return saved;
}

/** Ko trūksta pažymai (tušti laukai). */
const pazymaMissing = (record) => PAZYMA_NEEDS.filter(([, , get]) => !String(get(record) || "").trim()).map(([, name]) => name);

/** Ar skydelis matomas šalia sąrašo (plačiame ekrane). */
const stageBeside = () => window.matchMedia("(min-width: 1100px)").matches;

function setStage(id, animate = true) {
  const changed = id !== stageId;
  stageId = id;
  document.querySelectorAll("#rows .staged").forEach((row) => row.classList.toggle("staged", row.dataset.row === id));
  if (id) document.querySelector(`#rows [data-row="${CSS.escape(id)}"]`)?.classList.add("staged");
  renderStage(changed && animate);
}

let stageShown = "";

function renderStage(animate = false) {
  const record = byId(stageId);
  const stage = $("stage");
  stage.classList.toggle("empty", !record);
  if (!record) {
    $("stage-model").textContent = records.length ? "Pasirinkite CoC" : "Sandėlis tuščias";
    $("stage-sub").innerHTML = records.length ? "" : "Įkelkite nuskenuotą PDF dešinėje";
    $("stage-vin").textContent = "—";
    for (const id of ["stage-facts", "stage-actions", "stage-ready"]) $(id).innerHTML = "";
    $("stage-img").hidden = true;
    stageShown = "";
    return;
  }
  const key = carKeyOf(record);
  const car = CARS[key];
  const paint = paintOf(record);
  const generation = generationOf(record);
  const year = yearOf(record);
  const coc = record.coc || {};
  $("stage-model").textContent = [record.make || "NISSAN", record.model || car?.name || ""].filter(Boolean).join(" ");
  $("stage-sub").innerHTML = [esc(generation), year, coc.colour ? colourTag(record) : ""].filter(Boolean).join(" · ");
  stage.style.setProperty("--paint", paint ? cssColour(paint) : "rgb(120 124 130)");
  $("stage-vin").textContent = record.vin || "—";

  const name = folderOf(record);
  const status = record.status === STATUS.OUT
    ? `Atiduotas <i class="dot out"></i>` : `${esc(statusName(record.status))} <i class="dot ${record.status}"></i>`;
  $("stage-facts").innerHTML = `
    <div>${icon("file")}<dt>CoC</dt><dd>${status}</dd></div>
    ${record.status === STATUS.OUT
      ? `<div title="${esc(record.given_to || "")}">${icon("send")}<dt>Kam atiduota</dt><dd>${esc(record.given_to || "—")}</dd></div>`
      : `<div title="${esc(name)}">${icon("folder")}<dt>Aplankas</dt><dd>${esc(binderOfRecord(record) || name)}${
        binderOfRecord(record) ? ` <small class="muted-inline">${binderFill(binderCount(record.binder), inSpecialFolder(record))}</small>` : ""}</dd></div>`}
    <div>${icon("calendar")}<dt>${record.status === STATUS.OUT ? "Atiduota" : "Įkelta"}</dt><dd>${esc(shortDate(record.status === STATUS.OUT ? record.given_date : record.added))}</dd></div>`;
  const missing = pazymaMissing(record);
  const busy = ["laukia", "skaitoma"].includes(record.ocr);
  $("stage-ready").className = `stage-ready ${busy ? "busy" : missing.length ? "warn" : "ok"}`;
  $("stage-ready").innerHTML = busy
    ? `<span class="spinner"></span><span>Skaitoma iš naujo…</span>`
    : missing.length
    ? `${icon("doc")}<span>Pažymai trūksta: ${esc(missing.join(", "))}</span>
       <button type="button" class="link-inline" data-stage="reread">${icon("undo")}Perskaityti iš naujo</button>
       <button type="button" class="link-inline" data-stage="detail-fill">${icon("doc")}Įrašyti ranka</button>`
    : `${icon("check")}<span>Pažymos duomenys perskaityti${coc.approval_number ? ` · ${esc(coc.approval_number)}` : ""}</span>`;
  $("stage-actions").innerHTML = `
    <button type="button" class="skew-btn" data-stage="pdf"><span>${icon("eye")}Peržiūrėti dokumentą</span></button>
    <button type="button" class="skew-btn" data-stage="pazyma"><span>${icon("doc")}Pažyma</span></button>
    ${record.status === STATUS.IN ? `<button type="button" class="skew-btn red" data-stage="give"><span>${icon("send")}Atiduoti</span></button>`
      : record.status === STATUS.OUT ? `<button type="button" class="skew-btn" data-stage="return"><span>${icon("undo")}Grąžinti</span></button>` : ""}`;

  const shownKey = `${key}|${(record.coc || {}).colour || ""}|${paint ? paint.rgb.join(",") : "-"}`;
  const image = $("stage-img");
  const size = imageSize(key);
  if (shownKey === stageShown && !animate) return;
  const sameCar = shownKey === stageShown;
  stageShown = shownKey;
  carImage(key, paint, 960, (record.coc || {}).colour).then((url) => {
    if (!url || stageShown !== shownKey) return;
    image.src = url;
    image.hidden = false;
    $("stage-car").style.setProperty("--car", `url("${url}")`);
    $("stage-car").style.setProperty("--ratio", `${size.w} / ${size.h}`);
    if (animate && !sameCar && !reduceMotion()) {
      $("stage-car").classList.remove("enter");
      void $("stage-car").offsetWidth;
      $("stage-car").classList.add("enter");
    }
  }).catch(() => { image.hidden = true; });
}

// ---------------------------------------------------------------------------
// Apatinė juosta, patikros langas, kairysis meniu, eilutės meniu
// ---------------------------------------------------------------------------

const plural = (n, one, few, many) => {
  const tens = n % 100; const last = n % 10;
  if (last === 1 && tens !== 11) return one;
  if (last >= 2 && last <= 9 && (tens < 10 || tens > 20)) return few;
  return many;
};

/** „Paskutinis skenas · 12 dokumentų · ● 2 patikrinti“. */
function renderLastScan() {
  const pill = $("last-scan");
  if (!records.length) { pill.hidden = true; return; }
  const latest = records.reduce((best, record) => (String(record.added) > String(best.added) ? record : best), records[0]);
  const pages = scanOf(latest).length;
  const review = records.filter((record) => record.status === STATUS.REVIEW).length;
  pill.hidden = false;
  pill.classList.toggle("todo", review > 0);
  pill.innerHTML = `${icon("file")}<span class="nav-two">Paskutinis skenas
    <small>${pages} ${plural(pages, "dokumentas", "dokumentai", "dokumentų")} · <i class="dot ${review ? "tikrinti" : "turimas"}"></i>
    <span class="${review ? "todo-text" : ""}">${review ? `${review} patikrinti` : "viskas patikrinta"}</span></small></span>`;
}

function openReview() {
  if (!reviewList().length) { toast("Patikrinti nėra ko – viskas patvirtinta."); return; }
  $("review").classList.add("open");
  renderRail();
  requestAnimationFrame(() => $("review-list").querySelector("input[data-field]")?.focus({ preventScroll: true }));
}

function closeReview() {
  $("review").classList.remove("open");
  renderRail();
}

function renderRail() {
  const reviewing = $("review").classList.contains("open");
  const current = reviewing ? "scan" : tab === STATUS.OUT ? "history" : "library";
  document.querySelectorAll(".rail-item").forEach((item) => item.classList.toggle("on", item.dataset.rail === current));
}

let menuId = null;

function openRowMenu(id, anchor) {
  const record = byId(id);
  const menu = $("row-menu");
  if (!record) return;
  if (menuId === id && !menu.hidden) { closeRowMenu(); return; }
  menuId = id;
  const item = (action, iconName, label, extra = "") => `<button type="button" data-menu-action="${action}" class="${extra}">${icon(iconName)}${label}</button>`;
  menu.innerHTML = [
    item("detail", "file", "Atidaryti"),
    item("pdf", "eye", "Peržiūrėti dokumentą"),
    item("pazyma", "doc", "Pažyma"),
    item("download", "download", "Atsisiųsti PDF"),
    record.status === STATUS.IN ? item("binder", "folder", "Perkelti į kitą aplanką") : "",
    item("reread", "undo", "Perskaityti iš naujo"),
    record.status === STATUS.IN ? item("give", "send", "Atiduoti", "red") : "",
    record.status === STATUS.OUT ? item("return", "undo", "Grąžinti į turimus") : "",
  ].join("");
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const top = box.bottom + height + 8 > window.innerHeight ? box.top - height - 6 : box.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
}

function closeRowMenu() {
  $("row-menu").hidden = true;
  menuId = null;
}

function rowAction(action, id) {
  if (action === "detail") openDetail(id);
  if (action === "pdf") openPdf(id);
  if (action === "pazyma") makePazymos([id]);
  if (action === "download") downloadPdfs([id]);
  if (action === "reread") rereadRecords([id]);
  if (action === "give") openGive([id]);
  if (action === "return") returnRecords([id]);
  if (action === "binder") openBinderDialog([id]);
}

// ---------------------------------------------------------------------------
// Rankinis dėjimas į aplanką
// ---------------------------------------------------------------------------

let binderIds = [];

const nextBinderCode = () => {
  const numbers = [...binders.map((binder) => binder.code), ...Object.values(folderCodes)]
    .map((code) => Number((/^A-(\d+)$/.exec(code) || [])[1] || 0));
  return `A-${String(Math.max(0, ...numbers) + 1).padStart(2, "0")}`;
};

/** Pasirinktus CoC perkelia į pasirinktą (ar naują) to paties modelio aplanką. */
function openBinderDialog(ids) {
  const list = ids.map(byId).filter((record) => record && record.status === STATUS.IN);
  if (!list.length) { toast("Į aplanką dedami tik turimi CoC.", "warn"); return; }
  const groups = [...new Set(list.map(folderOf))];
  if (groups.length > 1) { toast(`Pažymėti skirtingi modeliai (${groups.join(", ")}) – viename aplanke modeliai nemaišomi.`, "warn"); return; }
  const [group] = groups;
  binderIds = list.map((record) => record.id);
  const special = list.some(inSpecialFolder);
  const own = binderContents(records, binders).filter((binder) => binder.group === group);
  const current = new Set(list.map((record) => record.binder));
  $("binder-count").textContent = list.length === 1 ? (list[0].vin || "").slice(-6) : `${list.length} CoC`;
  $("binder-text").textContent = `${group}: pasirinkite aplanką. ${special ? "Specialus aplankas – vietų nevaržo." : `Viename aplanke telpa ${BINDER_SIZE}; kas netilps, bus perkelta į kitą to modelio aplanką.`}`;
  $("binder-choices").innerHTML = own.map((binder) => {
    const moving = binderIds.filter((id) => byId(id).binder !== binder.code).length;
    const after = binder.records.length + moving;
    const over = !special && after > BINDER_SIZE;
    return `<label class="choice ${over ? "over" : ""}"><input type="radio" name="binder" value="${esc(binder.code)}" ${current.size === 1 && current.has(binder.code) ? "checked" : ""}>
      <b class="code">${esc(binder.code)}</b>${esc(binder.group)}<small>${binderFill(binder.records.length, special)}${moving && binder.records.length !== after ? ` → ${binderFill(after, special)}` : ""}${over ? " – netilps" : ""}</small></label>`;
  }).join("") || `<p class="muted">Šio modelio aplankų dar nėra – įrašykite naujo kodą.</p>`;
  $("binder-new").value = "";
  $("binder-new").placeholder = `pvz. ${nextBinderCode()}`;
  $("sidebar").classList.remove("open");
  $("binder-dialog").showModal();
}

async function moveToBinder(code) {
  const list = binderIds.map(byId).filter(Boolean);
  if (!list.length || !code) return false;
  const group = folderOf(list[0]);
  const existing = binders.find((binder) => binder.code === code);
  if (existing && existing.group !== group) {
    const used = records.some((record) => record.status === STATUS.IN && record.binder === code);
    if (used) { toast(`Aplankas ${code} skirtas „${existing.group}“ – kitų modelių nemaišome.`, "err"); return false; }
    existing.group = group; // tuščias aplankas gali būti panaudotas kitam modeliui
  }
  if (!existing) binders.push({ code, group });
  await setMeta("binders", binders);
  for (const record of list) {
    if (record.binder !== code) await update(record, { binder: code });
  }
  applyBinders();
  render();
  const overflow = list.filter((record) => record.binder !== code).length;
  toast(overflow
    ? `Į ${code} perkelta ${list.length - overflow}; ${overflow} netilpo ir liko kitame ${group} aplanke.`
    : `Perkelta į ${code}: ${list.length} CoC.`, overflow ? "warn" : "ok");
  return true;
}

/**
 * Sąrašo aukštis – sveikas eilučių skaičius: apačioje nelieka perpjautos eilutės.
 * (Tik kompiuteryje, kur slenka pats sąrašas.)
 */
function fitRows() {
  const wrap = document.querySelector(".rows-wrap");
  const library = $("list");
  if (!window.matchMedia("(min-width: 1100px)").matches) { wrap.style.height = ""; return; }
  const row = $("rows").querySelector(".lrow");
  wrap.style.height = "0px";
  const free = library.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top - 4;
  if (!row) { wrap.style.height = `${Math.max(0, free)}px`; return; }
  const height = row.getBoundingClientRect().height;
  const count = Math.max(1, Math.floor(free / height));
  wrap.style.height = `${count * height}px`;
}

// Kai pasikeičia laisva vieta (paieškos atsakymas, filtrai, lango dydis) – perskaičiuojama.
new ResizeObserver(() => requestAnimationFrame(fitRows)).observe($("list"));

/** Priartėjus prie sąrašo galo, automatiškai rodoma daugiau eilučių. */
const moreObserver = new IntersectionObserver((entries) => {
  if (!entries.some((entry) => entry.isIntersecting)) return;
  moreObserver.disconnect();
  shown += PAGE;
  renderTable();
}, { root: document.querySelector(".rows-wrap"), rootMargin: "300px" });

function renderBulk() {
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  $("bulk").classList.toggle("on", selected.size > 0);
  if (selected.size) $("bulk-count").textContent = `Pažymėta: ${selected.size}`;
}

function renderFolders() {
  const special = allFolders();
  const specialNames = new Set(special.map((folder) => folder.name));
  const names = folderNames(records, savedFolders);
  const models = names.filter((name) => !specialNames.has(name));
  const inStock = (name) => records.filter((record) => record.status === STATUS.IN && folderOf(record) === name).length;
  const view = binderContents(records, binders);
  if (folderFilter.startsWith(BINDER_PREFIX) && !binders.some((binder) => BINDER_PREFIX + binder.code === folderFilter)) folderFilter = "";
  if (folderFilter && !folderFilter.startsWith("\u0000") && !names.includes(folderFilter)) folderFilter = "";
  const groupOption = (name) => {
    const codes = view.filter((binder) => binder.group === name).map((binder) => binder.code);
    return `<option value="${esc(name)}">${esc(name)} (${inStock(name)})${codes.length ? ` · ${esc(codes.join(", "))}` : ""}</option>`;
  };
  $("folder-filter").innerHTML = [
    `<option value="">Visi aplankai</option>`,
    `<option value="${MODEL_FOLDERS}">Tik modelių aplankai</option>`,
    models.length ? `<optgroup label="Modeliai">${models.map(groupOption).join("")}</optgroup>` : "",
    special.length ? `<optgroup label="Specialūs aplankai">${special.map((folder) => groupOption(folder.name)).join("")}</optgroup>` : "",
    view.length ? `<optgroup label="Aplankai po ${BINDER_SIZE}">${view.map((binder) => `<option value="${BINDER_PREFIX}${esc(binder.code)}">${esc(binder.code)} · ${esc(binder.group)}${binder.of > 1 ? ` ${binder.index}/${binder.of}` : ""} (${binderFill(binder.records.length, binder.special)})</option>`).join("")}</optgroup>` : "",
  ].join("");
  $("folder-filter").value = folderFilter;
  renderPrintButton();
  $("folder-filter").closest(".folder-filter").classList.toggle("on", Boolean(folderFilter));
  $("filters-btn").classList.toggle("on", Boolean(folderFilter) || !$("filter-row").hidden);
  $("folders-title").textContent = `Aplankai (po ${BINDER_SIZE})`;
  $("folder-nav").innerHTML = view.length
    ? view.map((binder) => {
      const full = !binder.special && binder.records.length >= BINDER_SIZE;
      return `<button type="button" class="nav binder ${folderFilter === BINDER_PREFIX + binder.code ? "on-folder" : ""} ${specialNames.has(binder.group) ? "special" : ""}"
        data-folder="${BINDER_PREFIX}${esc(binder.code)}"><b class="code">${esc(binder.code)}</b><span class="nav-name">${esc(binder.group)}${binder.of > 1 ? ` <small>${binder.index}/${binder.of}</small>` : ""}</span>
        ${binder.special ? `<span class="fill none"></span>` : `<span class="fill ${full ? "full" : ""}" title="${binder.records.length} iš ${BINDER_SIZE}"><i style="width:${Math.round(binder.records.length / BINDER_SIZE * 100)}%"></i></span>`}<span class="badge">${binder.records.length}</span></button>`;
    }).join("")
    : `<p class="nav-empty">Dar nėra. Sukursite įkeldami skeną.</p>`;
  $("folders").innerHTML = special.map((folder) => `<option value="${esc(folder.name)}">`).join("");
}

/** Aplankų kodų langas: kodą galima pakeisti, kad atitiktų lipduką ant aplanko. */
function openCodes() {
  const view = binderContents(records, binders);
  $("codes-list").innerHTML = view.map((binder) => `
    <div class="code-row"><input type="text" class="mono" maxlength="8" data-code-for="${esc(binder.code)}" value="${esc(binder.code)}" aria-label="Kodas">
      <span>${esc(binder.group)}${binder.of > 1 ? ` <small>${binder.index}/${binder.of}</small>` : ""}</span><small>${binderFill(binder.records.length, binder.special)}${binder.special ? "" : " CoC"}</small>
      <span class="order"><button type="button" class="icon-btn sm" data-move="-1" aria-label="Aukščiau">↑</button><button type="button" class="icon-btn sm" data-move="1" aria-label="Žemiau">↓</button></span></div>`).join("")
    || `<p class="muted">Aplankų dar nėra.</p>`;
  $("sidebar").classList.remove("open");
  $("codes").showModal();
}

async function saveCodes() {
  const renames = new Map();
  for (const input of $("codes-list").querySelectorAll("[data-code-for]")) {
    const code = cleanFolderCode(input.value) || input.dataset.codeFor;
    renames.set(input.dataset.codeFor, code);
  }
  const seen = new Set();
  for (const code of renames.values()) {
    if (seen.has(code)) { toast(`Kodas ${code} kartojasi – kiekvienas aplankas turi turėti savo.`, "err"); return false; }
    seen.add(code);
  }
  binders = binders.map((binder) => ({ ...binder, code: renames.get(binder.code) || binder.code }));
  await setMeta("binders", binders);
  for (const record of records) {
    const to = record.binder && renames.get(record.binder);
    if (to && to !== record.binder) await update(record, { binder: to });
  }
  scheduleSync();
  render();
  toast("Aplankų kodai išsaugoti.");
  return true;
}

/** Perrūšiuoja visus turimus CoC į aplankus po 20 ir pasiūlo perkėlimo sąrašą bei lipdukus. */
async function reorganizeBinders() {
  $("sidebar").classList.remove("open");
  if (!await ask(
    `Perrūšiuoti visus aplankus po ${BINDER_SIZE}?`,
    "Kiekvieno modelio CoC bus išdėlioti pagal VIN į aplankus po 20 (specialūs aplankai, pvz. vardais, nekeičiami). Aplankų kodai lieka. Po to atsispausdinkite perkėlimo sąrašą – jame nurodyta, kurį CoC į kurį aplanką perkelti.",
    "Perrūšiuoti",
  )) return;
  const moved = applyBinders(true);
  render();
  await setMeta("bindersNotice", true);
  bindersNotice = true;
  renderIncomplete();
  toast(moved.length ? `Perrūšiuota. Perkelti reikia ${moved.length} CoC.` : "Viskas jau išdėliota teisingai.");
  if (moved.length) printMoves(moved);
}

/** Perkėlimo sąrašas: kuriuos CoC iš kur į kur perkelti. */
function printMoves(moved = null) {
  const view = binderContents(records, binders);
  // Be sąrašo – visi CoC, kurie ne savo senajame grupės aplanke (pirmas sutvarkymas).
  const list = moved || view.flatMap((binder) => binder.records
    .map((record) => ({ record, from: folderCodes[binder.group] || "", to: binder.code }))
    .filter((move) => move.from !== move.to));
  if (!list.length) { toast("Perkelti nieko nereikia – visi CoC savo aplankuose."); return; }
  printMoveSheet(view, list, stampNow());
}

function openStickers() {
  const view = binderContents(records, binders);
  $("sidebar").classList.remove("open");
  if (!view.length) { toast("Aplankų dar nėra.", "warn"); return; }
  $("stickers-list").innerHTML = view.map((binder) => `
    <label class="choice"><input type="checkbox" value="${esc(binder.code)}" checked>
      <b class="code">${esc(binder.code)}</b>${esc(binder.group)}${binder.of > 1 ? ` <small>${binder.index}/${binder.of}</small>` : ""}<small>${binderFill(binder.records.length, binder.special)}</small></label>`).join("");
  $("stickers").showModal();
}

/** Aplankai, kuriuos rodo dabartinis filtras. */
function filteredBinders() {
  const view = binderContents(records, binders);
  if (!folderFilter) return view;
  if (folderFilter.startsWith(BINDER_PREFIX)) return view.filter((binder) => BINDER_PREFIX + binder.code === folderFilter);
  if (folderFilter === MODEL_FOLDERS) return view.filter((binder) => !allFolders().some((folder) => folder.name === binder.group));
  return view.filter((binder) => binder.group === folderFilter);
}

const stampNow = () => `${showDate(todayIso())} ${new Date().toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })}`;

/** Spausdina pasirinkto aplanko (arba visų aplankų) turimų CoC sąrašą – po lapą aplankui. */
async function printFolders(all = false) {
  const list = (all === true ? binderContents(records, binders) : filteredBinders()).filter((binder) => binder.records.length);
  if (!list.length) { toast("Šiame aplanke turimų CoC nėra.", "warn"); return; }
  if (list.length > 1 && !await ask(
    "Spausdinti aplankų sąrašus?",
    `Bus išspausdinti ${list.length} aplankų sąrašai – po lapą kiekvienam aplankui (iki ${BINDER_SIZE} CoC).`,
    "Spausdinti",
  )) return;
  printFolderSheets(list.map((binder) => ({
    name: binder.group, code: binder.code, records: binder.records,
    special: allFolders().some((folder) => folder.name === binder.group), part: binder.of > 1 ? `${binder.index} iš ${binder.of}` : "",
  })), stampNow());
}

function renderPrintButton() {
  const label = !folderFilter ? "Spausdinti aplankų sąrašus"
    : folderFilter === MODEL_FOLDERS ? "Spausdinti modelių aplankus"
      : folderFilter.startsWith(BINDER_PREFIX) ? `Spausdinti aplanko ${folderFilter.slice(BINDER_PREFIX.length)} sąrašą`
        : `Spausdinti „${folderFilter}“ sąrašą`;
  $("print-folders").querySelector(".label").textContent = "Spausdinti";
  $("print-folders").title = label;
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
  applyBinders();
  renderCounts();
  renderRereadCount();
  renderReview();
  renderTable();
  renderAnswer($("q").value);
  renderRecipients();
  renderFolders();
  renderBackupState();
  renderIncomplete();
  highlightNav();
}

function renderIncomplete() {
  const notice = bindersNotice && binders.length ? `
    <div class="answer ok binders-notice"><span class="mark">${icon("folder")}</span>
      <div><b>CoC suskirstyti į aplankus po ${BINDER_SIZE}: ${binders.length} aplank.</b>
        <span class="where">Atsispausdinkite perkėlimo sąrašą, sudėkite CoC ir užklijuokite lipdukus.</span></div>
      <div class="actions">
        <button type="button" class="btn primary sm" data-binders="moves">${icon("printer")}Perkėlimo sąrašas</button>
        <button type="button" class="btn sm" data-binders="stickers">${icon("doc")}Lipdukai</button>
        <button type="button" class="btn sm" data-action="binders-notice-done" title="Paslėpti">${icon("check")}Sutvarkyta</button>
      </div></div>` : "";
  $("incomplete").innerHTML = notice + incompleteScans().map((scan) => `
    <div class="answer warn"><span class="mark">${icon("file")}</span>
      <div><b>„${esc(scan.name)}“: įkelta tik ${scan.pages.size} iš ${scan.total} lap.</b>
        <span class="where">Įkelkite tą patį PDF dar kartą – bus pridėti tik trūkstami lapai, be dublikatų.</span></div>
      <div class="actions">
        <button type="button" class="btn primary sm" data-action="upload">${icon("upload")}Įkelti dar kartą</button>
        <button type="button" class="btn sm" data-ignore-scan="${esc(scan.key)}" title="Nebeprimint apie šį skeną">${icon("x")}Nerodyti</button>
      </div>
    </div>`).join("");
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
  giveIds.forEach((id) => { selected.delete(id); bulkPicked.delete(id); });
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

/** Atidarytų liudijimų peržiūros (kad antrą kartą atsidarytų iš karto). */
const previews = new Map();

async function openDetail(id, fill = false) {
  const record = byId(id);
  if (!record) return;
  detailId = id;
  // Kai trūksta pažymos duomenų – „Pažymos laukai“ atskleidžiami iš karto.
  $("detail-coc").open = fill || pazymaMissing(record).length > 0;
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
    if (previews.has(id)) { $("detail-preview").src = previews.get(id); return; }
    const bytes = await getPdf(id);
    const url = bytes ? await thumbnail(bytes, 900) : "";
    if (url) {
      previews.set(id, url);
      if (previews.size > 40) previews.delete(previews.keys().next().value);
    }
    if (url && detailId === id) $("detail-preview").src = url;
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
    download(await getPdf(list[0].id), pdfName(list[0]), "application/pdf", { recordId: list[0].id });
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

/**
 * Pažymos šablonas – Jūsų aikštelės .docx (bendras su pažymų generatoriumi).
 * Jame pakeičiamos tik reikšmės; jei šablono dar nėra, paprašoma jį įkelti.
 */
async function templateBytes() {
  const stored = await getTemplate();
  if (stored) return stored.bytes;
  const ok = await ask(
    "Įkelkite pažymos šabloną",
    "Pažymos daromos iš Jūsų aikštelės pažymos (.docx) – joje pakeičiami tik duomenys. "
      + "Šabloną reikia įkelti vieną kartą, jis liks šiame kompiuteryje.",
    "Pasirinkti .docx",
  );
  if (!ok) return null;
  return (await pickTemplate())?.bytes || null;
}

let templateResolve = null;

/** Atidaro failo pasirinkimą ir įrašo šabloną. Grąžina { name, bytes } arba null. */
function pickTemplate() {
  return new Promise((resolve) => {
    templateResolve = resolve;
    $("template-file").click();
  });
}

async function useTemplate(file) {
  const done = templateResolve;
  templateResolve = null;
  if (!file) { done?.(null); return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const analysis = analyseTemplate(bytes);
    const found = Object.keys(analysis.recognised || {}).length;
    if (!found && !(analysis.placeholders || []).length) throw new Error("šablone nerasta pažymos lentelės");
    await saveTemplate(file.name, bytes);
    templateDirty = true;
    scheduleSync(0);
    renderTemplateState();
    const missing = analysis.missing || [];
    toast(missing.length
      ? `Šablonas įkeltas, bet neatpažinta: ${missing.join(", ")}.`
      : `Šablonas „${file.name}“ įkeltas – atpažintos visos ${found} eilutės.`, missing.length ? "warn" : "ok");
    done?.({ name: file.name, bytes });
  } catch (error) {
    toast(`Nepavyko perskaityti šablono: ${error.message || error}`, "err");
    done?.(null);
  }
}

async function renderTemplateState() {
  const stored = await getTemplate();
  $("template-name").textContent = stored ? stored.name : "neįkeltas";
  $("template-nav").classList.toggle("warn", !stored);
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
  const missing = list.filter((record) => pazymaMissing(record).length);
  if (missing.length && !await ask(
    "Trūksta pažymos duomenų",
    missing.length === 1
      ? `Neperskaityta: ${pazymaMissing(missing[0]).join(", ")}. Įrašykite liudijimo lange („Pažymos laukai“) arba generuokite – tie laukai liks tušti.`
      : `${missing.length} liudijimuose kai kurie pažymos laukai neperskaityti – pažymose jie liks tušti.`,
    "Vis tiek generuoti",
  )) return;
  const template = await templateBytes();
  if (!template) return;
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
  download(buildXlsx(sheets, excelColumns(folderCodes)), `coc-sandelis_${todayIso()}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  toast(`Excel failas paruoštas (${sheets[2].rows.length} CoC).`);
}

// ---------------------------------------------------------------------------
// Atsarginė kopija
// ---------------------------------------------------------------------------

async function backup() {
  if (!records.length) { toast("Kol kas nėra ko kopijuoti.", "warn"); return; }
  const files = { "sandelis.json": strToU8(JSON.stringify({ version: 1, saved: now(), settings: { folderCodes, binders }, records }, null, 1)) };
  const template = await getTemplate();
  if (template) files[disk.TEMPLATE_FILE] = template.bytes;
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
    const parsed = JSON.parse(strFromU8(files["sandelis.json"]));
    const incoming = parsed.records || [];
    const plan = mergePlan(records, incoming);
    for (const record of plan.add) await addRecord(record, files[`pdf/${record.id}.pdf`] || null);
    for (const record of plan.replace) await saveRecord(record);
    records = await allRecords();
    await mergeSettings(parsed.settings);
    if (files[disk.TEMPLATE_FILE] && !await getTemplate()) {
      await saveTemplate(disk.TEMPLATE_FILE, files[disk.TEMPLATE_FILE]);
      renderTemplateState();
    }
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
  $("store-dot").className = `store-dot ${store.state === "ok" ? "ok" : store.state === "permission" ? "due" : ""}`;
  $("store-dot").title = store.state === "ok" ? `Saugoma aplanke „${store.handle.name}“` : "Duomenys tik naršyklėje – meniu → Duomenų aplankas";
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
  record.typed = { ...(record.typed || {}), [input.dataset.field]: true };
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
  if (target.dataset.retry) retryReading([target.dataset.retry]);
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
  if (event.key === "Enter" && !bulkVins()) {
    const first = visibleRecords()[0];
    if (first && $("q").value.trim()) openDetail(first.id);
  }
});
// Įklijuotas VIN sąrašas (po vieną eilutėje) – eilutės paverčiamos tarpais,
// kitaip naršyklė jas tiesiog sulipdytų į vieną ilgą žodį.
$("q").addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text") || "";
  if (!/[\r\n]/.test(text.trim())) return;
  event.preventDefault();
  const input = $("q");
  const joined = text.trim().split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).join(" ");
  input.setRangeText(joined, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input"));
});
$("answer").addEventListener("change", (event) => {
  const box = event.target;
  if (box.dataset.pick) {
    if (box.checked) bulkPicked.add(box.dataset.pick); else bulkPicked.delete(box.dataset.pick);
  } else if (box.dataset.bulk === "pick-all") {
    const have = bulkResult.filter((row) => row.state === "in").map((row) => row.hits[0].id);
    have.forEach((id) => (box.checked ? bulkPicked.add(id) : bulkPicked.delete(id)));
  } else return;
  const scroll = $("answer").scrollTop;
  renderAnswer($("q").value);
  $("answer").scrollTop = scroll;
});
$("answer").addEventListener("click", async (event) => {
  if (event.target.closest("[data-bulk=pick-all]")) return;
  const action = event.target.closest("[data-bulk]")?.dataset.bulk;
  if (!action) return;
  const have = bulkResult.filter((row) => row.state === "in").map((row) => row.hits[0].id);
  if (action === "select") { have.forEach((id) => selected.add(id)); renderTable(); toast(`Pažymėta: ${have.length}.`); }
  if (action === "pazyma") makePazymos(have);
  if (action === "give") { if (bulkPicked.size) openGive([...bulkPicked]); }
  if (action === "binder") { if (bulkPicked.size) openBinderDialog([...bulkPicked]); }
  if (action === "clear") { $("q").value = ""; $("q").dispatchEvent(new Event("input")); }
  if (action === "copy") {
    const missing = bulkResult.filter((row) => row.state === "none").map((row) => row.query).join("\n");
    try { await navigator.clipboard.writeText(missing); toast("Neturimi VIN nukopijuoti."); } catch { toast("Nepavyko nukopijuoti.", "err"); }
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
  renderRail();
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
    box.closest("[data-row]").classList.toggle("selected", box.checked);
    renderBulk();
    return;
  }
  // Paspaudus PDF ženkliuką – pažymima (pats spragtelėjimas pasieks varnelę).
  if (event.target.closest(".doc-check")) return;
  const kebab = event.target.closest("[data-menu]");
  if (kebab) { openRowMenu(kebab.dataset.menu, kebab); return; }
  const row = event.target.closest("[data-row]");
  if (!row) return;
  // Paspaudus – CoC parodomas kairėje, antrą kartą – atidaromas.
  if (stageBeside() && row.dataset.row !== stageId) { setStage(row.dataset.row); return; }
  setStage(row.dataset.row, false);
  openDetail(row.dataset.row);
});
$("rows").addEventListener("dblclick", (event) => {
  const row = event.target.closest("[data-row]");
  if (row && !event.target.closest(".doc-check, .kebab")) openDetail(row.dataset.row);
});
$("row-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-menu-action]");
  if (!button) return;
  const id = menuId;
  closeRowMenu();
  rowAction(button.dataset.menuAction, id);
});
document.addEventListener("pointerdown", (event) => {
  if (!$("row-menu").hidden && !event.target.closest("#row-menu, .kebab")) closeRowMenu();
});
document.querySelector(".rows-wrap").addEventListener("scroll", closeRowMenu, { passive: true });
document.querySelectorAll(".rail-item").forEach((item) => item.addEventListener("click", () => {
  const rail = item.dataset.rail;
  if (rail === "library") { closeReview(); if (tab === STATUS.OUT) setTab(STATUS.IN); }
  if (rail === "history") { closeReview(); setTab(STATUS.OUT); }
  if (rail === "scan") { if (reviewList().length) openReview(); else $("files").click(); }
  if (rail === "folders") {
    $("sidebar").classList.add("open");
    $("folder-nav").scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
  }
  renderRail();
}));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (!$("row-menu").hidden) closeRowMenu();
  else if ($("sidebar").classList.contains("open")) $("sidebar").classList.remove("open");
  else if ($("review").classList.contains("open") && !event.target.closest?.("input")) closeReview();
});
$("stage-ready").addEventListener("click", (event) => {
  if (event.target.closest("[data-stage=reread]") && stageId) rereadRecords([stageId]);
  if (event.target.closest("[data-stage=detail-fill]") && stageId) openDetail(stageId, true);
});
$("stage-actions").addEventListener("click", (event) => {
  const action = event.target.closest("[data-stage]")?.dataset.stage;
  if (!action || !stageId) return;
  if (action === "give") openGive([stageId]);
  if (action === "return") returnRecords([stageId]);
  if (action === "pazyma") makePazymos([stageId]);
  if (action === "pdf") openPdf(stageId);
  if (action === "reread") rereadRecords([stageId]);
  if (action === "detail") openDetail(stageId);
});
$("template-file").addEventListener("change", (event) => { useTemplate(event.target.files[0]); event.target.value = ""; });
$("template-file").addEventListener("cancel", () => useTemplate(null));
$("incomplete").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ignore-scan]");
  if (!button) return;
  await ignoreScan(button.dataset.ignoreScan);
  renderIncomplete();
  toast("Daugiau neprimins.");
});
$("folder-filter").addEventListener("change", (event) => setFolderFilter(event.target.value));
$("folder-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  $("sidebar").classList.remove("open");
  setTab(STATUS.IN);
  setFolderFilter(folderFilter === button.dataset.folder ? "" : button.dataset.folder);
  closeReview();
});
$("answer").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.give) openGive([button.dataset.give]);
  if (button?.dataset.return) returnRecords([button.dataset.return]);
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
  if (link.dataset.nav === "review") { openReview(); return; }
  closeReview();
  if (link.dataset.tab) setTab(link.dataset.tab);
  if (link.dataset.nav === "top") focusSearch();
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
  "retry-failed": () => retryReading(records
    .filter((record) => record.status === STATUS.REVIEW && record.ocr === "klaida").map((record) => record.id)),
  more: () => { shown += PAGE; renderTable(); },
  "give-selected": () => openGive([...selected]),
  "return-selected": () => returnRecords([...selected]),
  "pdf-selected": () => downloadPdfs([...selected]),
  "pazyma-selected": () => makePazymos([...selected]),
  "reread-selected": () => rereadRecords([...selected]),
  "binder-selected": () => openBinderDialog([...selected]),
  "binder-cancel": () => $("binder-dialog").close(),
  "clear-selection": () => { selected.clear(); renderTable(); },
  "give-cancel": () => $("give").close(),
  "codes-cancel": () => $("codes").close(),
  downloads: () => { if ($("downloads").hidden) showDownloads(); else $("downloads").hidden = true; },
  "downloads-close": () => { $("downloads").hidden = true; },
  multi: () => { $("multi-text").value = (bulkVins() || []).join("\n"); updateMultiCount(); $("multi").showModal(); $("multi-text").focus(); },
  "multi-cancel": () => $("multi").close(),
  "viewer-close": closeViewer,
  "viewer-download": () => { if (viewer.id) downloadPdfs([viewer.id]); },
  "viewer-tab": () => { if (viewer.url) window.open(viewer.url, "_blank"); },
  "folder-cancel": () => $("folder-dialog").close(),
  "folder-connect": () => connectFolder(),
  "folder-restore": () => connectFolder(true),
  "folder-allow": allowFolder,
  "print-folders": printFolders,
  reorganize: reorganizeBinders,
  stickers: openStickers,
  "stickers-cancel": () => $("stickers").close(),
  "print-moves": () => { $("stickers").close(); printFolders(true); },
  "binders-notice-done": async () => { bindersNotice = false; await setMeta("bindersNotice", false); renderIncomplete(); },
  filters: () => { $("filter-row").hidden = !$("filter-row").hidden; renderFolders(); },
  "open-review": () => { $("sidebar").classList.remove("open"); if (reviewList().length) openReview(); else toast("Visi CoC patikrinti."); },
  "close-review": closeReview,
  "reread-missing": openMissing,
  "missing-close": () => $("missing").close(),
  "missing-reread": () => {
    const ids = missingRecords().map((record) => record.id);
    $("missing").close();
    rereadRecords(ids);
  },
  "open-staged": () => { if (stageId) openDetail(stageId); else toast("Pasirinkite CoC sąraše.", "warn"); },
  template: async () => { await pickTemplate(); },
  codes: openCodes,
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

function updateMultiCount() {
  const count = vinList($("multi-text").value).length;
  $("multi-count").textContent = count ? `Rasta VIN: ${count}` : "";
}
$("multi-text").addEventListener("input", updateMultiCount);
$("multi-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "check") return;
  const list = vinList($("multi-text").value);
  if (!list.length) { event.preventDefault(); toast("Nerasta nė vieno VIN.", "warn"); return; }
  closeReview();
  $("q").value = list.join(" ");
  $("q").dispatchEvent(new Event("input"));
});
$("viewer").addEventListener("close", () => {
  const { url } = viewer;
  $("viewer-frame").removeAttribute("src");
  if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  viewer = { id: null, url: "" };
});

$("downloads-list").addEventListener("click", (event) => {
  const view = event.target.closest("[data-dl-view]");
  const open = event.target.closest("[data-dl-open]");
  const item = downloads.find((entry) => entry.id === (view || open)?.dataset[view ? "dlView" : "dlOpen"]);
  if (!item) return;
  if (view) openPdf(item.recordId);
  else if (item.bytes) saveFile(item.bytes, item.filename, item.type);
});
$("downloads").addEventListener("mouseleave", () => {
  clearTimeout(downloadsTimer);
  downloadsTimer = setTimeout(() => { $("downloads").hidden = true; }, 6000);
});

$("missing-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  await saveMissing();
  if (missingRecords().length) openMissing(); else $("missing").close();
});
$("missing-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-missing-pdf]");
  if (button) openPdf(button.dataset.missingPdf);
});

$("stickers-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "print") return;
  const codes = [...$("stickers-list").querySelectorAll("input:checked")].map((input) => input.value);
  if (!codes.length) { event.preventDefault(); toast("Pažymėkite bent vieną aplanką.", "warn"); return; }
  const view = binderContents(records, binders).filter((binder) => codes.includes(binder.code));
  printBinderLabels(view, $("stickers-size").value);
});
$("incomplete").addEventListener("click", (event) => {
  const action = event.target.closest("[data-binders]")?.dataset.binders;
  if (action === "moves") printMoves();
  if (action === "stickers") openStickers();
});

// Aplankų eilė: ↑ ↓ perkelia eilutę, „Numeruoti iš eilės“ – A-01, A-02… pagal rodomą tvarką.
$("codes-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-move]");
  if (!button) return;
  const row = button.closest(".code-row");
  const target = Number(button.dataset.move) < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!target) return;
  if (Number(button.dataset.move) < 0) target.before(row); else target.after(row);
  row.animate([{ background: "rgba(226, 20, 63, .18)" }, { background: "transparent" }], { duration: 500 });
});
$("codes-number").addEventListener("click", () => {
  const start = Math.max(1, Number($("codes-start").value) || 1);
  [...$("codes-list").querySelectorAll("[data-code-for]")].forEach((input, index) => {
    input.value = `A-${String(start + index).padStart(2, "0")}`;
  });
});

$("binder-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "ok") return;
  event.preventDefault();
  const typed = cleanFolderCode($("binder-new").value);
  const picked = $("binder-choices").querySelector("input:checked")?.value;
  const code = typed || picked;
  if (!code) { toast("Pasirinkite aplanką arba įrašykite naujo kodą.", "warn"); return; }
  if (await moveToBinder(code)) $("binder-dialog").close();
});
$("binder-new").addEventListener("input", () => {
  if ($("binder-new").value) $("binder-choices").querySelectorAll("input").forEach((input) => { input.checked = false; });
});

$("codes-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  if (await saveCodes()) $("codes").close();
});

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
  resizeTimer = setTimeout(() => { moveIndicator(); fitRows(); }, 150);
});

// ---------------------------------------------------------------------------
// Paleidimas
// ---------------------------------------------------------------------------

async function start() {
  savedFolders = (await getMeta("folders").catch(() => null)) || [];
  ignoredScans = (await getMeta("ignoredScans").catch(() => null)) || [];
  folderCodes = (await getMeta("folderCodes").catch(() => null)) || {};
  binders = (await getMeta("binders").catch(() => null)) || [];
  bindersNotice = Boolean(await getMeta("bindersNotice").catch(() => false));
  renderTemplateState();
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
    const response = await fetch(new URL("../../version.js?patikra", import.meta.url), { cache: "no-store" });
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
