"""CoC (EC Certificate of Conformity) PDF duomenų ištraukimas.

Modulis skaito atitikties liudijimo PDF ir grąžina laukus, kurių reikia
"Pažymai apie transporto priemonės tapatumo duomenis" (aikštelei).

CoC skirsniai -> pažymos eilutės:
    0.1   Make .......................... Gamybinė markė            (RL D.1)
    0.2   Type / Variant / Version ...... Tipas/Variantas/Versija   (RL D.2)
    0.2.1 Commercial name ............... Komercinis pavadinimas    (RL D.3)
    0.10  Vehicle identification number . TP identifikavimo numeris (RL E)
    ---   "approval ... granted on ..." .. Tipo patvirtinimo Nr.    (RL K)
                                          ir jo suteikimo data
    40    Colour of the vehicle ......... TP spalva                 (RL R)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .colors import to_lithuanian

# ---------------------------------------------------------------------------
# Pagalbinės funkcijos
# ---------------------------------------------------------------------------

VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b")

# e9*2018/858*11042*16, e11*2007/46*6697*17, e4*KS07/46*1234*00 ir pan.
APPROVAL_RE = re.compile(
    r"\b[eE]\d{1,2}\s*\*\s*[A-Za-z0-9]{0,4}\d{2,4}\s*/\s*\d{1,3}\s*\*\s*\d{3,6}\s*\*\s*\d{1,3}\b"
)

DATE_RE = re.compile(r"\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})\b")
ISO_DATE_RE = re.compile(r"\b(\d{4})[./\-](\d{1,2})[./\-](\d{1,2})\b")

# Eilutės pradžioje esantis skirsnio numeris, pvz. "0.2.1", "40.", "16.1."
ITEM_CODE_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?(?=\s|$)")


def normalise_date(value: str | None) -> str:
    """Datą suvienodina į DD.MM.YYYY (kaip rašoma pažymoje)."""
    if not value:
        return ""
    m = DATE_RE.search(value)
    if m:
        d, mth, y = m.groups()
        return f"{int(d):02d}.{int(mth):02d}.{y}"
    m = ISO_DATE_RE.search(value)
    if m:
        y, mth, d = m.groups()
        return f"{int(d):02d}.{int(mth):02d}.{y}"
    return value.strip()


def _clean(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"\s+", " ", value).strip()
    # kai kuriuose CoC tuščia reikšmė žymima brūkšneliu
    if value in {"-", "--", "---", "N/A", "n/a"}:
        return ""
    return value


# ---------------------------------------------------------------------------
# Rezultato struktūra
# ---------------------------------------------------------------------------


@dataclass
class CoCData:
    """Iš CoC ištraukti duomenys (`*_lt` laukai jau paruošti pažymai)."""

    source_file: str = ""

    make: str = ""                    # 0.1
    type: str = ""                    # 0.2
    variant: str = ""                 # 0.2
    version: str = ""                 # 0.2
    commercial_name: str = ""         # 0.2.1
    vin: str = ""                     # 0.10
    manufacture_date: str = ""        # 0.11
    category: str = ""                # 0.4
    manufacturer: str = ""            # 0.5
    approval_number: str = ""         # "granted in approval ..."
    approval_date: str = ""           # "... granted on ..."
    national_approval_number: str = ""  # CoC nėra – pildoma ranka
    colour_raw: str = ""              # 40 (kaip PDF'e)
    colour: str = ""                  # 40 (lietuviškai)

    warnings: list[str] = field(default_factory=list)

    # -- išvestiniai laukai -------------------------------------------------

    @property
    def type_variant_version(self) -> str:
        """Pažymos eilutė "Tipas/Variantas/Versija", pvz. F16/A/A45."""
        parts = [p for p in (self.type, self.variant, self.version) if p]
        return "/".join(parts)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["type_variant_version"] = self.type_variant_version
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "CoCData":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


# ---------------------------------------------------------------------------
# Teksto skaitymas iš PDF
# ---------------------------------------------------------------------------


def pdf_to_text(pdf_path: str | Path) -> str:
    """Ištraukia visą PDF tekstą (visus puslapius) išlaikant išdėstymą."""
    import pdfplumber

    chunks: list[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""
            chunks.append(text)
    return "\n".join(chunks)


def _ocr_to_text(pdf_path: str | Path) -> str:
    """Atsarginis variantas skenuotiems (be teksto sluoksnio) CoC.

    Veikia tik jei įdiegti `pytesseract` + `pdf2image` + Tesseract.
    """
    try:
        import pytesseract  # type: ignore
        from pdf2image import convert_from_path  # type: ignore
    except Exception as exc:  # pragma: no cover - priklauso nuo aplinkos
        raise RuntimeError(
            "PDF neturi teksto sluoksnio (tikriausiai skenuotas). "
            "OCR reikalauja pytesseract, pdf2image ir Tesseract."
        ) from exc

    pages = convert_from_path(str(pdf_path), dpi=300)
    return "\n".join(pytesseract.image_to_string(p, lang="eng") for p in pages)


# ---------------------------------------------------------------------------
# Parsinimas
# ---------------------------------------------------------------------------


def _split_label_value(line: str) -> tuple[str, str] | None:
    """Eilutę "0.1. Make (Trade name) : NISSAN" skaido į (etiketė, reikšmė)."""
    if ":" not in line:
        return None
    label, _, value = line.partition(":")
    return label.strip(), value.strip()


def parse_coc_text(text: str, source_file: str = "") -> CoCData:
    """Iš CoC teksto sudaro `CoCData`."""
    data = CoCData(source_file=source_file)
    flat = re.sub(r"\s+", " ", text)

    colour_by_code = ""

    for raw_line in text.splitlines():
        line = raw_line.replace("\xa0", " ").strip()
        if not line:
            continue

        parts = _split_label_value(line)
        if not parts:
            continue
        label, value = parts
        value = _clean(value)
        if not value:
            continue

        code_match = ITEM_CODE_RE.match(label)
        code = code_match.group(1) if code_match else ""
        text_label = label[code_match.end():].strip() if code_match else label
        text_label = re.sub(r"\s+", " ", text_label).lower()

        # Variantas/versija tikrinami pirmiau: kai kuriuose CoC jie pažymėti
        # tuo pačiu 0.2 skirsnio numeriu kaip ir tipas.
        if text_label.startswith("variant"):
            data.variant = data.variant or value
        elif text_label.startswith("version"):
            data.version = data.version or value
        elif code == "0.1" or text_label.startswith("make"):
            data.make = data.make or value
        elif code == "0.2" or text_label == "type":
            data.type = data.type or value
        elif code == "0.2.1" or text_label.startswith("commercial name"):
            data.commercial_name = data.commercial_name or value
        elif code == "0.4" or text_label == "category":
            data.category = data.category or value
        elif code == "0.5" or text_label.startswith("company name"):
            data.manufacturer = data.manufacturer or value
        elif code == "0.10" or "vehicle identification number" in text_label:
            m = VIN_RE.search(value.replace(" ", ""))
            data.vin = data.vin or (m.group(0) if m else value)
        elif code == "0.11" or text_label.startswith("date of manufacture"):
            data.manufacture_date = data.manufacture_date or normalise_date(value)
        elif "colour of the vehicle" in text_label or "color of the vehicle" in text_label:
            data.colour_raw = data.colour_raw or value
        elif code == "40":
            colour_by_code = colour_by_code or value

    if not data.colour_raw and colour_by_code:
        data.colour_raw = colour_by_code
    data.colour = to_lithuanian(data.colour_raw)

    # -- tipo patvirtinimas ------------------------------------------------
    m = re.search(
        r"approval\s+(" + APPROVAL_RE.pattern + r")\s+granted\s+on\s+"
        r"(\d{1,2}[./\-]\d{1,2}[./\-]\d{4})",
        flat,
        re.IGNORECASE,
    )
    if m:
        data.approval_number = re.sub(r"\s+", "", m.group(1))
        data.approval_date = normalise_date(m.group(2))
    else:
        m_num = APPROVAL_RE.search(flat)
        if m_num:
            data.approval_number = re.sub(r"\s+", "", m_num.group(0))
        m_date = re.search(
            r"granted\s+on\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{4})", flat, re.IGNORECASE
        )
        if m_date:
            data.approval_date = normalise_date(m_date.group(1))

    # -- VIN atsarginis variantas -----------------------------------------
    if not data.vin:
        for candidate in VIN_RE.findall(flat):
            has_letter = any(ch.isalpha() for ch in candidate)
            has_digit = any(ch.isdigit() for ch in candidate)
            if has_letter and has_digit:
                data.vin = candidate
                data.warnings.append(
                    "VIN rastas ne pagal 0.10 skirsnį, o pagal formatą – patikrinkite."
                )
                break

    # -- įspėjimai ---------------------------------------------------------
    required = {
        "make": "Gamybinė markė (0.1)",
        "type": "Tipas (0.2)",
        "commercial_name": "Komercinis pavadinimas (0.2.1)",
        "vin": "Identifikavimo numeris (0.10)",
        "approval_number": "Tipo patvirtinimo Nr.",
        "approval_date": "Tipo patvirtinimo datos",
    }
    for attr, human in required.items():
        if not getattr(data, attr):
            data.warnings.append(f"Nerasta: {human}")
    if data.colour_raw and not data.colour:
        data.warnings.append(
            f"Spalva „{data.colour_raw}“ neatpažinta – įrašykite lietuvišką pavadinimą."
        )
    elif not data.colour_raw:
        data.warnings.append("Nerasta: spalva (40) – gali būti CoC 2 puslapyje.")

    return data


def extract_from_pdf(pdf_path: str | Path) -> CoCData:
    """Pagrindinė funkcija: CoC PDF -> `CoCData`."""
    pdf_path = Path(pdf_path)
    text = pdf_to_text(pdf_path)
    if len(re.sub(r"\s", "", text)) < 200:
        # PDF greičiausiai skenuotas – bandome OCR
        text = _ocr_to_text(pdf_path)
    return parse_coc_text(text, source_file=pdf_path.name)
