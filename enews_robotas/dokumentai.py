"""Dokumentai → Excel: QA lapai (PDI + akumuliatoriaus testas) ir technikos pasai.

Viskas skaitoma šiame kompiuteryje vietine OCR programa (RapidOCR) – be interneto,
be DI paslaugų ir be žetonų. Atspausdintas tekstas skaitomas automatiškai; ranka
rašyta PDI data – tik spėjama (parodoma jos iškarpa, kad žmogus patikrintų / įvestų).

QA lapas (vienas PDF – viena mašina):
  * VIN – „VIN: SJN…“ PDI lape;
  * akumuliatoriaus testo kodas – „TESTO KODAS“ juostelėje, pvz. AB12C-1D23E4-F5G67;
  * testo data ir rezultatas („GERAS AKUMULIAT.“);
  * PDI data – ranka, šalia „Data:“ dešiniame stulpelyje.
Technikos pasas (registracijos liudijimas, gali būti daug puslapių viename PDF):
  * A – valstybinis numeris, B – pirmos registracijos data, E – VIN.
"""

from __future__ import annotations

import datetime as dt
import io
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

DPI = 250
VIN_RE = re.compile(r"[A-HJ-NPR-Z0-9]{17}")
KODAS_RE = re.compile(r"\b([A-Z0-9]{4,6})-([A-Z0-9]{5,7})-([A-Z0-9]{4,6})\b")
DATA_ISO_RE = re.compile(r"(20\d\d)-(\d\d)-(\d\d)")
DATA_TESTO_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d\d)\b")
NUMERIS_RE = re.compile(r"^(?:[A-Z]{3}\d{3}|E[A-Z]\d{4})$")

# Elementas: (x, y, tekstas) – kairysis viršutinis kampas puslapio taškais (DPI raiška).
Elementas = tuple[float, float, str]


@dataclass
class QA:
    failas: str
    vin: str = ""
    kodas: tuple[str, str, str] = ("", "", "")
    testo_data: dt.date | None = None
    rezultatas: str = ""
    pdi_data: dt.date | None = None        # spėjimas iš ranka rašyto teksto (gali būti None)
    pdi_tekstas: str = ""                  # ką OCR „matė“
    pdi_iskarpa: bytes = b""               # PNG – ranka rašytos datos vieta
    kodo_iskarpa: bytes = b""              # PNG – testo juostelės kodas, data, rezultatas
    pdi_ivesta: bool = False               # PDI datą įvedė žmogus (nebe spėjimas)
    pastabos: list[str] = field(default_factory=list)


@dataclass
class Pasas:
    failas: str
    puslapis: int
    vin: str = ""
    numeris: str = ""
    b_data: dt.date | None = None
    iskarpa: bytes = b""                   # PNG – A (numeris), B (data), E (VIN)


@dataclass
class Eilute:
    """Viena mašina Excel'iui: QA + jos technikos pasas."""
    qa: QA
    pasas: Pasas | None
    pastabos: list[str] = field(default_factory=list)

    @property
    def blokuota(self) -> bool:
        return self.pasas is None or not self.qa.vin or not all(self.qa.kodas) or self.qa.pdi_data is None


# --- OCR -----------------------------------------------------------------------

@lru_cache(maxsize=1)
def _variklis():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR()


def _puslapiai(kelias: Path):
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    with fitz.open(str(kelias)) as doc:
        for p in doc:
            yield p.get_pixmap(dpi=DPI).tobytes("png")


Remas = tuple[float, float, float, float, str]   # x0, y0, x1, y1, tekstas


def ocr_remai(png: bytes) -> list[Remas]:
    rez, _ = _variklis()(png)
    out = []
    for b, t, _ in rez or []:
        if t.strip():
            xs, ys = [q[0] for q in b], [q[1] for q in b]
            out.append((min(xs), min(ys), max(xs), max(ys), t.strip()))
    return out


def ocr(png: bytes) -> list[Elementas]:
    return [(x0, y0, t) for x0, y0, _, _, t in ocr_remai(png)]


