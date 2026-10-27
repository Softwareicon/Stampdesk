// Tab 2 — document workspace. Preview, placement, export; all in the browser.
import { LIMITS } from "./config.js";
import { store } from "./db.js";
import { DocumentError, getPdfjs, stampPdf, thumbnail, toPdf } from "./pdfops.js";
import { assetById, assetUrl, newId, now, objectUrl, refresh, state } from "./store.js";
import { $, $$, confirmDialog, debounce, el, fmt, toast, withBusy } from "./ui.js";
import { ALIGN_GRID, HANDLES, UNITS, alignRect, fromUnit, getUnit, isCorner, resizeRect, setUnit, toUnit } from "./geometry.js";

let doc = null;             // the stored document record
let pdfDoc = null;          // pdf.js handle
let pageNo = 0;
let zoom = 1;
let placements = [];
let selectedId = null;
let activeAssetId = null;
let undoStack = [];
let redoStack = [];
let seq = 0;
let unit = getUnit();
let marginPt = 28.35;        // 10 mm default gap from the page edge when aligning

const stage = () => $("#pageStage");
const overlay = () => $("#overlay");
const pageGeom = (i = pageNo) => doc.pages[i] || { width: 595, height: 842 };
const scale = () => ($("#pageCanvas").clientWidth / pageGeom().width) || 1;

// ------------------------------------------------------------- undo / redo
function snapshot() {
  undoStack.push(JSON.stringify(placements));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  syncHistoryButtons();
}
function syncHistoryButtons() {
  $("#undoBtn").disabled = !undoStack.length;
  $("#redoBtn").disabled = !redoStack.length;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(placements));
  placements = JSON.parse(undoStack.pop());
  selectedId = null; renderOverlay(); renderThumbDots(); syncHistoryButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(placements));
  placements = JSON.parse(redoStack.pop());
  selectedId = null; renderOverlay(); renderThumbDots(); syncHistoryButtons();
}

// ------------------------------------------------------------- page render
async function renderPage() {
  const page = await pdfDoc.getPage(pageNo + 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: zoom * dpr });
  const canvas = $("#pageCanvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;
  stage().style.width = canvas.style.width;
  stage().style.height = canvas.style.height;
  await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;

  $("#pageInput").value = String(pageNo + 1);
  $("#zoomLabel").textContent = `${Math.round(zoom * 100)}%`;
  $$("#thumbs .thumb").forEach((t, i) => t.classList.toggle("is-active", i === pageNo));
  renderOverlay();
}

function fitPage() {
  const avail = $("#canvasScroll").clientWidth - 56;
  zoom = Math.max(0.2, Math.min(3, avail / pageGeom().width));
  return renderPage();
}

async function renderThumbs() {
  const box = $("#thumbs");
  box.replaceChildren();
  for (let i = 0; i < doc.pages.length; i++) {
    const img = el("img", { alt: `Page ${i + 1}`, loading: "lazy" });
    box.append(el("div", {
      class: `thumb${i === pageNo ? " is-active" : ""}`,
      onclick: () => { pageNo = i; renderPage(); },
    }, [img, el("span", { class: "thumb-no", text: String(i + 1) })]));
    thumbnail(doc.pdf, i, 200)
      .then((blob) => { img.src = objectUrl(`thumb:${doc.id}:${i}`, blob); })
      .catch(() => {});
  }
  renderThumbDots();
}

function renderThumbDots() {
  $$("#thumbs .thumb").forEach((node, i) => {
    const has = placements.some((p) => p.page === i);
    const dot = node.querySelector(".thumb-dot");
    if (has && !dot) node.append(el("span", { class: "thumb-dot" }));
    if (!has && dot) dot.remove();
  });
}

// ------------------------------------------------------------------ overlay
function renderOverlay() {
  const box = overlay();
  box.replaceChildren();
  const s = scale();
  for (const p of placements.filter((x) => x.page === pageNo)) {
    const asset = assetById(p.assetId);
    const node = el("div", {
      class: `placement${p.id === selectedId ? " is-selected" : ""}`,
      "data-id": p.id,
      style: `left:${p.x * s}px; top:${p.y * s}px; width:${p.w * s}px; height:${p.h * s}px;
              transform: rotate(${p.rot}deg); opacity:${p.opacity};`,
    }, [el("img", { src: asset ? assetUrl(asset) : "", alt: "" })]);
    for (const h of HANDLES) node.append(el("span", { class: "handle", "data-h": h, title: handleTitle(h) }));
    box.append(node);
  }
  syncInspector();
}

