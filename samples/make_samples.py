#!/usr/bin/env python3
"""Generate sample files for trying StampDesk out.

    python samples/make_samples.py

Writes, next to this script:
  sample-signature.png   a handwriting-style signature on white paper
  sample-stamp.png       a round company seal on white paper
  sample-invoice.pdf     a 2-page invoice with a signature block on page 2
"""
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
INK = (28, 36, 128)


def signature(path: Path) -> None:
    img = Image.new("RGB", (520, 190), "white")
    d = ImageDraw.Draw(img)
    d.line([(40, 140), (90, 50), (130, 150), (180, 45), (240, 120), (300, 60), (430, 95)],
           fill=INK, width=6, joint="curve")
    d.line([(60, 160), (440, 150)], fill=INK, width=3)
    d.text((330, 160), "Proprietor", fill=INK)
    img.save(path)


def seal(path: Path) -> None:
    img = Image.new("RGB", (420, 420), "white")
    d = ImageDraw.Draw(img)
    d.ellipse((10, 10, 410, 410), outline=INK, width=8)
    d.ellipse((42, 42, 378, 378), outline=INK, width=3)
    d.text((150, 175), "SAMPLE CO.", fill=INK)
    d.text((138, 205), "AUTHORISED", fill=INK)
    d.text((165, 235), "SEAL", fill=INK)
    img.save(path)


def invoice(path: Path) -> None:
    doc = pymupdf.open()
    for page_no in (1, 2):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 70), "TAX INVOICE", fontsize=18, fontname="hebo")
        page.insert_text((60, 95), f"Invoice SD/26-27/001   ·   page {page_no} of 2", fontsize=10)
        page.draw_rect(pymupdf.Rect(50, 110, 545, 112), fill=(0.1, 0.14, 0.5))

        y = 150
        for line in (
            "Sl   Description                        Qty      Rate        Amount",
            "1    Office chair — executive              8   3,502.77    28,022.16",
            "2    Workstation table 1200mm              4   7,744.81    30,979.24",
            "3    Visitor chair — mesh                 12   1,869.00    22,428.00",
        ):
            page.insert_text((60, y), line, fontsize=10, fontname="cour")
            y += 20

        if page_no == 2:
            page.insert_text((60, 300), "Total   ₹ 81,429.40", fontsize=12, fontname="hebo")
            # the signature block — drop a stamp between these two lines
            page.draw_rect(pymupdf.Rect(300, 700, 545, 800), color=(0.6, 0.6, 0.6), width=0.8)
            page.insert_text((430, 720), "for Sample Co.", fontsize=10, fontname="hebo")
            page.insert_text((415, 790), "Authorised Signatory", fontsize=10)
    doc.save(path)
    doc.close()


if __name__ == "__main__":
    signature(HERE / "sample-signature.png")
    seal(HERE / "sample-stamp.png")
    invoice(HERE / "sample-invoice.pdf")
    for f in sorted(HERE.glob("sample-*")):
        print(f"{f.name}  ({f.stat().st_size:,} bytes)")