def sudeti(*png: bytes) -> bytes:
    """Kelios iškarpos viena po kita (vienas paveikslėlis Excel'iui)."""
    from PIL import Image
    imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in png if b]
    if not imgs:
        return b""
    out = Image.new("RGB", (max(i.width for i in imgs), sum(i.height for i in imgs) + 6 * (len(imgs) - 1)), "white")
    y = 0
    for i in imgs:
        out.paste(i, (0, y))
        y += i.height + 6
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def remu_iskarpa(png: bytes, remai: list[Remas], pora: float = 25) -> bytes:
    """Iškarpa, apimanti visus nurodytus OCR rėmus (su paraštėmis)."""
    if not remai:
        return b""
    return iskarpa(png, min(r[0] for r in remai) - pora, min(r[1] for r in remai) - pora,
                   max(r[2] for r in remai) + pora, max(r[3] for r in remai) + pora)


def iskarpa(png: bytes, x0: float, y0: float, x1: float, y1: float) -> bytes:
    from PIL import Image
    img = Image.open(io.BytesIO(png))
    buf = io.BytesIO()
    img.crop((max(0, int(x0)), max(0, int(y0)), min(img.width, int(x1)), min(img.height, int(y1)))).save(buf, "PNG")
    return buf.getvalue()


# --- Tekstų tvarkymas -------------------------------------------------------------------

def vin_is(tekstas: str) -> str:
    """VIN iš OCR teksto; VIN abėcėlėje nėra I, O, Q – OCR juos painioja su 1, 0."""
    t = re.sub(r"[^A-Z0-9]", "", tekstas.upper()).replace("O", "0").replace("Q", "0").replace("I", "1")
    m = re.search(r"SJN[A-HJ-NPR-Z0-9]{14}|VNV[A-HJ-NPR-Z0-9]{14}|[A-HJ-NPR-Z0-9]{17}", t)
    return m.group(0) if m else ""


def numeris_is(tekstas: str) -> str:
    t = re.sub(r"[^A-Z0-9]", "", tekstas.upper())
    if len(t) != 6:
        return ""
    # skaitmenų dalyje OCR kartais mato O vietoj 0 ar I vietoj 1
    abc123 = t[:3] + t[3:].replace("O", "0").replace("I", "1")
    ea1234 = t[:2] + t[2:].replace("O", "0").replace("I", "1")
    for kandidatas in (abc123, ea1234):
        if NUMERIS_RE.match(kandidatas):
            return kandidatas
    return ""


RANKA = str.maketrans({"M": "11", "N": "11", "L": "1", "I": "1", "|": "1", "!": "1", "/": "1", "O": "0",
                       "D": "0", "Q": "0", "S": "5", "Z": "2", "B": "8", "G": "6", "A": "4", "T": "7"})


def ranka_rasyta_data(tekstas: str, siandien: dt.date, apie: dt.date | None = None) -> dt.date | None:
    """Ranka rašyta data: „26 11 03“, „261103“, „2026.10.28“, „26M03“ (M = 11) …
    Grąžinama tik tikėtina data (ne ateityje, ne senesnė nei metai; jei duota `apie` –
    ne toliau kaip 60 d. nuo jos)."""
    t = tekstas.upper().replace("DATA", "").replace(":", " ")
    t = "".join(c.translate(RANKA) if not c.isdigit() and not c in " .,-" else c for c in t)
    skaitmenys = re.sub(r"\D", "", t)
    kandidatai = []
    if len(skaitmenys) == 8:
        kandidatai.append((int(skaitmenys[:4]), int(skaitmenys[4:6]), int(skaitmenys[6:])))
    if len(skaitmenys) == 6:
        kandidatai.append((2000 + int(skaitmenys[:2]), int(skaitmenys[2:4]), int(skaitmenys[4:])))
    dalys = [d for d in re.split(r"[ .,\-]+", t) if d.isdigit()]
    if len(dalys) == 3:
        m = int(dalys[0]) if len(dalys[0]) == 4 else 2000 + int(dalys[0][-2:])
        kandidatai.append((m, int(dalys[1]), int(dalys[2])))
    for metai, menuo, diena in kandidatai:
        try:
            d = dt.date(metai, menuo, diena)
        except ValueError:
            continue
        if siandien - dt.timedelta(days=366) <= d <= siandien and (apie is None or abs((d - apie).days) <= 60):
            return d
    return None


