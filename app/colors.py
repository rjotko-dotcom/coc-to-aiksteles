"""Transporto priemonės spalvos vertimas iš CoC į lietuvių kalbą.

Liudijimai būna įvairiomis kalbomis: `Black`, `blanc`, `weiss`, `bianco`,
o spalva dažnai užrašyta kartu su gamintojo kodu – `SOLID WHITE (326)`,
`GREY/BLACK`. Dvispalvės transporto priemonės išverčiamos abiem spalvomis.
"""

from __future__ import annotations

import re
import unicodedata

#: Spalvų žodynas: (užrašas liudijime, lietuviškas pavadinimas).
#: Rašoma be diakritikų ir didžiosiomis – lyginama su sutvarkytu tekstu.
COLOUR_WORDS: list[tuple[str, str]] = [
    # anglų
    ("DARK GREY", "PILKA"), ("LIGHT GREY", "PILKA"),
    ("DARK BLUE", "MĖLYNA"), ("LIGHT BLUE", "MĖLYNA"),
    ("DARK GREEN", "ŽALIA"), ("LIGHT GREEN", "ŽALIA"),
    ("MULTICOLOUR", "ĮVAIRIASPALVĖ"), ("MULTICOLOR", "ĮVAIRIASPALVĖ"),
    ("SILVER", "SIDABRINĖ"), ("YELLOW", "GELTONA"), ("ORANGE", "ORANŽINĖ"),
    ("PURPLE", "VIOLETINĖ"), ("VIOLET", "VIOLETINĖ"), ("MAGENTA", "VIOLETINĖ"),
    ("TURQUOISE", "MĖLYNA"), ("BURGUNDY", "RAUDONA"), ("MAROON", "RAUDONA"),
    ("BRONZE", "RUDA"), ("COPPER", "RUDA"), ("BEIGE", "SMĖLIO"),
    ("CREAM", "SMĖLIO"), ("IVORY", "SMĖLIO"), ("SAND", "SMĖLIO"),
    ("KHAKI", "ŽALIA"), ("GOLD", "AUKSINĖ"), ("PINK", "ROŽINĖ"),
    ("BROWN", "RUDA"), ("GREEN", "ŽALIA"), ("WHITE", "BALTA"),
    ("BLACK", "JUODA"), ("GREY", "PILKA"), ("GRAY", "PILKA"),
    ("BLUE", "MĖLYNA"), ("RED", "RAUDONA"),
    # prancūzų
    ("BLANCHE", "BALTA"), ("BLANC", "BALTA"), ("NOIRE", "JUODA"),
    ("NOIR", "JUODA"), ("GRISE", "PILKA"), ("GRIS", "PILKA"),
    ("ROUGE", "RAUDONA"), ("BLEUE", "MĖLYNA"), ("BLEU", "MĖLYNA"),
    ("VERTE", "ŽALIA"), ("VERT", "ŽALIA"), ("JAUNE", "GELTONA"),
    ("MARRON", "RUDA"), ("BRUNE", "RUDA"), ("BRUN", "RUDA"),
    ("ARGENTE", "SIDABRINĖ"), ("ARGENT", "SIDABRINĖ"), ("DORE", "AUKSINĖ"),
    ("VIOLETTE", "VIOLETINĖ"), ("ROSE", "ROŽINĖ"),
    # vokiečių
    ("WEISS", "BALTA"), ("SCHWARZ", "JUODA"), ("GRAU", "PILKA"),
    ("ROT", "RAUDONA"), ("BLAU", "MĖLYNA"), ("GRUN", "ŽALIA"),
    ("GELB", "GELTONA"), ("BRAUN", "RUDA"), ("SILBER", "SIDABRINĖ"),
    ("GOLDEN", "AUKSINĖ"), ("VIOLETT", "VIOLETINĖ"), ("ROSA", "ROŽINĖ"),
    # italų / ispanų
    ("BIANCO", "BALTA"), ("BLANCO", "BALTA"), ("NERO", "JUODA"),
    ("NEGRO", "JUODA"), ("GRIGIO", "PILKA"), ("ROSSO", "RAUDONA"),
    ("ROJO", "RAUDONA"), ("VERDE", "ŽALIA"), ("GIALLO", "GELTONA"),
    ("AMARILLO", "GELTONA"), ("MARRONE", "RUDA"), ("ARGENTO", "SIDABRINĖ"),
    ("PLATA", "SIDABRINĖ"), ("ARANCIONE", "ORANŽINĖ"), ("AZUL", "MĖLYNA"),
    ("VIOLA", "VIOLETINĖ"), ("ORO", "AUKSINĖ"),
]

#: Jei liudijime spalva jau lietuviškai – paliekame kaip yra.
LT_COLOURS = {
    "BALTA", "JUODA", "PILKA", "MĖLYNA", "RAUDONA", "ŽALIA", "GELTONA",
    "RUDA", "ORANŽINĖ", "VIOLETINĖ", "ROŽINĖ", "SIDABRINĖ", "AUKSINĖ",
    "SMĖLIO", "ĮVAIRIASPALVĖ",
}


def _fold(text: str) -> str:
    """Didžiosiomis ir be diakritikų: `Blanc` -> `BLANC`, `weiß` -> `WEISS`."""
    text = text.replace("ß", "ss")
    text = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in text if not unicodedata.combining(ch)).upper()


_LOOKUP: dict[str, str] = {}
for _word, _lithuanian in COLOUR_WORDS:
    _LOOKUP.setdefault(_fold(_word), _lithuanian)
for _lithuanian in LT_COLOURS:
    _LOOKUP.setdefault(_fold(_lithuanian), _lithuanian)

#: Ilgesni pavadinimai tikrinami pirmiau ("DARK GREY" prieš "GREY").
_PATTERN = re.compile(
    r"(?<![A-Z])(" + "|".join(
        re.escape(word) for word in sorted(_LOOKUP, key=len, reverse=True)
    ) + r")(?![A-Z])"
)


def to_lithuanian(raw: str | None) -> str:
    """Grąžina lietuvišką spalvos pavadinimą arba "" jei atpažinti nepavyko.

    Dvispalvės transporto priemonės liudijime užrašomos kaip `GREY / BLACK`
    ar `TWO TONE BLACK-RED` – tokiu atveju grąžinamos abi spalvos ta pačia
    tvarka: `PILKA/JUODA`.
    """
    if not raw:
        return ""
    text = re.sub(r"\([^)]*\)", " ", raw)          # gamintojo kodai skliaustuose
    text = _fold(text)
    text = re.sub(r"[^A-Z]+", " ", text).strip()
    if not text:
        return ""

    found: list[str] = []
    for match in _PATTERN.finditer(text):
        lithuanian = _LOOKUP[match.group(1)]
        if lithuanian not in found:
            found.append(lithuanian)
    return "/".join(found)