const selected = () => placements.find((p) => p.id === selectedId) || null;

function handleTitle(h) {
  if (h === "rot") return "Drag to rotate (Shift snaps to 15°)";
  if (isCorner(h)) return "Drag to resize";
  return h === "n" || h === "s" ? "Drag to change height only" : "Drag to change width only";
}

function syncInspector() {
  const p = selected();
  $("#inspectorBody").hidden = !p;
  $("#inspectorEmpty").hidden = !!p;
  if (!p) return;
  const asset = assetById(p.assetId);
  $("#inspectorName").textContent = asset?.name || "Asset";
  if (asset) $("#inspectorImg").src = assetUrl(asset);
  $("#inX").value = toUnit(p.x, unit);
  $("#inY").value = toUnit(p.y, unit);
  $("#inW").value = toUnit(p.w, unit);
  $("#inH").value = toUnit(p.h, unit);
  $("#marginIn").value = toUnit(marginPt, unit);
  $("#inRot").value = String(Math.round(p.rot));
  $("#rotVal").textContent = `${Math.round(p.rot)}°`;
  $("#inOp").value = String(Math.round(p.opacity * 100));
  $("#opVal").textContent = `${Math.round(p.opacity * 100)}%`;
}

// --------------------------------------------------------------- placements
function addPlacement(assetId, xPt, yPt) {
  const asset = assetById(assetId);
  if (!asset) return;
  const aspect = asset.height ? asset.width / asset.height : 2;
  const geo = pageGeom();
  const w = Math.min(geo.width * 0.22, 150);
  const h = w / aspect;
  snapshot();
  const p = {
    id: `p${++seq}`, assetId, page: pageNo,
    x: Math.max(0, Math.min(geo.width - w, xPt - w / 2)),
    y: Math.max(0, Math.min(geo.height - h, yPt - h / 2)),
    w, h, rot: 0, opacity: 1,
  };
  placements.push(p);
  selectedId = p.id;
  renderOverlay(); renderThumbDots();
}

function updateSelected(patch) {
  const p = selected();
  if (!p) return;
  snapshot();
  Object.assign(p, patch);
  renderOverlay();
}

function deleteSelected() {
  if (!selectedId) return;
  snapshot();
  placements = placements.filter((p) => p.id !== selectedId);
  selectedId = null;
  renderOverlay(); renderThumbDots();
}

function duplicateSelected() {
  const p = selected();
  if (!p) return;
  snapshot();
  const copy = { ...p, id: `p${++seq}`, x: p.x + 12, y: p.y + 12 };
  placements.push(copy);
  selectedId = copy.id;
  renderOverlay();
}

function applyToAllPages() {
  const p = selected();
  if (!p) return;
  snapshot();
  const ref = pageGeom(p.page);
  for (let i = 0; i < doc.pages.length; i++) {
    if (i === p.page) continue;
    const geo = pageGeom(i);
    placements.push({
      ...p, id: `p${++seq}`, page: i,
      x: (p.x / ref.width) * geo.width, y: (p.y / ref.height) * geo.height,
      w: (p.w / ref.width) * geo.width, h: (p.h / ref.height) * geo.height,
    });
  }
  renderOverlay(); renderThumbDots();
  toast(`Copied to all ${doc.pages.length} pages.`, "success");
}

// ----------------------------------------------------------------- gestures
function clientToPt(ev) {
  const rect = $("#pageCanvas").getBoundingClientRect();
  const s = scale();
  return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s };
}