def ivesta_data(tekstas: str, siandien: dt.date | None = None) -> dt.date | None:
    """Žmogaus įvesta data: 261103, 26 11 03, 2026-11-03, 2026.11.03, 11.03 (šie metai)."""
    siandien = siandien or dt.date.today()
    t = tekstas.strip()
    sk = re.sub(r"\D", "", t)
    dalys = [d for d in re.split(r"\D+", t) if d]
    try:
        if len(dalys) == 3:
            m = int(dalys[0]) if len(dalys[0]) == 4 else 2000 + int(dalys[0])
            return dt.date(m, int(dalys[1]), int(dalys[2]))
        if len(dalys) == 2:
            return dt.date(siandien.year, int(dalys[0]), int(dalys[1]))
        if len(sk) == 8:
            return dt.date(int(sk[:4]), int(sk[4:6]), int(sk[6:]))
        if len(sk) == 6:
            return dt.date(2000 + int(sk[:2]), int(sk[2:4]), int(sk[4:]))
        if len(sk) == 4:
            return dt.date(siandien.year, int(sk[:2]), int(sk[2:]))
    except ValueError:
        return None
    return None


# --- QA lapas ----------------------------------------------------------------------------

def nagrineti_qa(elementai: list[Elementas], failas: str, siandien: dt.date, plotis: float = 2000) -> QA:
    """`plotis` – puslapio plotis taškais: testo juostelė yra dešiniame krašte (> 75 % pločio)."""
    qa = QA(failas=failas)
    for x, y, t in elementai:
        if not qa.vin and "VIN" in t.upper():
            qa.vin = vin_is(t.split(":", 1)[-1] if ":" in t else t)
        m = KODAS_RE.search(t.replace(" ", "").upper())
        if m and not all(qa.kodas):
            qa.kodas = (m.group(1), m.group(2), m.group(3))
        m = DATA_TESTO_RE.search(t)
        if m and qa.testo_data is None:
            try:
                qa.testo_data = dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except ValueError:
                pass
        # Rezultatas – juostelėje („GERAS AKUMULIAT.“), ne PDI sąrašo eilutė „Akumuliatoriaus būklės…“
        if x > plotis * 0.75 and "AKUMUL" in t.upper() and "TIPAS" not in t.upper() and not qa.rezultatas:
            qa.rezultatas = t
    if not qa.vin:
        qa.pastabos.append("nerastas VIN")
    if not all(qa.kodas):
        qa.pastabos.append("nerastas akumuliatoriaus testo kodas")
    if qa.rezultatas and "GERAS" not in qa.rezultatas.upper():
        qa.pastabos.append(f"akumuliatorius: {qa.rezultatas}")
    # Failo pavadinimas paprastai = 6 paskutiniai VIN skaitmenys – jei nesutampa, įspėjame.
    pav = re.search(r"(\d{6})", Path(failas).stem)
    if pav and qa.vin and not qa.vin.endswith(pav.group(1)):
        qa.pastabos.append(f"failo pavadinime {pav.group(1)}, o lape VIN …{qa.vin[-6:]} – patikrinkite")
    return qa


def pdi_datos_vieta(elementai: list[Elementas], plotis: float) -> tuple[float, float] | None:
    """Ranka rašytos PDI datos vieta: „Data:“ dešiniame stulpelyje tarp „Patikrinti visi nurodyti
    punktai… pristatymui.“ ir „GALUTINĖ PATIKRA“. OCR kartais „Data:“ nemato arba sujungia su ranka
    rašytu tekstu – tada vieta apskaičiuojama nuo šių užrašų."""
    desine = [(x, y, t.upper().replace(" ", "")) for x, y, t in elementai if x > plotis * 0.4]  # OCR praleidžia tarpus
    stulp_x = min((x for x, y, t in desine if "PRISTATYMUI" in t or "PATIKRINTIVISI" in t), default=None)
    virsus = max((y for x, y, t in desine if "PRISTATYMUI" in t), default=None)
    if virsus is None:
        virsus = min((y + 30 for x, y, t in desine if "PATIKRINTIVISI" in t), default=None)
    apacia = min((y for x, y, t in desine if "GALUTIN" in t and (virsus is None or y > virsus)), default=None)
    if virsus is None and apacia is not None:
        virsus = apacia - 220
    datos = sorted((y, x) for x, y, t in desine if t.startswith("DATA"))
    if virsus is not None:
        tarp = [(y, x) for y, x in datos if virsus < y < (apacia if apacia is not None else virsus + 220)]
        if tarp:
            return tarp[0][1], tarp[0][0]
        if stulp_x is None:
            stulp_x = min((x for x, y, t in desine if apacia is not None and abs(y - apacia) < 30), default=plotis * 0.51)
        return stulp_x, virsus + 75
    return (datos[0][1], datos[0][0]) if datos else None


