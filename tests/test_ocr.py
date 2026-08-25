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
        (2146, 1041, 1090, 20, "Black"),
        (2150, 90, 130, 22, "40."),
        (2150, 147, 420, 24, "Colour of vehicle"),
        (2162, 1040, 1330, 21, "5,2(left),2(right),1(rear)"),
        (2166, 92, 132, 19, "41."),
        (2166, 146, 640, 26, "Number and configuration of doors"),
        (2179, 1041, 1060, 17, "5"),
        (2183, 93, 133, 18, "42."),
    ]
    lines = _lines_from_boxes(items)
    assert lines[0] == "40. Colour of vehicle Black"
    assert lines[1].startswith("41. Number and configuration of doors")
    assert lines[2] == "42. 5"


def test_lines_keep_label_and_value_together():
    items = [
        (133, 105, 150, 18, "0.1."),
        (136, 206, 700, 20, "Make (Trade name of manufacturer)"),
        (138, 973, 1120, 19, ":NISSAN"),
        (154, 105, 150, 18, "0.2."),
        (156, 973, 1040, 19, ":J12"),
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


def test_three_column_page_is_split_into_separate_lines():
    """Hyundai ir Citroën liudijimuose viename aukštyje yra keli skirsniai."""
    items = [
        (200, 130, 180, 18, "0.2."),
        (200, 200, 320, 18, "Type :"),
        (200, 420, 470, 18, "OSE"),
        (200, 1250, 1310, 18, "16.2"),
        (200, 1330, 1700, 18, "Technically permissible mass on each axle :"),
        (200, 1720, 1850, 18, "1. 1100 kg 2. 1120 kg"),
    ]
    assert _lines_from_boxes(items) == [
        "0.2. Type : OSE",
        "16.2 Technically permissible mass on each axle : 1. 1100 kg 2. 1120 kg",
    ]


def test_value_far_to_the_right_is_not_treated_as_a_column():
    """Nissan forma: reikšmė toli dešinėje, bet tai ta pati eilutė."""
    items = [
        (100, 105, 150, 18, "0.1."),
        (100, 206, 700, 18, "Make (Trade name of manufacturer)"),
        (100, 973, 1120, 18, ":NISSAN"),
    ]
    assert _lines_from_boxes(items) == ["0.1. Make (Trade name of manufacturer) :NISSAN"]


def _column_page():
    """Trijų stulpelių puslapis: kiekviename – savos „pavadinimas : reikšmė“ eilutės."""
    items = []
    columns = [
        (20, 180, [("0.1. Make :", "Hyundai"), ("0.2. Type :", "OSE"),
                   ("- Variant :", "F5E11"), ("- Version :", "E11B11"),
                   ("0.4. Vehicle category :", "M1"), ("0.10. Vehicle ident. number :", "TMAJ38")]),
        (300, 460, [("0.11. Date of manufacture :", "10.12.2020"), ("1. Number of axles :", "2"),
                    ("4. Wheelbase :", "2600 mm"), ("5. Length :", "4205 mm"),
                    ("13. Mass in running order :", "1760 kg"), ("40. Colour of vehicle :", "white")]),
        (580, 740, [("16.2 Mass on each axle :", "1100 kg"), ("20. Engine manufacturer :", "MOBIS"),
                    ("21. Engine code :", "EM16"), ("23. Pure electric :", "yes"),
                    ("26. Fuel :", "Electricity"), ("29. Maximum speed :", "167 km/h")]),
    ]
    for x_label, x_value, rows in columns:
        y = 100
        for label, value in rows:
            items.append((y, x_label, x_label + 130, 10, label))
            items.append((y, x_value, x_value + 60, 10, value))
            y += 20
    return items


def test_page_is_split_into_three_columns():
    from app.ocr import _split_into_columns

    assert len(_split_into_columns(_column_page())) == 3


def test_columns_do_not_mix_in_the_rebuilt_lines():
    lines = _lines_from_boxes(_column_page())
    assert "0.2. Type : OSE" in lines
    assert "40. Colour of vehicle : white" in lines
    assert not any("Type : OSE" in line and "axles" in line for line in lines)


def test_value_column_is_not_taken_for_a_page_column():
    """Nissan forma: pavadinimai kairėje, reikšmės dešinėje – tai vienas stulpelis."""
    from app.ocr import _split_into_columns

    items = []
    y = 100
    for label, value in [
        ("0.1. Make (Trade name of manufacturer)", ":NISSAN"),
        ("0.2.", ":J12"), ("Variant", ":D"), ("Version", ":D13"),
        ("0.2.1. Commercial Name", ":NISSAN QASHQAI"),
        ("0.4. Category", ":M1"),
        ("0.10. Vehicle identification number", ":SJNJ12TD3U2000001"),
        ("0.11. Date of manufacture of the vehicle", ":07/05/2026"),
        ("40. Colour of the vehicle", ":Black"),
        ("38. Code for bodywork", ":AC"),
    ]:
        items.append((y, 90, 700, 20, label))
        items.append((y, 970, 1200, 20, value))
        y += 20
    assert len(_split_into_columns(items)) == 1
