"""Kurie kiekvienos mašinos žingsniai jau padaryti – kad sustojus (klaida, atsijungimas,
„Stabdyti“) kitą kartą būtų daroma tik tai, ko trūksta: niekas neįvedama ir
neatspausdinama du kartus.

Saugoma faile eiga.json šalia roboto (tik šiame kompiuteryje)."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ZINGSNIAI = {
    "akumuliatorius": "akumuliatorius",
    "pdi": "PDI",
    "garantija": "garantija",
    "failas1": "sertifikatas",
    "failas2": "TP planas",
}


class Eiga:
    def __init__(self, kelias: Path):
        self.kelias = Path(kelias)
        try:
            self.duom: dict[str, dict] = json.loads(self.kelias.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.duom = {}

    def _issaugoti(self) -> None:
        laikinas = self.kelias.with_suffix(".tmp")
        laikinas.write_text(json.dumps(self.duom, ensure_ascii=False, indent=1), encoding="utf-8")
        laikinas.replace(self.kelias)

    def padaryta(self, vin: str, zingsnis: str) -> bool:
        return zingsnis in self.duom.get(vin, {})

    def pazymeti(self, vin: str, zingsnis: str, reiksme=None) -> None:
        self.duom.setdefault(vin, {})[zingsnis] = reiksme if reiksme is not None else \
            f"{dt.datetime.now():%Y-%m-%d %H:%M}"
        self._issaugoti()

    def reiksme(self, vin: str, zingsnis: str):
        return self.duom.get(vin, {}).get(zingsnis)

    def isvalyti(self, vin: str) -> None:
        if self.duom.pop(vin, None) is not None:
            self._issaugoti()

    def santrauka(self, vin: str) -> str:
        """„jau padaryta: akumuliatorius, PDI, atspausdinta 1/3“ (tuščia, jei nieko)."""
        d = self.duom.get(vin, {})
        dalys = [pav for z, pav in ZINGSNIAI.items() if z in d]
        spausdinta = [z for z in d if z.startswith("spausdinta:")]
        if spausdinta:
            dalys.append(f"atspausdinta {len(spausdinta)} lap.")
        return ("jau padaryta: " + ", ".join(dalys)) if dalys else ""