function initGestures() {
  const box = overlay();
  // A press on a stamp (to move/resize it) must not also count as a click on
  // the page — that used to drop a second copy of the stamp.
  let pressedStamp = false;

  box.addEventListener("pointerdown", (ev) => {
    const node = ev.target.closest(".placement");
    pressedStamp = Boolean(node);
    if (!node) { selectedId = null; renderOverlay(); return; }
    const p = placements.find((x) => x.id === node.dataset.id);
    if (!p) return;
    selectedId = p.id;
    renderOverlay();

    const handle = ev.target.classList.contains("handle") ? ev.target.dataset.h : null;
    const start = clientToPt(ev);
    const orig = { ...p };
    const geo = pageGeom();
    const lock = $("#lockAspect").checked;
    let moved = false;

    const live = $(`.placement[data-id="${p.id}"]`, box) || node;
    live.classList.add("is-dragging");
    live.setPointerCapture(ev.pointerId);

    const onMove = (e) => {
      const nowPt = clientToPt(e);
      const dx = nowPt.x - start.x;
      const dy = nowPt.y - start.y;
      if (!moved && Math.hypot(dx, dy) > 0.5) { snapshot(); moved = true; }
      if (!moved) return;

      if (!handle) {
        p.x = Math.max(-orig.w / 2, Math.min(geo.width - orig.w / 2, orig.x + dx));
        p.y = Math.max(-orig.h / 2, Math.min(geo.height - orig.h / 2, orig.y + dy));
      } else if (handle === "rot") {
        const cx = orig.x + orig.w / 2;
        const cy = orig.y + orig.h / 2;
        let deg = (Math.atan2(nowPt.y - cy, nowPt.x - cx) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        p.rot = ((Math.round(deg) % 360) + 360) % 360;
      } else {
        Object.assign(p, resizeRect(orig, handle, dx, dy, { lock }));
      }
      const s = scale();
      live.style.left = `${p.x * s}px`;
      live.style.top = `${p.y * s}px`;
      live.style.width = `${p.w * s}px`;
      live.style.height = `${p.h * s}px`;
      live.style.transform = `rotate(${p.rot}deg)`;
      syncInspector();
    };
    const onUp = () => {
      live.classList.remove("is-dragging");
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onUp);
      renderOverlay(); renderThumbDots();
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onUp);
  });

  box.addEventListener("click", (ev) => {
    if (pressedStamp) { pressedStamp = false; return; }
    if (ev.target.closest(".placement") || !activeAssetId) return;
    const pt = clientToPt(ev);
    addPlacement(activeAssetId, pt.x, pt.y);
  });

  stage().addEventListener("dragover", (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; });
  stage().addEventListener("drop", (ev) => {
    ev.preventDefault();
    const id = ev.dataTransfer.getData("text/asset-id");
    if (!id) return;
    const pt = clientToPt(ev);
    addPlacement(id, pt.x, pt.y);
  });
}

// -------------------------------------------------------------- asset panel
export function renderWorkspaceAssets() {
  const list = $("#wsAssetList");
  const companyId = $("#wsCompany").value;
  const category = $("#wsCategory").value;
  const q = $("#wsSearch").value.trim().toLowerCase();

  const items = state.assets.filter((a) =>
    (!companyId || a.companyId === companyId) &&
    (!category || a.category === category) &&
    (!q || a.name.toLowerCase().includes(q)));

  list.replaceChildren();
  if (!items.length) {
    list.append(el("p", { class: "hint pad", text: "No assets yet — add one in the Stamp Library tab." }));
    return;
  }
  for (const a of items) {
    const company = state.companies.find((c) => c.id === a.companyId);
    list.append(el("div", {
      class: `ws-asset${a.id === activeAssetId ? " is-active" : ""}`,
      draggable: "true",
      title: "Drag onto the page, or click then click the page",
      onclick: () => { activeAssetId = activeAssetId === a.id ? null : a.id; renderWorkspaceAssets(); },
      ondragstart: (ev) => { ev.dataTransfer.setData("text/asset-id", a.id); ev.dataTransfer.effectAllowed = "copy"; },
    }, [
      el("img", { src: assetUrl(a), alt: "" }),
      el("div", {}, [el("strong", { text: a.name }), el("small", { text: `${company?.name || "—"} · ${a.category}` })]),
    ]));
  }
}

// ------------------------------------------------------------------ opening
export async function openDocumentById(id) {
  const record = await store.get("documents", id);
  if (!record) return toast("That document is no longer stored.", "error");
  await withBusy("Opening document…", async () => {
    doc = record;
    const lib = await getPdfjs();
    pdfDoc = await lib.getDocument({ data: new Uint8Array(await record.pdf.arrayBuffer()) }).promise;

    placements = []; undoStack = []; redoStack = []; selectedId = null; pageNo = 0;
    $("#dropZone").hidden = true;
    $("#editor").hidden = false;
    $("#docName").textContent = record.name;
    $("#docMeta").textContent = `${record.pages.length} page${record.pages.length > 1 ? "s" : ""} · ${fmt.bytes(record.size)}`;
    $("#pageTotal").textContent = String(record.pages.length);
    $("#pageInput").max = String(record.pages.length);
    await renderThumbs();
    await fitPage();
    syncHistoryButtons();
  });
}

