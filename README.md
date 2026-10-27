# StampDesk (offline edition)

Store your company stamps and signatures, drop them exactly where they belong on
a PDF, and download the stamped file.

**No account. No server. No API key. No subscription.** Everything — the
library, the PDF preview and the PDF writing — happens inside your browser. Your
stamps and documents never leave your computer.


## New in this version

- **Edit any stamp** — *Edit* on a stamp card changes its name, company, category and description, and lets you replace the image or adjust it (rotate, flip, trim empty edges, darken faint ink, recolour). *Replace image* jumps straight to picking a new file. Changes sync to the shared Google Sheet.
- **Resize handles on all sides** — corners resize (keeping proportions when *Lock aspect ratio* is on); the middle handles on each side stretch only the width or only the height.
- **Exact size and position** — X, Y, width and height in mm, cm, inches or points; a 9-point *Align on page* grid with a margin; nudge buttons; *Restore original proportions*.
- **Bulk Stamp (smart placement)** — add many PDFs, pick the stamp and pages, place it once on a sample page.
  - *Smart placement* reads the PDF text, finds the anchor (e.g. “Authorised Signatory” — *✨ Detect* suggests it) on every page and keeps the stamp at exactly the same distance from it, even when it moves between bills or pages. Pages without the text are skipped (or use the fixed position — your choice).
  - *Same position* puts the stamp at the same spot on every page, measured from the nearest page edges so A4 and Letter both line up.
  - *Preview all pages* shows every stamped page first; *Stamp all files* downloads one ZIP and keeps each file in History.
  - Smart placement needs PDFs with real text (as exported by Tally, Busy, Excel, Word…). Scanned image-only PDFs have no text to read — use *Same position* for those.

---

## Run it

Pick whichever suits you. All three are free.

**1. Straight off your computer**
Unzip and double-click `index.html`. That's it.
(If your browser blocks ES modules on `file://`, use option 2.)

**2. A local address — most reliable**

```bash
cd stampdesk-free
python3 -m http.server 8080      # Windows: py -m http.server 8080
```

Open <http://127.0.0.1:8080>. Nothing is uploaded anywhere; this just serves the
folder to your own browser.

**3. GitHub Pages — a free link you can open from any machine**

1. Create a repository and upload this whole folder.
2. **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
3. A minute later your app is at `https://YOURNAME.github.io/<repo>/`.

There is nothing to configure — no backend to point at. Every library the app
needs is in `vendor/`, so it works even with no internet.

---

## First five minutes

The welcome dialog walks through this, and the `samples/` folder has files to
practise on.

1. **Stamp Library → + New** — add a company (e.g. *Vishu Sales*).
2. **Upload stamp / signature** — a photo or scan of your stamp on white paper.
   Leave *Remove the paper background* ticked; the paper disappears and only the
   ink stays. The card will say **transparent**.
3. **Place on Document** — drop a PDF in. Drag the stamp onto the page, or click
   the stamp then click where it should land.
4. Fine-tune: drag to move, corners to resize (aspect locked), round handle to
   rotate, sliders for rotation and opacity — or type exact X/Y/Width in points.
5. **Export PDF** — the stamped file downloads straight to your Downloads folder.
6. **History & Backup → Download backup** — keep this file. It is how your
   library moves to another computer.

---

## What it does

### Stamp library
- Multiple companies, each with its own stamps and signatures.
- PNG, JPG, WEBP, BMP, GIF in; everything stored as PNG.
- **Background removal** that measures the paper tone from the image itself, so
  a grey scan or a phone photo works as well as a clean white scan. The ink
  keeps its pen pressure instead of turning into a hard cut-out.
- Categories: Company Stamp, Authorized Signature, Director Signature, Official
  Seal, Other. Search and filter by company, category or name.
- Preview, rename, replace, download, delete — with confirmation before deletes.

