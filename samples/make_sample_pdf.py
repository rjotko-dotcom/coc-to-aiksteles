"""Sukuria demonstracinį CoC PDF iš `sample_coc.txt` (reikia `reportlab`).

Naudojama testams ir bandymams: python samples/make_sample_pdf.py
"""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = Path(__file__).parent


def main() -> None:
    lines = (HERE / "sample_coc.txt").read_text(encoding="utf-8").splitlines()
    pdf = canvas.Canvas(str(HERE / "sample_coc.pdf"), pagesize=A4)
    width, height = A4
    y = height - 40
    pdf.setFont("Courier", 8)
    for line in lines:
        if y < 40:
            pdf.showPage()
            pdf.setFont("Courier", 8)
            y = height - 40
        pdf.drawString(30, y, line[:110])
        y -= 10
    pdf.save()
    print("Sukurta:", HERE / "sample_coc.pdf")


if __name__ == "__main__":
    main()
