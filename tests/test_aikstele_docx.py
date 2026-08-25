import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docx import Document  # noqa: E402

from app.aikstele_docx import (  # noqa: E402
    build_document,
    build_values,
    fill_template,
    suggested_filename,
)

DATA = {
    "make": "NISSAN",
    "type": "F16",
    "variant": "A",
    "version": "A45",
    "commercial_name": "NISSAN JUKE",
    "vin": "SJNF16FA7U2000002",
    "approval_number": "e9*2007/46*6697*17",
    "approval_date": "16.10.2025",
    "national_approval_number": "",
    "colour": "GELTONA",
}


def all_text(content: bytes) -> str:
    document = Document(io.BytesIO(content))
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


def test_build_document_contains_all_values():
    values = build_values(DATA, doc_date="2026-08-17")
    text = all_text(build_document(values, company_line="UAB Pavyzdys"))
    assert "NISSAN JUKE" in text
    assert "F16/A/A45" in text
    assert "SJNF16FA7U2000002" in text
    assert "e9*2007/46*6697*17" in text
    assert "GELTONA" in text
    assert "APIE TRANSPORTO PRIEMONĖS TAPATUMO DUOMENIS" in text


def test_fill_template_writes_into_value_column():
    empty = build_values({key: "" for key in DATA}, doc_date="")
    template = build_document(empty)
    filled, warnings = fill_template(
        template, build_values(DATA, doc_date="2026-08-17")
    )
    assert warnings == []

    document = Document(io.BytesIO(filled))
    table = document.tables[-1]
    rows = {row.cells[0].text: [c.text for c in row.cells] for row in table.rows}
    assert rows["Gamybinė markė (gamintojo prekės pavadinimas):"][2] == "NISSAN"
    assert rows["Tipas/Variantas/Versija:"][2] == "F16/A/A45"
    assert rows["Komercinis pavadinimas:"][2] == "NISSAN JUKE"
    assert rows["Transporto priemonės identifikavimo numeris"][2] == "SJNF16FA7U2000002"
    assert rows["Tipo patvirtinimo Nr."][2] == "e9*2007/46*6697*17"
    assert rows["Tipo patvirtinimo numerio suteikimo data"][2] == "16.10.2025"
    assert rows["Transporto priemonės spalva"][2] == "GELTONA"
    # RL skiltis lieka nepaliesta
    assert rows["Gamybinė markė (gamintojo prekės pavadinimas):"][3] == "D.1"


def test_fill_template_fills_date_boxes():
    template = build_document(build_values({key: "" for key in DATA}, doc_date="2000-01-01"))
    filled, _ = fill_template(template, build_values(DATA, doc_date="2026-08-17"))
    document = Document(io.BytesIO(filled))
    boxes = "".join(cell.text for cell in document.tables[0].rows[0].cells)
    assert boxes == "2026-08-17"


def test_fill_template_supports_placeholders():
    document = Document()
    document.add_paragraph("Markė: {{make}}, VIN: {{vin}}, spalva: {{colour}}")
    buffer = io.BytesIO()
    document.save(buffer)

    filled, _ = fill_template(buffer.getvalue(), build_values(DATA))
    text = all_text(filled)
    assert "Markė: NISSAN" in text
    assert "VIN: SJNF16FA7U2000002" in text
    assert "spalva: GELTONA" in text


def test_fill_template_three_column_table():
    document = Document()
    table = document.add_table(rows=3, cols=3)
    for row, label, rl in zip(
        table.rows,
        ("Gamybinė markė:", "Komercinis pavadinimas:", "Transporto priemonės spalva"),
        ("D.1", "D.3", "R"),
    ):
        row.cells[0].text = label
        row.cells[2].text = rl
    buffer = io.BytesIO()
    document.save(buffer)

    filled, _ = fill_template(buffer.getvalue(), build_values(DATA))
    result = Document(io.BytesIO(filled))
    values = [row.cells[1].text for row in result.tables[0].rows]
    assert values == ["NISSAN", "NISSAN JUKE", "GELTONA"]


def test_suggested_filename_uses_vin():
    assert suggested_filename(DATA) == "aikstele_SJNF16FA7U2000002.docx"


def test_analyse_template_recognises_all_rows():
    from app.aikstele_docx import analyse_template

    template = build_document(build_values({key: "" for key in DATA}, doc_date=""))
    report = analyse_template(template)
    assert len(report["recognised"]) == 8
    assert report["missing"] == []
    assert report["value_column"] == 2
    assert report["date_boxes"] is True
    assert report["unrecognised_rows"] == []


