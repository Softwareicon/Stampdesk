// Tab 3 — stored documents and exported files, plus backup / restore.
import { exportBackup, importBackup, store, usage } from "./db.js";
import { objectUrl, refresh, state } from "./store.js";
import { openDocumentById } from "./workspace.js";
import { $, confirmDialog, debounce, el, fmt, toast, withBusy } from "./ui.js";

let goToWorkspace = () => {};
export function onOpenDocument(fn) { goToWorkspace = fn; }

function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

export async function renderHistory() {
  const q = $("#historySearch").value.trim().toLowerCase();

  const docs = $("#docHistory");
  docs.replaceChildren();
  const documents = state.documents.filter((d) => !q || d.name.toLowerCase().includes(q));
  if (!documents.length) {
    docs.append(el("li", {}, [el("span", { class: "hint", text: "Nothing opened yet." })]));
  }
  for (const d of documents) {
    const exportCount = state.exports.filter((e) => e.documentId === d.id).length;
    docs.append(el("li", {}, [
      el("div", { class: "meta" }, [
        el("strong", { text: d.name }),
        el("small", { text: `${d.pages.length} page(s) · ${fmt.bytes(d.size)} · ${fmt.date(d.createdAt)}${exportCount ? ` · ${exportCount} export(s)` : ""}` }),
      ]),
      el("button", { class: "btn btn-ghost btn-sm", text: "Open", onclick: async () => {
        goToWorkspace();
        await openDocumentById(d.id);
      } }),
      el("button", { class: "btn btn-ghost btn-sm", text: d.original ? "Original" : "PDF", onclick: () =>
        download(d.original || d.pdf, d.original ? d.name : `${d.name.replace(/\.pdf$/i, "")}.pdf`) }),
      el("button", { class: "btn btn-ghost btn-sm danger", text: "✕", onclick: async () => {
        if (!(await confirmDialog("Delete document", `“${d.name}” and its exports will be removed.`))) return;
        for (const e of state.exports.filter((x) => x.documentId === d.id)) await store.del("exports", e.id);
        await store.del("documents", d.id);
        await refresh("documents", "exports");
        renderHistory();
        toast("Document deleted.", "success");
      } }),
    ]));
  }

  const exports = $("#exportHistory");
  exports.replaceChildren();
  if (!state.exports.length) {
    exports.append(el("li", {}, [el("span", { class: "hint", text: "No stamped files yet." })]));
  }
  for (const e of state.exports) {
    exports.append(el("li", {}, [
      el("div", { class: "meta" }, [
        el("strong", { text: e.name }),
        el("small", { text: `${e.placementCount} placement(s)${e.flatten ? " · flattened" : ""} · ${fmt.bytes(e.size)} · ${fmt.date(e.createdAt)}` }),
      ]),
      el("button", { class: "btn btn-ghost btn-sm", text: "Download", onclick: () => download(e.blob, e.name) }),
      el("button", { class: "btn btn-ghost btn-sm danger", text: "✕", onclick: async () => {
        if (!(await confirmDialog("Delete export", `“${e.name}” will be removed.`))) return;
        await store.del("exports", e.id);
        await refresh("exports");
        renderHistory();
      } }),
    ]));
  }

  void objectUrl;
  await renderStorage();
}

async function renderStorage() {
  const node = $("#storageInfo");
  const est = await usage();
  if (!est || !est.quota) { node.textContent = "Everything is stored in this browser."; return; }
  const pct = Math.min(100, (est.used / est.quota) * 100);
  node.textContent = `Using ${fmt.bytes(est.used)} of about ${fmt.bytes(est.quota)} available in this browser (${pct.toFixed(1)}%).`;
}

export function initHistory() {
  $("#historySearch").addEventListener("input", debounce(renderHistory, 220));
  document.addEventListener("stampdesk:exported", () => { renderHistory().catch(() => {}); });

  $("#backupBtn").addEventListener("click", async () => {
    await withBusy("Preparing backup…", async () => {
      const blob = await exportBackup({ includeDocuments: $("#backupDocs").checked });
      download(blob, `stampdesk-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toast("Backup downloaded — keep it safe.", "success");
    });
  });

  $("#restoreBtn").addEventListener("click", () => $("#restoreInput").click());
  $("#restoreInput").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    const replace = await confirmDialog(
      "Restore backup",
      "Replace everything currently in this browser with the backup? Choose Cancel to merge instead.",
      "Replace",
    );
    await withBusy("Restoring…", async () => {
      const counts = await importBackup(file, { replace });
      await refresh();
      document.dispatchEvent(new CustomEvent("stampdesk:restored"));
      renderHistory();
      toast(`Restored ${counts.companies} company(ies) and ${counts.assets} asset(s).`, "success");
    });
  });

  $("#wipeBtn").addEventListener("click", async () => {
    if (!(await confirmDialog("Erase everything",
      "Every company, stamp, document and export in this browser will be deleted. This cannot be undone.",
      "Erase all"))) return;
    for (const name of ["companies", "assets", "documents", "exports", "presets"]) await store.clear(name);
    await refresh();
    document.dispatchEvent(new CustomEvent("stampdesk:restored"));
    renderHistory();
    toast("All local data erased.", "success");
  });
}
