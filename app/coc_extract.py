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

import io
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

DATE_RE = re.compile(r"(?<!\d)(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})(?!\d)")
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


#: VIN kontrolinio skaitmens skaičiavimas (ISO 3779) – padeda pastebėti,
#: jei OCR supainiojo skaitmenį skenuotame liudijime.
_VIN_VALUES = {**{str(d): d for d in range(10)}, **{
    "A": 1, "B": 2, "C": 3, "D": 4, "E": 5, "F": 6, "G": 7, "H": 8,
    "J": 1, "K": 2, "L": 3, "M": 4, "N": 5, "P": 7, "R": 9,
    "S": 2, "T": 3, "U": 4, "V": 5, "W": 6, "X": 7, "Y": 8, "Z": 9,
}}
_VIN_WEIGHTS = (8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2)


def vin_check_digit_valid(vin: str) -> bool:
    """Ar VIN kontrolinis skaitmuo (9-as ženklas) teisingas.

    Europoje jis neprivalomas, todėl klaidingas rezultatas dar nereiškia
    blogo VIN – bet po OCR tai geras įspėjimas patikrinti.
    """
    vin = (vin or "").upper()
    if len(vin) != 17 or any(ch not in _VIN_VALUES for ch in vin):
        return False
    total = sum(_VIN_VALUES[ch] * weight for ch, weight in zip(vin, _VIN_WEIGHTS))
    remainder = total % 11
    return vin[8] == ("X" if remainder == 10 else str(remainder))


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
    ocr_used: bool = False

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


def pdf_to_text(source: str | Path | bytes) -> str:
    """Ištraukia visą PDF tekstą (visus puslapius) išlaikant išdėstymą.

    `source` gali būti failo kelias arba PDF baitai – baitų atveju niekas
    nerašoma į diską, dirbama tik atmintyje.
    """
    import pdfplumber

    handle = io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else str(source)
    chunks: list[str] = []
    with pdfplumber.open(handle) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""
            chunks.append(text)
    return "\n".join(chunks)


def _ocr_to_text(source: str | Path | bytes) -> str:
    """Skenuoto CoC atpažinimas (žr. `app/ocr.py`)."""
    from . import ocr

    content = bytes(source) if isinstance(source, (bytes, bytearray)) else Path(source).read_bytes()
    return ocr.pdf_to_text(content)


# ---------------------------------------------------------------------------
# Parsinimas
# ---------------------------------------------------------------------------


def _split_label_value(line: str) -> tuple[str, str] | None:
    """Eilutę "0.1. Make (Trade name) : NISSAN" skaido į (etiketė, reikšmė)."""
    if ":" not in line:
        return None
    label, _, value = line.partition(":")
    return label.strip(), value.strip()


def parse_coc_text(text: str, source_file: str = "", ocr_used: bool = False) -> CoCData:
    """Iš CoC teksto sudaro `CoCData`."""
    from .ocr import normalise_ocr_text

    text = normalise_ocr_text(text)
    data = CoCData(source_file=source_file, ocr_used=ocr_used)
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
        elif "colour of" in text_label or "color of" in text_label:
            data.colour_raw = data.colour_raw or value
        elif code == "40":
            colour_by_code = colour_by_code or value

    if not data.colour_raw and colour_by_code:
        data.colour_raw = colour_by_code
    data.colour = to_lithuanian(data.colour_raw)

    # -- tipo patvirtinimas ------------------------------------------------
    m = re.search(
        r"approval\s*(" + APPROVAL_RE.pattern + r")\s*granted\s*on\s*"
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
            r"granted\s*on\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{4})", flat, re.IGNORECASE
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
    if data.vin and ocr_used and not vin_check_digit_valid(data.vin):
        data.warnings.append(
            f"VIN „{data.vin}“ kontrolinis skaitmuo nesutampa – po OCR būtinai "
            "sulyginkite su liudijimu."
        )
    if ocr_used:
        data.warnings.append(
            "CoC skenuotas – duomenys atpažinti automatiškai (OCR). "
            "Prieš spausdindami sulyginkite VIN ir spalvą su liudijimu."
        )
    if data.colour_raw and not data.colour:
        data.warnings.append(
            f"Spalva „{data.colour_raw}“ neatpažinta – įrašykite lietuvišką pavadinimą."
        )
    elif not data.colour_raw:
        data.warnings.append("Nerasta: spalva (40) – gali būti CoC 2 puslapyje.")

    return data


def extract_from_bytes(content: bytes, source_file: str = "") -> CoCData:
    """CoC PDF baitai -> `CoCData`. Į diską nieko nerašoma."""
    text = pdf_to_text(content)
    ocr_used = len(re.sub(r"\s", "", text)) < 200
    if ocr_used:
        # Teksto sluoksnio nėra (Nissan B2B portalo CoC yra paveikslėliai)
        text = _ocr_to_text(content)
    return parse_coc_text(text, source_file=source_file, ocr_used=ocr_used)


def extract_from_pdf(pdf_path: str | Path) -> CoCData:
    """Pagrindinė funkcija: CoC PDF failas -> `CoCData`."""
    pdf_path = Path(pdf_path)
    return extract_from_bytes(pdf_path.read_bytes(), source_file=pdf_path.name)
