"""Testai OCR pagalbinėms funkcijoms.

Pats atpažinimas čia nepaleidžiamas (lėtas ir priklauso nuo bibliotekų) –
tikrinama logika, kuri iš OCR fragmentų atkuria dokumento eilutes, ir
OCR ženklų sutvarkymas.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.coc_extract import parse_coc_text, vin_check_digit_valid  # noqa: E402
from app.ocr import _lines_from_boxes, normalise_ocr_text  # noqa: E402


def test_lines_are_rebuilt_from_fragment_coordinates():
    # Tikros koordinatės iš skenuoto CoC: eilučių žingsnis (~16) mažesnis už
    # teksto aukštį (~24), o reikšmė dešinėje yra keliais taškais aukščiau.
    items = [
        (2146, 1041, 20, "Black"),
        (2150, 90, 22, "40."),
        (2150, 147, 24, "Colour of vehicle"),
        (2162, 1040, 21, "5,2(left),2(right),1(rear)"),
        (2166, 92, 19, "41."),
        (2166, 146, 26, "Number and configuration of doors"),
        (2179, 1041, 17, "5"),
        (2183, 93, 18, "42."),
    ]
    lines = _lines_from_boxes(items)
    assert lines[0] == "40. Colour of vehicle Black"
    assert lines[1].startswith("41. Number and configuration of doors")
    assert lines[2] == "42. 5"


def test_lines_keep_label_and_value_together():
    items = [
        (133, 105, 18, "0.1."),
        (136, 206, 20, "Make (Trade name of manufacturer)"),
        (138, 973, 19, ":NISSAN"),
        (154, 105, 18, "0.2."),
        (156, 973, 19, ":J12"),
    ]
    assert _lines_from_boxes(items) == [
        "0.1. Make (Trade name of manufacturer) :NISSAN",
        "0.2. :J12",
    ]


def test_fullwidth_characters_are_normalised():
    assert normalise_ocr_text("Colour of vehicle ： Black") == "Colour of vehicle : Black"
    assert normalise_ocr_text("Make （Trade name)") == "Make (Trade name)"


def test_scanned_certificate_text_is_parsed():
    """Tekstas tokia forma, kokią grąžina OCR iš tikro Nissan liudijimo."""
    text = (
        "0.1. Make （Trade name of manufacturer) :NISSAN\n"
        "0.2. :J12\n"
        "Variant :D\n"
        "Version :D13\n"
        "0.2.1. Commercial Name :NISSAN QASHQAI\n"
        "0.10. Vehicle identification number :SJNJ12TD3U2000001\n"
        "0.11. Date of manufacture of the vehicle ：07/05/2026\n"
        "Conforms inallrespects tothe type described in approval "
        "e9*2018/858*11042*16 grantedon\n"
        "03/03/2026and can be permanently registered in Member States\n"
        "40. Colour of vehicle ： Black\n"
    )
    data = parse_coc_text(text, ocr_used=True)
    assert data.make == "NISSAN"
    assert data.type_variant_version == "J12/D/D13"
    assert data.commercial_name == "NISSAN QASHQAI"
    assert data.vin == "SJNJ12TD3U2000001"
    assert data.approval_number == "e9*2018/858*11042*16"
    assert data.approval_date == "03.03.2026"
    assert data.manufacture_date == "07.05.2026"
    assert data.colour == "JUODA"


def test_ocr_result_carries_a_reminder_to_check():
    data = parse_coc_text("0.1. Make :NISSAN\n", ocr_used=True)
    assert any("OCR" in warning for warning in data.warnings)


def test_vin_check_digit():
    assert vin_check_digit_valid("SJNJ12TD3U2000001")
    assert vin_check_digit_valid("SJNF16FA7U2000002")
    assert not vin_check_digit_valid("SJNJ12TD1U2361797")  # pakeistas skaitmuo
    assert not vin_check_digit_valid("PERTRUMPAS")


def test_ocr_vin_error_is_flagged():
    data = parse_coc_text(
        "0.10. Vehicle identification number :SJNJ12TD1U2361797\n", ocr_used=True
    )
    assert any("kontrolinis skaitmuo" in warning for warning in data.warnings)
