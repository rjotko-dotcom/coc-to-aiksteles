"""Spausdinimas be jokios papildomos programos: paprastas (spalvotai) ir lipnus (Labels, vienpusis).

PDF puslapiai nupiešiami (pypdfium2 – tas pats PDF variklis kaip Chrome) ir siunčiami
tiesiai į Windows spausdintuvą. Nuostatos nurodomos tik šiam spausdinimui – taip pat,
kaip Preferences lange vienam kartui: lipniam – popieriaus tipas „Labels“ ir 2-Sided
Printing → None; paprastam – spalvotai. Jūsų įprastos spausdintuvo nuostatos nekeičiamos.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

import nustatymai as N

log = logging.getLogger("robotas")

DC_MEDIATYPENAMES, DC_MEDIATYPES = 34, 35
DM_COLOR, DM_DUPLEX, DM_MEDIATYPE = 0x800, 0x1000, 0x200000
DM_IN_BUFFER, DM_OUT_BUFFER = 8, 2
DMDUP_SIMPLEX, DMCOLOR_MONO, DMCOLOR_COLOR = 1, 1, 2
# GetDeviceCaps
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


def popieriaus_tipai(spausdintuvas: str) -> dict[str, int]:
    """Spausdintuvo popieriaus tipai: {"Labels": 263, "Plain-1": 257, …}."""
    import ctypes
    w = _biblioteka("win32print", "pywin32")
    h = w.OpenPrinter(spausdintuvas)
    try:
        prievadas = w.GetPrinter(h, 2)["pPortName"]
    finally:
        w.ClosePrinter(h)
    f = ctypes.WinDLL("winspool.drv").DeviceCapabilitiesW
    f.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ushort, ctypes.c_void_p, ctypes.c_void_p]
    f.restype = ctypes.c_int
    n = f(spausdintuvas, prievadas, DC_MEDIATYPENAMES, None, None)
    if n <= 0:
        return {}
    vardai = ctypes.create_unicode_buffer(64 * n)
    f(spausdintuvas, prievadas, DC_MEDIATYPENAMES, ctypes.cast(vardai, ctypes.c_void_p), None)
    numeriai = (ctypes.c_uint32 * n)()
    f(spausdintuvas, prievadas, DC_MEDIATYPES, ctypes.cast(numeriai, ctypes.c_void_p), None)
    return {vardai[i * 64:(i + 1) * 64].split("\0")[0].strip(): numeriai[i] for i in range(n)}


def _rasti_tipa(tipai: dict[str, int], pavadinimas: str) -> int | None:
    p = pavadinimas.strip().lower()
    for vardas, nr in tipai.items():
        if vardas.lower() == p:
            return nr
    for vardas, nr in tipai.items():
        if p in vardas.lower():
            return nr
    return None


def _nuostatos(w, spausdintuvas: str, lipnus: bool):
    """DEVMODE šiam spausdinimui: jūsų numatytosios + lipniam Labels ir vienpusis,
    paprastam – spalvotai."""
    h = w.OpenPrinter(spausdintuvas)
    try:
        try:
            dm = w.GetPrinter(h, 9)["pDevMode"]  # šio vartotojo numatytosios (Preferences)
        except Exception:
            dm = None
        dm = dm or w.GetPrinter(h, 2)["pDevMode"]
        if lipnus:
            nr = _rasti_tipa(popieriaus_tipai(spausdintuvas), N.LIPNUS_POPIERIUS)
            if nr is None:
                raise RuntimeError(f"spausdintuvas „{spausdintuvas}“ neturi popieriaus tipo „{N.LIPNUS_POPIERIUS}“")
            dm.MediaType = nr
            dm.Fields |= DM_MEDIATYPE
            dm.Duplex = DMDUP_SIMPLEX
            dm.Fields |= DM_DUPLEX
        elif N.PAPRASTAS_SPALVOTAI:
            dm.Color = DMCOLOR_COLOR
            dm.Fields |= DM_COLOR
        # Tvarkyklė sujungia pakeitimus su savo vidinėmis nuostatomis (kaip paspaudus OK).
        rezultatas = w.GetPrinter(h, 2)["pDevMode"]
        w.DocumentProperties(0, h, spausdintuvas, rezultatas, dm, DM_IN_BUFFER | DM_OUT_BUFFER)
        return rezultatas
    finally:
        w.ClosePrinter(h)


def isdestymas(lapas_px: tuple[int, int], spausdinama_px: tuple[int, int], poslinkis: tuple[int, int],
               puslapis_pt: tuple[float, float], dpi: tuple[int, int]) -> tuple[int, int, int, int]:
    """Kur ant lapo dėti puslapį (spausdintuvo taškais): tikru dydžiu, centruotas;
    jei netelpa į spausdinamą plotą – sumažinamas (kaip „Fit to printable area“)."""
    plotis = puslapis_pt[0] / 72 * dpi[0]
    aukstis = puslapis_pt[1] / 72 * dpi[1]
    mastelis = min(1.0, spausdinama_px[0] / plotis, spausdinama_px[1] / aukstis)
    plotis, aukstis = plotis * mastelis, aukstis * mastelis
    # centruojame fizinio lapo atžvilgiu, koordinatės – nuo spausdinamo ploto kampo
    x0 = (lapas_px[0] - plotis) / 2 - poslinkis[0]
    y0 = (lapas_px[1] - aukstis) / 2 - poslinkis[1]
    x0 = min(max(x0, 0), spausdinama_px[0] - plotis)
    y0 = min(max(y0, 0), spausdinama_px[1] - aukstis)
    return int(x0), int(y0), int(x0 + plotis), int(y0 + aukstis)


def spausdinti(failas: Path, rusis: str) -> None:
    """rusis: „paprastas“ (spalvotai, įprastas popierius) arba „lipnus“ (Labels, vienpusis)."""
    lipnus = rusis == "lipnus"
    spausdintuvas = N.SPAUSDINTUVAS_LIPNUS if lipnus else N.SPAUSDINTUVAS_PAPRASTAS
    w = _biblioteka("win32print", "pywin32")
    win32gui = _biblioteka("win32gui", "pywin32")
    pdfium = _biblioteka("pypdfium2", "pypdfium2")
    ImageWin = _biblioteka("PIL.ImageWin", "pillow")
    if not spausdintuvas:
        spausdintuvas = w.GetDefaultPrinter()

    devmode = _nuostatos(w, spausdintuvas, lipnus)
    hdc = win32gui.CreateDC("WINSPOOL", spausdintuvas, devmode)
    try:
        dpi = (w.GetDeviceCaps(hdc, LOGPIXELSX), w.GetDeviceCaps(hdc, LOGPIXELSY))
        lapas = (w.GetDeviceCaps(hdc, PHYSICALWIDTH), w.GetDeviceCaps(hdc, PHYSICALHEIGHT))
        plotas = (w.GetDeviceCaps(hdc, HORZRES), w.GetDeviceCaps(hdc, VERTRES))
        poslinkis = (w.GetDeviceCaps(hdc, PHYSICALOFFSETX), w.GetDeviceCaps(hdc, PHYSICALOFFSETY))
        pdf = pdfium.PdfDocument(str(failas))
        w.StartDoc(hdc, (f"eNEWS {failas.stem}", None, None, 0))
        try:
            for i in range(len(pdf)):
                puslapis = pdf[i]
                dydis = puslapis.get_size()
                vieta = isdestymas(lapas, plotas, poslinkis, dydis, dpi)
                # piešiame tokia raiška, kokia bus spausdinama (ne daugiau 300 dpi – užtenka)
                mastelis = min((vieta[2] - vieta[0]) / dydis[0], 300 / 72)
                vaizdas = puslapis.render(scale=mastelis).to_pil().convert("RGB")
                w.StartPage(hdc)
                ImageWin.Dib(vaizdas).draw(hdc, vieta)
                w.EndPage(hdc)
        finally:
            w.EndDoc(hdc)
            pdf.close()
    finally:
        win32gui.DeleteDC(hdc)
    log.info("     atspausdinta %s (%s, %s)", failas.name, rusis, spausdintuvas)


def planas() -> list[tuple[int, str]]:
    """„1:paprastas, 1:lipnus, 2:lipnus“ → [(1, "paprastas"), (1, "lipnus"), (2, "lipnus")]."""
    rez = []
    for dalis in N.SPAUSDINIMO_PLANAS.split(","):
        if ":" in dalis:
            nr, rusis = dalis.split(":", 1)
            rez.append((int(nr.strip()), rusis.strip().lower()))
    return rez
