"""Spausdinimas be papildomų programų: paprastas (spalvotai) ir lipnus.

Lipniam (ir, jei norite, paprastam) spausdinimui nuostatos nustatomos VIENĄ KARTĄ
tame pačiame spausdintuvo Preferences lange, kurį naudojate ranka (pvz. SHARP:
2-Sided Printing → None, Paper Source → Labels → OK). Robotas tas nuostatas
įsimena (failas aplanke „spausdintuvo_nuostatos“) ir kiekvieną kartą spausdina
lygiai su jomis. Jūsų įprastos spausdintuvo nuostatos nekeičiamos.

PDF puslapiai nupiešiami (pypdfium2 – tas pats PDF variklis kaip Chrome) ir
siunčiami tiesiai į Windows spausdintuvą.
"""

from __future__ import annotations

import ctypes
import datetime as dt
import json
import logging
import struct
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

import nustatymai as N

log = logging.getLogger("robotas")

ARCH = Path(__file__).resolve().parent
NUOSTATOS = ARCH / "spausdintuvo_nuostatos"

DM_OUT_BUFFER, DM_IN_PROMPT, DM_IN_BUFFER = 2, 4, 8
IDOK = 1
DM_COLOR = 0x800
DMCOLOR_COLOR = 2
FIELDS_POSLINKIS, COLOR_POSLINKIS = 72, 92  # DEVMODEW: dmFields, dmColor
HORZRES, VERTRES, LOGPIXELSX, LOGPIXELSY = 8, 10, 88, 90
PHYSICALWIDTH, PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY = 110, 111, 112, 113


def _biblioteka(modulis: str, paketas: str):
    """Importuoja; jei nėra (senesnė roboto versija) – įdiegia ir importuoja."""
    import importlib
    try:
        return importlib.import_module(modulis)
    except ImportError:
        log.info("     diegiama %s (vieną kartą)…", paketas)
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", paketas],
                       check=True, capture_output=True)
        importlib.invalidate_caches()
        return importlib.import_module(modulis)


# --- Windows funkcijos (ctypes – be papildomų bibliotekų) -------------------------

def _winspool():
    w = ctypes.WinDLL("winspool.drv")
    w.OpenPrinterW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p]
    w.OpenPrinterW.restype = wintypes.BOOL
    w.ClosePrinter.argtypes = [wintypes.HANDLE]
    w.DocumentPropertiesW.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.LPCWSTR,
                                      ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD]
    w.DocumentPropertiesW.restype = ctypes.c_long
    w.GetDefaultPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    return w


def _gdi():
    g = ctypes.WinDLL("gdi32")
    g.CreateDCW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
    g.CreateDCW.restype = wintypes.HDC
    g.DeleteDC.argtypes = [wintypes.HDC]
    g.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    g.StartDocW.argtypes = [wintypes.HDC, ctypes.c_void_p]
    for f in ("StartPage", "EndPage", "EndDoc"):
        getattr(g, f).argtypes = [wintypes.HDC]
    return g


class _DOCINFOW(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_int), ("lpszDocName", wintypes.LPCWSTR), ("lpszOutput", wintypes.LPCWSTR),
                ("lpszDatatype", wintypes.LPCWSTR), ("fwType", wintypes.DWORD)]


def numatytasis_spausdintuvas() -> str:
    w = _winspool()
    n = wintypes.DWORD(0)
    w.GetDefaultPrinterW(None, ctypes.byref(n))
    buf = ctypes.create_unicode_buffer(n.value or 1)
    w.GetDefaultPrinterW(buf, ctypes.byref(n))
    return buf.value