def skaityti_qa(kelias: Path, siandien: dt.date | None = None, png: bytes | None = None,
                remai: list[Remas] | None = None) -> QA:
    from PIL import Image
    siandien = siandien or dt.date.today()
    png = png or next(_puslapiai(kelias))
    remai = remai if remai is not None else ocr_remai(png)
    elementai = [(x0, y0, t) for x0, y0, _, _, t in remai]
    plotis = Image.open(io.BytesIO(png)).width
    qa = nagrineti_qa(elementai, Path(kelias).name, siandien, plotis)
    # Testo juostelės iškarpa: kodas + testo data + rezultatas (dešinė puslapio dalis)
    desine = [r for r in remai if r[0] > plotis * 0.7]
    kodas = [r for r in desine if KODAS_RE.search(r[4].replace(" ", "").upper()) or "KODAS" in r[4].upper()]
    data_rez = [r for r in desine if DATA_TESTO_RE.search(r[4]) or (r[4] == qa.rezultatas and qa.rezultatas)]
    qa.kodo_iskarpa = sudeti(remu_iskarpa(png, kodas, 12), remu_iskarpa(png, data_rez, 12))
    vieta = pdi_datos_vieta(elementai, plotis)
    if vieta:
        x, y = vieta
        qa.pdi_iskarpa = iskarpa(png, x - 10, y - 60, min(x + 520, plotis * 0.74), y + 110)
        # OCR tekstai toje pačioje vietoje (ranka rašyta data – šalia „Data:“)
        riba = min(x + 480, plotis * 0.75)  # ne toliau juostelės
        salia = [t for ex, ey, t in elementai
                 if x - 20 <= ex <= riba and y - 45 <= ey <= y + 70 and not t.upper().startswith("DATA")
                 and "PRISTATYM" not in t.upper()]
        qa.pdi_tekstas = " ".join(salia)
        qa.pdi_data = ranka_rasyta_data(qa.pdi_tekstas, siandien, qa.testo_data)
    if qa.pdi_data is None:
        qa.pastabos.append("PDI data ranka – įveskite pagal paveikslėlį")
    else:
        qa.pastabos.append("PDI data atspėta iš ranka rašyto – patikrinkite paveikslėlyje")
    return qa


# --- Technikos pasas ------------------------------------------------------------------------

def nagrineti_pasa(elementai: list[Elementas], failas: str, puslapis: int) -> Pasas:
    p = Pasas(failas=failas, puslapis=puslapis)
    datos: list[tuple[float, float, dt.date]] = []
    for x, y, t in elementai:
        if not p.vin and re.search(r"SJN|VNV", t.upper().replace(" ", "")):
            p.vin = vin_is(t)
        if not p.numeris:
            p.numeris = numeris_is(t[1:] if t[:1] == "A" and len(t) > 6 else t)
        for m in DATA_ISO_RE.finditer(t):
            try:
                datos.append((y, x, dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))))
            except ValueError:
                pass
    if datos:
        # Eilutės: „A … I data“ ir „B data B.1 data“ – B yra kairiausia data eilutėje su daugiausia datų.
        eilutes: dict[int, list[tuple[float, dt.date]]] = {}
        for y, x, d in datos:
            raktas = next((k for k in eilutes if abs(k - y) < 25), int(y))
            eilutes.setdefault(raktas, []).append((x, d))
        eil = max(eilutes.values(), key=lambda e: (len(e), -min(x for x, _ in e)))
        p.b_data = min(eil)[1] if len(eil) > 1 else sorted(datos)[min(1, len(datos) - 1)][2]
    return p


