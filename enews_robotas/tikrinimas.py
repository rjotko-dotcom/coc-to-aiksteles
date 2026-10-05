"""Patikra prieš paleidžiant: ar teisingi Excel duomenys ir ar paruoštas kompiuteris."""

from __future__ import annotations

import datetime as dt
import os
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from excel_eiles import Masina, uzrakintas

KLAIDA = "klaida"          # robotas šios eilutės nedarys, kol nepataisyta
PERSPEJIMAS = "perspėjimas"  # robotas darys, bet verta pažiūrėti

NUMERIS_RE = re.compile(r"^[A-Z]{3}\d{3}$")
KODO_DALIS_RE = re.compile(r"^[A-Z0-9]{3,7}$")


@dataclass
class Pastaba:
    lygis: str
    tekstas: str
    eilute: int | None = None  # None – bendra pastaba, ne eilutės


def duomenys(masinos: list[Masina], siandien: dt.date | None = None) -> list[Pastaba]:
    """Tikrina neapdorotas eilutes; jau nuspalvintos naudojamos tik dublikatams rasti."""
    siandien = siandien or dt.date.today()
    pastabos: list[Pastaba] = []
    darbas = [m for m in masinos if not m.nuspalvinta]

    for m in darbas:
        for k in m.klaidos:
            pastabos.append(Pastaba(KLAIDA, k, m.eilute))
        for dalis in m.kodas:
            if dalis and not KODO_DALIS_RE.match(dalis):
                pastabos.append(Pastaba(KLAIDA, f"keista kodo dalis „{dalis}“", m.eilute))
        if m.numeris and not NUMERIS_RE.match(m.numeris):
            pastabos.append(Pastaba(PERSPEJIMAS, f"numeris „{m.numeris}“ ne ABC123 formos", m.eilute))
        for pav, data in (("PDI", m.pdi_data), ("tech. pradžios", m.garantija)):
            if data and (siandien - data).days > 90:
                pastabos.append(Pastaba(PERSPEJIMAS, f"{pav} data senesnė nei 90 d.", m.eilute))

    # Dublikatai: tas pats kodas, VIN ar numeris dviejose eilutėse.
    for pav, raktas in (("Midtronics kodas", lambda m: m.kodas_tekstu if all(m.kodas) else ""),
                        ("VIN", lambda m: m.vin),
                        ("numeris", lambda m: m.numeris)):
        grupes: dict[str, list[Masina]] = defaultdict(list)
        for m in masinos:
            if raktas(m):
                grupes[raktas(m)].append(m)
        for reiksme, grupe in grupes.items():
            if len(grupe) < 2:
                continue
            kitos = ", ".join(str(g.eilute) for g in grupe)
            for m in grupe:
                if not m.nuspalvinta:
                    pastabos.append(Pastaba(KLAIDA, f"{pav} {reiksme} kartojasi (eil. {kitos})", m.eilute))
    return pastabos


def blokuojamos_eilutes(pastabos: list[Pastaba]) -> set[int]:
    return {p.eilute for p in pastabos if p.lygis == KLAIDA and p.eilute}


# --- Kompiuteris ---------------------------------------------------------------

def spausdintuvai() -> list[str] | None:
    """Windows spausdintuvų sąrašas (None – nepavyko sužinoti, pvz. ne Windows)."""
    if sys.platform != "win32":
        return None
    try:
        rez = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"],
            capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return None
    if rez.returncode != 0:
        return None
    return [e.strip() for e in rez.stdout.splitlines() if e.strip()]


def rasti_chrome() -> Path | None:
    kandidatai = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        Path("/usr/bin/google-chrome"),
        Path("/Applications/Google Chrome.app"),
    ]
    return next((k for k in kandidatai if k.exists()), None)


def rasti_sumatra(nurodytas: str) -> Path | None:
    kandidatai = [
        Path(nurodytas) if nurodytas else None,
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "SumatraPDF/SumatraPDF.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "SumatraPDF/SumatraPDF.exe",
    ]
    return next((k for k in kandidatai if k and k.is_file()), None)


def aplinka(N, profilis: Path, excel: str | None = None, bandymas: bool = False) -> list[Pastaba]:
    p: list[Pastaba] = []
    excel = Path(excel or N.EXCEL_FAILAS)
    if not excel.is_file():
        p.append(Pastaba(KLAIDA, f"nerastas Excel failas: {excel}"))
    elif uzrakintas(excel):
        p.append(Pastaba(KLAIDA, "Excel failas atidarytas – uždarykite jį (kitaip robotas negali žymėti eilučių)"))

    if rasti_chrome() is None:
        p.append(Pastaba(KLAIDA, "nerastas Google Chrome"))
    if (profilis / "SingletonLock").exists() or (profilis / "lockfile").exists():
        p.append(Pastaba(PERSPEJIMAS, "roboto Chrome langas gal dar atidarytas – uždarykite jį"))

    if bandymas:  # spausdinti nereikės
        return p
    sarasas = spausdintuvai()
    if sarasas is not None:
        for pav, vardas in (("paprasto popieriaus", N.SPAUSDINTUVAS_PAPRASTAS),
                            ("lipnaus popieriaus", N.SPAUSDINTUVAS_LIPNUS)):
            if vardas and vardas not in sarasas:
                p.append(Pastaba(KLAIDA, f"{pav} spausdintuvas „{vardas}“ nerastas. Yra: "
                                         + ", ".join(sarasas)))
        if "lipnus" in N.SPAUSDINIMO_PLANAS.lower():
            import spausdinimas
            if spausdinimas.busena("lipnus") == "nenustatyta":
                p.append(Pastaba(KLAIDA, "lipnaus spausdinimo nuostatos nenustatytos – Nustatymai → "
                                         "„Nustatyti lipnų spausdinimą…“ (Labels, 2-Sided: None)"))
    return p