def test_analyse_template_reports_missing_rows():
    from app.aikstele_docx import analyse_template

    document = Document()
    table = document.add_table(rows=2, cols=3)
    table.rows[0].cells[0].text = "Gamybinė markė:"
    table.rows[1].cells[0].text = "Komercinis pavadinimas:"
    buffer = io.BytesIO()
    document.save(buffer)

    report = analyse_template(buffer.getvalue())
    assert "Transporto priemonės spalva" in report["missing"]
    assert "Gamybinė markė (gamintojo prekės pavadinimas)" not in report["missing"]


def test_analyse_template_counts_placeholders_as_covered():
    from app.aikstele_docx import analyse_template

    document = Document()
    document.add_paragraph("Spalva: {{colour}}")
    table = document.add_table(rows=2, cols=3)
    table.rows[0].cells[0].text = "Gamybinė markė:"
    table.rows[1].cells[0].text = "Komercinis pavadinimas:"
    buffer = io.BytesIO()
    document.save(buffer)

    report = analyse_template(buffer.getvalue())
    assert report["placeholders"] == ["colour"]
    assert "Transporto priemonės spalva" not in report["missing"]


def _previous_pazyma() -> bytes:
    """Blankas, kuris yra ankstesnės pažymos kopija (su senos mašinos duomenimis).

    Būtent taip atrodo realus darbinis blankas: reikšmių stulpelis nėra
    tuščias, o datos langeliuose jau įrašyta ankstesnė data.
    """
    document = Document()

    boxes = document.add_table(rows=1, cols=10)
    for cell, ch in zip(boxes.rows[0].cells, "2025-10-16"):
        cell.text = ch
    document.add_paragraph("Nr. 41")

    table = document.add_table(rows=1, cols=4)
    for cell, text in zip(
        table.rows[0].cells,
        ("Transporto priemonės duomenys:", "Skirsnis atitikties liudijime", "", "Skiltis RL"),
    ):
        cell.text = text
    previous = [
        ("Gamybinė markė (gamintojo prekės pavadinimas):", "0.1", "NISSAN", "D.1"),
        ("Tipas/Variantas/Versija:", "0.2", "J12/D/D07", "D.2"),
        ("Komercinis pavadinimas:", "0.2.1", "NISSAN QASHQAI", "D.3"),
        ("Transporto priemonės identifikavimo numeris", "0.10", "SJNJ12TD4U2321187", "E"),
        ("Tipo patvirtinimo Nr.", "", "e9*2018/858*11042*15", "K"),
        ("Tipo patvirtinimo numerio suteikimo data", "", "05.05.2024", ""),
        ("Nacionalinis patvirtinimo numeris", "", "12345", "K.1"),
        ("Transporto priemonės spalva", "40", "PILKA/JUODA", "R"),
    ]
    for label, section, value, rl in previous:
        cells = table.add_row().cells
        for cell, text in zip(cells, (label, section, value, rl)):
            cell.text = text

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_value_column_found_when_template_is_a_previous_pazyma():
    from app.aikstele_docx import analyse_template

    report = analyse_template(_previous_pazyma())
    # 1 stulpelyje – CoC skirsniai, 3 – RL kodai; reikšmės rašomos į 2
    assert report["value_column"] == 2
    assert report["missing"] == []


def test_previous_vehicle_data_is_replaced_not_kept():
    filled, warnings = fill_template(
        _previous_pazyma(), build_values(DATA, doc_date="2026-09-01")
    )
    assert warnings == []
    text = all_text(filled)

    for stale in ("SJNJ12TD4U2321187", "J12/D/D07", "e9*2018/858*11042*15", "05.05.2024"):
        assert stale not in text, f"liko ankstesnės pažymos duomuo: {stale}"
    assert "SJNF16FA7U2000002" in text
    assert "NISSAN JUKE" in text

    document = Document(io.BytesIO(filled))
    rows = {row.cells[0].text: [c.text for c in row.cells] for row in document.tables[1].rows}
    # tuščias laukas išvalomas, o ne paliekamas iš ankstesnės pažymos
    assert rows["Nacionalinis patvirtinimo numeris"][2] == ""
    # skirsnių ir RL stulpeliai nepaliesti
    assert rows["Transporto priemonės spalva"][1] == "40"
    assert rows["Transporto priemonės spalva"][3] == "R"


def test_date_is_refreshed_but_number_is_left_alone():
    filled, _ = fill_template(
        _previous_pazyma(), build_values(DATA, doc_date="2026-09-01")
    )
    document = Document(io.BytesIO(filled))
    boxes = [cell.text for cell in document.tables[0].rows[0].cells]
    assert "".join(boxes) == "2026-09-01"
    assert boxes[4] == "-" and boxes[7] == "-"  # skirtukai išsaugoti
    # Pažymos numerį rašo pats vartotojas – programa jo neliečia
    assert any(p.text.strip() == "Nr. 41" for p in document.paragraphs)
