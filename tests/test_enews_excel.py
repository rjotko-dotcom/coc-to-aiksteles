import datetime as dt
import sys
from pathlib import Path

import pytest

openpyxl = pytest.importorskip("openpyxl")
from openpyxl.styles import PatternFill  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "enews_robotas"))
import nustatymai  # noqa: E402
from excel_eiles import Sarasas, menuo_diena  # noqa: E402

SIANDIEN = dt.date(2026, 10, 1)


@pytest.mark.parametrize("reiksme, laukiama", [
    ("09.24", dt.date(2026, 9, 24)),
    (9.24, dt.date(2026, 9, 24)),
    (9.1, dt.date(2026, 9, 10)),          # Excel skaičius 09.10 → 9.1
    (dt.datetime(2026, 9, 22), dt.date(2026, 9, 22)),
    ("12.30", dt.date(2025, 12, 30)),     # ateities data → praėję metai
    ("", None),
    ("abc", None),
    ("13.40", None),
])
def test_menuo_diena(reiksme, laukiama):
    assert menuo_diena(reiksme, SIANDIEN) == laukiama


def _sarasas(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    eil = [
        ("SJNJ12TD3U2389917", "JRJ36", "1Q1H77", "S3604", "09.24", "09.24", "OAU413"),
        ("SJNJ12TD0U2373741", "JRH36", "1Q9D77", "TE204", "09.22", "09.24", "OAU289"),
        ("SJNJ12TD3U2404660", "JRJ36", "", "TE504", "09.24", "09.25", "OAU572"),
    ]
    for i, (vin, a, b, c, pdi, te, nr) in enumerate(eil, start=1):
        ws[f"B{i}"], ws[f"E{i}"], ws[f"G{i}"], ws[f"I{i}"] = vin, a, b, c
        ws[f"D{i}"] = ws[f"F{i}"] = ws[f"H{i}"] = "-"
        ws[f"K{i}"], ws[f"L{i}"], ws[f"M{i}"] = pdi, te, nr
    ws["B1"].fill = PatternFill(fill_type="solid", fgColor="FF00B050")  # jau padaryta
    ws["B4"] = "(PDI date)"
    kelias = tmp_path / "masinos.xlsx"
    wb.save(kelias)
    return kelias


def test_neapdorotos_praleidzia_nuspalvintas(tmp_path):
    s = Sarasas(_sarasas(tmp_path), nustatymai)
    masinos = s.neapdorotos(SIANDIEN)
    assert [m.eilute for m in masinos] == [2, 3]
    m = masinos[0]
    assert m.kodas_tekstu == "JRH36-1Q9D77-TE204"
    assert (m.pdi_data, m.garantija, m.numeris) == (dt.date(2026, 9, 22), dt.date(2026, 9, 24), "OAU289")
    assert not m.klaidos
    assert masinos[1].klaidos == ["nepilnas Midtronics kodas"]


def test_pazymeti_issaugo_spalva_ir_busena(tmp_path):
    kelias = _sarasas(tmp_path)
    s = Sarasas(kelias, nustatymai)
    s.pazymeti(2, nustatymai.SPALVA_ATLIKTA, "Atlikta")
    s.issaugoti()
    s2 = Sarasas(kelias, nustatymai)
    assert s2.ws["N2"].value == "Atlikta"
    assert [m.eilute for m in s2.neapdorotos(SIANDIEN)] == [3]
