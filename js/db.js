// IndexedDB storage in the browser, plus the shared Google Sheet for
// companies and stamps (see remote.js).
import * as remote from "./remote.js";
import { getTeamKey, isShared, remoteEnabled } from "./remote.js";

const DB_NAME = "stampdesk";
const DB_VERSION = 1;
export const STORES = ["companies", "assets", "documents", "exports", "presets", "settings"];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("companies")) db.createObjectStore("companies", { keyPath: "id" });
      if (!db.objectStoreNames.contains("assets")) {
        const s = db.createObjectStore("assets", { keyPath: "id" });
        s.createIndex("companyId", "companyId");
      }
      if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents", { keyPath: "id" });
      if (!db.objectStoreNames.contains("exports")) {
        const s = db.createObjectStore("exports", { keyPath: "id" });
        s.createIndex("documentId", "documentId");
      }
      if (!db.objectStoreNames.contains("presets")) db.createObjectStore("presets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("This browser blocked local storage. Private/incognito windows often do — try a normal window."));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error || new Error("Storage write failed — your browser may be out of space."));
    t.onabort = () => reject(t.error || new Error("Storage write was aborted."));
  });
}

export const uid = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, "");

// Raw browser storage.
export const local = {
  get: (name, id) => tx(name, "readonly", (s) => s.get(id)),
  all: (name) => tx(name, "readonly", (s) => s.getAll()),
  put: (name, value) => tx(name, "readwrite", (s) => s.put(value)),
  del: (name, id) => tx(name, "readwrite", (s) => s.delete(id)),
  byIndex: (name, index, value) => tx(name, "readonly", (s) => s.index(index).getAll(value)),
  clear: (name) => tx(name, "readwrite", (s) => s.clear()),
};

// What the app uses. Companies and stamps are written to the shared Google
// Sheet first, so a save only "counts" once the whole team can see it.
// Without a team key (working offline) writes stay local and are uploaded
// automatically on the next successful connect.
const sharedOnline = (name) => isShared(name) && remoteEnabled() && Boolean(getTeamKey());
export const store = {
  ...local,
  async put(name, value) {
    if (!sharedOnline(name)) return local.put(name, value);
    try {
      const previous = await local.get(name, value.id);
      await remote.push(name, value, previous);
    } catch (err) { reportRemote(err); throw err; }
    const flags = name === "assets" ? { _remote: true, _imageAt: value.updatedAt } : { _remote: true };
    return local.put(name, { ...value, ...flags });
  },
  async del(name, id) {
    if (!sharedOnline(name)) return local.del(name, id);
    try { await remote.remove(name, id); } catch (err) { reportRemote(err); throw err; }
    return local.del(name, id);
  },
};

function reportRemote(err) {
  document.dispatchEvent(new CustomEvent("stampdesk:remote-error", { detail: err }));
}

export async function setting(key, value) {
  if (value === undefined) return (await store.get("settings", key))?.value;
  await store.put("settings", { key, value });
  return value;
}

/** Roughly how much space the browser has given us. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
  return { used, quota };
}

/** Ask the browser to keep this data even when disk space runs low. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

// --- backup / restore --------------------------------------------------------
const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const dataUrlToBlob = async (url) => (await fetch(url)).blob();

/** Everything in one JSON file, so the library can move to another device. */
export async function exportBackup({ includeDocuments = false } = {}) {
  const [companies, assets, presets] = await Promise.all([
    store.all("companies"), store.all("assets"), store.all("presets"),
  ]);
  const payload = {
    format: "stampdesk-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    companies,
    presets,
    assets: await Promise.all(assets.map(async (a) => ({ ...a, blob: await blobToDataUrl(a.blob) }))),
    documents: [],
  };
  if (includeDocuments) {
    const docs = await store.all("documents");
    payload.documents = await Promise.all(
      docs.map(async (d) => ({ ...d, pdf: await blobToDataUrl(d.pdf), original: null })),
    );
  }
  return new Blob([JSON.stringify(payload)], { type: "application/json" });
}

export async function importBackup(file, { replace = false } = {}) {
  const data = JSON.parse(await file.text());
  if (data.format !== "stampdesk-backup") throw new Error("That is not a StampDesk backup file.");
  if (replace) {
    await Promise.all(["companies", "assets", "presets", "documents", "exports"].map((s) => store.clear(s)));
  }
  for (const c of data.companies || []) await store.put("companies", c);
  for (const a of data.assets || []) await store.put("assets", { ...a, blob: await dataUrlToBlob(a.blob) });
  for (const p of data.presets || []) await store.put("presets", p);
  for (const d of data.documents || []) {
    await store.put("documents", { ...d, pdf: await dataUrlToBlob(d.pdf), original: null });
  }
  return {
    companies: (data.companies || []).length,
    assets: (data.assets || []).length,
    presets: (data.presets || []).length,
    documents: (data.documents || []).length,
  };
}
