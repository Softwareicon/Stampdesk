// All PDF work happens in the browser:
//   pdf.js  -> reading / rendering / thumbnails
//   pdf-lib -> writing the stamped file
import { PDFJS_URL, PDFJS_WORKER, PDFLIB_URL } from "./config.js";
import { loadImage, renderPlacementImage } from "./imaging.js";

let pdfjs = null;
let pdflib = null;

export async function getPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(/* @vite-ignore */ PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return pdfjs;
}

export async function getPdfLib() {
  if (pdflib) return pdflib;
  if (!window.PDFLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFLIB_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the PDF writer (vendor/pdf-lib.min.js)."));
      document.head.append(s);
    });
  }
  pdflib = window.PDFLib;
  return pdflib;
}

export const IMAGE_TYPES = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

export class DocumentError extends Error {}

/** Turn any supported upload into a PDF blob + page geometry. */
export async function toPdf(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  if (ext === "pdf") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pages = await inspect(bytes);          // also validates / catches encryption
    return { pdf: new Blob([bytes], { type: "application/pdf" }), pages, sourceFormat: "pdf" };
  }

  if (IMAGE_TYPES.includes(ext) || file.type.startsWith("image/")) {
    const { PDFDocument } = await getPdfLib();
    const img = await loadImage(file);
    const doc = await PDFDocument.create();
    const pageW = 595.28, pageH = 841.89, margin = 24;
    const scale = Math.min((pageW - margin * 2) / img.naturalWidth, (pageH - margin * 2) / img.naturalHeight, 1);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;

    // normalise through a canvas so any input format becomes embeddable PNG
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    const embedded = await doc.embedPng(await png.arrayBuffer());

    const page = doc.addPage([pageW, pageH]);
    page.drawImage(embedded, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
    const bytes = await doc.save();
    return {
      pdf: new Blob([bytes], { type: "application/pdf" }),
      pages: await inspect(bytes),
      sourceFormat: "image",
    };
  }

  if (["docx", "doc", "odt", "rtf"].includes(ext)) {
    throw new DocumentError(
      "Word files cannot be converted without a server. In Word use File → Save as → PDF " +
      "(or Print → Save as PDF), then upload that PDF here.",
    );
  }

  throw new DocumentError(`${ext ? `.${ext}` : "That file type"} is not supported. Use PDF, PNG or JPG.`);
}

/** Page sizes in points, and a readable error for files we cannot open. */
export async function inspect(bytes) {
  const lib = await getPdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data: bytes.slice(0) }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new DocumentError("This PDF is password protected. Remove the password and upload it again.");
    }
    throw new DocumentError("That PDF could not be opened — it may be corrupted.");
  }
  if (!doc.numPages) throw new DocumentError("That PDF has no pages.");
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ index: i - 1, width: +vp.width.toFixed(2), height: +vp.height.toFixed(2), rotation: page.rotate || 0 });
  }
  await doc.destroy();
  return pages;
}

export async function thumbnail(pdfBlob, pageIndex, width = 200) {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await pdfBlob.arrayBuffer()) }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return new Promise((r) => canvas.toBlob(r, "image/png"));
  } finally {
    await doc.destroy();
  }
}

/**
 * Write the stamped PDF.
 *
 * Placements use PDF points with a TOP-LEFT origin (what the preview uses);
 * this is the only place where they are flipped to pdf-lib's bottom-left
 * origin, so preview and output cannot drift apart.
 */
export async function stampPdf(pdfBlob, placements, assetBlobs, { flatten = false, flattenDpi = 150 } = {}) {
  const { PDFDocument } = await getPdfLib();
  const doc = await PDFDocument.load(await pdfBlob.arrayBuffer());
  const pages = doc.getPages();

  const cache = new Map();
  for (const p of placements) {
    if (p.page < 0 || p.page >= pages.length) {
      throw new DocumentError(`A stamp points at page ${p.page + 1}, but this document has ${pages.length} page(s).`);
    }
    const source = assetBlobs.get(p.assetId);
    if (!source) throw new DocumentError("One of the stamps is no longer in your library.");

    const key = `${p.assetId}|${Math.round(p.rot)}|${Math.round(p.opacity * 100)}|${Math.round(p.w)}`;
    if (!cache.has(key)) {
      const rendered = await renderPlacementImage(source, {
        rotation: p.rot,
        opacity: p.opacity,
        targetWidth: p.w * 3,                       // ~216 dpi so print stays crisp
      });
      cache.set(key, { embedded: await doc.embedPng(await rendered.blob.arrayBuffer()), rendered });
    }
    const { embedded } = cache.get(key);

    const page = pages[p.page];
    const { width: pw, height: ph } = page.getSize();

    // bounding box of the rotated stamp, centred on the placement rectangle
    const rad = (p.rot * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const boxW = p.w * cos + p.h * sin;
    const boxH = p.w * sin + p.h * cos;
    const cx = p.x + p.w / 2;
    const cyTop = p.y + p.h / 2;

    page.drawImage(embedded, {
      x: cx - boxW / 2,
      y: ph - cyTop - boxH / 2,                     // top-left origin -> PDF origin
      width: boxW,
      height: boxH,
    });
    void pw;
  }

  const stamped = await doc.save();
  if (!flatten) return new Blob([stamped], { type: "application/pdf" });

  // Flatten: render every page (stamps included) to an image and rebuild.
  const lib = await getPdfjs();
  const rendered = await lib.getDocument({ data: stamped.slice(0) }).promise;
  const flat = await PDFDocument.create();
  try {
    for (let i = 1; i <= rendered.numPages; i++) {
      const page = await rendered.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: flattenDpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const embedded = await flat.embedPng(await png.arrayBuffer());
      const out = flat.addPage([base.width, base.height]);
      out.drawImage(embedded, { x: 0, y: 0, width: base.width, height: base.height });
    }
  } finally {
    await rendered.destroy();
  }
  return new Blob([await flat.save()], { type: "application/pdf" });
}
