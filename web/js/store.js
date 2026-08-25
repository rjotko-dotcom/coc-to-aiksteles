// Šablono ir nustatymų saugojimas įrenginyje (IndexedDB).
//
// Blankas lieka Jūsų naršyklėje – niekur nesiunčiamas ir po perkrovimo vis dar
// čia. Ištrinamas mygtuku arba išvalius naršyklės duomenis.

const DB_NAME = "coc-aikstele";
const STORE = "files";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const get = (key) => run("readonly", (store) => store.get(key));
export const put = (key, value) => run("readwrite", (store) => store.put(value, key));
export const remove = (key) => run("readwrite", (store) => store.delete(key));

export async function getTemplate() {
  try {
    return (await get("template")) || null;
  } catch {
    return null;
  }
}

export async function saveTemplate(name, bytes) {
  await put("template", { name, bytes, saved: new Date().toISOString() });
}

export const clearTemplate = () => remove("template");

// --- Darbo eilė ------------------------------------------------------------
//
// Nuskaityti liudijimų duomenys išsaugomi šiame įrenginyje, kad atnaujinus
// puslapį ar netyčia jį uždarius nereikėtų viso atpažinimo kartoti. Ištrinami
// mygtuku „Išvalyti duomenis“.

export async function loadItems() {
  try {
    return (await get("items")) || [];
  } catch {
    return [];
  }
}

export async function saveItems(items) {
  try {
    await put("items", items);
  } catch {
    // jei įrenginyje neleidžiama saugoti, programa tiesiog veiks be atminties
  }
}

export const clearItems = () => remove("items").catch(() => {});
