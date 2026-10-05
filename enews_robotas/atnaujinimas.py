"""Roboto atnaujinimas iš GitHub: parsisiunčia naujausius failus vietoj senų.

Jūsų nustatymai (nustatymai.json), Excel, Chrome profilis ir žurnalai neliečiami.
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

ARCH = Path(__file__).resolve().parent
ADRESAS = ("https://raw.githubusercontent.com/rjotko-dotcom/coc-to-aiksteles/"
           "ccr-44a38a81-hew5zi/enews_robotas/")
FAILAI = [
    "robotas.py", "langas.py", "tikrinimas.py", "excel_eiles.py", "nustatymai.py",
    "netikras_enews.py", "atnaujinimas.py", "requirements.txt", "paleisti.bat", "README.md",
    "sablonas.xlsx", "bandymas/enews/hp_new.html", "bandymas/enews/pdi.html",
    "bandymas/enews/pranesimai.html",
]


def atnaujinti() -> list[str]:
    """Grąžina pakeistų failų sąrašą. Pirma parsisiunčia viską, tik tada keičia –
    jei nutrūktų internetas, seni failai lieka sveiki."""
    nauji: dict[str, bytes] = {}
    for f in FAILAI:
        with urllib.request.urlopen(ADRESAS + f, timeout=30) as ats:
            turinys = ats.read()
        if not turinys:
            raise RuntimeError(f"tuščias failas {f}")
        if f.endswith(".py"):
            compile(turinys, f, "exec")  # sugadinto failo nerašome
        nauji[f] = turinys
    pakeisti = []
    for f, turinys in nauji.items():
        kelias = ARCH / f
        if kelias.exists() and kelias.read_bytes() == turinys:
            continue
        kelias.parent.mkdir(parents=True, exist_ok=True)
        kelias.write_bytes(turinys)
        pakeisti.append(f)
    return pakeisti


if __name__ == "__main__":
    print("Pakeista:", ", ".join(atnaujinti()) or "nieko – jau naujausia versija")
