// Bulk stamping: many PDFs, one stamp, placed once on a sample page.
//   fixed mode — the same spot on every page (measured from the nearest edges)
//   smart mode — finds anchor text (e.g. "Authorised Signatory") on every page
//                and keeps the stamp at the same offset from it
// Everything runs in the browser; bills never leave the computer.
import { findAll, findBest, pageTextItems, suggestAnchors } from "./anchor.js";
import { LIMITS } from "./config.js";
import { store } from "./db.js";
import { ALIGN_GRID, HANDLES, UNITS, alignRect, fromUnit, getUnit, resizeRect, setUnit, toUnit } from "./geometry.js";
import { loadImage } from "./imaging.js";
import { DocumentError, getPdfjs, inspect, stampPdf } from "./pdfops.js";
import { assetById, assetUrl, newId, now, refresh, state } from "./store.js";
import { $, $$, el, fmt, toast, withBusy } from "./ui.js";
import { makeZip, uniqueNames } from "./zip.js";

const MAX_FILES = 200;
const PREVIEW_LIMIT = 60;

let files = [];            // { id, name, bytes, pages:[{width,height}], size, doc? }
let sample = { file: 0, page: 0 };
let rect = null;           // stamp rectangle on the sample page (pt, top-left origin)
let assetId = "";
let unit = getUnit();
let marginPt = 28.35;
let lastSampleAnchor = null;   // { box, frac } of the anchor text on the sample page
const textCache = new Map();

const sampleFile = () => files[sample.file] || null;
const sampleGeom = () => sampleFile()?.pages[sample.page] || { width: 595, height: 842 };
const mode = () => $('input[name="bulkMode"]:checked').value;
const anchorText = () => $("#anchorText").value.trim();
const canvasScale = () => ($("#bulkCanvas").clientWidth / sampleGeom().width) || 1;

// ------------------------------------------------------------------- files
async function pdfDocFor(f) {
  if (f.doc) return f.doc;
  const lib = await getPdfjs();
  f.doc = await lib.getDocument({ data: f.bytes.slice(0) }).promise;
  return f.doc;
}

async function textOf(f, i) {
  const key = `${f.id}:${i}`;
  if (!textCache.has(key)) {
    const doc = await pdfDocFor(f);
    textCache.set(key, await pageTextItems(await doc.getPage(i + 1)));
  }
  return textCache.get(key);
}