def pasas_is_puslapio(png: bytes, failas: str, puslapis: int, remai: list[Remas] | None = None) -> Pasas:
    remai = remai if remai is not None else ocr_remai(png)
    p = nagrineti_pasa([(x0, y0, t) for x0, y0, _, _, t in remai], failas, puslapis)
    numeris = [r for r in remai if p.numeris and numeris_is(r[4][1:] if r[4][:1] == "A" and len(r[4]) > 6
                                                            else r[4]) == p.numeris]
    vin = [r for r in remai if p.vin and vin_is(r[4]) == p.vin]
    # B data – toje pačioje eilutėje kaip „B“; imame kairiausią tokią datą žemiau numerio
    b = [r for r in remai if p.b_data and p.b_data.isoformat() in r[4]]
    if numeris and b:
        b = [min((r for r in b if r[1] > numeris[0][1] + 15), key=lambda r: (r[1], r[0]), default=b[0])]
    p.iskarpa = sudeti(remu_iskarpa(png, numeris + b, 12), remu_iskarpa(png, vin, 12))
    return p


def skaityti_pasus(kelias: Path) -> list[Pasas]:
    return [pasas_is_puslapio(png, Path(kelias).name, i) for i, png in enumerate(_puslapiai(kelias), start=1)]


def yra_pasas(remai: list[Remas]) -> bool:
    tekstas = " ".join(r[4].upper() for r in remai)
    return "REGISTRACIJOS" in tekstas or "LIUDIJIMAS" in tekstas


def skaityti_failus(keliai: list[Path], pranesti=None, siandien: dt.date | None = None
                    ) -> tuple[list[QA], list[Pasas]]:
    """Sumesti PDF'ai: kiekvienas puslapis atpažįstamas pats – QA lapas ar technikos pasas.
    `pranesti(tekstas)` – progreso pranešimams (gali būti None)."""
    qa_sarasas: list[QA] = []
    pasai: list[Pasas] = []
    for kelias in keliai:
        kelias = Path(kelias)
        for i, png in enumerate(_puslapiai(kelias), start=1):
            if pranesti:
                pranesti(f"Skaitomas {kelias.name}, {i} psl.…")
            remai = ocr_remai(png)
            if yra_pasas(remai):
                pasai.append(pasas_is_puslapio(png, kelias.name, i, remai))
            else:
                qa = skaityti_qa(kelias, siandien, png, remai)
                if i > 1:
                    qa.failas = f"{kelias.name} ({i} psl.)"
                qa_sarasas.append(qa)
    return qa_sarasas, pasai


# --- Sujungimas ir Excel ------------------------------------------------------------------------

def sujungti(qa_sarasas: list[QA], pasai: list[Pasas]) -> list[Eilute]:
    pagal_vin = {p.vin: p for p in pasai if p.vin}
    rez = []
    for qa in qa_sarasas:
        pasas = pagal_vin.get(qa.vin)
        eil = Eilute(qa=qa, pasas=pasas)
        if pasas is None and qa.vin:
            # leidžiame vieną OCR klaidą VIN'e, bet pažymime
            panasus = [p for v, p in pagal_vin.items() if len(v) == 17 and sum(a != b for a, b in zip(v, qa.vin)) == 1]
            if len(panasus) == 1:
                eil.pasas = panasus[0]
                eil.pastabos.append(f"VIN skiriasi 1 simboliu nuo technikos paso ({panasus[0].vin}) – patikrinkite")
            else:
                eil.pastabos.append("technikos pasas su šiuo VIN nerastas")
        if eil.pasas and not eil.pasas.numeris:
            eil.pastabos.append("technikos pase neperskaitytas numeris")
        if eil.pasas and not eil.pasas.b_data:
            eil.pastabos.append("technikos pase neperskaityta data B")
        rez.append(eil)
    return rez


def ivesti_pdi(qa: QA, data: dt.date) -> None:
    """Žmogus patikrino / įvedė PDI datą pagal iškarpą."""
    qa.pdi_data = data
    qa.pdi_ivesta = True
    qa.pastabos = [p for p in qa.pastabos if not p.startswith("PDI data")]


def be_qa(qa_sarasas: list[QA], pasai: list[Pasas]) -> list[Pasas]:
    """Technikos pasai, kuriems neatsiųstas QA lapas."""
    vin = {q.vin for q in qa_sarasas}
    return [p for p in pasai if p.vin and p.vin not in vin]


def _excel_paveikslelis(png: bytes, max_plotis: int = 340, max_aukstis: int = 170):
    from openpyxl.drawing.image import Image as XlImage
    from PIL import Image
    img = Image.open(io.BytesIO(png))
    mastas = min(1.0, max_plotis / img.width, max_aukstis / img.height)
    buf = io.BytesIO()
    img.resize((max(1, int(img.width * mastas)), max(1, int(img.height * mastas)))).save(buf, "PNG")
    buf.seek(0)
    x = XlImage(buf)
    return x, x.height


