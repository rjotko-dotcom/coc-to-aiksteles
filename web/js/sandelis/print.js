// Aplanko lapas: išspausdinamas turimų CoC sąrašas, kurį galima įdėti į patį
// aplanką. Kiekvienas aplankas – atskirame lape. Spausdinama per paslėptą
// rėmelį, todėl veikia ir be interneto, o programos langas nesikeičia.

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const STYLE = `
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.35 "Segoe UI", Arial, sans-serif; color: #000; }
  section { break-after: page; }
  section:last-child { break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px;
    border-bottom: 2.5pt solid #000; padding-bottom: 6pt; margin-bottom: 10pt; }
  h1 { margin: 0; font-size: 26pt; line-height: 1.1; letter-spacing: -.01em; }
  .kind { font-size: 9pt; text-transform: uppercase; letter-spacing: .12em; color: #555; margin-bottom: 3pt; }
  .meta { text-align: right; font-size: 10pt; color: #333; white-space: nowrap; }
  .meta b { display: block; font-size: 16pt; color: #000; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #555;
    border-bottom: 1pt solid #000; padding: 4pt 6pt; }
  td { padding: 5pt 6pt; border-bottom: .5pt solid #bbb; vertical-align: middle; }
  tr { break-inside: avoid; }
  td.nr { width: 8mm; color: #666; font-size: 9pt; }
  td.vin { font-family: Consolas, "Courier New", monospace; font-size: 11.5pt; letter-spacing: .03em; white-space: nowrap; }
  td.vin b { font-size: 12.5pt; }
  td.check { width: 12mm; text-align: center; }
  td.check span { display: inline-block; width: 4.5mm; height: 4.5mm; border: 1pt solid #000; }
  footer { margin-top: 8pt; font-size: 8.5pt; color: #666; }
`;

function sheet(group, date) {
  const rows = group.records.map((record, index) => {
    const vin = record.vin || "";
    return `<tr>
      <td class="nr">${index + 1}</td>
      <td class="vin">${esc(vin.slice(0, -6))}<b>${esc(vin.slice(-6))}</b></td>
      <td>${esc(record.make)}</td>
      <td>${esc(record.model)}</td>
      <td class="check"><span></span></td>
    </tr>`;
  }).join("");
  return `<section>
    <header>
      <div><div class="kind">${group.special ? "Specialus aplankas" : "Modelio aplankas"}</div><h1>${esc(group.name)}</h1></div>
      <div class="meta"><b>${group.records.length} CoC</b>${esc(date)}</div>
    </header>
    <table>
      <thead><tr><th>Nr.</th><th>VIN</th><th>Markė</th><th>Modelis</th><th>Yra</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <footer>Sąrašas iš „CoC sandėlis“ – turimi liudijimai ${esc(date)} dienai.</footer>
  </section>`;
}

/** Išspausdina aplankų lapus. `groups` – iš `folderGroups()`. */
export function printFolderSheets(groups, date) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="lt"><head><meta charset="utf-8"><title>Aplankų sąrašai ${esc(date)}</title>
    <style>${STYLE}</style></head><body>${groups.map((group) => sheet(group, date)).join("")}</body></html>`);
  doc.close();
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
  // Leidžiame rėmeliui išsidėstyti, tada atidarome spausdinimo langą.
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, 100);
}
