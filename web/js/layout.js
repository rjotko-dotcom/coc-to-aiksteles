// Dokumento eilučių atkūrimas iš teksto fragmentų su koordinatėmis.
//
// Tas pats algoritmas kaip `app/ocr.py` – naudojamas ir PDF teksto sluoksniui,
// ir OCR rezultatui. Fragmentas: { y, x0, x1, h, text }.

/** Eilutė su „pavadinimas : reikšmė“ pora (tekstas iš abiejų dvitaškio pusių). */
const PAIR_RE = /\S\s*:\s*\S/;

/** Naujo skirsnio pradžia: numeris ir po jo pavadinimas („16.2 Technically…“). */
const ITEM_START_RE = /^\d+(?:\.\d+)*\.?\s+[^\d\s]/;

/** Mažiausias tarpas tarp stulpelių (puslapio pločio dalis). */
const MIN_GUTTER = 0.02;

/** Fragmentus sugrupuoja į eilutes pagal aukštį (be stulpelių dalybos). */
export function rows(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const heights = sorted.map((item) => item.h).sort((a, b) => a - b);
  const tolerance = Math.max(3, heights[Math.floor(heights.length / 2)] * 0.45);

  const out = [];
  let current = [];
  let previousY = null;
  for (const item of sorted) {
    if (previousY !== null && item.y - previousY > tolerance) {
      out.push(current);
      current = [];
    }
    current.push(item);
    previousY = item.y;
  }
  if (current.length) out.push(current);
  return out;
}

function rowText(row) {
  return [...row].sort((a, b) => a.x0 - b.x0).map((item) => item.text).join(" ");
}

/** Ar šioje puslapio dalyje yra savų „pavadinimas : reikšmė“ eilučių. */
function hasLabelValuePairs(items) {
  const lines = rows(items).map(rowText);
  if (!lines.length) return false;
  const pairs = lines.filter((line) => PAIR_RE.test(line)).length;
  return pairs >= 4 && pairs / lines.length >= 0.25;
}

/** Vertikalūs tarpai (be teksto), platesni už `minimum`. */
function gutters(items, minimum) {
  const spans = [...items].sort((a, b) => a.x0 - b.x0);
  const found = [];
  let end = spans[0].x1;
  for (const span of spans.slice(1)) {
    if (span.x0 - end > minimum) found.push((end + span.x0) / 2);
    end = Math.max(end, span.x1);
  }
  return found;
}

/**
 * Puslapį padalija į stulpelius.
 *
 * Vien pagal tarpus spręsti negalima: tarpas yra ir tarp pavadinimų bei
 * reikšmių skilties. Stulpelio riba pripažįstama tik tada, kai abiejose pusėse
 * yra savarankiškų „pavadinimas : reikšmė“ eilučių – reikšmių skiltyje jų nėra
 * (vien reikšmės), pavadinimų skiltyje irgi ne (vien pavadinimai).
 */
export function splitIntoColumns(items) {
  if (items.length < 20) return [items];
  const width = Math.max(...items.map((i) => i.x1)) - Math.min(...items.map((i) => i.x0));
  const minimum = Math.max(10, width * MIN_GUTTER);

  for (const boundary of gutters(items, minimum)) {
    const left = items.filter((item) => item.x1 <= boundary);
    const right = items.filter((item) => item.x0 >= boundary);
    if (hasLabelValuePairs(left) && hasLabelValuePairs(right)) {
      return [left, ...splitIntoColumns(right)];
    }
  }
  return [items];
}

