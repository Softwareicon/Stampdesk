# How it works

A plain-language walkthrough of what happens when you use StampDesk, and why
there is no server bill attached to it.

## Nothing is uploaded

Normally an app like this needs a server: somewhere to keep your stamps,
somewhere to run the code that writes the PDF. That is what costs money and what
needs an account and an API address.

This version does all of it in the browser instead:

| Job | Who does it | Where |
|---|---|---|
| Keeps your stamps and companies | IndexedDB | your browser's own storage |
| Removes the paper background | `<canvas>` pixel work | your browser |
| Shows the PDF page | pdf.js | your browser |
| Writes the stamped PDF | pdf-lib | your browser |
| Downloads the result | a normal browser download | your computer |

Open your browser's Network tab while you work: after the page loads, nothing
goes out. Both libraries are bundled in `vendor/`, so even the first load needs
no CDN and the app keeps working with the internet switched off.

Hosting on GitHub Pages does not change this. Pages only hands your browser the
files; your documents never pass through it.

## Step by step

### 1. Adding a stamp

You upload a photo or scan. The image is drawn onto a canvas and every pixel is
examined:

1. A brightness histogram is built for the whole image.
2. The 95th percentile becomes the **paper** level and the 2nd percentile the
   **ink** level. Reading them from the image is what makes a grey scan or a
   warm phone photo work — "white" is whatever the paper actually is, not an
   assumed 255.
3. Each pixel's transparency is set by how far it sits from paper towards ink.
   A faint stroke stays faint instead of disappearing or hardening into a blob.
4. Fully transparent margins are trimmed so the stamp sits tight in its box.

The result is saved as a PNG in IndexedDB, with its size and whether it carries
transparency.

### 2. Opening a document

A PDF is kept as-is. A JPG or PNG is placed on an A4 page first, so everything
downstream is a PDF. pdf.js reads it and reports each page's exact size in
points; a password-protected or corrupt file is refused here with a plain
message rather than a stack trace.

### 3. Placing a stamp

Each placement is just numbers:

```js
{ page: 1, assetId: "…", x: 330, y: 726, w: 140, h: 44.7, rot: 0, opacity: 1 }
```

`x` and `y` are **PDF points measured from the top-left of the page** — the
same system the preview uses. The on-screen position is only those numbers
multiplied by the zoom factor, so dragging, typing coordinates and the exported
file all describe the same thing.

Undo and redo are snapshots of this little list, which is why they are instant.

### 4. Exporting

pdf-lib opens the PDF and, for each placement:

- the stamp is pre-rendered onto a canvas at the requested angle and opacity, at
  about 216 dpi so print stays crisp;
- the rotated image's bounding box is worked out and centred on your rectangle;
- `y` is flipped once — `pageHeight − y − height` — because PDFs measure from
  the bottom-left. **This is the only conversion in the whole app**, which is
  why preview and output cannot drift apart.

With **Flatten** ticked, every page is then re-rendered at 150 dpi and rebuilt
as an image, so the stamp cannot be selected or dragged out in a PDF reader. The
text also stops being selectable — that is the trade-off.

The finished file downloads, and a copy is kept under History (the 30 most
recent) so you can fetch it again without redoing the work.

## Where your data lives

Everything sits in an IndexedDB database called `stampdesk` belonging to the
exact address you opened the app from. Two consequences worth understanding:

- A different browser, a different computer, or a different address (say
  `file://` versus `127.0.0.1`) is a different, empty library.
- Clearing site data or "Clear browsing data → Cookies and site data" erases it.

The app calls `navigator.storage.persist()` at startup, which asks the browser
not to evict the data when disk space runs low. Browsers usually grant this once
you have actually used the app.

**So take backups.** History → *Download backup* writes one JSON file holding
every company, stamp and preset (images included, base64-encoded). Restore it in
any browser to get your library back — merge into what is there, or replace it.
Tick *Include documents* only if you want the PDFs in there too; that file gets
large.

## What this is not

A stamp image on a page is a picture of a signature. Anyone can copy it out of
the exported file and reuse it. It does not prove who signed, when, or that the
document is unaltered.

A real digital signature uses a certificate (a DSC in India; eIDAS / PAdES
elsewhere) to seal the document cryptographically. That needs a certificate
issued to you and software that can use it — it cannot be done by any
browser-only app, including this one.

Flattening makes casual extraction harder. It is not security.
