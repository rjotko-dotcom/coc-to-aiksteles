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
import {
  STATUS, backupDue, cleanVin, counts, duplicatesOf, matches, mergePlan, newestFirst, pdfName,
  showDate, statusName, toCsv, todayIso, vinDoubtful, vinProblems,
} from "./logic.js";

/** Kiek eilučių rodyti iš karto – didelis sąrašas kitaip stabdytų puslapį. */
const PAGE = 200;

/** Laukai, dėl kurių verta skaityti lapą antrą kartą (žr. `readCertificate`). */
const NEEDED = ["vin", "commercial_name"];

let records = [];
let tab = STATUS.IN;
let shown = PAGE;
const selected = new Set();
let detailId = null;
let giveIds = [];

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const byId = (id) => records.find((record) => record.id === id);
const now = () => new Date().toISOString();

function status(text, ok = false) {
  $("status").textContent = text;
  $("status").className = ok ? "status ok" : "status";
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
  if (!bytes) { alert("Šio liudijimo PDF nerastas."); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function update(record, changes) {
  Object.assign(record, changes, { updated: now() });
  await saveRecord(record);
}

// ---------------------------------------------------------------------------
// Skenų priėmimas
// ---------------------------------------------------------------------------

let queueRunning = false;

async function handleFiles(fileList) {
  const files = [...fileList].filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (!files.length) { status("Pasirinkite PDF failą."); return; }
  askPersistence();

  let added = 0;
  for (const file of files) {
    status(`Karpomas ${file.name}…`);
    let pages;
    try {
      pages = await splitPages(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      status(`Nepavyko atidaryti ${file.name}: ${error.message || error}`);
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
    }
    render();
  }
  status(added ? `Įkelta lapų: ${added}. Skaitomi VIN ir modeliai…` : "Nieko neįkelta.", added > 0);
  runQueue();
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
      const left = waiting.length;
      await update(record, { ocr: "skaitoma" });
      renderCard(record);
      try {
        const bytes = await getPdf(record.id);
        const file = new File([bytes], `${record.source_file} (${record.page} lapas).pdf`, { type: "application/pdf" });
        const data = await readCertificate(file, (message) => status(`Liko ${left}. ${message}`), { required: NEEDED });
        const found = {
          coc: {
            approval_number: data.approval_number, approval_date: data.approval_date,
            colour: data.colour, colour_raw: data.colour_raw, category: data.category,
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
          Object.assign(found, {
            vin: cleanVin(data.vin), make: data.make, model: data.commercial_name, tvv: data.type_variant_version,
          });
        }
        await update(record, found);
      } catch (error) {
        await update(record, { ocr: "klaida", ocr_error: error.message || String(error) });
      }
      if (byId(record.id)) renderCard(record);
      renderCounts();
    }
    const review = records.filter((record) => record.status === STATUS.REVIEW).length;
    if (review) status(`Perskaityta. Patikrinkite ${review} lap. ir patvirtinkite.`, true);
  } finally {
    queueRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Patikra
// ---------------------------------------------------------------------------

/** Pastabos apie VIN po laukeliu: klaida, abejonė, dublikatas. */
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
    return ["err", `Toks VIN jau yra (${where}). Gal tas pats lapas nuskenuotas dukart?`];
  }
  if (vinDoubtful(vin)) return ["warn", "Kontrolinis skaitmuo nesutampa – sulyginkite ženklą po ženklo."];
  return ["ok", "17 ženklų ✓"];
}

function cardHtml(record) {
  const busy = record.ocr === "laukia" || record.ocr === "skaitoma";
  const [kind, hint] = vinHint(record);
  const snippet = (record.snippets || {}).vin;
  return `
    <button type="button" class="thumb" data-open="${record.id}" title="Atidaryti PDF">
      ${record.thumb ? `<img src="${record.thumb}" alt="${record.page} lapas">` : "<span>Peržiūros nėra – atidaryti PDF</span>"}
    </button>
    <div class="fields">
      <div class="fileline">
        <strong>${esc(record.source_file)} · ${record.page} iš ${record.pages} lapo</strong>
        <span>${busy ? `<span class="working">${record.ocr === "skaitoma" ? "Skaitoma…" : "Laukia eilėje"}</span>` : ""}</span>
      </div>
      ${record.ocr === "klaida" ? `<div class="banner err">Automatiškai perskaityti nepavyko (${esc(record.ocr_error)}). Įrašykite ranka.</div>` : ""}
      ${snippet ? `<div class="snippet-box"><img class="snippet" src="${snippet}" alt="VIN vieta liudijime"></div>` : ""}
      <div class="vin">
        <label for="r-${record.id}-vin">VIN</label>
        <input type="text" class="code" id="r-${record.id}-vin" data-field="vin" value="${esc(record.vin)}"
               maxlength="24" autocomplete="off" spellcheck="false">
        <div class="hint ${kind}">${esc(hint)}</div>
      </div>
      <div>
        <label for="r-${record.id}-make">Markė</label>
        <input type="text" id="r-${record.id}-make" data-field="make" value="${esc(record.make)}" autocomplete="off">
      </div>
      <div>
        <label for="r-${record.id}-model">Modelis</label>
        <input type="text" id="r-${record.id}-model" data-field="model" value="${esc(record.model)}" autocomplete="off">
      </div>
      <div class="row">
        <button type="button" class="primary" data-confirm="${record.id}">Patvirtinti</button>
        <button type="button" data-open="${record.id}">Atidaryti PDF</button>
        <button type="button" class="danger" data-remove="${record.id}">Ištrinti lapą</button>
      </div>
    </div>`;
}

/** Perpiešia vieną kortelę, neprarandant žymeklio laukelyje. */
function renderCard(record) {
  const card = document.querySelector(`.card[data-id="${record.id}"]`);
  if (!card) { render(); return; }
  if (record.status !== STATUS.REVIEW) { render(); return; }
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

function renderReview() {
  const review = records.filter((record) => record.status === STATUS.REVIEW)
    .sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.page - b.page);
  $("review").classList.toggle("hidden", !review.length);
  $("review-count").textContent = review.length ? `(${review.length})` : "";
  const list = $("review-list");
  const existing = new Map([...list.children].map((card) => [card.dataset.id, card]));
  const wanted = new Set(review.map((record) => record.id));
  for (const [id, card] of existing) if (!wanted.has(id)) card.remove();
  let previous = null;
  for (const record of review) {
    let card = existing.get(record.id);
    if (!card) {
      card = document.createElement("div");
      card.className = "card";
      card.dataset.id = record.id;
      card.innerHTML = cardHtml(record);
    }
    if (previous ? previous.nextSibling !== card : list.firstChild !== card) {
      list.insertBefore(card, previous ? previous.nextSibling : list.firstChild);
    }
    previous = card;
  }
}

async function confirmRecord(id) {
  const record = byId(id);
  if (!record) return;
  const vin = cleanVin(record.vin);
  const problems = vinProblems(vin);
  if (problems.length && !confirm(`${problems[0]}\n\nVis tiek patvirtinti?`)) return;
  if (duplicatesOf(records, record).length && !confirm("Toks VIN jau yra sąraše. Vis tiek pridėti dar vieną?")) return;
  const next = nextReviewAfter(id);
  // Peržiūros paveikslėlių sąraše nebereikia – jie tik didintų duomenis.
  await update(record, { vin, status: STATUS.IN, thumb: "", snippets: {} });
  render();
  if (next) document.getElementById(`r-${next}-vin`)?.focus();
  else $("q").focus();
}

function nextReviewAfter(id) {
  const cards = [...document.querySelectorAll("#review-list .card")];
  const index = cards.findIndex((card) => card.dataset.id === id);
  const next = cards[index + 1] || cards[index - 1];
  return next ? next.dataset.id : null;
}

async function removeRecord(id, ask = true) {
  const record = byId(id);
  if (!record) return;
  const label = record.vin || `${record.source_file}, ${record.page} lapas`;
  if (ask && !confirm(`Ištrinti liudijimą ${label}? Bus ištrintas ir jo PDF.`)) return;
  await deleteRecord(id);
  records = records.filter((other) => other.id !== id);
  selected.delete(id);
  render();
}

// ---------------------------------------------------------------------------
// Sąrašas ir paieška
// ---------------------------------------------------------------------------

function renderCounts() {
  const n = counts(records);
  $("n-in").textContent = n[STATUS.IN];
  $("n-out").textContent = n[STATUS.OUT];
  $("n-review").textContent = n[STATUS.REVIEW];
  $("t-in").textContent = n[STATUS.IN];
  $("t-out").textContent = n[STATUS.OUT];
  $("t-all").textContent = n.all - n[STATUS.REVIEW];
}

/** Aiškus atsakymas į klausimą „ar turime šitą CoC?“. */
function renderAnswer(query) {
  const box = $("answer");
  const vin = cleanVin(query);
  if (/\s/.test(query.trim()) || vin.length < 5) { box.innerHTML = ""; return; }
  const hits = records.filter((record) => (record.vin || "").includes(vin));
  if (!hits.length) {
    // Gal tai ne VIN, o modelis ar žmogus – tada atsakymo nerodome, tik sąrašą.
    if (/\d/.test(vin)) box.innerHTML = `<div class="banner err">✗ CoC su VIN, kuriame yra „${esc(vin)}“, <strong>neturime</strong>.</div>`;
    else box.innerHTML = "";
    return;
  }
  const have = hits.filter((record) => record.status === STATUS.IN);
  const review = hits.filter((record) => record.status === STATUS.REVIEW);
  const gone = hits.filter((record) => record.status === STATUS.OUT);
  const list = (items) => items.slice(0, 3).map((record) =>
    `<strong>${esc(record.vin)}</strong> ${esc([record.make, record.model].filter(Boolean).join(" "))}`).join(", ");
  if (have.length) {
    box.innerHTML = `<div class="banner ok">✓ <strong>Turime</strong>: ${list(have)}${have.length > 3 ? ` ir dar ${have.length - 3}` : ""}.</div>`;
  } else if (review.length) {
    box.innerHTML = `<div class="banner warn">Yra, bet dar nepatikrintas: ${list(review)}.</div>`;
  } else {
    const last = gone.sort((a, b) => String(b.given_date).localeCompare(String(a.given_date)))[0];
    box.innerHTML = `<div class="banner warn">Buvo, bet <strong>atiduotas</strong> ${esc(showDate(last.given_date))}${last.given_to ? ` – ${esc(last.given_to)}` : ""}: ${list([last])}.</div>`;
  }
}

function vinCell(vin) {
  if (!vin) return `<span class="sub">VIN nėra</span>`;
  return `${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b>`;
}

function visibleRecords() {
  const query = $("q").value;
  if (query.trim()) {
    return records.filter((record) => record.status !== STATUS.REVIEW && matches(record, query))
      .sort(newestFirst);
  }
  if (tab === "visi") return records.filter((record) => record.status !== STATUS.REVIEW).sort(newestFirst);
  const list = records.filter((record) => record.status === tab);
  if (tab === STATUS.OUT) {
    return list.sort((a, b) => String(b.given_date).localeCompare(String(a.given_date)) || newestFirst(a, b));
  }
  return list.sort(newestFirst);
}

function renderTable() {
  const query = $("q").value;
  const list = visibleRecords();
  document.querySelector(".tabs").classList.toggle("searching", Boolean(query.trim()));
  document.querySelectorAll(".tabs button").forEach((button) =>
    button.classList.toggle("on", button.dataset.tab === tab));

  const rows = list.slice(0, shown).map((record) => {
    const statusText = record.status === STATUS.OUT
      ? `<span class="pill atiduotas">Atiduotas ${esc(showDate(record.given_date))}</span>
         ${record.given_to ? `<span class="sub">${esc(record.given_to)}</span>` : ""}`
      : `<span class="pill ${record.status}">${esc(statusName(record.status))}</span>`;
    const action = record.status === STATUS.OUT
      ? `<button type="button" data-return="${record.id}">Grąžinti</button>`
      : `<button type="button" data-give="${record.id}">Atiduoti</button>`;
    return `<tr data-row="${record.id}" class="${selected.has(record.id) ? "selected" : ""}">
      <td class="check"><input type="checkbox" data-select="${record.id}" ${selected.has(record.id) ? "checked" : ""}
          aria-label="Pažymėti ${esc(record.vin)}"></td>
      <td class="vin">${vinCell(record.vin)}</td>
      <td>${esc(record.make)}</td>
      <td>${esc(record.model)}${record.note ? `<span class="sub">${esc(record.note)}</span>` : ""}</td>
      <td>${esc(showDate(record.added))}</td>
      <td>${statusText}</td>
      <td class="actions">${action}</td>
    </tr>`;
  });
  $("rows").innerHTML = rows.join("") || `<tr><td colspan="7" class="empty">${
    query.trim() ? "Nieko nerasta." : records.length ? "Šiame sąraše tuščia." : "Dar nėra nė vieno liudijimo – įmeskite nuskenuotą PDF."
  }</td></tr>`;

  const more = list.length - shown;
  $("list-note").innerHTML = more > 0
    ? `Rodoma ${shown} iš ${list.length}. <button type="button" data-action="more">Rodyti daugiau</button>`
    : query.trim() ? `Rasta: ${list.length} (ieškoma visuose sąrašuose).` : "";

  const visibleIds = list.slice(0, shown).map((record) => record.id);
  $("check-all").checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  renderBulk();
}

function renderBulk() {
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  $("bulk").classList.toggle("hidden", selected.size === 0);
  $("bulk-count").textContent = `Pažymėta: ${selected.size}`;
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
}

// ---------------------------------------------------------------------------
// Atidavimas
// ---------------------------------------------------------------------------

function openGive(ids) {
  giveIds = ids.filter((id) => byId(id));
  if (!giveIds.length) return;
  const first = byId(giveIds[0]);
  $("give-title").textContent = giveIds.length === 1
    ? `Atiduoti ${first.vin || "liudijimą"}${first.model ? ` (${first.model})` : ""}`
    : `Atiduoti ${giveIds.length} liudijimus`;
  $("g-date").value = todayIso();
  $("g-to").value = "";
  $("g-note").value = "";
  $("give").showModal();
  $("g-to").focus();
}

async function give() {
  const changes = {
    status: STATUS.OUT, given_date: $("g-date").value || todayIso(),
    given_to: $("g-to").value.trim(),
  };
  const note = $("g-note").value.trim();
  for (const id of giveIds) {
    const record = byId(id);
    if (record) await update(record, note ? { ...changes, note } : changes);
  }
  status(`Atiduota: ${giveIds.length}.`, true);
  giveIds.forEach((id) => selected.delete(id));
  giveIds = [];
  render();
}

async function returnRecords(ids) {
  const list = ids.map(byId).filter((record) => record && record.status === STATUS.OUT);
  if (!list.length) return;
  if (!confirm(list.length === 1
    ? `Grąžinti ${list[0].vin} į turimus? Atidavimo data ir gavėjas bus ištrinti.`
    : `Grąžinti ${list.length} liudijimus į turimus?`)) return;
  for (const record of list) await update(record, { status: STATUS.IN, given_date: "", given_to: "" });
  render();
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
  $("d-vin-hint").textContent = text;
}

async function openDetail(id) {
  const record = byId(id);
  if (!record) return;
  detailId = id;
  $("detail-title").textContent = [record.make, record.model].filter(Boolean).join(" ") || "Liudijimas";
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
}

// ---------------------------------------------------------------------------
// PDF ir pažymos
// ---------------------------------------------------------------------------

async function downloadPdfs(ids) {
  const list = ids.map(byId).filter(Boolean);
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
}

async function templateBytes() {
  const stored = await getTemplate();
  if (stored) return stored.bytes;
  const response = await fetch(new URL("../../blank-template.docx", import.meta.url));
  return new Uint8Array(await response.arrayBuffer());
}

function pazymaValues(record) {
  const coc = record.coc || {};
  return buildValues({
    ...coc,
    make: record.make, commercial_name: record.model, type_variant_version: record.tvv,
    vin: record.vin, national_approval_number: coc.national_approval_number || "",
  }, todayIso());
}

async function makePazymos(ids) {
  const list = ids.map(byId).filter(Boolean);
  if (!list.length) return;
  const missing = list.filter((record) => !(record.coc || {}).colour || !(record.coc || {}).approval_number);
  if (missing.length && !confirm(
    `${missing.length === 1 ? "Šiame liudijime" : `${missing.length} liudijimuose`} trūksta spalvos arba tipo patvirtinimo Nr. `
    + "(jie dažnai būna kitoje CoC pusėje). Pažymoje tie laukai liks tušti.\n\nVis tiek generuoti?")) return;
  const template = await templateBytes();
  const documents = list.map((record) => {
    const values = pazymaValues(record);
    return [suggestedFilename(values), fillTemplate(template, values).bytes];
  });
  const type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (documents.length === 1) download(documents[0][1], documents[0][0], type);
  else download(zipDocuments(documents), "aiksteles.zip", "application/zip");
}

// ---------------------------------------------------------------------------
// Atsarginė kopija
// ---------------------------------------------------------------------------

function dataStatus(text) { $("data-status").textContent = text; }

async function backup() {
  dataStatus("Ruošiama kopija…");
  const files = { "sandelis.json": strToU8(JSON.stringify({ version: 1, saved: now(), records }, null, 1)) };
  for (const record of records) {
    const bytes = await getPdf(record.id);
    if (bytes) files[`pdf/${record.id}.pdf`] = bytes;
  }
  // PDF jau suspausti – spaudžiant dar kartą tik gaištamas laikas.
  download(zipSync(files, { level: 0 }), `coc-sandelis_${todayIso()}.zip`, "application/zip");
  await setMeta("lastBackup", now());
  dataStatus(`Kopija atsisiųsta (${records.length} įraš.). Laikykite ją ne šiame kompiuteryje.`);
  renderBackupState();
}

async function restore(file) {
  if (!file) return;
  try {
    dataStatus("Skaitoma kopija…");
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!files["sandelis.json"]) throw new Error("tai ne sandėlio kopija");
    const incoming = JSON.parse(strFromU8(files["sandelis.json"])).records || [];
    const plan = mergePlan(records, incoming);
    for (const record of plan.add) await addRecord(record, files[`pdf/${record.id}.pdf`] || null);
    for (const record of plan.replace) await saveRecord(record);
    records = await allRecords();
    render();
    dataStatus(`Kopija įkelta: pridėta ${plan.add.length}, atnaujinta ${plan.replace.length}, jau buvo ${plan.skip}.`);
    runQueue();
  } catch (error) {
    dataStatus(`Nepavyko įkelti kopijos: ${error.message || error}`);
  }
}

async function renderBackupState() {
  const last = await getMeta("lastBackup").catch(() => null);
  const due = backupDue(last, records.filter((record) => record.status !== STATUS.REVIEW).length);
  $("backup-due").hidden = !due;
  $("backup-due-text").textContent = last
    ? `Paskutinė kopija – ${showDate(last)}. Visi duomenys yra tik šiame kompiuteryje.`
    : "Kopija dar nedaryta. Visi duomenys yra tik šiame kompiuteryje.";
  const usage = await usageMb();
  const parts = [
    last ? `Paskutinė kopija: ${showDate(last)}.` : "Kopija dar nedaryta.",
    usage !== null ? `Užimama vietos: ${usage.toFixed(0)} MB.` : "",
  ];
  if (!$("data-status").textContent || $("data-status").dataset.auto) {
    $("data-status").textContent = parts.filter(Boolean).join(" ");
    $("data-status").dataset.auto = "1";
  }
}

// ---------------------------------------------------------------------------
// Įvykiai
// ---------------------------------------------------------------------------

$("drop").addEventListener("click", () => $("files").click());
$("files").addEventListener("change", (event) => { handleFiles(event.target.files); event.target.value = ""; });
["dragenter", "dragover"].forEach((type) =>
  $("drop").addEventListener(type, (event) => { event.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((type) =>
  $("drop").addEventListener(type, (event) => { event.preventDefault(); $("drop").classList.remove("over"); }));
$("drop").addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

// Patikros kortelės
let saveTimers = {};
$("review-list").addEventListener("input", (event) => {
  const input = event.target;
  const card = input.closest(".card");
  if (!card || !input.dataset.field) return;
  const record = byId(card.dataset.id);
  if (!record) return;
  record[input.dataset.field] = input.value;
  record.touched = true;
  if (input.dataset.field === "vin") {
    const [kind, text] = vinHint(record);
    const hint = card.querySelector(".hint");
    hint.className = `hint ${kind}`;
    hint.textContent = text;
  }
  clearTimeout(saveTimers[record.id]);
  saveTimers[record.id] = setTimeout(() => update(record, {}), 400);
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
  confirmRecord(event.target.closest(".card").dataset.id);
});
$("review-list").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.open) openPdf(target.dataset.open);
  if (target.dataset.confirm) confirmRecord(target.dataset.confirm);
  if (target.dataset.remove) removeRecord(target.dataset.remove);
});

// Paieška ir sąrašas
$("q").addEventListener("input", () => { shown = PAGE; renderTable(); renderAnswer($("q").value); });
$("q").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { $("q").value = ""; $("q").dispatchEvent(new Event("input")); }
});
document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => {
  tab = button.dataset.tab;
  shown = PAGE;
  if ($("q").value) $("q").value = "";
  renderTable();
  renderAnswer("");
}));
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
$("check-all").addEventListener("change", (event) => {
  const ids = visibleRecords().slice(0, shown).map((record) => record.id);
  ids.forEach((id) => (event.target.checked ? selected.add(id) : selected.delete(id)));
  renderTable();
});

