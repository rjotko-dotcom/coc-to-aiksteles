// Transporto priemonės spalvos vertimas iš liudijimo į lietuvių kalbą.
// Tas pats žodynas kaip `app/colors.py`.

const COLOUR_WORDS = [
  // anglų
  ["DARK GREY", "PILKA"], ["LIGHT GREY", "PILKA"],
  ["DARK BLUE", "MĖLYNA"], ["LIGHT BLUE", "MĖLYNA"],
  ["DARK GREEN", "ŽALIA"], ["LIGHT GREEN", "ŽALIA"],
  ["MULTICOLOUR", "ĮVAIRIASPALVĖ"], ["MULTICOLOR", "ĮVAIRIASPALVĖ"],
  ["SILVER", "SIDABRINĖ"], ["YELLOW", "GELTONA"], ["ORANGE", "ORANŽINĖ"],
  ["PURPLE", "VIOLETINĖ"], ["VIOLET", "VIOLETINĖ"], ["MAGENTA", "VIOLETINĖ"],
  ["TURQUOISE", "MĖLYNA"], ["BURGUNDY", "RAUDONA"], ["MAROON", "RAUDONA"],
  ["BRONZE", "RUDA"], ["COPPER", "RUDA"], ["BEIGE", "SMĖLIO"],
  ["CREAM", "SMĖLIO"], ["IVORY", "SMĖLIO"], ["SAND", "SMĖLIO"],
  ["KHAKI", "ŽALIA"], ["GOLD", "AUKSINĖ"], ["PINK", "ROŽINĖ"],
  ["BROWN", "RUDA"], ["GREEN", "ŽALIA"], ["WHITE", "BALTA"],
  ["BLACK", "JUODA"], ["GREY", "PILKA"], ["GRAY", "PILKA"],
  ["BLUE", "MĖLYNA"], ["RED", "RAUDONA"],
  // prancūzų
  ["BLANCHE", "BALTA"], ["BLANC", "BALTA"], ["NOIRE", "JUODA"], ["NOIR", "JUODA"],
  ["GRISE", "PILKA"], ["GRIS", "PILKA"], ["ROUGE", "RAUDONA"],
  ["BLEUE", "MĖLYNA"], ["BLEU", "MĖLYNA"], ["VERTE", "ŽALIA"], ["VERT", "ŽALIA"],
  ["JAUNE", "GELTONA"], ["MARRON", "RUDA"], ["BRUNE", "RUDA"], ["BRUN", "RUDA"],
  ["ARGENTE", "SIDABRINĖ"], ["ARGENT", "SIDABRINĖ"], ["DORE", "AUKSINĖ"],
  ["VIOLETTE", "VIOLETINĖ"], ["ROSE", "ROŽINĖ"],
  // vokiečių
  ["WEISS", "BALTA"], ["SCHWARZ", "JUODA"], ["GRAU", "PILKA"], ["ROT", "RAUDONA"],
  ["BLAU", "MĖLYNA"], ["GRUN", "ŽALIA"], ["GELB", "GELTONA"], ["BRAUN", "RUDA"],
  ["SILBER", "SIDABRINĖ"], ["GOLDEN", "AUKSINĖ"], ["VIOLETT", "VIOLETINĖ"],
  ["ROSA", "ROŽINĖ"],
  // italų / ispanų
  ["BIANCO", "BALTA"], ["BLANCO", "BALTA"], ["NERO", "JUODA"], ["NEGRO", "JUODA"],
  ["GRIGIO", "PILKA"], ["ROSSO", "RAUDONA"], ["ROJO", "RAUDONA"], ["VERDE", "ŽALIA"],
  ["GIALLO", "GELTONA"], ["AMARILLO", "GELTONA"], ["MARRONE", "RUDA"],
  ["ARGENTO", "SIDABRINĖ"], ["PLATA", "SIDABRINĖ"], ["ARANCIONE", "ORANŽINĖ"],
  ["AZUL", "MĖLYNA"], ["VIOLA", "VIOLETINĖ"], ["ORO", "AUKSINĖ"],
];

const LT_COLOURS = [
  "BALTA", "JUODA", "PILKA", "MĖLYNA", "RAUDONA", "ŽALIA", "GELTONA", "RUDA",
  "ORANŽINĖ", "VIOLETINĖ", "ROŽINĖ", "SIDABRINĖ", "AUKSINĖ", "SMĖLIO",
  "ĮVAIRIASPALVĖ",
];

/** Didžiosiomis ir be diakritikų: `Blanc` -> `BLANC`, `weiß` -> `WEISS`. */
function fold(text) {
  return (text || "")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

const LOOKUP = new Map();
for (const [word, lithuanian] of COLOUR_WORDS) {
  if (!LOOKUP.has(fold(word))) LOOKUP.set(fold(word), lithuanian);
}
for (const lithuanian of LT_COLOURS) {
  if (!LOOKUP.has(fold(lithuanian))) LOOKUP.set(fold(lithuanian), lithuanian);
}

// Ilgesni pavadinimai tikrinami pirmiau („DARK GREY“ prieš „GREY“).
const PATTERN = new RegExp(
  "(?<![A-Z])(" +
    [...LOOKUP.keys()].sort((a, b) => b.length - a.length).join("|") +
    ")(?![A-Z])",
  "g",
);

/** Ar žodžiai skiriasi ne daugiau kaip vienu ženklu (pakeistu, praleistu ar pridėtu). */
function oneEditAway(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Lietuviškas spalvos pavadinimas arba "" jei atpažinti nepavyko.
 * Dvispalvės transporto priemonės grąžinamos abiem spalvomis: `PILKA/JUODA`.
 */
export function toLithuanian(raw) {
  if (!raw) return "";
  let text = raw.replace(/\([^)]*\)/g, " "); // gamintojo kodai skliaustuose
  text = fold(text).replace(/[^A-Z]+/g, " ").trim();
  if (!text) return "";

  const found = [];
  for (const match of text.matchAll(PATTERN)) {
    const lithuanian = LOOKUP.get(match[1]);
    if (!found.includes(lithuanian)) found.push(lithuanian);
  }
  // Atpažinimo klaida vienoje raidėje („GRECN“ → GREEN, „BLACX“ → BLACK).
  if (!found.length) {
    for (const word of text.split(" ").filter((part) => part.length >= 4)) {
      const near = [...LOOKUP.keys()].filter((key) => key.length >= 4 && !key.includes(" ") && oneEditAway(word, key));
      const names = [...new Set(near.map((key) => LOOKUP.get(key)))];
      if (names.length === 1 && !found.includes(names[0])) found.push(names[0]);
    }
  }
  return found.join("/");
}
