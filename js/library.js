// Tab 1 — company stamp & signature library (stored locally).
import { CATEGORIES } from "./config.js";
import { store } from "./db.js";
import { prepareAsset, removeBackground, loadImage, canvasToBlob } from "./imaging.js";
import { assetById, assetUrl, forget, newId, now, refresh, state } from "./store.js";
import { $, $$, confirmDialog, debounce, el, fmt, toast, withBusy } from "./ui.js";

let onChanged = () => {};
export function onLibraryChange(fn) { onChanged = fn; }

// ---------------------------------------------------------------- companies
export function renderCompanies() {
  const list = $("#companyList");
  list.replaceChildren(
    el("li", { class: state.activeCompanyId ? "" : "is-active", onclick: () => selectCompany("") }, [
      el("span", { text: "All companies" }),
      el("span", { class: "count", text: String(state.assets.length) }),
    ]),
  );
  for (const c of state.companies) {
    list.append(el("li", {
      class: c.id === state.activeCompanyId ? "is-active" : "",
      onclick: () => selectCompany(c.id),
    }, [
      el("span", { text: c.name }),
      el("span", { class: "count", text: String(state.assets.filter((a) => a.companyId === c.id).length) }),
    ]));
  }
  fillCompanySelects();
}

function fillCompanySelects() {
  const opts = () => state.companies.map((c) => el("option", { value: c.id, text: c.name }));
  const ws = $("#wsCompany");
  const keepWs = ws.value;
  ws.replaceChildren(el("option", { value: "", text: "All companies" }), ...opts());
  ws.value = keepWs;
  const dlg = $("#aCompany");
  const keep = dlg.value || state.activeCompanyId;
  dlg.replaceChildren(...opts());
  if (keep) dlg.value = keep;
}

export function selectCompany(id) {
  state.activeCompanyId = id;
  const company = state.companies.find((c) => c.id === id);
  $("#libraryTitle").textContent = company ? company.name : "All assets";
  $("#librarySubtitle").textContent = company
    ? [company.gstin && `GSTIN ${company.gstin}`, company.notes].filter(Boolean).join(" · ") ||
      "Stamps and signatures stored for this company."
    : "Stamps and signatures saved in this browser.";
  $("#editCompanyBtn").disabled = !company;
  $("#deleteCompanyBtn").disabled = !company;
  renderCompanies();
  renderAssets();
}

async function companyDialog(company) {
  const dlg = $("#companyDialog");
  $("#companyDialogTitle").textContent = company ? "Edit company" : "New company";
  $("#cName").value = company?.name || "";
  $("#cGstin").value = company?.gstin || "";
  $("#cNotes").value = company?.notes || "";
  dlg.showModal();
  const result = await new Promise((r) => dlg.addEventListener("close", () => r(dlg.returnValue), { once: true }));
  if (result !== "save") return;

  const name = $("#cName").value.trim();
  if (!name) return toast("Company name is required.", "error");
  if (state.companies.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== company?.id)) {
    return toast("You already have a company with that name.", "error");
  }
  const record = {
    id: company?.id || newId(),
    name,
    gstin: $("#cGstin").value.trim(),
    notes: $("#cNotes").value.trim(),
    createdAt: company?.createdAt || now(),
  };
  await store.put("companies", record);
  await refresh("companies");
  selectCompany(record.id);
  onChanged();
  toast(company ? "Company updated." : "Company created.", "success");
}

// ------------------------------------------------------------------- assets
function visibleAssets() {
  const q = $("#assetSearch").value.trim().toLowerCase();
  const cat = $("#categoryFilter").value;
  return state.assets.filter((a) =>
    (!state.activeCompanyId || a.companyId === state.activeCompanyId) &&
    (!cat || a.category === cat) &&
    (!q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)));
}

