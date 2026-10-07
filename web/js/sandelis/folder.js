// Duomenų aplankas kompiuteryje.
//
// Naršyklės duomenys dingsta išvalius Chrome („Clear browsing data“), todėl
// viskas papildomai įrašoma į Jūsų pasirinktą aplanką diske:
//
//   sandelis.json        – visas sąrašas (tas pats formatas kaip kopijos ZIP)
//   pdf/<id>.pdf         – kiekvieno liudijimo PDF
//   coc-sandelis.xlsx    – sąrašas Excel'iui (atsidaro ir be programos)
//
// Aplanko failai naršyklės valymo nepaliečia – iš jų viską galima atkurti.
// Naudojama Chrome / Edge „File System Access“ galimybė.

import { strFromU8, strToU8 } from "../../vendor/fflate/fflate.mjs";

export const supported = () => typeof window.showDirectoryPicker === "function";

/** Paprašo pasirinkti aplanką (reikia paspaudimo). Grąžina aplanko rankenėlę. */
export function pickFolder() {
  return window.showDirectoryPicker({ id: "coc-sandelis", mode: "readwrite", startIn: "documents" });
}

/**
 * Ar galima rašyti į aplanką. `ask` – paprašyti leidimo (tik po paspaudimo).
 * Chrome po perkrovimo kartais vėl klausia – tada užtenka vieno paspaudimo.
 */
export async function hasPermission(handle, ask = false) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  try {
    if (await handle.queryPermission(options) === "granted") return true;
    if (!ask) return false;
    return await handle.requestPermission(options) === "granted";
  } catch {
    return false;
  }
}

async function writeFile(directory, name, bytes) {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function exists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Įrašai be peržiūros paveikslėlių – jie tik padidintų failą. */
const lean = (records) => records.map(({ thumb, snippets, ...rest }) => rest);

/**
 * Įrašo sąrašą, Excel ir trūkstamus PDF.
 * `getPdf(id)` – iš kur paimti PDF; `xlsx` – paruoštas Excel failas.
 */
export async function save(handle, records, { getPdf, xlsx }) {
  const json = JSON.stringify({ version: 1, saved: new Date().toISOString(), records: lean(records) }, null, 1);
  await writeFile(handle, "sandelis.json", strToU8(json));
  if (xlsx) await writeFile(handle, "coc-sandelis.xlsx", xlsx);
  const folder = await handle.getDirectoryHandle("pdf", { create: true });
  for (const record of records) {
    const name = `${record.id}.pdf`;
    if (await exists(folder, name)) continue;
    const bytes = await getPdf(record.id);
    if (bytes) await writeFile(folder, name, bytes);
  }
}

/** Ištrina liudijimo PDF iš aplanko. */
export async function removePdf(handle, id) {
  try {
    const folder = await handle.getDirectoryHandle("pdf");
    await folder.removeEntry(`${id}.pdf`);
  } catch {
    // failo jau nėra – nieko blogo
  }
}

/** Perskaito aplanke esantį sąrašą: { records, pdf(id) } arba null, jei aplankas tuščias. */
export async function load(handle) {
  let text;
  try {
    const file = await (await handle.getFileHandle("sandelis.json")).getFile();
    text = strFromU8(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
  const records = JSON.parse(text).records || [];
  const pdf = async (id) => {
    try {
      const folder = await handle.getDirectoryHandle("pdf");
      const file = await (await folder.getFileHandle(`${id}.pdf`)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  };
  return { records, pdf };
}
