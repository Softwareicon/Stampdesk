// Shared placement geometry: resize handles, units and alignment.
// All rectangles are PDF points with a TOP-LEFT origin: { x, y, w, h }.

// Corner handles resize both sides (and keep the aspect ratio when locked);
// side handles stretch only width or only height.
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rot"];
export const isCorner = (h) => h.length === 2;

const MIN = 6;

/** New rectangle after dragging `handle` by (dx, dy) points from `orig`. */
export function resizeRect(orig, handle, dx, dy, { lock = false } = {}) {
  let { x, y, w, h } = orig;
  const aspect = orig.w / orig.h || 1;
  if (handle.includes("e")) w = orig.w + dx;
  if (handle.includes("w")) { w = orig.w - dx; x = orig.x + dx; }
  if (handle.includes("s")) h = orig.h + dy;
  if (handle.includes("n")) { h = orig.h - dy; y = orig.y + dy; }

  if (w < MIN) { if (handle.includes("w")) x -= MIN - w; w = MIN; }
  if (h < MIN) { if (handle.includes("n")) y -= MIN - h; h = MIN; }

  if (lock && isCorner(handle)) {
    // follow whichever side moved more, keep the opposite corner fixed
    if (Math.abs(w - orig.w) / orig.w >= Math.abs(h - orig.h) / orig.h) h = w / aspect;
    else w = h * aspect;
    if (handle.includes("w")) x = orig.x + orig.w - w;
    if (handle.includes("n")) y = orig.y + orig.h - h;
  }
  return { x, y, w, h };
}

// ------------------------------------------------------------------- units
export const UNITS = {
  pt: { label: "pt", perUnit: 1, digits: 1, step: 0.5 },
  mm: { label: "mm", perUnit: 72 / 25.4, digits: 1, step: 0.5 },
  cm: { label: "cm", perUnit: 72 / 2.54, digits: 2, step: 0.05 },
  in: { label: "in", perUnit: 72, digits: 3, step: 0.01 },
};
const UNIT_KEY = "stampdesk.unit";

export function getUnit() {
  try { const u = localStorage.getItem(UNIT_KEY); if (UNITS[u]) return u; } catch { /* ignore */ }
  return "mm";
}
export function setUnit(u) {
  try { localStorage.setItem(UNIT_KEY, u); } catch { /* ignore */ }
}
export const toUnit = (pt, u = getUnit()) => Number((pt / UNITS[u].perUnit).toFixed(UNITS[u].digits));
export const fromUnit = (v, u = getUnit()) => Number(v) * UNITS[u].perUnit;

// --------------------------------------------------------------- alignment
/**
 * Snap a rectangle to one of nine page positions.
 * align: two letters — vertical (t|m|b) + horizontal (l|c|r), e.g. "br".
 */
export function alignRect(rect, page, align, margin = 0) {
  const [v, hz] = align;
  let { x, y } = rect;
  if (hz === "l") x = margin;
  if (hz === "c") x = (page.width - rect.w) / 2;
  if (hz === "r") x = page.width - rect.w - margin;
  if (v === "t") y = margin;
  if (v === "m") y = (page.height - rect.h) / 2;
  if (v === "b") y = page.height - rect.h - margin;
  return { ...rect, x, y };
}

export const ALIGN_GRID = [
  ["tl", "↖"], ["tc", "↑"], ["tr", "↗"],
  ["ml", "←"], ["mc", "•"], ["mr", "→"],
  ["bl", "↙"], ["bc", "↓"], ["br", "↘"],
];
