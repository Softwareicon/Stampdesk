// Everything is vendored, so the app runs with no network at all —
// open index.html from a USB stick or host it on GitHub Pages, your choice.
export const PDFJS_URL = new URL("../vendor/pdf.min.mjs", import.meta.url).href;
export const PDFJS_WORKER = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
export const PDFLIB_URL = new URL("../vendor/pdf-lib.min.js", import.meta.url).href;

export const CATEGORIES = [
  "Company Stamp",
  "Authorized Signature",
  "Director Signature",
  "Official Seal",
  "Other",
];

// Shared database: the Google Apps Script web app attached to the team's
// Google Sheet. Leave url empty to run fully offline (browser-only).
export const REMOTE = {
  url: "https://script.google.com/macros/s/AKfycbwUJ9Twmge6jmuERXx4WMrGznblyCrb0ADfrRHmn86SAsO2puWpk31gdz3gw5zad6W5/exec",
  autoSyncSeconds: 60,
};

export const KEYS = {
  theme: "stampdesk.theme",
  assetView: "stampdesk.assetView",
  seenIntro: "stampdesk.seenIntro",
};

export const LIMITS = {
  assetMb: 12,
  documentMb: 60,
  maxPages: 500,
  keepExports: 30,        // older exported files are pruned to save space
};
