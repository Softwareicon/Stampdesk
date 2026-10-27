// Image work, all on a <canvas> in the browser — the same background-removal
// idea the Python version used, ported to ImageData.
const MAX_SIDE = 3000;

export async function loadImage(blobOrFile) {
  const url = URL.createObjectURL(blobOrFile);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("That file is not a readable image (PNG, JPG or WEBP work best)."));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export function toCanvas(img) {
  let { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c;
}

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Rebuild the alpha channel so paper disappears and ink stays.
 *
 * The paper tone is measured from the image itself (95th percentile of
 * luminance), so a grey scan or a phone photo works as well as a clean
 * white scan, and ink keeps its pen pressure instead of becoming a hard
 * cut-out.
 */
export function removeBackground(source, { tolerance = 34, crop = true } = {}) {
  const canvas = source instanceof HTMLCanvasElement ? source : toCanvas(source);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const n = canvas.width * canvas.height;

  // luminance histogram -> paper and ink reference levels
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    hist[(px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) | 0]++;
  }
  const at = (fraction) => {
    let seen = 0;
    const target = n * fraction;
    for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= target) return v; }
    return 255;
  };
  const paper = at(0.95);
  const ink = at(0.02);
  const span = Math.max(paper - ink, 1);
  const cut = paper - span * (tolerance / 100) * 0.15;
  const range = Math.max(paper - Math.min(ink, cut), 1);

  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114;
    let a = ((paper - lum) / range) * 1.35;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    const alpha = Math.round(Math.min(a * 255, px[o + 3]));
    px[o + 3] = alpha;
    if (alpha > 12) {
      const x = i % canvas.width;
      const y = (i / canvas.width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(data, 0, 0);

  if (!crop || maxX < 0) return canvas;
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function hasAlpha(canvas) {
  const { data } = canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** Normalise any uploaded image to a PNG blob + its dimensions. */
export async function prepareAsset(file, { strip = false } = {}) {
  const img = await loadImage(file);
  const canvas = strip ? removeBackground(toCanvas(img)) : toCanvas(img);
  return {
    blob: await canvasToBlob(canvas),
    width: canvas.width,
    height: canvas.height,
    hasAlpha: hasAlpha(canvas),
  };
}

/**
 * Pre-render a stamp at an arbitrary angle with opacity applied, returning an
 * upright PNG plus the bounding box it needs. Doing the rotation here means the
 * exported PDF matches the preview at any angle, not just multiples of 90°.
 */
export async function renderPlacementImage(blob, { rotation = 0, opacity = 1, targetWidth = 0 } = {}) {
  const img = await loadImage(blob);
  const base = toCanvas(img);
  const scale = targetWidth ? Math.min(4, Math.max(1, targetWidth / base.width)) : 1;
  const w = Math.round(base.width * scale);
  const h = Math.round(base.height * scale);

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.ceil(w * cos + h * sin);
  const outH = Math.ceil(w * sin + h * cos);

  const out = document.createElement("canvas");
  out.width = Math.max(1, outW);
  out.height = Math.max(1, outH);
  const ctx = out.getContext("2d");
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(base, -w / 2, -h / 2, w, h);

  return { blob: await canvasToBlob(out), width: out.width, height: out.height };
}

// ------------------------------------------------------------- edit tools
/** Copy onto white paper, so a transparent PNG can go through removeBackground again. */
export function onWhite(canvas) {
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

function trimTransparent(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas;
  const pad = 2;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Non-destructive edits for a stamp image.
 * ops: { rotate: 0|90|180|270, flip: bool, darkness: 0..100, color: "" | "#rrggbb", trim: bool }
 */
export function adjustImage(source, ops = {}) {
  const rotate = ((ops.rotate || 0) % 360 + 360) % 360;
  const swap = rotate === 90 || rotate === 270;
  let out = document.createElement("canvas");
  out.width = swap ? source.height : source.width;
  out.height = swap ? source.width : source.height;
  let ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  if (ops.flip) ctx.scale(-1, 1);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const dark = Math.max(0, Math.min(100, ops.darkness || 0)) / 100;
  if (dark > 0 || ops.color) {
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const px = img.data;
    const tint = ops.color ? hexToRgb(ops.color) : null;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      if (tint) { px[i] = tint[0]; px[i + 1] = tint[1]; px[i + 2] = tint[2]; }
      if (dark > 0) {
        const keep = 1 - dark * 0.55;                       // deepen the ink colour
        px[i] *= keep; px[i + 1] *= keep; px[i + 2] *= keep;
        px[i + 3] = Math.min(255, px[i + 3] * (1 + dark * 2.2)); // and fill faint strokes
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  if (ops.trim) out = trimTransparent(out);
  return out;
}