// Mygtukai su data-action
const ACTIONS = {
  backup,
  restore: () => $("restore-file").click(),
  csv: () => {
    const list = records.filter((record) => record.status !== STATUS.REVIEW).sort(newestFirst);
    download(strToU8(toCsv(list)), `coc-sandelis_${todayIso()}.csv`, "text/csv;charset=utf-8");
  },
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

// ---------------------------------------------------------------------------
// Paleidimas
// ---------------------------------------------------------------------------

async function start() {
  try {
    records = await allRecords();
  } catch (error) {
    status(`Nepavyko atidaryti duomenų: ${error.message || error}`);
    records = [];
  }
  // Puslapį uždarius vidury skaitymo, tas lapas skaitomas iš naujo.
  for (const record of records) if (record.ocr === "skaitoma") record.ocr = "laukia";
  render();
  renderBackupState();
  if (records.some((record) => record.ocr === "laukia")) {
    status("Tęsiamas neperskaitytų lapų atpažinimas…");
    runQueue();
  } else {
    warmUp();
  }
  if (records.length) askPersistence();
}

start();

/** Ar serveryje yra naujesnė versija (kaip ir pažymų puslapyje). */
async function checkVersion() {
  $("version").textContent = `versija ${VERSION.replace("aikstele-", "")}`;
  try {
    const response = await fetch(new URL("../../version.js", import.meta.url), { cache: "no-store" });
    const latest = ((await response.text()).match(/VERSION = "([^"]+)"/) || [])[1];
    if (latest && latest !== VERSION) $("update").hidden = false;
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
