// Smart placement: find a piece of text (e.g. "Authorised Signatory") on a
// PDF page and return where it sits, so a stamp can be placed next to it on
// every page and every file — even when the text moves around.
// Runs entirely in the browser on the PDF's own text layer (no OCR, no server).
import { getPdfjs } from "./pdfops.js";

const LETTER = /[\p{L}\p{N}]/u;

/** lower-case, letters and digits only, British/American spelling folded. */
export function normalize(text) {
  let out = "";
  for (const ch of text.toLowerCase()) if (LETTER.test(ch)) out += ch;
  return out.replace(/authoriz/g, "authoris");
}

/**
 * Text items of one page in TOP-LEFT point coordinates.
 * pdfPage: a pdf.js page proxy.
 */
export async function pageTextItems(pdfPage) {
  const lib = await getPdfjs();
  const vp = pdfPage.getViewport({ scale: 1 });
  const content = await pdfPage.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = lib.Util.transform(vp.transform, it.transform);
    const h = Math.hypot(tr[2], tr[3]) || Math.abs(it.height) || 8;
    const w = Math.abs(it.width) || h * it.str.length * 0.5;
    items.push({ str: it.str, x: tr[4], y: tr[5] - h, w, h });
  }
  return { items, width: vp.width, height: vp.height };
}

/** Build the normalised text of a page plus a map back to the items. */
function index(items) {
  let text = "";
  const map = [];
  items.forEach((it, k) => {
    const s = it.str.toLowerCase();
    for (let c = 0; c < s.length; c++) {
      if (LETTER.test(s[c])) { text += s[c]; map.push([k, c]); }
    }
  });
  return { text: text.replace(/authoriz/g, "authoris"), map };
}

/** Every box on the page where `needle` occurs. */
export function findAll(pageText, needle) {
  const want = normalize(needle);
  if (!want) return [];
  const { items } = pageText;
  const { text, map } = index(items);
  const boxes = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(want, from);
    if (at < 0) break;
    from = at + 1;
    const [k1, c1] = map[at];
    const [k2, c2] = map[at + want.length - 1];
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (let k = k1; k <= k2; k++) {
      const it = items[k];
      const len = Math.max(it.str.length, 1);
      const sx = k === k1 ? it.x + it.w * (c1 / len) : it.x;
      const ex = k === k2 ? it.x + it.w * ((c2 + 1) / len) : it.x + it.w;
      x1 = Math.min(x1, sx); x2 = Math.max(x2, ex);
      y1 = Math.min(y1, it.y); y2 = Math.max(y2, it.y + it.h);
    }
    boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  return boxes;
}

/**
 * The occurrence that best matches the one on the sample page: the closest to
 * the same relative spot. Returns null when the text is not on this page.
 */
export function findBest(pageText, needle, refFrac) {
  const boxes = findAll(pageText, needle);
  if (!boxes.length) return null;
  if (!refFrac || boxes.length === 1) return boxes[boxes.length - 1];
  let best = null, bestD = Infinity;
  for (const b of boxes) {
    const fx = (b.x + b.w / 2) / pageText.width;
    const fy = (b.y + b.h / 2) / pageText.height;
    const d = Math.hypot(fx - refFrac.x, fy - refFrac.y);
    if (d < bestD) { best = b; bestD = d; }
  }
  return best;
}

// Phrases that usually mark where a stamp or signature belongs.
const KNOWN = [
  "Authorised Signatory", "Authorized Signatory", "Authorised Signature", "Authorized Signature",
  "Authorised Person", "Proprietor", "Partner", "Director", "Signature", "Signed by",
  "Receiver's Signature", "Customer Signature", "Company Seal", "Stamp",
];

/**
 * Suggest anchor phrases found in a document.
 * pages: [{ page, text }] where text is a pageTextItems() result.
 */
export function suggestAnchors(pages) {
  const found = new Map();
  const add = (label, page) => {
    const key = normalize(label);
    if (!key) return;
    const entry = found.get(key) || { text: label.trim(), pages: new Set(), score: 0 };
    entry.pages.add(page);
    found.set(key, entry);
  };
  for (const { page, text } of pages) {
    const flat = index(text.items).text;
    for (const phrase of KNOWN) if (flat.includes(normalize(phrase))) add(phrase, page);
    for (const it of text.items) {
      const m = it.str.trim().match(/^for\s+(.{2,48})$/i);       // "for Vishu Sales"
      if (m && !/^(the|any|all|this|more|details|delivery|payment)\b/i.test(m[1])) add(it.str.trim(), page);
    }
  }
  // signatory wording first, then "for <Company>", then the rest
  const rank = (t) => (/signator/i.test(t) ? 0 : /^for\s/i.test(t) ? 1 : 2);
  return [...found.values()]
    .map((e) => ({ text: e.text, pages: [...e.pages].sort((a, b) => a - b) }))
    .sort((a, b) => rank(a.text) - rank(b.text) || a.text.length - b.text.length)
    .filter((e, i, arr) => arr.findIndex((o) => normalize(o.text) === normalize(e.text)) === i)
    .slice(0, 8);
}
