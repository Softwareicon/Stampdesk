// Shell: tabs, theme, shortcuts, first-run intro, shared-library sync.
import { KEYS, REMOTE } from "./config.js";
import { local, requestPersistence } from "./db.js";
import * as remote from "./remote.js";
import { initHistory, onOpenDocument, renderHistory } from "./history.js";
import { initLibrary, onLibraryChange, renderAssets, renderCompanies, selectCompany } from "./library.js";
import { refresh, state } from "./store.js";
import { $, $$, toast } from "./ui.js";
import { initWorkspace, renderPresets, renderWorkspaceAssets, workspaceShortcut } from "./workspace.js";

let currentView = "library";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(KEYS.theme, theme);
}
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

function showView(name) {
  currentView = name;
  for (const v of ["library", "workspace", "history"]) $(`#view-${v}`).hidden = v !== name;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  if (name === "history") renderHistory().catch((e) => toast(e.message, "error"));
  if (name === "workspace") renderWorkspaceAssets();
}

function initShell() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#shortcutsBtn").addEventListener("click", () => $("#shortcutsDialog").showModal());
  $("#aboutBtn").addEventListener("click", () => $("#introDialog").showModal());
  $("#navToggle").addEventListener("click", () => {
    const side = currentView === "library" ? $("#librarySide") : $("#workspaceSide");
    side?.classList.toggle("is-collapsed");
  });

  onLibraryChange(() => renderWorkspaceAssets());
  onOpenDocument(() => showView("workspace"));
  document.addEventListener("stampdesk:restored", () => {
    renderCompanies(); renderAssets(); renderPresets(); renderWorkspaceAssets();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest("dialog")) return;
    if (currentView === "workspace" && workspaceShortcut(ev)) return;
    const typing = /input|textarea|select/i.test(ev.target.tagName);
    if (!typing && ev.key.toLowerCase() === "t" && !ev.ctrlKey && !ev.metaKey) toggleTheme();
  });
}

// ------------------------------------------------------------ shared library
let syncing = null;

function setPill(mode, title) {
  const pill = $("#syncPill");
  pill.classList.toggle("is-shared", mode === "shared");
  pill.classList.toggle("is-syncing", mode === "syncing");
  pill.classList.toggle("is-error", mode === "error");
  pill.textContent = { shared: "shared ✓", syncing: "syncing…", error: "sync error", offline: "offline" }[mode];
  pill.title = title || "";
}

function rerenderAll() {
  renderCompanies(); renderAssets(); renderPresets(); renderWorkspaceAssets();
}

async function askTeamKey(message = "") {
  const dlg = $("#teamKeyDialog");
  $("#teamKeyInput").value = "";
  $("#teamKeyError").hidden = !message;
  $("#teamKeyError").textContent = message;
  dlg.showModal();
  const result = await new Promise((r) => dlg.addEventListener("close", () => r(dlg.returnValue), { once: true }));
  if (result !== "save" || !$("#teamKeyInput").value.trim()) return false;
  remote.setTeamKey($("#teamKeyInput").value);
  try {
    await remote.ping();
    return true;
  } catch (err) {
    return askTeamKey(err.message);
  }
}

async function syncNow({ quiet = false } = {}) {
  if (!remote.remoteEnabled() || !remote.getTeamKey()) return;
  if (syncing) return syncing;
  setPill("syncing", "Syncing with the Google Sheet…");
  syncing = (async () => {
    try {
      const changed = await remote.sync(local);
      if (changed) {
        const active = state.activeCompanyId;
        await refresh("companies", "assets");
        if (active && !state.companies.some((c) => c.id === active)) selectCompany("");
        rerenderAll();
      }
      setPill("shared", `Shared library — synced ${new Date().toLocaleTimeString()}. Click to sync now.`);
    } catch (err) {
      setPill("error", `${err.message} Click to retry.`);
      if (!quiet) toast(err.message, "error", 7000);
      if (!remote.getTeamKey()) await connectShared();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function connectShared() {
  if (!remote.remoteEnabled()) { setPill("offline", "No server, no account, no internet needed"); return; }
  if (!remote.getTeamKey() && !(await askTeamKey())) {
    setPill("offline", "Working offline — click to connect to the shared library.");
    return;
  }
  await syncNow();
}

function initShared() {
  $("#syncPill").addEventListener("click", () => {
    if (!remote.remoteEnabled()) return;
    if (!remote.getTeamKey()) connectShared(); else syncNow();
  });
  document.addEventListener("stampdesk:remote-error", (ev) => {
    toast(`Not saved: ${ev.detail?.message || "Google Sheet unreachable."}`, "error", 8000);
    setPill("error", `${ev.detail?.message || ""} Click to retry.`);
  });
  if (!remote.remoteEnabled()) return;
  setInterval(() => { if (!document.hidden) syncNow({ quiet: true }); }, REMOTE.autoSyncSeconds * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow({ quiet: true }); });
}

async function main() {
  applyTheme(localStorage.getItem(KEYS.theme) || "light");
  state.assetView = localStorage.getItem(KEYS.assetView) || "grid";
  $$("#assetViewToggle button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === state.assetView));

  initShell();
  initLibrary();
  initWorkspace();
  initHistory();
  initShared();

  try {
    await refresh();
  } catch (err) {
    toast(err.message, "error", 9000);
  }
  selectCompany("");
  renderPresets();
  renderWorkspaceAssets();
  showView("library");

  // Ask the browser not to evict the library when disk space runs low.
  requestPersistence().then((ok) => {
    if (!ok) console.info("Storage is not marked persistent; take a backup regularly.");
  });

  if (!localStorage.getItem(KEYS.seenIntro) && !remote.remoteEnabled()) {
    $("#introDialog").showModal();
    localStorage.setItem(KEYS.seenIntro, "1");
  }
  await connectShared();
}

main().catch((err) => {
  console.error(err);
  toast(err.message || "Something went wrong starting the app.", "error", 9000);
});
