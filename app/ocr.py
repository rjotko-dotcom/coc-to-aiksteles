"""Skenuotų CoC atpažinimas (OCR).

Nissan B2B portalo atitikties liudijimai atsisiunčiami kaip **paveikslėliai**
PDF viduje – teksto sluoksnio juose nėra, todėl duomenis reikia atpažinti.

Naudojama:
* `pymupdf` – puslapiams paversti į vaizdą (viskas atmintyje, be laikinų failų);
* `rapidocr-onnxruntime` – pats atpažinimas. Tai įprastas Python paketas:
  nereikia nei administratoriaus teisių, nei atskirai diegiamos programos,
  o įdiegus veikia be interneto.

Jei kompiuteryje jau įdiegtas Tesseract, jis naudojamas kaip alternatyva.
"""

from __future__ import annotations

import re
from functools import lru_cache

#: Kokia raiška piešiami puslapiai. 200 dpi pakanka CoC šriftui ir yra
#: pastebimai greičiau nei 300 dpi.
RENDER_DPI = 200

#: Pilno pločio (CJK) ženklai, kuriuos OCR kartais grąžina vietoj įprastų.
_TRANSLATION = str.maketrans({
    "：": ":", "（": "(", "）": ")", "，": ",", "．": ".",
    "－": "-", "＊": "*", "／": "/", "　": " ",
})


class OcrUnavailable(RuntimeError):
    """OCR reikalingas, bet nėra įdiegtų bibliotekų."""


def normalise_ocr_text(text: str) -> str:
    """Sutvarko OCR ženklus, kad tekstą būtų galima parsinti kaip įprastą."""
    return text.translate(_TRANSLATION)


def available_backend() -> str | None:
    """Grąžina naudojamo OCR variklio pavadinimą arba None."""
    try:
        import pymupdf  # noqa: F401
    except ImportError:
        return None
    try:
        import rapidocr_onnxruntime  # noqa: F401

        return "rapidocr"
    except ImportError:
        pass
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return "tesseract"
    except Exception:
        return None


def render_pages(pdf_bytes: bytes, dpi: int = RENDER_DPI) -> list[bytes]:
    """PDF puslapius paverčia PNG vaizdais atmintyje."""
    import pymupdf

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
        return [page.get_pixmap(dpi=dpi).tobytes("png") for page in document]


def _lines_from_boxes(items: list[tuple[float, float, float, str]]) -> list[str]:
    """Iš OCR fragmentų su koordinatėmis atkuria dokumento eilutes.

    CoC yra dviejų stulpelių forma (kairėje – pavadinimas, dešinėje – reikšmė),
    o eilučių žingsnis mažesnis už teksto aukštį, todėl fragmentai grupuojami
    pagal nedidelį nuokrypį nuo ankstesnio fragmento vidurio.
    """
    if not items:
        return []
    items = sorted(items, key=lambda item: (item[0], item[1]))
    heights = sorted(item[2] for item in items)
    tolerance = max(3.0, heights[len(heights) // 2] * 0.45)

    lines: list[list[tuple[float, str]]] = []
    current: list[tuple[float, str]] = []
    previous_y: float | None = None
    for y, x, _, text in items:
        if previous_y is not None and y - previous_y > tolerance:
            lines.append(current)
            current = []
        current.append((x, text))
        previous_y = y
    if current:
        lines.append(current)

    return [
        " ".join(text for _, text in sorted(line, key=lambda part: part[0]))
        for line in lines
    ]


@lru_cache(maxsize=1)
def _rapidocr_engine():
    """Modelis įkeliamas vieną kartą – kitiems failams nebereikia laukti."""
    from rapidocr_onnxruntime import RapidOCR

    return RapidOCR()


def _rapidocr_text(images: list[bytes]) -> str:
    engine = _rapidocr_engine()
    pages: list[str] = []
    for image in images:
        result, _ = engine(image)
        items = []
        for box, text, _score in result or []:
            ys = [point[1] for point in box]
            xs = [point[0] for point in box]
            items.append(((min(ys) + max(ys)) / 2, min(xs), max(ys) - min(ys), text))
        pages.append("\n".join(_lines_from_boxes(items)))
    return "\n".join(pages)


def _tesseract_text(images: list[bytes]) -> str:
    import io

    import pytesseract
    from PIL import Image

    return "\n".join(
        pytesseract.image_to_string(Image.open(io.BytesIO(image)), lang="eng")
        for image in images
    )


def pdf_to_text(pdf_bytes: bytes) -> str:
    """Atpažįsta skenuoto CoC tekstą. Į diską nieko nerašoma."""
    backend = available_backend()
    if backend is None:
        raise OcrUnavailable(
            "CoC yra skenuotas (be teksto sluoksnio), o OCR bibliotekų nerasta. "
            "Įdiekite: pip install pymupdf rapidocr-onnxruntime"
        )
    images = render_pages(pdf_bytes)
    text = _rapidocr_text(images) if backend == "rapidocr" else _tesseract_text(images)
    return normalise_ocr_text(re.sub(r"[ \t]+", " ", text))