### Document workspace
- PDF, JPG and PNG. Page thumbnails, page navigation, zoom, fit-to-width.
- Drag-and-drop or click-to-place; several stamps per document, on any page.
- Move, resize, rotate to **any** angle, opacity, or type exact coordinates.
- *All pages* copies a placement to every page, scaled to each page's size.
- Undo / redo / clear, and keyboard nudging at 1 pt or 10 pt.
- **Presets** remember a placement as a fraction of the page, so "bottom-right
  of the last page" lands correctly on A4, Letter or any other size.
- **Flatten** on export turns the pages into images, so the stamp cannot be
  dragged out in a PDF reader.

### History & backup
Recent documents and every exported file, re-downloadable. Backup to a single
JSON file and restore it on another computer or browser. *Erase everything*
clears all local data in one step.

### Throughout
Light and dark themes, works down to phone width, keyboard shortcuts, progress
indicators, and a standing note that a visual stamp is not a cryptographic
signature.

---

## Two things to know

**Word files.** `.docx` cannot be converted without a server. In Word use
*File → Save as → PDF* (or *Print → Save as PDF*), then drop that PDF here.
Everything else is unchanged.

**Your data lives in this browser.** Clearing site data, using a different
browser, or moving to another computer means starting empty. So:

- Take a **backup** from the History tab after you add stamps, and keep the JSON
  file somewhere safe (Drive, email to yourself, a USB stick).
- The app asks the browser to mark its storage as *persistent*, which stops it
  being evicted when disk space runs low — but a backup is still the real
  safety net.
- Private/incognito windows throw the data away when you close them.

---

## How placement stays accurate

Every placement is stored as **PDF points with a top-left origin** —
`{page, x, y, w, h, rot, opacity}`. That is the coordinate system the on-screen
preview uses. The flip to the PDF's own bottom-left origin happens in exactly
one place, in `js/pdfops.js`, when the file is written. One conversion, in one
function, means the preview and the exported file cannot drift apart.

Rotation at any angle is handled by pre-rendering the stamp onto a canvas at the
requested angle and opacity, then placing that upright image in its bounding
box — so a 37° stamp exports exactly as it looked.

---

## Files

```
index.html              the whole app shell
css/app.css             design system, light + dark
js/
  app.js                tabs, theme, shortcuts, first-run intro
  db.js                 IndexedDB — this is the "backend"; also backup/restore
  store.js              in-memory mirror + object-URL cache
  imaging.js            background removal, opacity, rotation rendering
  pdfops.js             pdf.js reading / pdf-lib writing / flatten
  library.js            Tab 1
  workspace.js          Tab 2
  history.js            Tab 3
  config.js             categories, limits, vendor paths
  ui.js                 toasts, dialogs, formatting
vendor/                 pdf.js + pdf-lib, bundled so nothing is fetched
samples/                a signature, a seal and a 2-page invoice to practise on
tests/                  browser end-to-end tests
docs/HOW-IT-WORKS.md    the flow in plain language, and the privacy story
```

---

## Tests

```bash
pip install playwright pymupdf && playwright install chromium
python -m pytest tests -q
```

Two tests, both driving a real headless browser against the folder served as
plain static files:

1. Full workflow — company → stamp with background removal → PDF → place →
   nudge → undo → exact coordinates → place on a second page → export → the
   downloaded PDF is opened and the stamp's rectangle is asserted to be at
   x=330, y=726, width=120 (±2 pt), with one stamp on each page. It then
   reloads the page and checks the library survived, and fails on any console
   error.
2. Backup round-trip — back up in one browser profile, restore in a fresh one,
   and confirm the library reappears.

---

## Limits

| | |
|---|---|
| Stamp image | 12 MB |
| Document | 60 MB, 500 pages |
| Stored exports | the 30 most recent (older ones are pruned automatically) |
| Browser | any current Chrome, Edge, Firefox or Safari |

---

## Not a digital signature

Placing a stamp or signature image on a page is a **visual mark**. It is not a
cryptographic digital signature, and it does not by itself establish
authenticity or legal validity. For that you need a certificate-based signature
(DSC in India, or eIDAS / PAdES elsewhere), which requires a signing certificate
and dedicated software.