async function addDocument(file) {
  if (file.size > LIMITS.documentMb * 1024 * 1024) {
    throw new DocumentError(`That file is larger than the ${LIMITS.documentMb} MB limit.`);
  }
  const record = await withBusy("Reading document…", async () => {
    const { pdf, pages, sourceFormat } = await toPdf(file);
    if (pages.length > LIMITS.maxPages) throw new DocumentError(`Documents are limited to ${LIMITS.maxPages} pages.`);
    const rec = {
      id: newId(),
      name: file.name.replace(/[\\/]/g, "_").slice(0, 180) || "document.pdf",
      pdf, original: sourceFormat === "pdf" ? null : file,
      sourceFormat, pages, size: pdf.size, createdAt: now(),
    };
    await store.put("documents", rec);
    await refresh("documents");
    return rec;
  });
  await openDocumentById(record.id);
  toast(`${record.name} is ready.`, "success");
}

function closeDocument() {
  doc = null; pdfDoc = null; placements = []; selectedId = null;
  $("#editor").hidden = true;
  $("#dropZone").hidden = false;
}

// -------------------------------------------------------------------- export
async function exportPdf() {
  if (!doc) return;
  if (!placements.length) return toast("Place at least one stamp before exporting.", "error");

  await withBusy("Building the stamped PDF…", async () => {
    const blobs = new Map();
    for (const p of placements) {
      if (!blobs.has(p.assetId)) {
        const asset = assetById(p.assetId);
        if (!asset) throw new DocumentError("One of the stamps is no longer in your library.");
        blobs.set(p.assetId, asset.blob);
      }
    }
    const flatten = $("#flattenChk").checked;
    const out = await stampPdf(doc.pdf, placements, blobs, { flatten });

    const name = `${doc.name.replace(/\.pdf$/i, "")} - stamped.pdf`;
    const record = {
      id: newId(), documentId: doc.id, name, blob: out,
      placements: JSON.parse(JSON.stringify(placements)),
      placementCount: placements.length, flatten, size: out.size, createdAt: now(),
    };
    await store.put("exports", record);

    // keep storage tidy
    await refresh("exports");
    for (const old of state.exports.slice(LIMITS.keepExports)) await store.del("exports", old.id);
    await refresh("exports");

    const a = el("a", { href: URL.createObjectURL(out), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);

    toast("Stamped PDF downloaded.", "success");
    document.dispatchEvent(new CustomEvent("stampdesk:exported"));
  });
}

// ------------------------------------------------------------------ presets
export function renderPresets() {
  const list = $("#presetList");
  list.replaceChildren();
  if (!state.presets.length) {
    list.append(el("li", {}, [el("span", { class: "hint", text: "Save a placement to reuse it on other documents." })]));
    return;
  }
  for (const preset of state.presets) {
    list.append(el("li", {}, [
      el("button", { class: "use", text: preset.name, onclick: () => applyPreset(preset) }),
      el("button", { class: "del", text: "✕", title: "Delete preset", onclick: async () => {
        await store.del("presets", preset.id);
        await refresh("presets");
        renderPresets();
      } }),
    ]));
  }
}

function applyPreset(preset) {
  if (!doc) return toast("Open a document first.", "error");
  const asset = assetById(preset.assetId);
  if (!asset) return toast("That preset's asset is no longer in the library.", "error");
  const targets = preset.pageMode === "all"
    ? [...Array(doc.pages.length).keys()]
    : [preset.pageMode === "first" ? 0
      : preset.pageMode === "last" ? doc.pages.length - 1
      : Math.min(preset.pageIndex, doc.pages.length - 1)];

  snapshot();
  const aspect = asset.height ? asset.width / asset.height : 2;
  for (const idx of targets) {
    const geo = pageGeom(idx);
    const w = preset.w * geo.width;
    placements.push({
      id: `p${++seq}`, assetId: preset.assetId, page: idx,
      x: preset.x * geo.width, y: preset.y * geo.height,
      w, h: w / aspect, rot: preset.rotation, opacity: preset.opacity,
    });
  }
  pageNo = targets[0];
  renderPage(); renderThumbDots();
  toast(`Applied “${preset.name}”.`, "success");
}

async function savePreset() {
  const p = selected();
  if (!p) return;
  const asset = assetById(p.assetId);
  const name = prompt("Preset name",
    `${asset?.name || "Stamp"} — ${p.page === doc.pages.length - 1 ? "last page" : `page ${p.page + 1}`}`);
  if (!name) return;
  const geo = pageGeom(p.page);
  await store.put("presets", {
    id: newId(), name: name.trim(), assetId: p.assetId,
    pageMode: p.page === 0 ? "first" : p.page === doc.pages.length - 1 ? "last" : "index",
    pageIndex: p.page,
    x: p.x / geo.width, y: p.y / geo.height, w: p.w / geo.width,
    rotation: p.rot, opacity: p.opacity, createdAt: now(),
  });
  await refresh("presets");
  renderPresets();
  toast("Preset saved.", "success");
}

// --------------------------------------------------------------------- init
export function initWorkspace() {
  const dz = $("#dropZone");
  const fail = (e) => toast(e.message, "error");

  $("#pickDocBtn").addEventListener("click", () => $("#docInput").click());
  $("#docInput").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (f) addDocument(f).catch(fail);
  });
  ["dragenter", "dragover"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((e) => dz.addEventListener(e, () => dz.classList.remove("is-over")));
  dz.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer.files[0];
    if (f) addDocument(f).catch(fail);
  });

  $("#prevPage").addEventListener("click", () => { if (pageNo > 0) { pageNo--; renderPage(); } });
  $("#nextPage").addEventListener("click", () => { if (pageNo < doc.pages.length - 1) { pageNo++; renderPage(); } });
  $("#pageInput").addEventListener("change", (ev) => {
    pageNo = Math.max(1, Math.min(doc.pages.length, Number(ev.target.value) || 1)) - 1;
    renderPage();
  });
  $("#zoomIn").addEventListener("click", () => { zoom = Math.min(4, zoom * 1.2); renderPage(); });
  $("#zoomOut").addEventListener("click", () => { zoom = Math.max(0.15, zoom / 1.2); renderPage(); });
  $("#fitPage").addEventListener("click", fitPage);
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);
  $("#clearBtn").addEventListener("click", async () => {
    if (!placements.length) return;
    if (await confirmDialog("Clear placements", "Remove every stamp placed on this document?", "Clear")) {
      snapshot(); placements = []; selectedId = null; renderOverlay(); renderThumbDots();
    }
  });
  $("#closeDocBtn").addEventListener("click", closeDocument);
  $("#exportBtn").addEventListener("click", () => exportPdf().catch(fail));

  $("#delPlacementBtn").addEventListener("click", deleteSelected);
  $("#dupBtn").addEventListener("click", duplicateSelected);
  $("#applyAllBtn").addEventListener("click", applyToAllPages);
  $("#savePresetBtn").addEventListener("click", () => savePreset().catch(fail));
  $("#centerH").addEventListener("click", () => {
    const p = selected(); if (!p) return;
    updateSelected({ x: (pageGeom(p.page).width - p.w) / 2 });
  });

  for (const [id, key] of Object.entries({ inX: "x", inY: "y", inW: "w", inH: "h" })) {
    $(`#${id}`).addEventListener("change", (ev) => {
      const p = selected(); if (!p) return;
      if (ev.target.value === "" || !Number.isFinite(Number(ev.target.value))) return syncInspector();
      const v = fromUnit(ev.target.value, unit);
      const patch = { [key]: key === "w" || key === "h" ? Math.max(4, v) : v };
      if ($("#lockAspect").checked && (key === "w" || key === "h")) {
        const aspect = p.w / p.h;
        if (key === "w") patch.h = patch.w / aspect; else patch.w = patch.h * aspect;
      }
      updateSelected(patch);
    });
  }
  // units, alignment, nudging
  const fillUnits = () => {
    $("#unitSel").value = unit;
    $$(".unit-label").forEach((n) => { n.textContent = UNITS[unit].label; });
    for (const id of ["inX", "inY", "inW", "inH", "marginIn"]) $(`#${id}`).step = String(UNITS[unit].step);
  };
  $("#unitSel").replaceChildren(...Object.keys(UNITS).map((u) => el("option", { value: u, text: UNITS[u].label })));
  $("#unitSel").addEventListener("change", (ev) => { unit = ev.target.value; setUnit(unit); fillUnits(); syncInspector(); });
  fillUnits();
  $("#marginIn").addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v) && v >= 0) marginPt = fromUnit(v, unit);
  });
  $("#alignGrid").replaceChildren(...ALIGN_GRID.map(([code, glyph]) => el("button", {
    type: "button", class: "align-btn", text: glyph, title: alignTitle(code),
    onclick: () => {
      const p = selected(); if (!p) return;
      const r = alignRect(p, pageGeom(p.page), code, marginPt);
      updateSelected({ x: r.x, y: r.y });
    },
  })));
  $$("[data-nudge]").forEach((b) => b.addEventListener("click", () => {
    const p = selected(); if (!p) return;
    const [dx, dy] = b.dataset.nudge.split(",").map(Number);
    const step = UNITS[unit].perUnit * (unit === "pt" ? 1 : unit === "mm" ? 1 : unit === "cm" ? 0.1 : 0.05);
    updateSelected({ x: p.x + dx * step, y: p.y + dy * step });
  }));
  $("#fitWidthBtn").addEventListener("click", () => {
    const p = selected(); if (!p) return;
    const asset = assetById(p.assetId);
    if (!asset?.width || !asset?.height) return;
    updateSelected({ h: p.w * (asset.height / asset.width) });
    toast("Original proportions restored.", "success");
  });

  $("#inRot").addEventListener("input", (ev) => {
    const p = selected(); if (!p) return;
    p.rot = Number(ev.target.value);
    $("#rotVal").textContent = `${p.rot}°`;
    const node = $(`.placement[data-id="${p.id}"]`);
    if (node) node.style.transform = `rotate(${p.rot}deg)`;
  });
  $("#inRot").addEventListener("change", () => { snapshot(); renderOverlay(); });
  $("#inOp").addEventListener("input", (ev) => {
    const p = selected(); if (!p) return;
    p.opacity = Number(ev.target.value) / 100;
    $("#opVal").textContent = `${ev.target.value}%`;
    const node = $(`.placement[data-id="${p.id}"]`);
    if (node) node.style.opacity = String(p.opacity);
  });
  $("#inOp").addEventListener("change", () => { snapshot(); renderOverlay(); });

  $("#wsCompany").addEventListener("change", renderWorkspaceAssets);
  $("#wsCategory").addEventListener("change", renderWorkspaceAssets);
  $("#wsSearch").addEventListener("input", debounce(renderWorkspaceAssets, 200));

  initGestures();
  window.addEventListener("resize", debounce(() => { if (doc) renderOverlay(); }, 180));
}

