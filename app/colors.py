"""Transporto priemonės spalvos vertimas iš CoC (EN) į lietuvių kalbą.

CoC 40 skirsnyje spalva rašoma angliškai ir dažnai su gamintojo kodu,
pvz. "SOLID WHITE (326)", "BLACK / QAB", "GREY-BLUE". Čia bandome iš
tokio teksto ištraukti pagrindinę spalvą ir pateikti lietuvišką pavadinimą,
kokį įprasta rašyti pažymoje.
"""

from __future__ import annotations

import re

# Raktas – angliškas žodis (didžiosiomis), reikšmė – lietuviškas pavadinimas.
# Tvarka svarbi: ilgesni / sudėtiniai variantai tikrinami pirmiau.
COLOUR_MAP: list[tuple[str, str]] = [
    ("DARK GREY", "PILKA"),
    ("LIGHT GREY", "PILKA"),
    ("DARK BLUE", "MĖLYNA"),
    ("LIGHT BLUE", "MĖLYNA"),
    ("DARK GREEN", "ŽALIA"),
    ("LIGHT GREEN", "ŽALIA"),
    ("DARK RED", "RAUDONA"),
    ("MULTICOLOUR", "ĮVAIRIASPALVĖ"),
    ("MULTICOLOR", "ĮVAIRIASPALVĖ"),
    ("MULTI-COLOUR", "ĮVAIRIASPALVĖ"),
    ("SILVER", "SIDABRINĖ"),
    ("YELLOW", "GELTONA"),
    ("ORANGE", "ORANŽINĖ"),
    ("PURPLE", "VIOLETINĖ"),
    ("VIOLET", "VIOLETINĖ"),
    ("MAGENTA", "VIOLETINĖ"),
    ("TURQUOISE", "MĖLYNA"),
    ("BURGUNDY", "RAUDONA"),
    ("MAROON", "RAUDONA"),
    ("BRONZE", "RUDA"),
    ("COPPER", "RUDA"),
    ("BEIGE", "SMĖLIO"),
    ("CREAM", "SMĖLIO"),
    ("IVORY", "SMĖLIO"),
    ("SAND", "SMĖLIO"),
    ("KHAKI", "ŽALIA"),
    ("GOLD", "AUKSINĖ"),
    ("PINK", "ROŽINĖ"),
    ("BROWN", "RUDA"),
    ("GREEN", "ŽALIA"),
    ("WHITE", "BALTA"),
    ("BLACK", "JUODA"),
    ("GREY", "PILKA"),
    ("GRAY", "PILKA"),
    ("BLUE", "MĖLYNA"),
    ("RED", "RAUDONA"),
]

# Jei CoC iškart parašyta lietuviškai – paliekame kaip yra.
LT_COLOURS = {
    "BALTA", "JUODA", "PILKA", "MĖLYNA", "RAUDONA", "ŽALIA", "GELTONA",
    "RUDA", "ORANŽINĖ", "VIOLETINĖ", "ROŽINĖ", "SIDABRINĖ", "AUKSINĖ",
    "SMĖLIO", "ĮVAIRIASPALVĖ",
}


def to_lithuanian(raw: str | None) -> str:
    """Grąžina lietuvišką spalvos pavadinimą arba "" jei atpažinti nepavyko.

    Dvispalvės (two-tone) transporto priemonės CoC užrašomos kaip
    "GREY / BLACK", "TWO TONE BLACK-RED" ir pan. – tokiu atveju grąžinamos
    abi spalvos ta pačia tvarka: "PILKA/JUODA".
    """
    if not raw:
        return ""
    text = raw.upper()
    # nuimame gamintojo kodus skliaustuose
    text = re.sub(r"\([^)]*\)", " ", text)
    text = text.replace("_", " ").replace("-", " ").replace("/", " ")
    text = re.sub(r"[^A-ZĄČĘĖĮŠŲŪŽ ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""

    # ilgesni pavadinimai ("DARK GREY") tikrinami pirmiau nei trumpi ("GREY")
    names = sorted(
        [(en, lt) for en, lt in COLOUR_MAP] + [(lt, lt) for lt in LT_COLOURS],
        key=lambda pair: -len(pair[0]),
    )
    pattern = re.compile(r"(?<![A-ZĄČĘĖĮŠŲŪŽ])(" + "|".join(
        re.escape(en) for en, _ in names
    ) + r")(?![A-ZĄČĘĖĮŠŲŪŽ])")
    lookup = dict(names)

    found: list[str] = []
    for match in pattern.finditer(text):
        lithuanian = lookup[match.group(1)]
        if lithuanian not in found:
            found.append(lithuanian)
    return "/".join(found)
