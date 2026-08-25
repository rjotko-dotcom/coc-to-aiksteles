import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.coc_extract import extract_from_pdf, normalise_date, parse_coc_text  # noqa: E402
from app.colors import to_lithuanian  # noqa: E402

SAMPLES = Path(__file__).resolve().parents[1] / "samples"


def sample_text() -> str:
    return (SAMPLES / "sample_coc.txt").read_text(encoding="utf-8")


def test_parses_identity_fields():
    data = parse_coc_text(sample_text(), source_file="sample.pdf")
    assert data.make == "NISSAN"
    assert data.type == "J12"
    assert data.variant == "D"
    assert data.version == "D13"
    assert data.type_variant_version == "J12/D/D13"
    assert data.commercial_name == "NISSAN QASHQAI"
    assert data.vin == "SJNJ12TD3U2000001"
    assert data.category == "M1"


def test_parses_type_approval():
    data = parse_coc_text(sample_text())
    assert data.approval_number == "e9*2018/858*11042*16"
    assert data.approval_date == "03.03.2026"
    assert data.manufacture_date == "07.05.2026"


def test_parses_colour_and_translates():
    data = parse_coc_text(sample_text())
    assert data.colour_raw == "SOLID WHITE (326)"
    assert data.colour == "BALTA"


def test_no_warnings_for_complete_certificate():
    assert parse_coc_text(sample_text()).warnings == []


def test_variant_version_with_repeated_section_number():
    text = (
        "0.1. Make : NISSAN\n"
        "0.2. Type : F16\n"
        "0.2. Variant : A\n"
        "0.2. Version : A45\n"
        "0.2.1 Commercial Name : NISSAN JUKE\n"
        "0.10. Vehicle identification number : SJNF16FA7U2000002\n"
        "type described in approval e9*2007/46*6697*17 granted on 16/10/2025\n"
        "40. Colour of the vehicle : YELLOW\n"
    )
    data = parse_coc_text(text)
    assert data.type_variant_version == "F16/A/A45"
    assert data.approval_number == "e9*2007/46*6697*17"
    assert data.approval_date == "16.10.2025"
    assert data.colour == "GELTONA"


def test_missing_fields_produce_warnings():
    data = parse_coc_text("0.1. Make : NISSAN\n")
    assert any("Komercinis pavadinimas" in w for w in data.warnings)
    assert any("spalva" in w for w in data.warnings)


def test_vin_fallback_by_format():
    data = parse_coc_text("Some text SJNF16FA7U2000002 elsewhere\n")
    assert data.vin == "SJNF16FA7U2000002"
    assert any("VIN rastas ne pagal" in w for w in data.warnings)


def test_normalise_date_variants():
    assert normalise_date("07/05/2026") == "07.05.2026"
    assert normalise_date("2026-05-07") == "07.05.2026"
    assert normalise_date("7.5.2026") == "07.05.2026"
    assert normalise_date("") == ""


def test_colour_translation():
    assert to_lithuanian("SOLID BLACK / GNO") == "JUODA"
    assert to_lithuanian("DARK GREY") == "PILKA"
    assert to_lithuanian("MĖLYNA") == "MĖLYNA"
    assert to_lithuanian("UNKNOWN SHADE") == ""


def test_extract_from_pdf_end_to_end():
    pdf = SAMPLES / "sample_coc.pdf"
    if not pdf.exists():  # PDF generuojamas samples/make_sample_pdf.py
        return
    data = extract_from_pdf(pdf)
    assert data.make == "NISSAN"
    assert data.vin == "SJNJ12TD3U2000001"
    assert data.colour == "BALTA"


def test_two_tone_colour_keeps_both_names():
    assert to_lithuanian("GREY/BLACK") == "PILKA/JUODA"
    assert to_lithuanian("TWO TONE WHITE-BLACK (QNC)") == "BALTA/JUODA"
    assert to_lithuanian("BLACK") == "JUODA"


def test_two_tone_colour_from_certificate():
    data = parse_coc_text(
        "0.1. Make : NISSAN\n40. Colour of the vehicle : GREY / BLACK ROOF\n"
    )
    assert data.colour_raw == "GREY / BLACK ROOF"
    assert data.colour == "PILKA/JUODA"


def test_vin_taken_from_the_file_name_when_unreadable():
    """Gamintojų portalai liudijimus pavadina VIN numeriu."""
    data = parse_coc_text(
        "0.1. Make : NISSAN\n", source_file="SJNJ12TD3U2371076.pdf", ocr_used=True
    )
    assert data.vin == "SJNJ12TD3U2371076"
    assert any("failo pavadinimo" in w for w in data.warnings)


def test_file_name_vin_must_pass_the_check_digit():
    data = parse_coc_text("0.1. Make : NISSAN\n", source_file="SJNJ12TD9U2371076.pdf")
    assert data.vin == ""


def test_file_name_disagreeing_with_the_certificate_is_flagged():
    data = parse_coc_text(
        "0.10. Vehicle identification number : SJNJ12TD3U2000001\n",
        source_file="SJNJ12TD3U2371076.pdf",
    )
    assert data.vin == "SJNJ12TD3U2000001"
    assert any("nesutampa su failo" in w for w in data.warnings)


def test_approval_number_rebuilt_from_damaged_text():
    """Po atpažinimo žvaigždutė dažnai virsta „%“ arba „x“."""
    data = parse_coc_text(
        "type described in approval e9%2018/858%11042%16 granted on 03/03/2026 and\n",
        ocr_used=True,
    )
    assert data.approval_number == "e9*2018/858*11042*16"
    assert data.approval_date == "03.03.2026"
    assert any("sudėliotas iš neaiškiai" in w for w in data.warnings)


def test_make_corrected_from_the_commercial_name():
    data = parse_coc_text(
        "0.1. Make : HISSAN\n0.2.1. Commercial Name : NISSAN QASHQAI\n", ocr_used=True
    )
    assert data.make == "NISSAN"
    assert any("Markė pataisyta" in w for w in data.warnings)


def test_make_left_alone_when_it_differs_by_more_than_one_letter():
    data = parse_coc_text(
        "0.1. Make : DACIA\n0.2.1. Commercial Name : NISSAN QASHQAI\n", ocr_used=True
    )
    assert data.make == "DACIA"


def test_line_without_a_colon_is_still_split():
    """PP-OCR kartais dvitaškio nepamato visai."""
    data = parse_coc_text(
        "0.1. Make (Trade name of manufacturer) NISSAN\n"
        "0.2. Type J12\n"
        "0.2.1 Commercial Name NISSAN QASHQAI\n"
        "0.10. Vehicle identification number SJNJ12TD3U2000001\n"
        "0.4. Vehicle category M1\n"
        "40. Colour of vehicle Black\n",
        ocr_used=True,
    )
    assert data.make == "NISSAN"
    assert data.type == "J12"
    assert data.commercial_name == "NISSAN QASHQAI"
    assert data.vin == "SJNJ12TD3U2000001"
    assert data.category == "M1"
    assert data.colour == "JUODA"


def test_line_without_a_colon_needs_a_known_section():
    """Atsitiktinė eilutė be dvitaškio nieko neužpildo."""
    data = parse_coc_text("35. Fitted tyre wheel combination 215/55R18 92V\n")
    assert data.make == ""
    assert data.colour == ""