function alignTitle(code) {
  const v = { t: "top", m: "middle", b: "bottom" }[code[0]];
  const h = { l: "left", c: "centre", r: "right" }[code[1]];
  return code === "mc" ? "Centre of the page" : `Align ${v} ${h} (uses the margin)`;
}

export function workspaceShortcut(ev) {
  if (!doc) return false;
  const typing = /input|textarea|select/i.test(ev.target.tagName);
  const mod = ev.ctrlKey || ev.metaKey;

  if (mod && ev.key.toLowerCase() === "z") { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return true; }
  if (mod && ev.key.toLowerCase() === "y") { ev.preventDefault(); redo(); return true; }
  if (mod && ev.key.toLowerCase() === "d") { ev.preventDefault(); duplicateSelected(); return true; }
  if (mod && ev.key.toLowerCase() === "s") { ev.preventDefault(); exportPdf().catch((e) => toast(e.message, "error")); return true; }
  if (typing) return false;

  if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSelected(); return true; }
  if (ev.key === "PageDown") { if (pageNo < doc.pages.length - 1) { pageNo++; renderPage(); } return true; }
  if (ev.key === "PageUp") { if (pageNo > 0) { pageNo--; renderPage(); } return true; }
  if (ev.key === "+" || ev.key === "=") { zoom = Math.min(4, zoom * 1.2); renderPage(); return true; }
  if (ev.key === "-") { zoom = Math.max(0.15, zoom / 1.2); renderPage(); return true; }

  const step = ev.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const p = selected();
  if (moves[ev.key] && p) {
    ev.preventDefault();
    snapshot();
    p.x += moves[ev.key][0];
    p.y += moves[ev.key][1];
    renderOverlay();
    return true;
  }
  return false;
}
