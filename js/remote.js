// Shared library: companies and stamps are kept in the team's Google Sheet
// (through a Google Apps Script web app), so every user sees the same list.
// Documents, exports and presets stay in each user's own browser.
import { REMOTE } from "./config.js";

const KEY_STORAGE = "stampdesk.teamKey";
const SHARED = new Set(["companies", "assets"]);

export const isShared = (name) => SHARED.has(name);
export const remoteEnabled = () => Boolean(REMOTE.url);

let teamKey = null;
try { teamKey = localStorage.getItem(KEY_STORAGE); } catch { /* storage blocked */ }

export function getTeamKey() { return teamKey; }
export function setTeamKey(k) {
  teamKey = (k || "").trim() || null;
  try { teamKey ? localStorage.setItem(KEY_STORAGE, teamKey) : localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}

export class RemoteError extends Error {}

async function call(payload, { method = "POST" } = {}) {
  if (!remoteEnabled()) throw new RemoteError("Shared database is not configured.");
  if (!teamKey) throw new RemoteError("Enter the team key to use the shared database.");
  let res;
  try {
    if (method === "GET") {
      const qs = new URLSearchParams({ ...payload, key: teamKey });
      res = await fetch(`${REMOTE.url}?${qs}`, { redirect: "follow" });
    } else {
      // text/plain keeps this a "simple" request, so no CORS preflight is needed
      res = await fetch(REMOTE.url, {
        method: "POST", redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...payload, key: teamKey }),
      });
    }
  } catch {
    throw new RemoteError("Could not reach the Google Sheet. Check your internet connection.");
  }
  let data;
  try { data = await res.json(); } catch { throw new RemoteError("The Google Sheet sent an unexpected reply."); }
  if (!data.ok) {
    if (/team key/i.test(data.error || "")) setTeamKey(null);
    throw new RemoteError(data.error || "The Google Sheet refused the request.");
  }
  return data;
}

export const ping = () => call({ action: "ping" }, { method: "GET" });

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const base64ToBlob = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
};

function assetMeta(a) {
  const { blob, _remote, _imageAt, ...meta } = a;
  void blob; void _remote; void _imageAt;
  return meta;
}

/** Push one record to the sheet. `previous` is the local copy before this write. */
export async function push(name, value, previous) {
  if (name === "companies") {
    const { _remote, ...rec } = value; void _remote;
    await call({ action: "putCompany", record: { ...rec, updatedAt: rec.updatedAt || new Date().toISOString() } });
    return;
  }
  // re-upload the PNG only when it is new or actually changed (rename/edit keeps the same file)
  const sameImage = previous && previous._remote && previous.blob && value.blob &&
    previous.blob.size === value.blob.size && previous.width === value.width && previous.height === value.height;
  await call({
    action: "putAsset",
    record: assetMeta(value),
    image: sameImage ? null : await blobToBase64(value.blob),
  });
}

export async function remove(name, id) {
  await call({ action: name === "companies" ? "deleteCompany" : "deleteAsset", id });
}

/**
 * Make the local copy match the sheet.
 * - rows on the sheet are written locally (images downloaded only when new/changed)
 * - local rows that were never uploaded (made before sharing was switched on) are uploaded
 * - local rows that came from the sheet but are gone from it are removed
 */
export async function sync(local) {
  const data = await call({ action: "list" }, { method: "GET" });
  let changed = false;

  const localCompanies = new Map((await local.all("companies")).map((c) => [c.id, c]));
  const remoteCompanyIds = new Set();
  for (const c of data.companies) {
    remoteCompanyIds.add(c.id);
    const mine = localCompanies.get(c.id);
    const rec = { id: c.id, name: c.name, gstin: c.gstin || "", notes: c.notes || "", createdAt: c.createdAt, updatedAt: c.updatedAt, _remote: true };
    if (!mine || mine.name !== rec.name || mine.gstin !== rec.gstin || mine.notes !== rec.notes || !mine._remote) {
      await local.put("companies", rec); changed = true;
    }
  }
  for (const c of localCompanies.values()) {
    if (remoteCompanyIds.has(c.id)) continue;
    if (c._remote) { await local.del("companies", c.id); changed = true; continue; }
    await push("companies", c);                       // first-time upload of an older local company
    await local.put("companies", { ...c, _remote: true }); changed = true;
  }

  const localAssets = new Map((await local.all("assets")).map((a) => [a.id, a]));
  const remoteAssetIds = new Set();
  for (const a of data.assets) {
    remoteAssetIds.add(a.id);
    const mine = localAssets.get(a.id);
    const meta = {
      id: a.id, companyId: a.companyId, name: a.name, category: a.category || "Other",
      description: a.description || "", width: Number(a.width) || 0, height: Number(a.height) || 0,
      hasAlpha: String(a.hasAlpha) === "true", size: Number(a.size) || 0,
      originalName: a.originalName || "", createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
    if (mine && mine._remote && mine._imageAt === a.updatedAt && mine.blob) {
      if (mine.name !== meta.name || mine.category !== meta.category || mine.description !== meta.description || mine.companyId !== meta.companyId) {
        await local.put("assets", { ...mine, ...meta }); changed = true;
      }
      continue;
    }
    let blob = mine?.blob;
    if (!mine || mine.updatedAt !== a.updatedAt || !blob) {
      const img = await call({ action: "image", id: a.id }, { method: "GET" });
      blob = base64ToBlob(img.data);
    }
    await local.put("assets", { ...meta, blob, _remote: true, _imageAt: a.updatedAt }); changed = true;
  }
  for (const a of localAssets.values()) {
    if (remoteAssetIds.has(a.id)) continue;
    if (a._remote) { await local.del("assets", a.id); changed = true; continue; }
    await push("assets", a);
    await local.put("assets", { ...a, _remote: true, _imageAt: a.updatedAt }); changed = true;
  }
  return changed;
}
