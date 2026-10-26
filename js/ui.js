// Small shared UI helpers: toasts, progress bar, confirm dialog, formatting.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer = new WeakMap();
export function toast(message, kind = "info", ms = 4200) {
  const box = $("#toasts");
  const node = el("div", { class: `toast ${kind}`, text: message });
  box.append(node);
  toastTimer.set(node, setTimeout(() => node.remove(), ms));
  node.addEventListener("click", () => node.remove());
}

let busyCount = 0;
export function busy(on, label = "Working…") {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const bar = $("#progress");
  $("#progressLabel").textContent = label;
  bar.hidden = busyCount === 0;
}

export async function withBusy(label, fn) {
  busy(true, label);
  try { return await fn(); }
  finally { busy(false); }
}

export function confirmDialog(title, body, confirmLabel = "Delete") {
  const dlg = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmBody").textContent = body;
  $("#confirmYes").textContent = confirmLabel;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    dlg.showModal();
  });
}

export const fmt = {
  bytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  },
  date(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  },
  initials(name, email) {
    const src = (name || email || "?").trim();
    const parts = src.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "··";
  },
};

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