def sukurti_excel(eilutes: list[Eilute], kelias: Path, nust, be_qa_pasai: list[Pasas] | None = None) -> Path:
    """Nauja partijos Excel – tie patys stulpeliai kaip robotui (VIN, 3 kodo dalys, PDI, B, numeris),
    o dešiniau – pastabos ir iškarpos iš dokumentų, kad būtų galima patikrinti akimis.
    Neužpildytus laukus (pvz. PDI datą) įrašykite patys – robotas tokių eilučių nepradės."""
    from excel_eiles import sukurti_sablona
    from openpyxl import load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import column_index_from_string, get_column_letter

    sukurti_sablona(kelias, nust)
    wb = load_workbook(kelias)
    del wb["Pavyzdys"]
    ws = wb.worksheets[0]
    k1, k2, k3 = nust.STULP_KODAS
    po = column_index_from_string(nust.STULP_BUSENA)
    st_past, st_pdi, st_kodas, st_pasas = (get_column_letter(po + i) for i in (1, 2, 3, 4))
    for st, tekstas, plotis in ((st_past, "Pastabos (iš dokumentų)", 40), (st_pdi, "PDI data (ranka) – iškarpa", 46),
                                (st_kodas, "Akumuliatoriaus testas – iškarpa", 46),
                                (st_pasas, "Tech. pasas (A, B, E) – iškarpa", 46)):
        ws[f"{st}1"] = tekstas
        ws[f"{st}1"].font = Font(bold=True)
        ws[f"{st}1"].alignment = Alignment(wrap_text=True, horizontal="center")
        ws.column_dimensions[st].width = plotis
    geltona = PatternFill(fill_type="solid", fgColor="FFFFFF00")
    nr = 2
    for e in eilutes:
        p = e.pasas
        qa = e.qa
        pdi = qa.pdi_data.strftime("%m.%d") if qa.pdi_data else ""
        for st, v in ((nust.STULP_VIN, qa.vin), (k1, qa.kodas[0]), (k2, qa.kodas[1]), (k3, qa.kodas[2]),
                      (nust.STULP_PDI_DATA, pdi),
                      (nust.STULP_GARANTIJA, p.b_data.strftime("%m.%d") if p and p.b_data else ""),
                      (nust.STULP_NUMERIS, p.numeris if p else "")):
            ws[f"{st}{nr}"] = v
            if not v:
                ws[f"{st}{nr}"].fill = geltona          # trūksta – įrašykite (VIN langelio nespalviname)
        if qa.pdi_data and qa.pdi_tekstas and not qa.pdi_ivesta:
            ws[f"{nust.STULP_PDI_DATA}{nr}"].fill = geltona    # atspėta iš ranka rašyto – patikrinkite
        pastabos = [qa.failas] + qa.pastabos + e.pastabos
        ws[f"{st_past}{nr}"] = "\n".join(pastabos)
        ws[f"{st_past}{nr}"].alignment = Alignment(wrap_text=True, vertical="top")
        aukstis = 20
        for st, png in ((st_pdi, qa.pdi_iskarpa), (st_kodas, qa.kodo_iskarpa), (st_pasas, p.iskarpa if p else b"")):
            if png:
                img, h = _excel_paveikslelis(png)
                ws.add_image(img, f"{st}{nr}")
                aukstis = max(aukstis, h)
        ws.row_dimensions[nr].height = aukstis * 0.75 + 6   # taškai (pt) ≈ 0,75 px
        for st in (nust.STULP_VIN, k1, k2, k3, nust.STULP_PDI_DATA, nust.STULP_GARANTIJA, nust.STULP_NUMERIS):
            ws[f"{st}{nr}"].alignment = Alignment(vertical="center")
        nr += 1
    if be_qa_pasai:
        lapas = wb.create_sheet("Pasai be QA")
        lapas.append(["Numeris", "VIN", "B data", "Failas", "Puslapis"])
        for p in be_qa_pasai:
            lapas.append([p.numeris, p.vin, p.b_data.isoformat() if p.b_data else "", p.failas, p.puslapis])
        for st, w in (("A", 10), ("B", 22), ("C", 12), ("D", 30)):
            lapas.column_dimensions[st].width = w
    wb.save(kelias)
    return kelias