def _devmode(spausdintuvas: str, ivestis: bytes | None = None, langas: int = 0,
             rodyti_langa: bool = False) -> bytes | None:
    """Spausdintuvo DEVMODE (nuostatų blokas). ivestis – pradinės nuostatos;
    rodyti_langa – atidaryti Preferences langą (grąžina None, jei paspausta Cancel)."""
    w = _winspool()
    h = wintypes.HANDLE()
    if not w.OpenPrinterW(spausdintuvas, ctypes.byref(h), None):
        raise RuntimeError(f"nepavyko atidaryti spausdintuvo „{spausdintuvas}“")
    try:
        dydis = w.DocumentPropertiesW(None, h, spausdintuvas, None, None, 0)
        if dydis <= 0:
            raise RuntimeError(f"spausdintuvas „{spausdintuvas}“ neatsako")
        isvestis = ctypes.create_string_buffer(dydis)
        rezimas = DM_OUT_BUFFER
        ivesties_buf = None
        if ivestis:
            ivesties_buf = ctypes.create_string_buffer(ivestis, max(len(ivestis), dydis))
            rezimas |= DM_IN_BUFFER
        if rodyti_langa:
            rezimas |= DM_IN_PROMPT
        rez = w.DocumentPropertiesW(langas or None, h, spausdintuvas, isvestis, ivesties_buf, rezimas)
        if rez < 0:
            raise RuntimeError("spausdintuvo nuostatų klaida")
        if rodyti_langa and rez != IDOK:
            return None
        return isvestis.raw
    finally:
        w.ClosePrinter(h)


# --- Įsimintos nuostatos ---------------------------------------------------------------

def _failas(rusis: str) -> Path:
    return NUOSTATOS / f"{rusis}.devmode"


def busena(rusis: str) -> str:
    """Tekstas nustatymų langui: ar nuostatos įsimintos."""
    meta = NUOSTATOS / f"{rusis}.json"
    if not _failas(rusis).is_file() or not meta.is_file():
        return "nenustatyta"
    m = json.loads(meta.read_text(encoding="utf-8"))
    return f"✔ nustatyta {m.get('kada', '')} ({m.get('spausdintuvas', '')})"


def nustatyti_langu(rusis: str, langas: int = 0) -> bool:
    """Atidaro spausdintuvo Preferences langą; paspaudus OK – nuostatos įsimenamos.
    Grąžina False, jei paspausta Cancel."""
    spausdintuvas = _spausdintuvas(rusis)
    esamos = _failas(rusis).read_bytes() if _failas(rusis).is_file() else None
    nauja = _devmode(spausdintuvas, esamos, langas, rodyti_langa=True)
    if nauja is None:
        return False
    NUOSTATOS.mkdir(exist_ok=True)
    _failas(rusis).write_bytes(nauja)
    (NUOSTATOS / f"{rusis}.json").write_text(json.dumps(
        {"spausdintuvas": spausdintuvas, "kada": f"{dt.datetime.now():%Y-%m-%d %H:%M}"}), encoding="utf-8")
    return True


def _spausdintuvas(rusis: str) -> str:
    vardas = N.SPAUSDINTUVAS_LIPNUS if rusis == "lipnus" else N.SPAUSDINTUVAS_PAPRASTAS
    return vardas or numatytasis_spausdintuvas()


def _nuostatos_spausdinimui(rusis: str, spausdintuvas: str) -> bytes:
    if _failas(rusis).is_file():
        meta = json.loads((NUOSTATOS / f"{rusis}.json").read_text(encoding="utf-8"))
        if meta.get("spausdintuvas") != spausdintuvas:
            raise RuntimeError(f"{rusis} nuostatos įsimintos kitam spausdintuvui ({meta.get('spausdintuvas')}) – "
                               "Nustatymuose paspauskite „Nustatyti…“ dar kartą")
        # pratekame per tvarkyklę – jei ji atnaujinta, nuostatos suderinamos
        return _devmode(spausdintuvas, _failas(rusis).read_bytes())
    if rusis == "lipnus":
        raise RuntimeError("lipnaus spausdinimo nuostatos dar nenustatytos – Nustatymuose paspauskite "
                           "„Nustatyti lipnų spausdinimą…“ ir Preferences lange pasirinkite Labels ir 2-Sided: None")
    dm = bytearray(_devmode(spausdintuvas))
    if N.PAPRASTAS_SPALVOTAI and len(dm) > COLOR_POSLINKIS + 2:
        laukai = struct.unpack_from("<I", dm, FIELDS_POSLINKIS)[0] | DM_COLOR
        struct.pack_into("<I", dm, FIELDS_POSLINKIS, laukai)
        struct.pack_into("<h", dm, COLOR_POSLINKIS, DMCOLOR_COLOR)
        return _devmode(spausdintuvas, bytes(dm))
    return bytes(dm)


