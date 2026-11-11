"""Dokumentai → Excel: tik išgalvoti duomenys (jokių tikrų VIN / numerių)."""
import datetime as dt
import io
import sys
from pathlib import Path

import pytest

openpyxl = pytest.importorskip("openpyxl")
Image = pytest.importorskip("PIL.Image")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "enews_robotas"))
import dokumentai as d  # noqa: E402
import nustatymai  # noqa: E402
from excel_eiles import Sarasas  # noqa: E402

SIANDIEN = dt.date(2026, 11, 11)
VIN1 = "TESTA000000000001"
VIN2 = "TESTA000000000002"


def _png(w=200, h=60):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


def _qa_elementai(vin=VIN1, kodas="TST01-1T1T01-T0001", rezultatas="GERAS AKUMULIAT."):
    return [
        (100, 200, f"VIN: {vin}"),
        (300, 900, "Akumuliatoriaus būklės patikrinimas"),   # PDI sąrašo eilutė – ne rezultatas
        (1700, 300, "3/11/2026"),
        (1700, 400, rezultatas),
        (1700, 900, "TESTO KODAS"),
        (1700, 950, kodas),
    ]


def test_qa_nagrinejimas():
    qa = d.nagrineti_qa(_qa_elementai(), "000001_QA.pdf", SIANDIEN, plotis=2000)
    assert qa.vin == VIN1
    assert qa.kodas == ("TST01", "1T1T01", "T0001")
    assert qa.testo_data == dt.date(2026, 11, 3)
    assert qa.rezultatas == "GERAS AKUMULIAT."
    assert qa.pastabos == []


def test_qa_failo_pavadinimas_nesutampa_ir_blogas_akumas():
    qa = d.nagrineti_qa(_qa_elementai(rezultatas="KEISTI AKUMULIAT."), "000009_QA.pdf", SIANDIEN, 2000)
    assert any("000009" in p for p in qa.pastabos)
    assert any("KEISTI" in p for p in qa.pastabos)


@pytest.mark.parametrize("tekstas, laukiama", [
    ("26 11 03", dt.date(2026, 11, 3)),
    ("261103", dt.date(2026, 11, 3)),
    ("2026.10.28", dt.date(2026, 10, 28)),
    ("26M03", dt.date(2026, 11, 3)),        # ranka rašytas „11“ OCR atrodo kaip M
    ("27 01 01", None),                     # ateityje
    ("abc", None),
])
def test_ranka_rasyta_data(tekstas, laukiama):
    assert d.ranka_rasyta_data(tekstas, SIANDIEN, dt.date(2026, 11, 3)) == laukiama


@pytest.mark.parametrize("tekstas, laukiama", [
    ("261103", dt.date(2026, 11, 3)), ("26 11 03", dt.date(2026, 11, 3)),
    ("2026-11-03", dt.date(2026, 11, 3)), ("11.03", dt.date(2026, 11, 3)),
    ("261340", None), ("", None),
])
def test_ivesta_data(tekstas, laukiama):
    assert d.ivesta_data(tekstas, SIANDIEN) == laukiama


def test_numeris_is():
    assert d.numeris_is("AAA0O1") == "AAA001"
    assert d.numeris_is("EA12I4") == "EA1214"
    assert d.numeris_is("AA12345") == ""


def test_pasas_ir_sujungimas():
    pasas = d.nagrineti_pasa([
        (120, 476, "AAA001"), (380, 480, "2026-10-30"),
        (120, 513, "2026-10-29"), (315, 515, "B1"), (378, 513, "2026-10-30"),
        (120, 908, "TESTA00000000000I"),     # VIN su I vietoj 1 – bet čia ne SJN/VNV, nepaimamas
    ], "pasai.pdf", 1)
    assert pasas.numeris == "AAA001"
    assert pasas.b_data == dt.date(2026, 10, 29)
    pasas.vin = VIN1
    kitas = d.Pasas("pasai.pdf", 2, vin=VIN2, numeris="AAA002", b_data=dt.date(2026, 10, 30))
    qa = d.nagrineti_qa(_qa_elementai(vin="TESTA000000000007"), "x_QA.pdf", SIANDIEN, 2000)
    eil = d.sujungti([qa], [pasas, kitas])
    assert eil[0].pasas is None and "nerastas" in eil[0].pastabos[0]   # skiriasi 1 simboliu nuo DVIEJŲ
    qa.vin = "TESTA00000000000X"
    eil = d.sujungti([qa], [pasas])
    assert eil[0].pasas is pasas and "1 simboliu" in eil[0].pastabos[0]
    assert d.be_qa([qa], [pasas, kitas]) == [pasas, kitas]