/** Ženklai, kuriais liudijime skiriamas pavadinimas nuo reikšmės. */
const SEPARATOR_RE = /^[^\p{L}\p{N}(]{1,2}$/u;

/**
 * Eilutėje atkuria „pavadinimas : reikšmė“ skirtuką.
 *
 * Skenuotame liudijime dvitaškis dažnai perskaitomas kaip `*`, `©` ar visai
 * dingsta, bet reikšmė visada atskirta plačiu tarpu. Todėl, jei dvitaškio
 * eilutėje nėra, jis įrašomas ties didžiausiu tarpu, o šalia likę vieno ženklo
 * nuolaužos išmetamos.
 */
/**
 * Apytiksliai nustato, kurioje eilutės vietoje prasideda reikšmė.
 *
 * PP-OCR visą eilutę grąžina vienu langeliu, todėl tikslios reikšmės vietos
 * nėra. Ji apskaičiuojama pagal ženklų dalį iki dvitaškio – to pakanka, kad
 * sąsajoje būtų parodyta būtent reikšmės iškarpa, o ne visa eilutė.
 */
function estimateValueBox(line, part) {
  const text = part.text;
  const at = text.indexOf(":");
  const share = at >= 0 && at < text.length - 1
    ? (at + 1) / text.length
    : 0.55; // be dvitaškio reikšmė beveik visada dešinėje eilutės pusėje
  const width = part.x1 - part.x0;
  line.valueBox = {
    x0: part.x0 + width * share,
    x1: part.x1,
    y0: part.y - part.h / 2,
    y1: part.y + part.h / 2,
  };
  return line;
}

function withSeparator(parts, minGap) {
  const texts = parts.map((part) => part.text);
  // Visos eilutės vieta puslapyje – iš jos sąsajoje rodoma iškarpa tikrinimui.
  const line = {
    text: texts.join(" "),
    // Atskiri fragmentai su savo vietomis – iš jų sąsajoje kerpamos iškarpos.
    parts: parts.map((part) => ({
      text: part.text,
      x0: part.x0, x1: part.x1, y0: part.y - part.h / 2, y1: part.y + part.h / 2,
    })),
    box: {
      x0: Math.min(...parts.map((part) => part.x0)),
      x1: Math.max(...parts.map((part) => part.x1)),
      y0: Math.min(...parts.map((part) => part.y - part.h / 2)),
      y1: Math.max(...parts.map((part) => part.y + part.h / 2)),
    },
  };
  if (parts.length < 2) return estimateValueBox(line, parts[0]);

  // Jau esantis dvitaškis: turi būti ne paskutinis ženklas eilutėje.
  let at = -1;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (index > 0 && texts[index].includes(":")) at = index + 1;
  }

  if (at < 0) {
    const gaps = parts.slice(1).map((part, index) => part.x0 - parts[index].x1);
    const widest = Math.max(...gaps);
    const at0 = gaps.indexOf(widest);
    // Mediana skaičiuojama be paties plačiausio tarpo – kitaip, kai tarpas
    // vienintelis, jis pats save ir paneigtų.
    const others = gaps.filter((_, index) => index !== at0).sort((a, b) => a - b);
    const median = others.length ? others[Math.floor((others.length - 1) / 2)] : 0;
    if (widest < Math.max(3 * median, minGap)) return line;
    at = at0 + 1;
  }

  const label = parts.slice(0, at);
  const value = parts.slice(at);
  if (SEPARATOR_RE.test(label[label.length - 1]?.text || "")) label.pop();
  if (SEPARATOR_RE.test(value[0]?.text || "")) value.shift();
  if (!label.length || !value.length) return line;


  line.label = label.map((part) => part.text).join(" ").replace(/[\s:*]+$/, "");
  line.value = value.map((part) => part.text).join(" ").replace(/^[:;*·•°©]+\s*/, "");
  if (!line.value) return { text: line.text, box: line.box, parts: line.parts };
  line.text = `${line.label} : ${line.value}`;
  line.valueBox = {
    x0: Math.min(...value.map((part) => part.x0)),
    x1: Math.max(...value.map((part) => part.x1)),
    y0: Math.min(...value.map((part) => part.y - part.h / 2)),
    y1: Math.max(...value.map((part) => part.y + part.h / 2)),
  };
  return line;
}

/**
 * Vieno aukščio fragmentus išskaido ties stulpelių tarpais.
 *
 * Tarpas laikomas riba tik tada, kai už jo prasideda naujas skirsnio numeris su
 * pavadinimu – kitaip būtų suskaldytos ir įprastos „pavadinimas : reikšmė“
 * eilutės, kur reikšmė irgi nutolusi į dešinę.
 */
function splitAtColumnGaps(row, gap, minGap) {
  const parts = [...row].sort((a, b) => a.x0 - b.x0);
  const lines = [[]];
  let previousEnd = null;
  parts.forEach((part, index) => {
    const rest = parts.slice(index).map((p) => p.text).join(" ");
    if (
      previousEnd !== null
      && part.x0 - previousEnd > gap
      && ITEM_START_RE.test(rest)
      && rest.length >= 12 // trumpa reikšmė („1 J12“) nėra naujas stulpelis
    ) {
      lines.push([]);
    }
    lines[lines.length - 1].push(part);
    previousEnd = previousEnd === null ? part.x1 : Math.max(previousEnd, part.x1);
  });
  return lines.filter((line) => line.length).map((line) => withSeparator(line, minGap));
}

/**
 * Iš fragmentų atkuria dokumento eilutes (stulpelis po stulpelio).
 *
 * Grąžinama po objektą eilutei: `{ text, label?, value?, valueBox? }`.
 * `valueBox` – reikšmės vieta puslapyje; ja naudojamasi tikslinant atpažinimą.
 */
export function linesFromBoxes(items) {
  if (!items.length) return [];
  const width = Math.max(...items.map((i) => i.x1)) - Math.min(...items.map((i) => i.x0));
  const columnGap = Math.max(20, width * 0.045);

  const lines = [];
  for (const column of splitIntoColumns(items)) {
    for (const row of rows(column)) {
      lines.push(...splitAtColumnGaps(row, columnGap, columnGap / 2.5));
    }
  }
  return lines;
}
