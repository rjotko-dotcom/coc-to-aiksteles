// Sandėlio duomenys įrenginyje (IndexedDB).
//
// Įrašai (VIN, modelis, kam atiduota…) ir patys PDF laikomi atskirai, kad
// sąrašui parodyti nereikėtų įkelti šimtų megabaitų liudijimų.

const DB_NAME = "coc-sandelis";
const RECORDS = "records";
const PDFS = "pdfs";
const META = "meta";

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(RECORDS, { keyPath: "id" });
        db.createObjectStore(PDFS);
        db.createObjectStore(META);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function tx(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    Promise.resolve(work(transaction)).then((value) => { result = value; }, reject);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Įrašyti nepavyko."));
  });
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const allRecords = () => tx([RECORDS], "readonly",
  (t) => request(t.objectStore(RECORDS).getAll()));

/** Įrašas kartu su PDF – viena operacija, kad neliktų įrašo be failo. */
export const addRecord = (record, pdfBytes) => tx([RECORDS, PDFS], "readwrite", (t) => {
  t.objectStore(RECORDS).put(record);
  if (pdfBytes) t.objectStore(PDFS).put(pdfBytes, record.id);
});

export const saveRecord = (record) => tx([RECORDS], "readwrite",
  (t) => { t.objectStore(RECORDS).put(record); });

export const deleteRecord = (id) => tx([RECORDS, PDFS], "readwrite", (t) => {
  t.objectStore(RECORDS).delete(id);
  t.objectStore(PDFS).delete(id);
});

export const getPdf = (id) => tx([PDFS], "readonly", (t) => request(t.objectStore(PDFS).get(id)));

export const getMeta = (key) => tx([META], "readonly", (t) => request(t.objectStore(META).get(key)));
export const setMeta = (key, value) => tx([META], "readwrite",
  (t) => { t.objectStore(META).put(value, key); });

/**
 * Paprašo naršyklės duomenų netrinti.
 *
 * Be šito Chrome, pritrūkus vietos diske, gali pats išvalyti svetainės
 * duomenis. Įdiegtai programai leidimas paprastai suteikiamas iškart.
 */
export async function askPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Kiek vietos užima duomenys (MB) – rodoma apačioje. */
export async function usageMb() {
  try {
    const { usage } = await navigator.storage.estimate();
    return usage / 1024 / 1024;
  } catch {
    return null;
  }
}
