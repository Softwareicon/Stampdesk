"""End-to-end test of the offline app: no server, no account, real PDF out.

The page is served as plain static files (exactly what GitHub Pages does) and
driven with headless Chromium.  The exported PDF is then opened and the stamp's
position measured, so preview-to-export accuracy is verified, not assumed.

    pip install playwright pymupdf && playwright install chromium
    python -m pytest tests -q
"""
import http.server
import socket
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def site():
    """Serve the folder statically — the same thing GitHub Pages does."""
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def log_message(self, *a):
            pass

    port = _free_port()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.2)
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()


def test_full_offline_workflow(site, tmp_path):
    sig = ROOT / "samples" / "sample-signature.png"
    pdf = ROOT / "samples" / "sample-invoice.pdf"
    assert sig.exists() and pdf.exists(), "run samples/make_samples.py first"

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(site)
        page.wait_for_selector("#introDialog[open]")
        page.click("#introDialog button[value=ok]")

        # --- company -----------------------------------------------------
        page.click("#addCompanyBtn")
        page.fill("#cName", "Vishu Sales")
        page.click("#companySave")
        page.wait_for_selector("#companyList li:nth-child(2)")

        # --- stamp, with background removal -------------------------------
        page.click("#addAssetBtn")
        page.set_input_files("#assetFile", str(sig))
        page.fill("#aName", "Authorised Signatory")
        page.click("#assetSave")
        page.wait_for_selector(".asset-card", timeout=20000)
        assert "transparent" in page.inner_text(".asset-card")

        # --- document ------------------------------------------------------
        page.click('.tab[data-view="workspace"]')
        page.set_input_files("#docInput", str(pdf))
        page.wait_for_selector("#editor:not([hidden])", timeout=30000)
        page.wait_for_function("document.querySelector('#pageCanvas').width > 0", timeout=30000)
        assert page.inner_text("#pageTotal") == "2"

        # --- place, nudge, undo --------------------------------------------
        page.click(".ws-asset")
        box = page.locator("#pageCanvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + min(box["height"] * 0.5, 600))
        page.wait_for_selector(".placement", timeout=10000)
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Control+z")
        assert page.locator(".placement").count() == 1

        page.click(".placement")
        page.wait_for_selector("#inspectorBody:not([hidden])")
        for field, value in (("#inX", "330"), ("#inY", "726"), ("#inW", "120")):
            page.fill(field, value)
            page.press(field, "Enter")

        # --- page 2 as well, to prove multi-page works ----------------------
        page.click("#nextPage")
        page.wait_for_timeout(600)
        # the asset is still armed from before, so one click places another copy
        box = page.locator("#pageCanvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + 200)
        page.wait_for_selector(".placement")

        # --- export ----------------------------------------------------------
        with page.expect_download(timeout=40000) as dl:
            page.click("#exportBtn")
        out = tmp_path / "stamped.pdf"
        dl.value.save_as(str(out))

        # --- it is remembered -------------------------------------------------
        page.click('.tab[data-view="history"]')
        page.wait_for_selector("#exportHistory li strong", timeout=15000)

        # --- backup round-trip -------------------------------------------------
        with page.expect_download(timeout=20000) as backup:
            page.click("#backupBtn")
        backup_file = tmp_path / "backup.json"
        backup.value.save_as(str(backup_file))
        assert backup_file.stat().st_size > 500

        # --- survives a reload (IndexedDB, not memory) --------------------------
        page.reload()
        page.wait_for_selector(".asset-card", timeout=20000)
        assert page.locator(".asset-card").count() == 1

        ctx.close()
        browser.close()

    assert not errors, f"console/page errors: {errors[:3]}"

    import pymupdf

    doc = pymupdf.open(str(out))
    try:
        assert doc.page_count == 2
        first = doc[0].get_images(full=True)
        assert len(first) == 1, "page 1 should carry exactly one stamp"
        rect = doc[0].get_image_rects(first[0][0])[0]
        assert abs(rect.x0 - 330) < 2, rect
        assert abs(rect.y0 - 726) < 2, rect
        assert abs(rect.width - 120) < 2, rect
        assert len(doc[1].get_images()) == 1, "page 2 should carry its own stamp"
    finally:
        doc.close()


def test_backup_file_contains_the_library(site, tmp_path):
    """A backup written on one machine restores the library on another."""
    import json

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
        page = ctx.new_page()
        page.goto(site)
        page.wait_for_selector("#introDialog[open]")
        page.click("#introDialog button[value=ok]")

        page.click("#addCompanyBtn")
        page.fill("#cName", "Oakcraft Furniture")
        page.click("#companySave")
        page.wait_for_selector("#companyList li:nth-child(2)")
        page.click("#addAssetBtn")
        page.set_input_files("#assetFile", str(ROOT / "samples" / "sample-stamp.png"))
        page.fill("#aName", "Round Seal")
        page.click("#assetSave")
        page.wait_for_selector(".asset-card", timeout=20000)

        page.click('.tab[data-view="history"]')
        with page.expect_download(timeout=20000) as dl:
            page.click("#backupBtn")
        path = tmp_path / "b.json"
        dl.value.save_as(str(path))

        # a fresh browser profile = a different machine
        ctx2 = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
        page2 = ctx2.new_page()
        page2.goto(site)
        page2.wait_for_selector("#introDialog[open]")
        page2.click("#introDialog button[value=ok]")
        assert page2.locator(".asset-card").count() == 0

        page2.click('.tab[data-view="history"]')
        page2.set_input_files("#restoreInput", str(path))
        page2.wait_for_selector("#confirmDialog[open]")
        page2.click("#confirmYes")
        page2.click('.tab[data-view="library"]')
        page2.wait_for_selector(".asset-card", timeout=20000)
        assert page2.locator(".asset-card").count() == 1

        browser.close()

    data = json.loads(path.read_text())
    assert data["format"] == "stampdesk-backup"
    assert len(data["companies"]) == 1 and len(data["assets"]) == 1
    assert data["assets"][0]["blob"].startswith("data:image/png;base64,")
