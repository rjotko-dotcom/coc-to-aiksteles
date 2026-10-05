"""Visa roboto eiga prieš netikrą eNEWS (tą patį, kurį naudoja „BANDYMAS be B2B“)."""
import datetime as dt
import os
import sys
from pathlib import Path

import pytest

pytest.importorskip("openpyxl")
playwright = pytest.importorskip("playwright.sync_api")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "enews_robotas"))
import netikras_enews  # noqa: E402


def test_pdf_ir_pavyzdinis_excel(tmp_path):
    assert netikras_enews.pdf(["VIN: X"]).startswith(b"%PDF-1.4")
    import nustatymai
    from excel_eiles import Sarasas
    masinos = Sarasas(netikras_enews.sukurti_pavyzdi(tmp_path / "p.xlsx"), nustatymai).visos()
    assert len(masinos) == 6 and sum(m.nuspalvinta for m in masinos) == 1


@pytest.fixture
def narsykle():
    with playwright.sync_playwright() as pw:
        try:
            kelias = os.environ.get("ENEWS_CHROMIUM")  # pvz. /opt/pw-browsers/chromium
            b = pw.chromium.launch(executable_path=kelias, args=["--no-proxy-server"])
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"nėra naršyklės: {e}")
        yield b
        b.close()


def test_visa_eiga(narsykle, tmp_path, monkeypatch):
    import robotas
    from excel_eiles import Masina
    monkeypatch.setattr(robotas, "SPAUSDINTI", tmp_path)
    monkeypatch.setattr(robotas, "BANDYMAS", True)
    monkeypatch.setattr(robotas.N, "LAUKTI_SEK", 8)
    serveris, adresas = netikras_enews.paleisti()
    try:
        page = narsykle.new_context(accept_downloads=True).new_page()
        geras = Masina(2, "SJNJ12TD0U2373741", ("JRH36", "1Q9D77", "TE204"),
                       dt.date(2026, 9, 22), dt.date(2026, 9, 24), "OAU289")
        robotas.apdoroti(page, adresas, geras)
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "OAU289-SJNJ12TD0U2373741-1-sertifikatas.pdf", "OAU289-SJNJ12TD0U2373741-2-tp-planas.pdf"]

        blogas = Masina(3, "SJNJ12TD5U2387571", ("BAD36", "1Q9D77", "SA004"),
                        dt.date(2026, 9, 22), dt.date(2026, 9, 22), "AYT599")
        with pytest.raises(robotas.BlogasAkumas, match="Replace battery"):
            robotas.apdoroti(page, adresas, blogas)

        panaudotas = Masina(4, "SJNJ12TD2U2378584", geras.kodas,
                            dt.date(2026, 9, 22), dt.date(2026, 9, 22), "AYT592")
        with pytest.raises(robotas.BlogasAkumas, match="already used"):
            robotas.apdoroti(page, adresas, panaudotas)
    finally:
        serveris.shutdown()


def test_perziura_nieko_neissaugo(narsykle, tmp_path, monkeypatch):
    """Peržiūroje robotas pereina visus žingsnius, bet eNEWS lieka nepakeistas."""
    import robotas
    from excel_eiles import Masina
    monkeypatch.setattr(robotas, "SPAUSDINTI", tmp_path)
    monkeypatch.setattr(robotas, "PERZIURA", True)
    monkeypatch.setattr(robotas.N, "LAUKTI_SEK", 8)
    monkeypatch.setattr(robotas.time, "sleep", lambda s: None)
    serveris, adresas = netikras_enews.paleisti()
    try:
        page = narsykle.new_context(accept_downloads=True).new_page()
        m = Masina(2, "SJNJ12TD0U2373741", ("JRH36", "1Q9D77", "TE204"),
                   dt.date(2026, 9, 22), dt.date(2026, 9, 24), "OAU289")
        robotas.apdoroti(page, adresas, m)
        busena = page.evaluate("JSON.parse(localStorage.getItem('bandymas'))")[m.vin]
        assert busena["testai"] == [] and "pdi" not in busena and "reg" not in busena
        assert list(tmp_path.iterdir()) == []   # nieko neparsisiųsta / nespausdinta
    finally:
        serveris.shutdown()
