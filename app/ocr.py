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


#: Naujo skirsnio pradžia: numeris ir po jo pavadinimas ("16.2 Technically…",
#: "0.4. Catégorie…"). Vien skaičius ar "1. 1100 kg" netinka – tai reikšmė.
ITEM_START_RE = re.compile(r"^\d+(?:\.\d+)*\.?\s+[^\d\s]")


#: Eilutė, kurioje yra „pavadinimas : reikšmė“ pora (yra tekstas iš abiejų
#: dvitaškio pusių). Pagal tokių eilučių dalį sprendžiama, ar tai atskiras
#: puslapio stulpelis, ar tik reikšmių skiltis.
PAIR_RE = re.compile(r"\S\s*:\s*\S")

#: Mažiausias tarpas tarp stulpelių (puslapio pločio dalis).
MIN_GUTTER = 0.02


def _rows(items: list[tuple[float, float, float, float, str]]) -> list[list[tuple[float, float, str]]]:
    """Fragmentus sugrupuoja į eilutes pagal aukštį (be stulpelių dalybos)."""
    if not items:
        return []
    items = sorted(items, key=lambda item: (item[0], item[1]))
    heights = sorted(item[3] for item in items)
    tolerance = max(3.0, heights[len(heights) // 2] * 0.45)

    rows: list[list[tuple[float, float, str]]] = []
    current: list[tuple[float, float, str]] = []
    previous_y: float | None = None
    for y, x0, x1, _height, text in items:
        if previous_y is not None and y - previous_y > tolerance:
            rows.append(current)
            current = []
        current.append((x0, x1, text))
        previous_y = y
    if current:
        rows.append(current)
    return rows


def _has_label_value_pairs(items) -> bool:
    """Ar šioje puslapio dalyje yra savų „pavadinimas : reikšmė“ eilučių."""
    lines = [" ".join(text for _, _, text in sorted(row)) for row in _rows(items)]
    if not lines:
        return False
    pairs = sum(1 for line in lines if PAIR_RE.search(line))
    return pairs >= 4 and pairs / len(lines) >= 0.25


def _gutters(items, minimum: float) -> list[float]:
    """Vertikalūs tarpai (be teksto), platesni už `minimum`."""
    spans = sorted((item[1], item[2]) for item in items)
    gaps: list[float] = []
    end = spans[0][1]
    for x0, x1 in spans[1:]:
        if x0 - end > minimum:
            gaps.append((end + x0) / 2)
        end = max(end, x1)
    return gaps


def _split_into_columns(items) -> list[list]:
    """Puslapį padalija į stulpelius.

    Vien pagal tarpus spręsti negalima: tarpas yra ir tarp pavadinimų bei
    reikšmių skilties. Stulpelio riba pripažįstama tik tada, kai **abiejose**
    pusėse yra savarankiškų „pavadinimas : reikšmė“ eilučių – reikšmių skiltis
    tokių neturi (joje vien reikšmės), o pavadinimų – vien pavadinimai.
    """
    if len(items) < 20:
        return [items]
    width = max(item[2] for item in items) - min(item[1] for item in items)
    minimum = max(10.0, width * MIN_GUTTER)

    for boundary in _gutters(items, minimum):
        left = [item for item in items if item[2] <= boundary]
        right = [item for item in items if item[1] >= boundary]
        if _has_label_value_pairs(left) and _has_label_value_pairs(right):
            return [left] + _split_into_columns(right)
    return [items]


def _split_at_column_gaps(parts: list[tuple[float, float, str]], gap: float) -> list[str]:
    """Vieno aukščio fragmentus išskaido į atskiras eilutes ties stulpelių tarpais.

    Daugiastulpelėse formose (Hyundai, Citroën) toje pačioje aukštumoje yra
    kelių skirsnių eilutės, todėl grupuoti vien pagal aukštį negalima. Tarpas
    laikomas stulpelių riba tik tada, kai už jo prasideda naujas skirsnio
    numeris – kitaip būtų suskaldytos ir įprastos „pavadinimas : reikšmė“
    eilutės, kur reikšmė irgi nutolusi į dešinę.
    """
    parts = sorted(parts, key=lambda part: part[0])
    lines: list[list[str]] = [[]]
    previous_end = None
    for index, (x0, x1, text) in enumerate(parts):
        rest = " ".join(part[2] for part in parts[index:])
        if (
            previous_end is not None
            and x0 - previous_end > gap
            and ITEM_START_RE.match(rest)
        ):
            lines.append([])
        lines[-1].append(text)
        previous_end = x1 if previous_end is None else max(previous_end, x1)
    return [" ".join(line) for line in lines if line]


def _lines_from_boxes(items: list[tuple[float, float, float, float, str]]) -> list[str]:
    """Iš fragmentų su koordinatėmis atkuria dokumento eilutes.

    `items` – (vidurio y, x pradžia, x pabaiga, aukštis, tekstas).

    Pirmiausia puslapis padalijamas į stulpelius (Hyundai liudijimas – trijų,
    Citroën – dviejų), tada kiekviename stulpelyje fragmentai grupuojami į
    eilutes. Eilučių žingsnis formose mažesnis už teksto aukštį, todėl
    grupuojama pagal nedidelį nuokrypį nuo ankstesnio fragmento vidurio.
    """
    if not items:
        return []
    width = max(item[2] for item in items) - min(item[1] for item in items)
    column_gap = max(20.0, width * 0.045)

    lines: list[str] = []
    for column in _split_into_columns(items):
        for row in _rows(column):
            lines.extend(_split_at_column_gaps(row, column_gap))
    return lines


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
            items.append(
                ((min(ys) + max(ys)) / 2, min(xs), max(xs), max(ys) - min(ys), text)
            )
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