export function renderAssets() {
  const grid = $("#assetGrid");
  grid.className = `asset-grid${state.assetView === "list" ? " list-mode" : ""}`;
  grid.replaceChildren();
  const items = visibleAssets();
  $("#assetEmpty").hidden = items.length > 0;

  for (const asset of items) {
    const company = state.companies.find((c) => c.id === asset.companyId);
    grid.append(el("div", { class: "asset-card" }, [
      el("div", { class: "asset-thumb" }, [el("img", { src: assetUrl(asset), alt: asset.name, loading: "lazy" })]),
      el("div", { class: "asset-body" }, [
        el("strong", { text: asset.name }),
        el("div", { class: "asset-meta" }, [
          el("span", { text: company?.name || "—" }), el("span", { text: "·" }), el("span", { text: asset.category }),
        ]),
        el("div", { class: "asset-meta" }, [
          el("span", { text: `${asset.width}×${asset.height}` }), el("span", { text: "·" }),
          el("span", { text: fmt.bytes(asset.size) }), el("span", { text: "·" }),
          el("span", { text: asset.hasAlpha ? "transparent" : "opaque" }),
        ]),
      ]),
      el("div", { class: "asset-actions" }, [
        el("button", { text: "Rename", onclick: () => renameAsset(asset.id) }),
        el("button", { text: "Remove background", onclick: () => stripBackground(asset.id) }),
        el("button", { text: "Replace", onclick: () => replaceAsset(asset.id) }),
        el("button", { text: "Download", onclick: () => downloadAsset(asset.id) }),
        el("button", { class: "danger", text: "Delete", onclick: () => deleteAsset(asset.id) }),
      ]),
    ]));
  }
  onChanged();
}

async function renameAsset(id) {
  const asset = assetById(id);
  const name = prompt("Asset name", asset.name);
  if (name === null) return;
  if (!name.trim()) return toast("Name cannot be empty.", "error");
  await store.put("assets", { ...asset, name: name.trim(), updatedAt: now() });
  await refresh("assets");
  renderAssets();
  toast("Renamed.", "success");
}

async function stripBackground(id) {
  const asset = assetById(id);
  if (!(await confirmDialog("Remove background",
    `Create a transparent copy of “${asset.name}”? The original stays in your library.`, "Create copy"))) return;

  await withBusy("Removing background…", async () => {
    const img = await loadImage(asset.blob);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const cut = removeBackground(canvas);
    const blob = await canvasToBlob(cut);
    await store.put("assets", {
      ...asset,
      id: newId(),
      name: `${asset.name} (transparent)`.slice(0, 200),
      blob, width: cut.width, height: cut.height, hasAlpha: true, size: blob.size,
      createdAt: now(), updatedAt: now(),
    });
    await refresh("assets");
    renderCompanies(); renderAssets();
    toast("Transparent copy created.", "success");
  });
}

