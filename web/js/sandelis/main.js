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
import {
  EXCEL_COLUMNS, STATUS, backupDue, cleanVin, counts, duplicatesOf, excelSheets, initials, localDay, matches,
  mergePlan, monthlyActivity, newestFirst, pdfName, showDate, splitMakeModel, statusName, todayIso, vinDoubtful,
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
}

/** Skaičius „atsuka“ iki naujos reikšmės. */
function countTo(element, value) {
  const from = Number(element.dataset.value || 0);
  element.dataset.value = value;
  if (from === value || reduceMotion()) { element.textContent = value; return; }
  const start = performance.now();
  const duration = 900;
  const step = (time) => {
    const t = Math.min(1, (time - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    element.textContent = Math.round(from + (value - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Avataro spalva iš vardo – tas pats žmogus visada tos pačios spalvos. */
function hue(name) {
  let sum = 0;
  for (const ch of String(name)) sum = (sum * 31 + ch.charCodeAt(0)) % 360;
  return sum;
}

// ---------------------------------------------------------------------------
// Skenų priėmimas ir atpažinimas
// ---------------------------------------------------------------------------

let queueRunning = false;
const session = { done: 0, times: [] };

async function handleFiles(fileList) {
  const files = [...fileList].filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (!files.length) { toast("Pasirinkite PDF failą.", "warn"); return; }
  askPersistence();

  let added = 0;
  for (const file of files) {
    let pages;
    try {
      pages = await splitPages(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      toast(`Nepavyko atidaryti ${file.name}: ${error.message || error}`, "err");
      continue;
    }
    const batch = now();
    for (const [index, bytes] of pages.entries()) {
      const record = {
        id: crypto.randomUUID(),
        status: STATUS.REVIEW,
        ocr: "laukia",
        vin: "", make: "", model: "", tvv: "",
        coc: {},
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
  return found(full) >= found(quick) ? full : quick;
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
const isClean = (record) => record.status === STATUS.REVIEW && record.ocr === "baigta"
  && vinHint(record)[0] === "ok" && String(record.model || "").trim();

function hintHtml(kind, text) {
  if (!kind) return "";
  return `${icon(kind === "ok" ? "check" : kind === "warn" ? "clock" : "x")}${esc(text)}`;
}

function cardHtml(record) {
  const busy = record.ocr === "laukia" || record.ocr === "skaitoma";
  const [kind, hint] = vinHint(record);
  const snippet = (record.snippets || {}).vin;
  const state = busy
    ? `<span class="state"><span class="spinner"></span>${record.ocr === "skaitoma" ? "Skaitoma…" : "Laukia eilėje"}</span>`
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
        ${state}
      </div>
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

async function removeRecord(id) {
  const record = byId(id);
  if (!record) return;
  const label = record.vin || `${record.source_file}, ${record.page} lapas`;
  if (!await ask("Ištrinti liudijimą?", `${label}\nBus ištrintas ir jo PDF.`, "Ištrinti", true)) return;
  await deleteRecord(id);
  records = records.filter((other) => other.id !== id);
  selected.delete(id);
  animateOut(id);
  render();
  toast("Ištrinta.");
}

// ---------------------------------------------------------------------------
// Apžvalga: skaičiai, grafikas, paskutiniai atiduoti
// ---------------------------------------------------------------------------

function renderCounts() {
  const n = counts(records);
  const month = todayIso().slice(0, 7);
  const week = Date.now() - 7 * 864e5;
  const ready = records.filter((record) => record.status !== STATUS.REVIEW);
  const givenMonth = records.filter((record) => record.status === STATUS.OUT && String(record.given_date).startsWith(month));
  const addedMonth = ready.filter((record) => localDay(record.added).startsWith(month));
  const addedWeek = ready.filter((record) => new Date(record.added).getTime() > week);

  countTo($("s-in"), n[STATUS.IN]);
  countTo($("s-review"), n[STATUS.REVIEW]);
  countTo($("s-out"), givenMonth.length);
  countTo($("s-added"), addedMonth.length);
  $("s-in-sub").textContent = addedWeek.length ? `+${addedWeek.length} per savaitę` : " ";
  $("s-review-sub").textContent = n[STATUS.REVIEW] ? "Laukia Jūsų patvirtinimo" : "Viskas patikrinta";
  $("s-out-sub").textContent = `Iš viso atiduota: ${n[STATUS.OUT]}`;
  $("s-added-sub").textContent = `Iš viso įkelta: ${ready.length}`;

  $("nav-in").textContent = n[STATUS.IN] || "";
  $("nav-out").textContent = n[STATUS.OUT] || "";
  $("nav-review").textContent = n[STATUS.REVIEW] || "";
  $("t-in").textContent = n[STATUS.IN];
  $("t-out").textContent = n[STATUS.OUT];
  $("t-all").textContent = ready.length;

  const hour = new Date().getHours();
  const hello = hour < 11 ? "Labas rytas!" : hour < 18 ? "Laba diena!" : "Labas vakaras!";
  $("greeting").innerHTML = records.length
    ? `${hello} Turime <span class="num">${n[STATUS.IN]}</span> CoC.`
    : `${hello} Pradėkime nuo pirmo skeno.`;

  $("empty").classList.toggle("hidden", records.length > 0);
  $("overview").classList.toggle("hidden", ready.length === 0);
}

/** Švelni kreivė per taškus (Catmull–Rom → Bezier). */
function smoothPath(points) {
  if (points.length < 2) return "";
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i - 1] || points[i];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const [x3, y3] = points[i + 2] || points[i + 1];
    const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6];
    const c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
    path += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x2},${y2}`;
  }
  return path;
}

let chartKey = "";

function renderChart() {
  const months = monthlyActivity(records);
  const key = JSON.stringify(months) + $("chart").clientHeight;
  if (key === chartKey) return;
  chartKey = key;

  const box = $("chart");
  const width = Math.max(320, box.clientWidth || 600);
  const height = Math.max(200, box.clientHeight || 230);
  const pad = { left: 34, right: 12, top: 14, bottom: 28 };
  const peak = Math.max(4, ...months.map((m) => Math.max(m.added, m.given)));
  const top = Math.ceil(peak / 4) * 4;
  const x = (i) => pad.left + (i * (width - pad.left - pad.right)) / (months.length - 1);
  const y = (v) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom);
  const added = months.map((m, i) => [x(i), y(m.added)]);
  const given = months.map((m, i) => [x(i), y(m.given)]);
  const addedPath = smoothPath(added);
  const area = `${addedPath} L${x(months.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

  const grid = [0, 1, 2, 3, 4].map((step) => {
    const value = (top / 4) * step;
    return `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/>
      <text class="axis" x="${pad.left - 10}" y="${y(value) + 4}" text-anchor="end">${value}</text>`;
  }).join("");
  const labels = months.map((m, i) =>
    `<text class="axis" x="${x(i)}" y="${height - 6}" text-anchor="middle">${m.label}</text>`).join("");

  box.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Įkelta ir atiduota per paskutinius 6 mėnesius">
      <defs>
        <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#fafafa" stop-opacity=".16"/>
          <stop offset="1" stop-color="#fafafa" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}${labels}
      <path class="area fade" d="${area}"/>
      <path class="line given" d="${smoothPath(given)}"/>
      <path class="line added draw" d="${addedPath}"/>
      <line class="guide" y1="${pad.top}" y2="${y(0)}"/>
      <circle class="dot d-added" r="4.5"/>
      <circle class="dot d-given" r="4" style="stroke:#71717a"/>
    </svg>
    <div class="tip"></div>`;

  const line = box.querySelector(".line.added");
  const length = line.getTotalLength();
  line.style.strokeDasharray = length;
  line.style.strokeDashoffset = length;
  const dashed = box.querySelector(".line.given");
  if (!reduceMotion()) {
    dashed.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 500, fill: "both" });
  }

  const svg = box.querySelector("svg");
  const tip = box.querySelector(".tip");
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let index = 0;
    for (let i = 1; i < months.length; i += 1) if (Math.abs(x(i) - px) < Math.abs(x(index) - px)) index = i;
    const m = months[index];
    box.classList.add("hover");
    box.querySelector(".guide").setAttribute("x1", x(index));
    box.querySelector(".guide").setAttribute("x2", x(index));
    const [ax, ay] = added[index];
    const [gx, gy] = given[index];
    box.querySelector(".d-added").setAttribute("cx", ax);
    box.querySelector(".d-added").setAttribute("cy", ay);
    box.querySelector(".d-given").setAttribute("cx", gx);
    box.querySelector(".d-given").setAttribute("cy", gy);
    tip.innerHTML = `<b>${m.label}</b><span>Įkelta: ${m.added}</span><span>Atiduota: ${m.given}</span>`;
    tip.style.left = `${(ax / width) * rect.width}px`;
    tip.style.top = `${(Math.min(ay, gy) / height) * rect.height}px`;
  });
  svg.addEventListener("mouseleave", () => box.classList.remove("hover"));
}

function renderRecent() {
  const list = records.filter((record) => record.status === STATUS.OUT)
    .sort((a, b) => String(b.given_date).localeCompare(String(a.given_date)) || String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 5);
  $("recent").innerHTML = list.length
    ? list.map((record, i) => `
      <li data-row="${record.id}" style="--i:${i}">
        <span class="avatar" style="--h:${hue(record.given_to || "?")}">${esc(initials(record.given_to))}</span>
        <div class="who"><b>${esc(record.given_to || "Gavėjas nenurodytas")}</b>
          <span>…${esc((record.vin || "").slice(-6))} · ${esc(record.model || "")}</span></div>
        <time>${esc(showDate(record.given_date))}</time>
      </li>`).join("")
    : `<li class="none">Dar nieko neatiduota.</li>`;
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
    if (have.length) {
      html = `<div class="answer ok"><span class="mark">${icon("check")}</span>
        <div><b>Turime.</b> <span>${list(have)}${have.length > 3 ? ` ir dar ${have.length - 3}` : ""}</span></div></div>`;
    } else if (review.length) {
      html = `<div class="answer warn"><span class="mark">${icon("scan")}</span>
        <div><b>Yra, bet dar nepatikrintas.</b> <span>${list(review)}</span></div></div>`;
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

function visibleRecords() {
  const query = $("q").value;
  if (query.trim()) {
    return records.filter((record) => record.status !== STATUS.REVIEW && matches(record, query)).sort(newestFirst);
  }
  if (tab === "visi") return records.filter((record) => record.status !== STATUS.REVIEW).sort(newestFirst);
  const list = records.filter((record) => record.status === tab);
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
      <td class="date hide-sm">${esc(showDate(record.added))}</td>
      <td class="status-cell">${statusText}</td>
      <td class="actions">${action}</td>
    </tr>`;
  });
  animateRows = false;
  $("rows").innerHTML = rows.join("") || `<tr class="empty-row"><td colspan="6">${
    query ? "Nieko nerasta." : records.length ? "Šiame sąraše tuščia." : "Dar nėra nė vieno liudijimo – įmeskite nuskenuotą PDF."
  }</td></tr>`;

  const more = list.length - shown;
  $("list-note").innerHTML = more > 0
    ? `Rodoma ${shown} iš ${list.length}. <button type="button" class="btn sm" data-action="more">Rodyti daugiau</button>`
    : query ? `Rasta: ${list.length} · ieškoma visuose sąrašuose` : "";

  const visibleIds = list.slice(0, shown).map((record) => record.id);
  $("check-all").checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  renderBulk();
}

function renderBulk() {
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  $("bulk").classList.toggle("on", selected.size > 0);
  if (selected.size) $("bulk-count").textContent = `Pažymėta: ${selected.size}`;
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
  renderRecent();
  if (!$("overview").classList.contains("hidden")) renderChart();
  renderBackupState();
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
    animateRows = true;
    chartKey = "";
    render();
    toast(`Kopija įkelta: pridėta ${plan.add.length}, atnaujinta ${plan.replace.length}, jau buvo ${plan.skip}.`);
    runQueue();
  } catch (error) {
    toast(`Nepavyko įkelti kopijos: ${error.message || error}`, "err");
  }
}

async function renderBackupState() {
  const last = await getMeta("lastBackup").catch(() => null);
  const ready = records.filter((record) => record.status !== STATUS.REVIEW).length;
  const due = backupDue(last, ready);
  const days = last ? Math.floor((Date.now() - new Date(last)) / 864e5) : null;
  $("backup-card").classList.toggle("due", due);
  $("backup-text").textContent = last
    ? (days === 0 ? "Padaryta šiandien." : `Paskutinė prieš ${days} d.${due ? " Laikas naujai." : ""}`)
    : ready ? "Dar nedaryta – duomenys tik šiame kompiuteryje." : "Bus galima, kai įkelsite CoC.";
  $("backup-meter").style.width = last ? `${Math.max(6, 100 - (days / 7) * 100)}%` : "0%";
  const usage = await usageMb();
  $("usage").textContent = usage !== null ? `Užimama vietos: ${usage < 1 ? "<1" : usage.toFixed(0)} MB` : "";
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
$("recent").addEventListener("click", (event) => {
  const row = event.target.closest("[data-row]");
  if (row) openDetail(row.dataset.row);
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
  resizeTimer = setTimeout(() => { chartKey = ""; renderChart(); moveIndicator(); }, 150);
});

// ---------------------------------------------------------------------------
// Paleidimas
// ---------------------------------------------------------------------------

function renderToday() {
  const text = new Intl.DateTimeFormat("lt-LT", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
    .format(new Date());
  $("today").textContent = text.charAt(0).toUpperCase() + text.slice(1);
}

async function start() {
  renderToday();
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
