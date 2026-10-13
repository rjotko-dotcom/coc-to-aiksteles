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
      <div class="stat"><b>${records.length}</b><span>CoC aplanke${pages.length > 1 ? ` · lapas ${index + 1} iš ${pages.length}` : ""}</span></div>
    </header>
    ${table(chunk, index * PER_PAGE, showMake)}
    <footer><span>CoC sandėlis · turimi liudijimai</span><span>Atspausdinta ${esc(stamp)}</span></footer>
  </div>`).join("");
}

/** Išspausdina aplankų lapus. `groups` – iš `folderGroups()` (+ `code`). Grąžina rėmelį (bandymams). */
export function printFolderSheets(groups, stamp, { print = true } = {}) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  // Rėmelis A4 pločio (bet nematomas) – kad matavimai atitiktų tikrą lapą.
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "210mm", height: "297mm", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="lt"><head><meta charset="utf-8"><title>Aplankų sąrašai</title>
    <style>${STYLE}</style></head><body>${groups.map((group) => sheet(group, stamp)).join("")}</body></html>`);
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