def test_sukurti_excel_su_iskarpomis(tmp_path):
    q1 = d.nagrineti_qa(_qa_elementai(), "000001_QA.pdf", SIANDIEN, 2000)
    q1.pdi_iskarpa = q1.kodo_iskarpa = _png()
    q1.pdi_tekstas = "26 11 03"
    q1.pdi_data = dt.date(2026, 11, 3)           # spėta – Excel'yje turi būti geltona
    q2 = d.nagrineti_qa(_qa_elementai(vin=VIN2, kodas="TST02-1T2T02-T0002"), "000002_QA.pdf", SIANDIEN, 2000)
    q2.pdi_iskarpa = _png()                      # PDI datos nėra – žmogus įrašys Excel'yje
    p1 = d.Pasas("pasai.pdf", 1, vin=VIN1, numeris="AAA001", b_data=dt.date(2026, 10, 30), iskarpa=_png(300, 120))
    p2 = d.Pasas("pasai.pdf", 2, vin=VIN2, numeris="AAA002", b_data=dt.date(2026, 10, 30), iskarpa=_png())
    p3 = d.Pasas("pasai.pdf", 3, vin="TESTA000000000003", numeris="AAA003")
    eilutes = d.sujungti([q1, q2], [p1, p2, p3])
    assert not eilutes[0].blokuota and eilutes[1].blokuota
    kelias = d.sukurti_excel(eilutes, tmp_path / "partija.xlsx", nustatymai, d.be_qa([q1, q2], [p1, p2, p3]))

    wb = openpyxl.load_workbook(kelias)
    ws = wb.worksheets[0]
    assert len(ws._images) == 5
    assert ws["K2"].fill.fgColor.rgb == "FFFFFF00" and ws["K3"].fill.fgColor.rgb == "FFFFFF00"
    assert "000002_QA.pdf" in ws["O3"].value
    assert wb["Pasai be QA"]["A2"].value == "AAA003"

    masinos = Sarasas(kelias, nustatymai).visos(SIANDIEN)
    assert [(m.vin, m.kodas_tekstu, m.numeris, m.pdi_data, m.garantija) for m in masinos][0] == (
        VIN1, "TST01-1T1T01-T0001", "AAA001", dt.date(2026, 11, 3), dt.date(2026, 10, 30))
    assert not masinos[0].klaidos and masinos[1].klaidos      # be PDI datos robotas nedarys
    assert [m.eilute for m in Sarasas(kelias, nustatymai).neapdorotos(SIANDIEN)] == [2, 3]  # geltona ≠ padaryta

    # Robotas išsaugo Excel – iškarpos turi likti
    s = Sarasas(kelias, nustatymai)
    s.pazymeti(2, nustatymai.SPALVA_ATLIKTA, "Atlikta")
    s.issaugoti()
    assert len(openpyxl.load_workbook(kelias).worksheets[0]._images) == 5


def test_ivesti_pdi_nuima_pastaba():
    qa = d.QA("x.pdf", pastabos=["PDI data ranka – įveskite pagal paveikslėlį", "kita"])
    d.ivesti_pdi(qa, dt.date(2026, 11, 3))
    assert qa.pdi_ivesta and qa.pastabos == ["kita"]


def test_sudeti_iskarpas():
    out = Image.open(io.BytesIO(d.sudeti(_png(100, 20), b"", _png(50, 30))))
    assert out.size == (100, 56)


def test_pdi_datos_vieta():
    pagrindas = [(1058, 1018, "Patikrinti visi nurodyti punktai"), (1058, 1047, "pristatymui."),
                 (1059, 1268, "GALUTINE PATIKRA"), (1058, 1574, "Data:")]   # apatinė „Data:“ – ne PDI
    # OCR „Data:“ nematė (sujungė su ranka rašytu) – vieta skaičiuojama po „pristatymui.“
    assert d.pdi_datos_vieta(pagrindas + [(1049, 1112, "Dla10")], 2067) == (1058, 1047 + 75)
    # „Data:“ matyta – imama ji, ne apatinė
    assert d.pdi_datos_vieta(pagrindas + [(1062, 1143, "Data:")], 2067) == (1062, 1143)
    # OCR sugadino viršutinį užrašą – lieka „GALUTINE PATIKRA“
    assert d.pdi_datos_vieta([(1059, 1268, "GALUTINEPATIKRA"), (1058, 1574, "Data:")], 2067)[1] == 1268 - 220 + 75


def _eil(failas, vin, kodas, numeris):
    qa = d.QA(failas, vin=vin, kodas=tuple(kodas.split("-")), pdi_data=dt.date(2026, 11, 3))
    return d.Eilute(qa, d.Pasas("pasai.pdf", 1, vin=vin, numeris=numeris, b_data=dt.date(2026, 10, 30)))


def test_kartojimai_ir_dublikatai(tmp_path):
    e = [_eil("a_QA.pdf", VIN1, "TST01-1T1T01-T0001", "AAA001"),
         _eil("a (kopija)_QA.pdf", VIN1, "TST01-1T1T01-T0001", "AAA001"),   # tas pats lapas du kartus
         _eil("b_QA.pdf", VIN2, "TST01-1T1T01-T0001", "AAA002"),            # tas pats kodas kitai mašinai
         _eil("c_QA.pdf", "TESTA000000000003", "TST03-1T3T03-T0003", "AAA003"),
         _eil("d_QA.pdf", "TESTA000000000004", "TST04-1T4T04-T0004", "AAA004")]
    d.pazymeti_kartojimus(e, {"TESTA000000000003": "partija_senas.xlsx"}, {})
    assert e[1].dublikatas and not e[0].dublikatas
    assert any("testo kodas" in k for k in e[0].kartojasi) and any("testo kodas" in k for k in e[2].kartojasi)
    assert "partija_senas.xlsx" in e[3].kartojasi[0]
    assert not e[4].kartojasi and not e[4].blokuota
    e[3].leisti_kartojima = True
    assert not e[3].blokuota
    kelias = d.sukurti_excel(e, tmp_path / "p.xlsx", nustatymai)
    wb = openpyxl.load_workbook(kelias)
    assert [r[1] for r in wb.worksheets[0].iter_rows(min_row=2, values_only=True) if r[1]] == [
        "TESTA000000000003", "TESTA000000000004"]
    assert len(list(wb["Kartojasi (neįtraukta)"].iter_rows(min_row=2))) == 3
    # ankstesnių partijų skaitymas
    vinai, kodai = d.ankstesni_irasai([kelias, tmp_path / "nera.xlsx"], nustatymai)
    assert vinai == {"TESTA000000000003": "p.xlsx", "TESTA000000000004": "p.xlsx"}
    assert kodai["TST04-1T4T04-T0004"] == "p.xlsx"
