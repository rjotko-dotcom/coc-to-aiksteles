"""Spausdinimas: paprastas (spalvotai) ir lipnus (Labels, vienpusis).

PDF spausdina SumatraPDF (jei nėra – parsisiunčiama nešiojama versija, be diegimo).
Lipniam popieriui spausdintuvo nuostatos keičiamos taip pat, kaip žmogus daro
Preferences lange: Paper Type → „Labels“, 2-Sided Printing → None. Keičiama tik šio
Windows vartotojo numatytoji nuostata (administratoriaus teisių nereikia) ir tik tol,
kol spausdinama – po to grąžinama, kas buvo.
"""

from __future__ import annotations

import contextlib
import io
import logging
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import nustatymai as N
from tikrinimas import rasti_sumatra

ARCH = Path(__file__).resolve().parent
IRANKIAI = ARCH / "irankiai"
SUMATRA_ZIP = "https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip"

log = logging.getLogger("robotas")

DC_MEDIATYPENAMES, DC_MEDIATYPES = 34, 35
DM_COLOR, DM_DUPLEX, DM_MEDIATYPE = 0x800, 0x1000, 0x200000
DM_IN_BUFFER, DM_OUT_BUFFER = 8, 2
DMDUP_SIMPLEX, DMCOLOR_MONO, DMCOLOR_COLOR = 1, 1, 2


def sumatra() -> Path:
    """SumatraPDF kelias; jei nerasta – parsisiunčia į aplanką „irankiai“."""
    rasta = rasti_sumatra(N.SUMATRA) or (IRANKIAI / "SumatraPDF.exe" if (IRANKIAI / "SumatraPDF.exe").is_file()
                                         else None)
    if rasta:
        return rasta
    log.info("     SumatraPDF nerastas – parsisiunčiama (vieną kartą, ~8 MB)…")
    with urllib.request.urlopen(SUMATRA_ZIP, timeout=120) as ats:
        duom = ats.read()
    with zipfile.ZipFile(io.BytesIO(duom)) as z:
        exe = next(n for n in z.namelist() if n.lower().endswith(".exe"))
        IRANKIAI.mkdir(exist_ok=True)
        (IRANKIAI / "SumatraPDF.exe").write_bytes(z.read(exe))
    return IRANKIAI / "SumatraPDF.exe"


def _win32print():
    try:
        import win32print
    except ImportError:  # senesnėje roboto versijoje bibliotekos nebuvo – įdiegiame
        log.info("     diegiama pywin32 (vieną kartą)…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "pywin32"],
                       check=True, capture_output=True)
        import win32print
    return win32print


def popieriaus_tipai(spausdintuvas: str) -> dict[str, int]:
    """Spausdintuvo popieriaus tipai: {"Labels": 263, "Plain-1": 257, …}."""
    import ctypes
    w = _win32print()
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


@contextlib.contextmanager
def laikinos_nuostatos(spausdintuvas: str, popierius: str | None, vienpusis: bool, spalvotai: bool | None):
    """Kaip Preferences lange: laikinai pakeičia šio vartotojo numatytąsias spausdintuvo
    nuostatas, o išeinant grąžina senas."""
    w = _win32print()
    h = w.OpenPrinter(spausdintuvas)
    senos = None
    pakeista = False
    try:
        try:
            senos = w.GetPrinter(h, 9)["pDevMode"]
        except Exception:
            senos = None
        dm = (w.GetPrinter(h, 9)["pDevMode"] if senos is not None else None) or w.GetPrinter(h, 2)["pDevMode"]
        if popierius:
            nr = _rasti_tipa(popieriaus_tipai(spausdintuvas), popierius)
            if nr is None:
                raise RuntimeError(f"spausdintuvas „{spausdintuvas}“ neturi popieriaus tipo „{popierius}“")
            dm.MediaType = nr
            dm.Fields |= DM_MEDIATYPE
        if vienpusis:
            dm.Duplex = DMDUP_SIMPLEX
            dm.Fields |= DM_DUPLEX
        if spalvotai is not None:
            dm.Color = DMCOLOR_COLOR if spalvotai else DMCOLOR_MONO
            dm.Fields |= DM_COLOR
        # Tvarkyklė sujungia pakeitimus su savo vidinėmis nuostatomis (kaip paspaudus OK).
        rezultatas = w.GetPrinter(h, 2)["pDevMode"]
        w.DocumentProperties(0, h, spausdintuvas, rezultatas, dm, DM_IN_BUFFER | DM_OUT_BUFFER)
        w.SetPrinter(h, 9, {"pDevMode": rezultatas}, 0)
        pakeista = True
        yield
    finally:
        if pakeista:
            try:
                w.SetPrinter(h, 9, {"pDevMode": senos or w.GetPrinter(h, 2)["pDevMode"]}, 0)
            except Exception as e:  # noqa: BLE001
                log.warning("     nepavyko grąžinti spausdintuvo nuostatų: %s – patikrinkite Preferences", e)
        w.ClosePrinter(h)


def spausdinti(failas: Path, rusis: str) -> None:
    """rusis: „paprastas“ (spalvotai, įprastas popierius) arba „lipnus“ (Labels, vienpusis)."""
    lipnus = rusis == "lipnus"
    spausdintuvas = N.SPAUSDINTUVAS_LIPNUS if lipnus else N.SPAUSDINTUVAS_PAPRASTAS
    exe = sumatra()
    komanda = [str(exe)]
    komanda += ["-print-to", spausdintuvas] if spausdintuvas else ["-print-to-default"]
    papildomi = [x for x in (N.NUSTATYMAI_LIPNUS if lipnus else N.NUSTATYMAI_PAPRASTAS).split(",") if x.strip()]
    if lipnus:
        papildomi.append("simplex")
    elif N.PAPRASTAS_SPALVOTAI:
        papildomi.append("color")
    if papildomi:
        komanda += ["-print-settings", ",".join(papildomi)]
    komanda += ["-silent", str(failas)]

    if lipnus and sys.platform == "win32" and spausdintuvas:
        with laikinos_nuostatos(spausdintuvas, N.LIPNUS_POPIERIUS, vienpusis=True, spalvotai=None):
            subprocess.run(komanda, check=True, timeout=180)
    else:
        subprocess.run(komanda, check=True, timeout=180)
    log.info("     atspausdinta %s (%s, %s)", failas.name, rusis, spausdintuvas or "numatytasis")


def planas() -> list[tuple[int, str]]:
    """„1:paprastas, 2:lipnus“ → [(1, "paprastas"), (2, "lipnus")]."""
    rez = []
    for dalis in N.SPAUSDINIMO_PLANAS.split(","):
        if ":" in dalis:
            nr, rusis = dalis.split(":", 1)
            rez.append((int(nr.strip()), rusis.strip().lower()))
    return rez