# --- Spausdinimas -----------------------------------------------------------------------------

def isdestymas(lapas_px: tuple[int, int], spausdinama_px: tuple[int, int], poslinkis: tuple[int, int],
               puslapis_pt: tuple[float, float], dpi: tuple[int, int]) -> tuple[int, int, int, int]:
    """Kur ant lapo dėti puslapį (spausdintuvo taškais): tikru dydžiu, centruotas;
    jei netelpa į spausdinamą plotą – sumažinamas (kaip „Fit to printable area“)."""
    plotis = puslapis_pt[0] / 72 * dpi[0]
    aukstis = puslapis_pt[1] / 72 * dpi[1]
    mastelis = min(1.0, spausdinama_px[0] / plotis, spausdinama_px[1] / aukstis)
    plotis, aukstis = plotis * mastelis, aukstis * mastelis
    x0 = (lapas_px[0] - plotis) / 2 - poslinkis[0]
    y0 = (lapas_px[1] - aukstis) / 2 - poslinkis[1]
    x0 = min(max(x0, 0), spausdinama_px[0] - plotis)
    y0 = min(max(y0, 0), spausdinama_px[1] - aukstis)
    return int(x0), int(y0), int(x0 + plotis), int(y0 + aukstis)


def spausdinti(failas: Path, rusis: str) -> None:
    """rusis: „paprastas“ arba „lipnus“ – su įsimintomis (arba numatytosiomis) nuostatomis."""
    pdfium = _biblioteka("pypdfium2", "pypdfium2")
    ImageWin = _biblioteka("PIL.ImageWin", "pillow")
    spausdintuvas = _spausdintuvas(rusis)
    devmode = ctypes.create_string_buffer(_nuostatos_spausdinimui(rusis, spausdintuvas))
    g = _gdi()
    hdc = g.CreateDCW("WINSPOOL", spausdintuvas, None, devmode)
    if not hdc:
        raise RuntimeError(f"nepavyko prisijungti prie spausdintuvo „{spausdintuvas}“")
    try:
        dpi = (g.GetDeviceCaps(hdc, LOGPIXELSX), g.GetDeviceCaps(hdc, LOGPIXELSY))
        lapas = (g.GetDeviceCaps(hdc, PHYSICALWIDTH), g.GetDeviceCaps(hdc, PHYSICALHEIGHT))
        plotas = (g.GetDeviceCaps(hdc, HORZRES), g.GetDeviceCaps(hdc, VERTRES))
        poslinkis = (g.GetDeviceCaps(hdc, PHYSICALOFFSETX), g.GetDeviceCaps(hdc, PHYSICALOFFSETY))
        pdf = pdfium.PdfDocument(str(failas))
        info = _DOCINFOW(ctypes.sizeof(_DOCINFOW), f"eNEWS {failas.stem}", None, None, 0)
        if g.StartDocW(hdc, ctypes.byref(info)) <= 0:
            raise RuntimeError("spausdintuvas nepriėmė darbo")
        try:
            for i in range(len(pdf)):
                puslapis = pdf[i]
                dydis = puslapis.get_size()
                vieta = isdestymas(lapas, plotas, poslinkis, dydis, dpi)
                mastelis = min((vieta[2] - vieta[0]) / dydis[0], 300 / 72)  # ne daugiau 300 dpi
                vaizdas = puslapis.render(scale=mastelis).to_pil().convert("RGB")
                g.StartPage(hdc)
                ImageWin.Dib(vaizdas).draw(hdc, vieta)
                g.EndPage(hdc)
        finally:
            g.EndDoc(hdc)
            pdf.close()
    finally:
        g.DeleteDC(hdc)
    log.info("     atspausdinta %s (%s, %s)", failas.name, rusis, spausdintuvas)


def planas() -> list[tuple[int, str]]:
    """„1:paprastas, 1:lipnus, 2:lipnus“ → [(1, "paprastas"), (1, "lipnus"), (2, "lipnus")]."""
    rez = []
    for dalis in N.SPAUSDINIMO_PLANAS.split(","):
        if ":" in dalis:
            nr, rusis = dalis.split(":", 1)
            rez.append((int(nr.strip()), rusis.strip().lower()))
    return rez
