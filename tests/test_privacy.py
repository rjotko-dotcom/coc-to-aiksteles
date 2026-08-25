"""Testai, saugantys konfidencialumo garantijas.

Šie testai neleidžia netyčia atsirasti kodui, kuris siųstų duomenis į išorę
arba paliktų CoC failus diske.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.coc_extract import extract_from_bytes  # noqa: E402
from app.main import _is_loopback  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
SAMPLE_PDF = ROOT / "samples" / "sample_coc.pdf"


def test_no_outbound_network_libraries_in_app():
    forbidden = ("import requests", "urllib.request", "urlopen", "httpx.", "smtplib")
    for path in APP.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        for needle in forbidden:
            assert needle not in source, f"{path.name} naudoja {needle}"


def test_ui_has_no_external_resources():
    html = (APP / "static" / "index.html").read_text(encoding="utf-8")
    for needle in ("http://", "https://"):
        assert needle not in html, "sąsaja neturi kreiptis į išorinius adresus"


def test_extraction_leaves_no_files_on_disk():
    if not SAMPLE_PDF.exists():
        return
    temp_dir = Path(tempfile.gettempdir())
    before_temp = set(os.listdir(temp_dir))
    before_cwd = set(os.listdir(ROOT))

    data = extract_from_bytes(SAMPLE_PDF.read_bytes(), source_file="slaptas.pdf")
    assert data.vin  # apdorojimas tikrai įvyko

    assert set(os.listdir(temp_dir)) - before_temp == set()
    assert set(os.listdir(ROOT)) - before_cwd == set()


def test_only_loopback_clients_accepted():
    assert _is_loopback("127.0.0.1")
    assert _is_loopback("::1")
    assert _is_loopback("localhost")
    assert not _is_loopback("192.168.1.15")
    assert not _is_loopback("10.0.0.1")
    assert not _is_loopback(None)