function pickFile(accept = "image/*") {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept, hidden: true });
    input.addEventListener("change", () => { resolve(input.files[0] || null); input.remove(); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

async function replaceAsset(id) {
  const file = await pickFile();
  if (!file) return;
  const asset = assetById(id);
  await withBusy("Replacing image…", async () => {
    const prepared = await prepareAsset(file);
    forget(`asset:${asset.id}:${asset.updatedAt}`);
    await store.put("assets", {
      ...asset, blob: prepared.blob, width: prepared.width, height: prepared.height,
      hasAlpha: prepared.hasAlpha, size: prepared.blob.size, updatedAt: now(),
    });
    await refresh("assets");
    renderAssets();
    toast("Image replaced.", "success");
  });
}

function downloadAsset(id) {
  const asset = assetById(id);
  const a = el("a", { href: assetUrl(asset), download: `${asset.name}.png` });
  document.body.append(a); a.click(); a.remove();
}

async function deleteAsset(id) {
  const asset = assetById(id);
  if (!(await confirmDialog("Delete asset", `“${asset.name}” will be removed from this browser.`))) return;
  forget(`asset:${asset.id}:${asset.updatedAt}`);
  await store.del("assets", id);
  await refresh("assets");
  renderCompanies(); renderAssets();
  toast("Asset deleted.", "success");
}

// ------------------------------------------------------------ upload dialog
function setupAssetDialog() {
  const dlg = $("#assetDialog");
  const drop = $("#assetDrop");
  const input = $("#assetFile");
  const preview = $("#assetPreview");
  let chosen = null;

  const show = (file) => {
    chosen = file;
    preview.hidden = !file;
    $("#assetDropText").hidden = !!file;
    if (file) {
      preview.src = URL.createObjectURL(file);
      if (!$("#aName").value.trim()) $("#aName").value = file.name.replace(/\.[^.]+$/, "");
    }
  };

  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => show(input.files[0] || null));
  ["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, () => drop.classList.remove("is-over")));
  drop.addEventListener("drop", (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) show(f); });
  $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));

  $("#assetForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!chosen) return toast("Choose an image first.", "error");
    const companyId = $("#aCompany").value;
    if (!companyId) return toast("Create a company first.", "error");

    await withBusy("Saving asset…", async () => {
      const prepared = await prepareAsset(chosen, { strip: $("#aStrip").checked });
      await store.put("assets", {
        id: newId(), companyId,
        name: $("#aName").value.trim().slice(0, 200) || "Untitled",
        category: CATEGORIES.includes($("#aCategory").value) ? $("#aCategory").value : "Other",
        description: $("#aDesc").value.trim().slice(0, 2000),
        blob: prepared.blob, width: prepared.width, height: prepared.height,
        hasAlpha: prepared.hasAlpha, size: prepared.blob.size,
        originalName: chosen.name, createdAt: now(), updatedAt: now(),
      });
      dlg.close();
      show(null);
      $("#assetForm").reset();
      $("#aStrip").checked = true;
      await refresh("assets");
      renderCompanies(); renderAssets();
      toast("Asset saved to the library.", "success");
    });
  });

  return () => {
    if (!state.companies.length) {
      toast("Create a company first — assets are grouped per company.", "error");
      return companyDialog(null);
    }
    $("#aCompany").value = state.activeCompanyId || state.companies[0].id;
    dlg.showModal();
  };
}

// --------------------------------------------------------------------- init
export function initLibrary() {
  const openAssetDialog = setupAssetDialog();
  const fill = (node, allLabel) => node.replaceChildren(
    ...(allLabel ? [el("option", { value: "", text: allLabel })] : []),
    ...CATEGORIES.map((c) => el("option", { value: c, text: c })),
  );
  fill($("#categoryFilter"), "All categories");
  fill($("#wsCategory"), "All categories");
  fill($("#aCategory"), null);

  $("#addCompanyBtn").addEventListener("click", () => companyDialog(null));
  $("#editCompanyBtn").addEventListener("click", () => {
    const c = state.companies.find((x) => x.id === state.activeCompanyId);
    if (c) companyDialog(c);
  });
  $("#deleteCompanyBtn").addEventListener("click", async () => {
    const c = state.companies.find((x) => x.id === state.activeCompanyId);
    if (!c) return;
    const count = state.assets.filter((a) => a.companyId === c.id).length;
    if (!(await confirmDialog("Delete company", `“${c.name}” and its ${count} asset(s) will be removed.`))) return;
    for (const a of state.assets.filter((x) => x.companyId === c.id)) await store.del("assets", a.id);
    await store.del("companies", c.id);
    await refresh("companies", "assets");
    selectCompany("");
    toast("Company deleted.", "success");
  });

  $("#addAssetBtn").addEventListener("click", openAssetDialog);
  document.addEventListener("click", (ev) => {
    if (ev.target.closest('[data-action="add-asset"]')) openAssetDialog();
  });
  $("#assetSearch").addEventListener("input", debounce(renderAssets, 200));
  $("#categoryFilter").addEventListener("change", renderAssets);
  $$("#assetViewToggle button").forEach((b) => b.addEventListener("click", () => {
    $$("#assetViewToggle button").forEach((x) => x.classList.toggle("is-active", x === b));
    state.assetView = b.dataset.mode;
    localStorage.setItem("stampdesk.assetView", state.assetView);
    renderAssets();
  }));
}

export { companyDialog };