async function addFiles(list) {
  const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (!pdfs.length) return toast("Choose PDF files (other formats can be stamped one by one in Place on Document).", "error");
  if (files.length + pdfs.length > MAX_FILES) return toast(`Up to ${MAX_FILES} files at a time.`, "error");
  const problems = [];
  await withBusy("Reading PDF files…", async () => {
    for (const file of pdfs) {
      if (file.size > LIMITS.documentMb * 1024 * 1024) { problems.push(`${file.name}: larger than ${LIMITS.documentMb} MB`); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pages = await inspect(bytes);
        files.push({ id: newId(), name: file.name, bytes, pages, size: file.size });
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`);
      }
    }
  });
  if (problems.length) toast(`Skipped ${problems.length} file(s) — ${problems.join("; ")}`, "error", 9000);
  clearResults();
  renderFiles();
  if (files.length) await showSample(Math.min(sample.file, files.length - 1), sample.page);
}

function removeFile(id) {
  const i = files.findIndex((f) => f.id === id);
  if (i < 0) return;
  files[i].doc?.destroy();
  files.splice(i, 1);
  for (const k of [...textCache.keys()]) if (k.startsWith(`${id}:`)) textCache.delete(k);
  clearResults();
  renderFiles();
  if (!files.length) return;
  showSample(Math.min(sample.file, files.length - 1), 0);
}

function renderFiles() {
  const ul = $("#bulkFiles");
  ul.replaceChildren(...files.map((f, i) => el("li", { class: i === sample.file ? "is-sample" : "" }, [
    el("button", { class: "file-name", type: "button", title: "Use as sample", text: f.name, onclick: () => showSample(i, 0) }),
    el("small", { text: `${f.pages.length} p` }),
    el("button", { class: "file-del", type: "button", text: "✕", title: "Remove", onclick: () => removeFile(f.id) }),
  ])));
  const pages = files.reduce((s, f) => s + f.pages.length, 0);
  $("#bulkFilesInfo").textContent = files.length ? `${files.length} file(s) · ${pages} page(s)` : "";
  $("#bulkClear").hidden = !files.length;
  $("#bulkEmpty").hidden = files.length > 0;
  $("#bulkEditor").hidden = files.length === 0;
  $("#bulkSampleFile").replaceChildren(...files.map((f, i) => el("option", { value: String(i), text: f.name })));
  $("#bulkSampleFile").value = String(sample.file);
}

// ------------------------------------------------------------------ sample
async function showSample(fileIndex, pageIndex) {
  const f = files[fileIndex];
  if (!f) return;
  sample = { file: fileIndex, page: Math.max(0, Math.min(f.pages.length - 1, pageIndex)) };
  renderFiles();
  const doc = await pdfDocFor(f);
  const page = await doc.getPage(sample.page + 1);
  // fit the whole page in view, so the stamp and the found text are both visible
  const availW = Math.max(240, $("#bulkScroll").clientWidth - 40);
  const availH = Math.max(320, $("#bulkScroll").clientHeight - 40);
  const zoom = Math.min(2, availW / sampleGeom().width, availH / sampleGeom().height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: zoom * dpr });
  const canvas = $("#bulkCanvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${vp.width / dpr}px`;
  canvas.style.height = `${vp.height / dpr}px`;
  $("#bulkStage").style.width = canvas.style.width;
  $("#bulkStage").style.height = canvas.style.height;
  await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
  $("#bulkPageInput").value = String(sample.page + 1);
  $("#bulkPageTotal").textContent = String(f.pages.length);
  if (!rect) defaultRect();
  await refreshAnchor();
  renderOverlay();
}

function defaultRect() {
  const asset = assetById(assetId);
  const aspect = asset?.width && asset?.height ? asset.width / asset.height : 2;
  const w = Math.min(130, sampleGeom().width * 0.22);
  rect = alignRect({ x: 0, y: 0, w, h: w / aspect }, sampleGeom(), "br", marginPt);
}

// ----------------------------------------------------------------- overlay
function renderOverlay() {
  const box = $("#bulkOverlay");
  box.replaceChildren();
  const s = canvasScale();
  if (lastSampleAnchor && mode() === "smart") {
    const b = lastSampleAnchor.box;
    box.append(el("div", {
      class: "anchor-box", title: `Found “${anchorText()}”`,
      style: `left:${b.x * s - 3}px; top:${b.y * s - 3}px; width:${b.w * s + 6}px; height:${b.h * s + 6}px;`,
    }, [el("span", { text: "✨ found" })]));
  }
  const asset = assetById(assetId);
  if (!asset || !rect) return syncInspector();
  const node = el("div", {
    class: "placement is-selected", "data-id": "bulk",
    style: `left:${rect.x * s}px; top:${rect.y * s}px; width:${rect.w * s}px; height:${rect.h * s}px;
            transform: rotate(${Number($("#bulkRot").value)}deg); opacity:${Number($("#bulkOp").value) / 100};`,
  }, [el("img", { src: assetUrl(asset), alt: "" })]);
  for (const h of HANDLES.filter((x) => x !== "rot")) node.append(el("span", { class: "handle", "data-h": h }));
  box.append(node);
  syncInspector();
}

function syncInspector() {
  const ids = { bX: "x", bY: "y", bW: "w", bH: "h" };
  for (const [id, key] of Object.entries(ids)) $(`#${id}`).value = rect ? toUnit(rect[key], unit) : "";
  $("#bMargin").value = toUnit(marginPt, unit);
}

function setRect(r, { quiet = false } = {}) {
  const geo = sampleGeom();
  rect = {
    ...r,
    x: Math.max(-r.w / 2, Math.min(geo.width - r.w / 2, r.x)),
    y: Math.max(-r.h / 2, Math.min(geo.height - r.h / 2, r.y)),
  };
  clearResults();
  if (!quiet) renderOverlay();
}

function clientToPt(ev) {
  const r = $("#bulkCanvas").getBoundingClientRect();
  const s = canvasScale();
  return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s };
}

function initGestures() {
  const box = $("#bulkOverlay");
  box.addEventListener("pointerdown", (ev) => {
    const node = ev.target.closest(".placement");
    if (!node || !rect) {
      // click on the page: move the stamp there
      if (!rect || !assetById(assetId)) return;
      const pt = clientToPt(ev);
      setRect({ ...rect, x: pt.x - rect.w / 2, y: pt.y - rect.h / 2 });
      return;
    }
    ev.preventDefault();
    const handle = ev.target.classList.contains("handle") ? ev.target.dataset.h : null;
    const start = clientToPt(ev);
    const orig = { ...rect };
    const lock = $("#bLock").checked;
    node.setPointerCapture(ev.pointerId);
    node.classList.add("is-dragging");

    const onMove = (e) => {
      const p = clientToPt(e);
      const dx = p.x - start.x, dy = p.y - start.y;
      const next = handle ? resizeRect(orig, handle, dx, dy, { lock }) : { ...orig, x: orig.x + dx, y: orig.y + dy };
      setRect(next, { quiet: true });
      const s = canvasScale();
      Object.assign(node.style, { left: `${rect.x * s}px`, top: `${rect.y * s}px`, width: `${rect.w * s}px`, height: `${rect.h * s}px` });
      syncInspector();
    };
    const onUp = () => {
      node.classList.remove("is-dragging");
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
      renderOverlay();
      updateAnchorStatus();
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
  });
}

// ------------------------------------------------------------ smart anchor
async function refreshAnchor() {
  lastSampleAnchor = null;
  const f = sampleFile();
  if (f && mode() === "smart" && anchorText()) {
    const text = await textOf(f, sample.page);
    const boxes = findAll(text, anchorText());
    if (boxes.length) {
      // with several matches on the sample page, use the one nearest the stamp
      const c = rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : { x: 0, y: 0 };
      const box = boxes.reduce((a, b) =>
        Math.hypot(b.x - c.x, b.y - c.y) < Math.hypot(a.x - c.x, a.y - c.y) ? b : a);
      lastSampleAnchor = {
        box,
        frac: { x: (box.x + box.w / 2) / text.width, y: (box.y + box.h / 2) / text.height },
      };
    }
  }
  updateAnchorStatus();
  renderOverlay();
}

function updateAnchorStatus() {
  const st = $("#anchorStatus");
  st.classList.remove("ok", "bad");
  if (mode() !== "smart") { st.textContent = ""; return; }
  if (!anchorText()) { st.textContent = "Type the text to look for, or press ✨ Detect."; return; }
  if (!lastSampleAnchor) {
    st.textContent = `“${anchorText()}” is not on this sample page — open a page where it appears (✨ Detect finds it).`;
    st.classList.add("bad");
    return;
  }
  st.textContent = `Found on this page. The stamp will keep this distance from “${anchorText()}” on every page where the text appears.`;
  st.classList.add("ok");
}

async function detectAnchors() {
  const f = sampleFile();
  if (!f) return toast("Add PDF files first.", "error");
  await withBusy("Reading the sample file…", async () => {
    const idx = [...new Set([...Array(Math.min(f.pages.length, 6)).keys(), f.pages.length - 1])];
    const pages = [];
    for (const i of idx) pages.push({ page: i, text: await textOf(f, i) });
    const list = suggestAnchors(pages);
    const chips = $("#anchorChips");
    chips.replaceChildren();
    if (!list.length) {
      const scanned = pages.every((p) => !p.text.items.length);
      $("#anchorStatus").textContent = scanned
        ? "This PDF has no text layer (it looks like a scanned image), so smart placement can't read it. Use “Same position on every page”."
        : "No signatory wording found. Type the text that sits next to where the stamp goes.";
      return;
    }
    for (const s of list) {
      chips.append(el("button", {
        type: "button", class: "chip", title: `On page ${s.pages.map((p) => p + 1).join(", ")}`,
        text: `${s.text} · p${s.pages.map((p) => p + 1).join(",")}`,
        onclick: () => useAnchor(s.text, s.pages),
      }));
    }
    if (!anchorText()) useAnchor(list[0].text, list[0].pages);
  });
}

async function useAnchor(text, pages) {
  $("#anchorText").value = text;
  setMode("smart");
  clearResults();
  if (pages?.length && !pages.includes(sample.page)) {
    await showSample(sample.file, pages[pages.length - 1]);
  } else {
    await refreshAnchor();
  }
  if (lastSampleAnchor) placeNearAnchor();
}

/** First-time helper: put the stamp just above the found text, right-aligned to it. */
function placeNearAnchor() {
  if (!lastSampleAnchor || !rect) return;
  const b = lastSampleAnchor.box;
  const geo = sampleGeom();
  let x = b.x + b.w - rect.w;
  let y = b.y - rect.h - 4;
  if (y < 0) y = b.y + b.h + 4;
  x = Math.max(4, Math.min(geo.width - rect.w - 4, x));
  setRect({ ...rect, x, y });
}

// ------------------------------------------------------------------ plans
function parsePages(spec, count) {
  const out = new Set();
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const p = part.toLowerCase().replace(/last/g, String(count));
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new DocumentError(`“${part}” is not a page or range (use e.g. 1, 3-5, last).`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

function targetPages(count) {
  const sel = $("#bulkPages").value;
  if (sel === "first") return [0];
  if (sel === "last") return [count - 1];
  if (sel === "custom") return parsePages($("#bulkRange").value || "1", count);
  return [...Array(count).keys()];
}

/** Same spot measured from the nearest page edges, so A4 and Letter both work. */
function fixedRectFor(geo) {
  const ref = sampleGeom();
  const right = rect.x + rect.w / 2 > ref.width / 2;
  const bottom = rect.y + rect.h / 2 > ref.height / 2;
  return {
    x: right ? geo.width - (ref.width - rect.x) : rect.x,
    y: bottom ? geo.height - (ref.height - rect.y) : rect.y,
    w: rect.w, h: rect.h,
  };
}

async function planFile(f) {
  const smart = mode() === "smart";
  const missing = $("#smartMissing").value;
  const offset = smart && lastSampleAnchor
    ? { dx: rect.x - lastSampleAnchor.box.x, dy: rect.y - lastSampleAnchor.box.y }
    : null;
  const placements = [];
  const notes = [];
  for (const i of targetPages(f.pages.length)) {
    const geo = f.pages[i];
    let r = null, how = "fixed";
    if (smart) {
      const box = findBest(await textOf(f, i), anchorText(), lastSampleAnchor.frac);
      if (box) { r = { x: box.x + offset.dx, y: box.y + offset.dy, w: rect.w, h: rect.h }; how = "smart"; }
      else if (missing === "skip") { notes.push(i); continue; }
    }
    if (!r) r = fixedRectFor(geo);
    r.x = Math.max(0, Math.min(geo.width - r.w, r.x));
    r.y = Math.max(0, Math.min(geo.height - r.h, r.y));
    placements.push({
      id: `b${i}`, assetId, page: i, ...r,
      rot: Number($("#bulkRot").value), opacity: Number($("#bulkOp").value) / 100, how,
    });
  }
  return { placements, skipped: notes };
}

function checkReady() {
  if (!files.length) throw new DocumentError("Add some PDF files first.");
  const asset = assetById(assetId);
  if (!asset) throw new DocumentError("Choose a stamp in step 2.");
  if (!rect) throw new DocumentError("Place the stamp on the sample page first.");
  if (mode() === "smart") {
    if (!anchorText()) throw new DocumentError("Smart placement needs the text to look for — type it or press ✨ Detect.");
    if (!lastSampleAnchor) throw new DocumentError(`“${anchorText()}” is not on the sample page. Open a page where it appears, then place the stamp next to it.`);
  }
  if ($("#bulkPages").value === "custom") parsePages($("#bulkRange").value || "1", 9999);
  return asset;
}

// ---------------------------------------------------------------- preview
function clearResults() {
  $("#bulkResults").hidden = true;
  $("#bulkGrid").replaceChildren();
  $("#bulkSummary").replaceChildren();
  $("#bulkResultsActions").replaceChildren();
}

async function preview() {
  const asset = checkReady();
  const stampImg = await loadImage(asset.blob);
  clearResults();
  $("#bulkResults").hidden = false;
  $("#bulkResultsTitle").textContent = "Preview — check every stamp before you run";
  const grid = $("#bulkGrid");
  let shown = 0, total = 0, smartCount = 0, skippedTotal = 0;
  const lines = [];

  await withBusy("Building the preview…", async () => {
    for (const f of files) {
      const plan = await planFile(f);
      total += plan.placements.length;
      skippedTotal += plan.skipped.length;
      smartCount += plan.placements.filter((p) => p.how === "smart").length;
      lines.push({ f, plan });
      for (const p of plan.placements) {
        if (shown >= PREVIEW_LIMIT) continue;
        shown++;
        grid.append(await previewCard(f, p, stampImg));
      }
    }
  });

  renderSummary(lines, { total, smartCount, skippedTotal });
  if (total > shown) grid.append(el("p", { class: "hint", text: `…and ${total - shown} more page(s) not shown.` }));
  $("#bulkResultsActions").replaceChildren(
    el("button", { class: "btn btn-primary btn-sm", type: "button", text: `Stamp ${files.length} file(s)`, onclick: () => run().catch(fail) }),
  );
  $("#bulkResults").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function previewCard(f, p, stampImg) {
  const doc = await pdfDocFor(f);
  const page = await doc.getPage(p.page + 1);
  const base = page.getViewport({ scale: 1 });
  const s = 200 / base.width;
  const vp = page.getViewport({ scale: s * 1.5 });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const k = s * 1.5;
  ctx.save();
  ctx.globalAlpha = p.opacity;
  ctx.translate((p.x + p.w / 2) * k, (p.y + p.h / 2) * k);
  ctx.rotate((p.rot * Math.PI) / 180);
  ctx.drawImage(stampImg, (-p.w / 2) * k, (-p.h / 2) * k, p.w * k, p.h * k);
  ctx.restore();
  ctx.strokeStyle = "rgba(47,75,216,.85)";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(p.x * k, p.y * k, p.w * k, p.h * k);
  return el("figure", { class: "bulk-card" }, [
    c,
    el("figcaption", {}, [
      el("strong", { text: f.name }),
      el("small", { text: `Page ${p.page + 1} · ${p.how === "smart" ? `✨ next to “${anchorText()}”` : "fixed position"}` }),
    ]),
  ]);
}

function renderSummary(lines, { total, smartCount, skippedTotal }) {
  const box = $("#bulkSummary");
  box.replaceChildren(
    el("p", {}, [
      el("strong", { text: `${total} stamp(s) on ${files.length} file(s)` }),
      el("span", { text: mode() === "smart" ? ` · ${smartCount} placed by smart detection` : "" }),
      el("span", { text: skippedTotal ? ` · ${skippedTotal} page(s) skipped (text not found)` : "" }),
    ]),
  );
  const missing = lines.filter((l) => !l.plan.placements.length);
  if (missing.length) {
    box.append(el("p", { class: "warn", text: `No stamp at all in: ${missing.map((l) => l.f.name).join(", ")}` }));
  }
}

// -------------------------------------------------------------------- run
async function run() {
  const asset = checkReady();
  const flatten = $("#bulkFlatten").checked;
  const outputs = [];
  let stamps = 0, skipped = 0;
  const empty = [];

  await withBusy("Stamping files…", async () => {
    let n = 0;
    for (const f of files) {
      n++;
      $("#progressLabel").textContent = `Stamping ${n} / ${files.length}: ${f.name}`;
      const plan = await planFile(f);
      skipped += plan.skipped.length;
      if (!plan.placements.length) { empty.push(f.name); continue; }
      const out = await stampPdf(new Blob([f.bytes], { type: "application/pdf" }), plan.placements,
        new Map([[asset.id, asset.blob]]), { flatten });
      stamps += plan.placements.length;
      outputs.push({ name: `${f.name.replace(/\.pdf$/i, "")} - stamped.pdf`, blob: out, count: plan.placements.length, placements: plan.placements });
    }
    const names = uniqueNames(outputs.map((o) => o.name));
    outputs.forEach((o, i) => { o.name = names[i]; });

    // keep them in History too (older exports are pruned as usual)
    for (const o of outputs) {
      await store.put("exports", {
        id: newId(), documentId: null, name: o.name, blob: o.blob,
        placements: o.placements, placementCount: o.count, flatten, size: o.blob.size, createdAt: now(), bulk: true,
      });
    }
    await refresh("exports");
    for (const old of state.exports.slice(LIMITS.keepExports)) await store.del("exports", old.id);
    await refresh("exports");
  });

  if (!outputs.length) return toast("Nothing was stamped — the text wasn't found on any selected page.", "error", 8000);

  let zip = null;
  if (outputs.length > 1) {
    zip = await withBusy("Packing the ZIP…", () => makeZip(outputs));
    download(zip, `stamped-${new Date().toISOString().slice(0, 10)}.zip`);
  } else {
    download(outputs[0].blob, outputs[0].name);
  }

  clearResults();
  $("#bulkResults").hidden = false;
  $("#bulkResultsTitle").textContent = "Done";
  $("#bulkSummary").replaceChildren(
    el("p", {}, [el("strong", { text: `${stamps} stamp(s) placed in ${outputs.length} file(s).` }),
      el("span", { text: skipped ? ` ${skipped} page(s) skipped because the text wasn't on them.` : "" })]),
    ...(empty.length ? [el("p", { class: "warn", text: `Not stamped (text not found): ${empty.join(", ")}` })] : []),
  );
  $("#bulkResultsActions").replaceChildren(...(zip
    ? [el("button", { class: "btn btn-primary btn-sm", type: "button", text: "Download ZIP again", onclick: () => download(zip, `stamped-${new Date().toISOString().slice(0, 10)}.zip`) })]
    : []));
  $("#bulkGrid").replaceChildren(el("ul", { class: "history-list" }, outputs.map((o) => el("li", {}, [
    el("div", { class: "meta" }, [el("strong", { text: o.name }), el("small", { text: `${o.count} stamp(s) · ${fmt.bytes(o.blob.size)}` })]),
    el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Download", onclick: () => download(o.blob, o.name) }),
  ]))));
  toast(outputs.length > 1 ? `Stamped ${outputs.length} files — ZIP downloaded.` : "Stamped PDF downloaded.", "success");
  document.dispatchEvent(new CustomEvent("stampdesk:exported"));
}

function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

const fail = (err) => toast(err.message || String(err), "error", 7000);

// ------------------------------------------------------------------ assets
export function renderBulkAssets() {
  const sel = $("#bulkAsset");
  const groups = state.companies.map((c) => {
    const items = state.assets.filter((a) => a.companyId === c.id);
    return items.length ? el("optgroup", { label: c.name }, items.map((a) => el("option", { value: a.id, text: `${a.name} (${a.category})` }))) : null;
  }).filter(Boolean);
  const orphans = state.assets.filter((a) => !state.companies.some((c) => c.id === a.companyId));
  sel.replaceChildren(
    el("option", { value: "", text: state.assets.length ? "Choose a stamp…" : "No stamps yet — add one in Stamp Library" }),
    ...groups,
    ...orphans.map((a) => el("option", { value: a.id, text: a.name })),
  );
  if (assetId && !assetById(assetId)) assetId = "";
  if (!assetId && state.assets.length === 1) assetId = state.assets[0].id;
  sel.value = assetId;
  const asset = assetById(assetId);
  $("#bulkAssetImg").hidden = !asset;
  if (asset) $("#bulkAssetImg").src = assetUrl(asset);
  if (files.length) renderOverlay();
}

function setMode(m) {
  $$('input[name="bulkMode"]').forEach((r) => { r.checked = r.value === m; });
  $("#smartBox").hidden = m !== "smart";
  $$(".mode-card").forEach((c) => c.classList.toggle("is-on", c.querySelector("input").checked));
}

// -------------------------------------------------------------------- init
export function initBulk() {
  const input = $("#bulkInput");
  const pick = () => input.click();
  $("#bulkPick").addEventListener("click", pick);
  $("#bulkPick2").addEventListener("click", pick);
  input.addEventListener("change", () => { const list = [...input.files]; input.value = ""; addFiles(list).catch(fail); });
  for (const zone of [$("#bulkDrop"), $("#bulkEmpty")]) {
    ["dragenter", "dragover"].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((e) => zone.addEventListener(e, () => zone.classList.remove("is-over")));
    zone.addEventListener("drop", (ev) => { ev.preventDefault(); addFiles(ev.dataTransfer.files).catch(fail); });
  }
  $("#bulkClear").addEventListener("click", () => {
    files.forEach((f) => f.doc?.destroy());
    files = []; textCache.clear(); sample = { file: 0, page: 0 }; lastSampleAnchor = null;
    clearResults(); renderFiles();
  });

  $("#bulkSampleFile").addEventListener("change", (ev) => showSample(Number(ev.target.value), 0).catch(fail));
  $("#bulkPrev").addEventListener("click", () => showSample(sample.file, sample.page - 1).catch(fail));
  $("#bulkNext").addEventListener("click", () => showSample(sample.file, sample.page + 1).catch(fail));
  $("#bulkPageInput").addEventListener("change", (ev) => showSample(sample.file, Number(ev.target.value) - 1).catch(fail));

  $("#bulkAsset").addEventListener("change", (ev) => {
    assetId = ev.target.value;
    const asset = assetById(assetId);
    $("#bulkAssetImg").hidden = !asset;
    if (asset) {
      $("#bulkAssetImg").src = assetUrl(asset);
      if (rect && asset.width && asset.height) setRect({ ...rect, h: rect.w * (asset.height / asset.width) });
    }
    clearResults(); renderOverlay();
  });
  $("#bulkOp").addEventListener("input", (ev) => { $("#bulkOpVal").textContent = `${ev.target.value}%`; clearResults(); renderOverlay(); });
  $("#bulkRot").addEventListener("input", (ev) => { $("#bulkRotVal").textContent = `${ev.target.value}°`; clearResults(); renderOverlay(); });
  $("#bulkPages").addEventListener("change", (ev) => { $("#bulkRange").hidden = ev.target.value !== "custom"; clearResults(); });
  $("#bulkRange").addEventListener("input", clearResults);

  $$('input[name="bulkMode"]').forEach((r) => r.addEventListener("change", () => {
    setMode(mode()); clearResults(); refreshAnchor().catch(fail);
  }));
  let t = null;
  $("#anchorText").addEventListener("input", () => {
    clearTimeout(t);
    clearResults();
    t = setTimeout(() => refreshAnchor().catch(fail), 350);
  });
  $("#detectBtn").addEventListener("click", () => detectAnchors().catch(fail));
  $("#smartMissing").addEventListener("change", clearResults);

  // position inputs, units, alignment
  const fillUnits = () => {
    $("#bUnit").value = unit;
    $$(".bunit-label").forEach((n) => { n.textContent = UNITS[unit].label; });
    for (const id of ["bX", "bY", "bW", "bH", "bMargin"]) $(`#${id}`).step = String(UNITS[unit].step);
  };
  $("#bUnit").replaceChildren(...Object.keys(UNITS).map((u) => el("option", { value: u, text: UNITS[u].label })));
  $("#bUnit").addEventListener("change", (ev) => { unit = ev.target.value; setUnit(unit); fillUnits(); syncInspector(); });
  fillUnits();
  for (const [id, key] of Object.entries({ bX: "x", bY: "y", bW: "w", bH: "h" })) {
    $(`#${id}`).addEventListener("change", (ev) => {
      if (!rect || ev.target.value === "" || !Number.isFinite(Number(ev.target.value))) return syncInspector();
      const v = fromUnit(ev.target.value, unit);
      const next = { ...rect, [key]: key === "w" || key === "h" ? Math.max(4, v) : v };
      if ($("#bLock").checked && (key === "w" || key === "h")) {
        const aspect = rect.w / rect.h;
        if (key === "w") next.h = next.w / aspect; else next.w = next.h * aspect;
      }
      setRect(next);
      updateAnchorStatus();
    });
  }
  $("#bMargin").addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v) && v >= 0) marginPt = fromUnit(v, unit);
  });
  $("#bAlignGrid").replaceChildren(...ALIGN_GRID.map(([code, glyph]) => el("button", {
    type: "button", class: "align-btn", text: glyph, title: `Align ${code}`,
    onclick: () => { if (rect) setRect(alignRect(rect, sampleGeom(), code, marginPt)); },
  })));

  $("#bulkPreviewBtn").addEventListener("click", () => preview().catch(fail));
  $("#bulkRunBtn").addEventListener("click", () => run().catch(fail));

  initGestures();
  setMode("smart");
  updateAnchorStatus();
  window.addEventListener("resize", () => { if (files.length && !$("#view-bulk").hidden) showSample(sample.file, sample.page).catch(() => {}); });
}

export function onBulkShown() {
  renderBulkAssets();
  if (files.length) showSample(sample.file, sample.page).catch(fail);
}

