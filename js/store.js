// In-memory mirror of the IndexedDB data, plus object-URL caching for images.
import { store, uid } from "./db.js";

export const state = {
  companies: [],
  assets: [],
  documents: [],
  exports: [],
  presets: [],
  activeCompanyId: "",
  assetView: "grid",
};

const urls = new Map();

export function objectUrl(key, blob) {
  if (urls.has(key)) return urls.get(key);
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

export function forget(key) {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
}

export const assetUrl = (asset) => objectUrl(`asset:${asset.id}:${asset.updatedAt}`, asset.blob);
export const assetById = (id) => state.assets.find((a) => a.id === id) || null;
export const companyById = (id) => state.companies.find((c) => c.id === id) || null;

export async function refresh(...names) {
  const all = names.length ? names : ["companies", "assets", "documents", "exports", "presets"];
  await Promise.all(all.map(async (name) => {
    const rows = await store.all(name);
    rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    state[name] = rows;
  }));
  state.companies.sort((a, b) => a.name.localeCompare(b.name));
}

export function assetCount(companyId) {
  return state.assets.filter((a) => a.companyId === companyId).length;
}

export const newId = uid;
export const now = () => new Date().toISOString();
