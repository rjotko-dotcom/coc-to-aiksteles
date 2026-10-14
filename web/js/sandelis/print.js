// Aplanko lapas: išspausdinamas turimų CoC sąrašas, kurį galima įdėti į patį
// aplanką. Viename lape – iki 30 CoC (dydžiai fiksuoti milimetrais, todėl
// tilpimas nepriklauso nuo naršyklės ar spausdintuvo); didesnis aplankas
// tęsiamas kitame lape su ta pačia antrašte ir ištisine numeracija. Spausdinama per paslėptą
// rėmelį, todėl veikia ir be interneto, o programos langas nesikeičia.

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// Paraštės lygios nuliui – tada naršyklė neprideda savo antraščių (datos, adreso).
const STYLE = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 10pt/1.3 "Segoe UI", Arial, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; width: 210mm; height: 296mm; padding: 13mm 13mm 0; overflow: hidden; break-after: page; }
  .page:last-child { break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: stretch; gap: 10mm; height: 18mm; margin-bottom: 5mm; }
  .lead { display: flex; align-items: stretch; gap: 4mm; }
  .code { display: flex; align-items: center; justify-content: center; min-width: 26mm; padding: 0 3mm; background: #111; color: #fff;
    font-size: 20pt; font-weight: 800; letter-spacing: .02em; border-radius: 1.5mm; }
  .title { border-left: 2.2mm solid #111; padding-left: 4mm; }
  .code + .title { border-left: 0; padding-left: 0; display: flex; flex-direction: column; justify-content: center; }
  .kind { font-size: 7.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .16em; color: #666; }
  h1 { margin: 1mm 0 0; font-size: 24pt; line-height: 1.05; letter-spacing: -.02em; font-weight: 700; }
  .stat { text-align: right; display: flex; flex-direction: column; justify-content: flex-end; }
  .stat b { font-size: 22pt; line-height: 1; font-weight: 700; }
  .stat span { font-size: 8pt; color: #666; margin-top: 1mm; text-transform: uppercase; letter-spacing: .1em; white-space: nowrap; }
  /* 30 eilučių po 7,2 mm + antraštė telpa tarp lapo antraštės ir poraštės. */
  .page { --row: 7.2mm; --font: 3.3mm; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  tr { height: var(--row); }
  th { text-align: left; font-size: min(6.5pt, calc(var(--font) * .8)); font-weight: 600; text-transform: uppercase; letter-spacing: .1em; color: #777;
    padding: 0 1.5mm; border-bottom: .45mm solid #111; vertical-align: bottom; padding-bottom: .8mm; }
  td { padding: 0 1.5mm; border-bottom: .2mm solid #ddd; vertical-align: middle; white-space: nowrap; overflow: hidden; line-height: 1; }
  tbody tr:nth-child(even) td { background: #f4f4f5; }
  .nr { width: calc(var(--font) * 2.4); }
  td.nr { color: #888; font-size: calc(var(--font) * .78); text-align: right; }
  .vin { width: calc(var(--font) * 12.8); }
  td.vin { font-family: Consolas, "Courier New", monospace; font-size: var(--font); letter-spacing: .02em; color: #555; }
  td.vin b { color: #000; font-weight: 700; }
  td.model { font-weight: 600; font-size: var(--font); text-overflow: ellipsis; }
  .make { width: 22mm; }
  td.make { color: #555; font-size: calc(var(--font) * .9); }
  .check { width: calc(var(--font) * 2.6); }
  td.check { text-align: center; }
  td.check i { display: inline-block; width: calc(var(--font) * 1.15); height: calc(var(--font) * 1.15); border: .3mm solid #111; border-radius: .5mm; vertical-align: middle; }
  footer { position: absolute; left: 13mm; right: 13mm; bottom: 8mm; display: flex; justify-content: space-between; font-size: 7pt; color: #888; border-top: .2mm solid #ccc; padding-top: 1.8mm; }
`;

/** Kiek CoC telpa į vieną lapą. */
export const PER_PAGE = 30;

/** Aplanko CoC suskirstymas į lapus po PER_PAGE. */
export function pagesFor(records) {
  const pages = [];
  for (let start = 0; start < records.length; start += PER_PAGE) pages.push(records.slice(start, start + PER_PAGE));
  return pages.length ? pages : [[]];
}

function table(records, offset, showMake) {
  const cols = `<colgroup><col class="nr"><col class="vin">${showMake ? '<col class="make">' : ""}<col class="model"><col class="check"></colgroup>`;
  const rows = records.map((record, index) => {
    const vin = record.vin || "";
    return `<tr>
      <td class="nr">${offset + index + 1}</td>
      <td class="vin">${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b></td>
      ${showMake ? `<td class="make">${esc(record.make)}</td>` : ""}
      <td class="model">${esc(record.model)}</td>
      <td class="check"><i></i></td>
    </tr>`;
  }).join("");
  return `<table>${cols}
    <thead><tr><th></th><th>VIN</th>${showMake ? "<th>Markė</th>" : ""}<th>Modelis</th><th>Yra</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function sheet(group, stamp) {
  const records = group.records;
  const makes = new Set(records.map((record) => (record.make || "").trim()).filter(Boolean));
  // Markės stulpelis – tik kai aplanke yra skirtingų markių.
  const showMake = makes.size > 1;
  const brand = makes.size === 1 ? [...makes][0] : "";
  const pages = pagesFor(records);
  return pages.map((chunk, index) => `<div class="page">
    <header>
      <div class="lead">${group.code ? `<div class="code">${esc(group.code)}</div>` : ""}<div class="title">
        <div class="kind">${group.special ? "Specialus aplankas" : "Modelio aplankas"}${brand ? ` · ${esc(brand)}` : ""}</div>
        <h1>${esc(group.name)}</h1>
      </div></div>
      <div class="stat"><b>${records.length}</b><span>CoC aplanke${group.part ? ` · aplankas ${esc(group.part)}` : ""}${pages.length > 1 ? ` · lapas ${index + 1} iš ${pages.length}` : ""}</span></div>
    </header>
    ${table(chunk, index * PER_PAGE, showMake)}
    <footer><span>CoC sandėlis · turimi liudijimai</span><span>Atspausdinta ${esc(stamp)}</span></footer>
  </div>`).join("");
}

/** Atspausdina HTML per paslėptą rėmelį. Grąžina rėmelį (bandymams). */
function printHtml(title, style, body, print = true) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  // Rėmelis A4 pločio (bet nematomas) – kad matavimai atitiktų tikrą lapą.
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "210mm", height: "297mm", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="lt"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${style}</style></head><body>${body}</body></html>`);
  doc.close();
  if (print) {
    frame.contentWindow.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 1000), { once: true });
    setTimeout(() => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 150);
  }
  return frame;
}

/** Išspausdina aplankų lapus. `groups` – [{ name, code, part, special, records }]. */
export function printFolderSheets(groups, stamp, { print = true } = {}) {
  return printHtml("Aplankų sąrašai", STYLE, groups.map((group) => sheet(group, stamp)).join(""), print);
}

// ---------------------------------------------------------------------------
// Perkėlimo sąrašas
// ---------------------------------------------------------------------------

const MOVE_STYLE = STYLE + `
  .to { display: flex; align-items: center; gap: 3mm; margin: 4mm 0 1.5mm; break-inside: avoid; }
  .to .code { min-width: 0; padding: 1mm 3mm; font-size: 13pt; border-radius: 1mm; }
  .to b { font-size: 11pt; }
  .to span { color: #666; font-size: 8.5pt; }
  .page.moves { height: auto; min-height: 296mm; padding-bottom: 20mm; overflow: visible; }
  .moves table { margin-bottom: 2mm; }
  .from { width: 22mm; }
  td.from { font-family: Consolas, monospace; color: #c3002f; font-weight: 700; }
`;

/**
 * Kur kurį CoC perkelti. `moves` – [{ record, from, to }]; sugrupuojama pagal
 * aplanką, į kurį dėti.
 */
export function printMoveSheet(binders, moves, stamp, { print = true } = {}) {
  const byTo = new Map();
  for (const move of moves) {
    if (!byTo.has(move.to)) byTo.set(move.to, []);
    byTo.get(move.to).push(move);
  }
  const info = new Map(binders.map((binder) => [binder.code, binder]));
  const sections = [...byTo].sort(([a], [b]) => a.localeCompare(b, "lt", { numeric: true })).map(([to, list]) => {
    const binder = info.get(to) || { group: "", records: [] };
    list.sort((a, b) => String(a.record.vin).localeCompare(String(b.record.vin)));
    const rows = list.map((move, index) => {
      const vin = move.record.vin || "";
      return `<tr><td class="nr">${index + 1}</td><td class="vin">${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b></td>
        <td class="model">${esc(move.record.model)}</td><td class="from">${esc(move.from || "—")}</td><td class="check"><i></i></td></tr>`;
    }).join("");
    return `<div class="to"><div class="code">${esc(to)}</div><b>${esc(binder.group)}</b>
        <span>dėti ${list.length} CoC · aplanke bus ${binder.records.length}</span></div>
      <table><colgroup><col class="nr"><col class="vin"><col class="model"><col class="from"><col class="check"></colgroup>
        <thead><tr><th></th><th>VIN</th><th>Modelis</th><th>Iš aplanko</th><th>Įdėta</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
  const body = `<div class="page moves">
    <header><div class="lead"><div class="title"><div class="kind">Aplankų tvarkymas</div><h1>Perkėlimo sąrašas</h1></div></div>
      <div class="stat"><b>${moves.length}</b><span>CoC perkelti</span></div></header>
    ${sections}
    <footer><span>CoC sandėlis · aplankai po 20</span><span>Atspausdinta ${esc(stamp)}</span></footer>
  </div>`;
  return printHtml("Perkėlimo sąrašas", MOVE_STYLE, body, print);
}

// ---------------------------------------------------------------------------
// Lipdukai aplankams
// ---------------------------------------------------------------------------

/**
 * Lipdukų lapų formatai (standartiniai A4 lipdukų lapai):
 * didelis – 99,1×67,7 mm, 8 lape (Avery L7165 / J8165);
 * mažas – 63,5×38,1 mm, 21 lape (Avery L7160 / J8160).
 */
export const LABEL_SIZES = {
  large: { w: 99.1, h: 67.7, cols: 2, rows: 4, top: 13.1, left: 4.65, gapX: 2.5, gapY: 0 },
  small: { w: 63.5, h: 38.1, cols: 3, rows: 7, top: 15.15, left: 7.2, gapX: 2.5, gapY: 0 },
};

/** Spausdina lipdukus aplankams. `binders` – iš `binderContents()`; `logo` – NISSAN užrašo SVG turinys. */
export function printBinderLabels(binders, size = "large", { print = true, logo = "" } = {}) {
  const f = LABEL_SIZES[size] || LABEL_SIZES.large;
  const k = f.h / 67.7;
  const word = logo || (typeof document !== "undefined" ? document.getElementById("nissan-word")?.innerHTML || "" : "");
  const style = `
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sheet { width: 210mm; height: 297mm; padding: ${f.top}mm 0 0 ${f.left}mm; display: grid;
      grid-template-columns: repeat(${f.cols}, ${f.w}mm); grid-auto-rows: ${f.h}mm; column-gap: ${f.gapX}mm; row-gap: ${f.gapY}mm;
      break-after: page; overflow: hidden; }
    .sheet:last-child { break-after: auto; }
    .label { position: relative; overflow: hidden; border-radius: 2.5mm; padding: ${6 * k}mm ${6.5 * k}mm ${5 * k}mm;
      display: flex; flex-direction: column; background: #fff; outline: .2mm dashed #e2e2e2; outline-offset: -.1mm; }
    .label::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: ${3.2 * k}mm; background: #111; }
    .label::after { content: ""; position: absolute; left: ${6.5 * k}mm; right: ${6.5 * k}mm; bottom: ${4.2 * k}mm; height: ${0.9 * k}mm; background: #c3002f; }
    .top { display: flex; justify-content: space-between; align-items: center; margin-left: ${1.5 * k}mm; }
    .top svg { height: ${3.4 * k}mm; width: auto; fill: #111; }
    .top span { font-size: ${7 * k}pt; font-weight: 700; letter-spacing: .24em; color: #111; }
    .top span i { font-style: normal; font-weight: 300; color: #777; margin-left: .3em; }
    .code { margin: ${2.5 * k}mm 0 0 ${1.2 * k}mm; font-size: ${44 * k}pt; font-weight: 800; line-height: .95; letter-spacing: -.02em; }
    .group { margin: ${1.6 * k}mm 0 0 ${1.5 * k}mm; display: flex; align-items: center; gap: ${2.4 * k}mm; }
    .group b { font-size: ${13 * k}pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .group em { font-style: normal; font-size: ${8.5 * k}pt; font-weight: 700; padding: ${0.5 * k}mm ${2 * k}mm; border: ${0.35 * k}mm solid #111; border-radius: 99px; white-space: nowrap; }
    .cap { margin: auto 0 ${3 * k}mm ${1.5 * k}mm; font-size: ${7 * k}pt; color: #777; letter-spacing: .08em; text-transform: uppercase; }
    ${size === "small" ? ".top span, .cap { display: none; } .code { margin-top: 1mm; }" : ""}
  `;
  const per = f.cols * f.rows;
  const cards = binders.map((binder) => `<div class="label">
      <div class="top"><svg viewBox="0 0 300 44.174264">${word}</svg><span>FAKTO<i>auto</i></span></div>
      <div class="code">${esc(binder.code)}</div>
      <div class="group"><b>${esc(binder.group)}</b>${binder.of > 1 ? `<em>${binder.index}/${binder.of}</em>` : ""}</div>
      <div class="cap">CoC aplankas · iki 20 liudijimų</div>
    </div>`);
  const sheets = [];
  for (let i = 0; i < cards.length; i += per) sheets.push(`<div class="sheet">${cards.slice(i, i + per).join("")}</div>`);
  return printHtml("Aplankų lipdukai", style, sheets.join(""), print);
}
