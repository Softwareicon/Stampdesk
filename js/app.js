// Shell: tabs, theme, shortcuts, first-run intro. No sign-in, no server.
import { KEYS } from "./config.js";
import { requestPersistence } from "./db.js";
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

async function main() {
  applyTheme(localStorage.getItem(KEYS.theme) || "light");
  state.assetView = localStorage.getItem(KEYS.assetView) || "grid";
  $$("#assetViewToggle button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === state.assetView));

  initShell();
  initLibrary();
  initWorkspace();
  initHistory();

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

  if (!localStorage.getItem(KEYS.seenIntro)) {
    $("#introDialog").showModal();
    localStorage.setItem(KEYS.seenIntro, "1");
  }
}

main().catch((err) => {
  console.error(err);
  toast(err.message || "Something went wrong starting the app.", "error", 9000);
});
