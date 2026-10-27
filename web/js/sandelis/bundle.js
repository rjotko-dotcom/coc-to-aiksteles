// CoC kopijos ir jų pažymos viename Word faile spausdinimui: CoC, pažyma, CoC, pažyma…
//
// Kiekviena CoC kopija įdedama kaip paveikslas atskirame A4 skirsnyje (per visą
// lapą, be paraščių ir poraščių), po jo – iš šablono užpildyta pažyma su šablono
// lapo nustatymais. Šablono gale esantis tuščias skirsnis (tuščias lapas)
// praleidžiamas, kad tarp lapų nebūtų tuščių puslapių.

import { unzipSync, zipSync, strToU8, strFromU8 } from "../../vendor/fflate/fflate.mjs";
import { fillTemplate } from "../docx.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_IMAGE = `${R}/image`;
const REL_HEADER = `${R}/header`;
const REL_FOOTER = `${R}/footer`;

/**
 * CoC lapas: A4 be paraščių – paveikslas per visą lapą. Aukštis 1 mm mažesnis,
 * kad tuščia antraštė (1 pt) nenustumtų paveikslo į kitą lapą.
 */
const COC_PAGE = { w: 11906, h: 16838, margin: 0 };
const COC_MAX_MM = { w: 210, h: 296 };
const EMU_PER_MM = 36000;

const parse = (bytes) => new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
const serialise = (doc) => strToU8(new XMLSerializer().serializeToString(doc));
const kids = (element, name, ns = W) => [...element.children].filter((child) => child.namespaceURI === ns && child.localName === name);
const isW = (node, name) => node.nodeType === 1 && node.namespaceURI === W && node.localName === name;

/** Ar pastraipa tuščia (be teksto, paveikslų ir skirsnio pabaigos). */
function emptyParagraph(node) {
  if (!isW(node, "p")) return false;
  if (node.getElementsByTagNameNS(W, "sectPr").length) return false;
  if (node.getElementsByTagNameNS(W, "drawing").length || node.getElementsByTagNameNS(W, "pict").length) return false;
  return ![...node.getElementsByTagNameNS(W, "t")].some((text) => text.textContent.trim());
}

/**
 * Užpildytos pažymos turinys: kūno elementai be galinio tuščio skirsnio.
 * `close` – skirsnio pabaigos nustatymai (sectPr), jei paskutinė pastraipa jų dar neturi.
 */
function pazymaContent(doc) {
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  const nodes = [...body.childNodes].filter((node) => node.nodeType === 1);
  let close = nodes.length && isW(nodes[nodes.length - 1], "sectPr") ? nodes.pop() : null;
  // Galinės tuščios pastraipos po paskutinio skirsnio – tai tik tuščias lapas.
  const lastSection = nodes.map((node) => isW(node, "p") && kids(node, "pPr")[0] && kids(kids(node, "pPr")[0], "sectPr").length > 0)
    .lastIndexOf(true);
  if (lastSection >= 0 && nodes.slice(lastSection + 1).every(emptyParagraph)) {
    nodes.splice(lastSection + 1);
    close = null; // skirsnį jau užbaigia paskutinė pastraipa
  } else {
    while (nodes.length > 1 && emptyParagraph(nodes[nodes.length - 1]) && emptyParagraph(nodes[nodes.length - 2])) nodes.pop();
  }
  return { nodes, close };
}

/** Kiek lapų užima pažyma: 1 + aiškūs lapų/skirsnių lūžiai šablone. */
function pageCount(nodes) {
  let breaks = 0;
  nodes.forEach((node, index) => {
    breaks += [...node.getElementsByTagNameNS(W, "br")].filter((br) => br.getAttributeNS(W, "type") === "page").length;
    breaks += node.getElementsByTagNameNS(W, "pageBreakBefore").length;
    if (isW(node, "p") && paragraphSect(node) && index < nodes.length - 1) breaks += 1;
  });
  return 1 + breaks;
}

function paragraphSect(paragraph) {
  const pPr = kids(paragraph, "pPr")[0];
  return pPr ? kids(pPr, "sectPr")[0] || null : null;
}

/** Įdeda sectPr į pastraipą (pPr gale). */
function putSect(doc, paragraph, sect) {
  let pPr = kids(paragraph, "pPr")[0];
  if (!pPr) {
    pPr = doc.createElementNS(W, "w:pPr");
    paragraph.insertBefore(pPr, paragraph.firstChild);
  }
  const change = kids(pPr, "pPrChange")[0];
  pPr.insertBefore(sect, change || null);
}

/** `oddPage` – skirsnis prasideda nelyginiame puslapyje (dvipusiam spausdinimui: naujas lapas). */
function cocSect(headerId, footerId, oddPage = false) {
  const refs = ["default", "first", "even"].map((type) =>
    `<w:headerReference w:type="${type}" r:id="${headerId}"/>`).join("")
    + ["default", "first", "even"].map((type) => `<w:footerReference w:type="${type}" r:id="${footerId}"/>`).join("");
  const m = COC_PAGE.margin;
  return `<w:sectPr>${refs}${oddPage ? `<w:type w:val="oddPage"/>` : ""}<w:pgSz w:w="${COC_PAGE.w}" w:h="${COC_PAGE.h}"/>`
    + `<w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
}

function imageParagraph(index, relId, size, sect) {
  const ratio = Math.min(COC_MAX_MM.w / size.mmW, COC_MAX_MM.h / size.mmH);
  const cx = Math.round(size.mmW * ratio * EMU_PER_MM);
  const cy = Math.round(size.mmH * ratio * EMU_PER_MM);
  const id = 50000 + index;
  return `<w:p xmlns:w="${W}" xmlns:r="${R}"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="center"/>${sect}</w:pPr>`
    + `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${id}" name="CoC ${index + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="coc${index + 1}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const EMPTY_PART = (tag) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<w:${tag} xmlns:w="${W}"><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p></w:${tag}>`);

/**
 * items: [{ images: [{ jpeg: Uint8Array, mmW, mmH }], values }] – CoC lapai (JPEG, dydis mm;
 * priekis, galas…) ir pažymos reikšmės. Be lapų – tik pažyma. Grąžina .docx baitus.
 */
export function buildPrintBundle(templateBytes, items, { duplex = false } = {}) {
  const files = unzipSync(new Uint8Array(templateBytes));
  const doc = parse(files["word/document.xml"]);
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  while (body.firstChild) body.removeChild(body.firstChild);

  const rels = parse(files["word/_rels/document.xml.rels"]);
  const relRoot = rels.documentElement;
  const addRel = (id, type, target) => {
    const rel = rels.createElementNS(PKG, "Relationship");
    rel.setAttribute("Id", id);
    rel.setAttribute("Type", type);
    rel.setAttribute("Target", target);
    relRoot.appendChild(rel);
  };
  const types = parse(files["[Content_Types].xml"]);
  const typeRoot = types.documentElement;
  const addDefault = (extension, contentType) => {
    if ([...typeRoot.children].some((node) => node.localName === "Default" && node.getAttribute("Extension").toLowerCase() === extension)) return;
    const node = types.createElementNS(CT, "Default");
    node.setAttribute("Extension", extension);
    node.setAttribute("ContentType", contentType);
    typeRoot.insertBefore(node, typeRoot.firstChild);
  };
  const addOverride = (part, contentType) => {
    const node = types.createElementNS(CT, "Override");
    node.setAttribute("PartName", part);
    node.setAttribute("ContentType", contentType);
    typeRoot.appendChild(node);
  };

  // Tuščia antraštė ir poraštė CoC lapams (kad nepaveldėtų pažymos poraščių).
  files["word/coc-header.xml"] = EMPTY_PART("hdr");
  files["word/coc-footer.xml"] = EMPTY_PART("ftr");
  addRel("rIdCocHeader", REL_HEADER, "coc-header.xml");
  addRel("rIdCocFooter", REL_FOOTER, "coc-footer.xml");
  addOverride("/word/coc-header.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");
  addOverride("/word/coc-footer.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml");
  addDefault("jpeg", "image/jpeg");
  const sect = cocSect("rIdCocHeader", "rIdCocFooter");
  // Dvipusiai: kiekvieno CoC priekis – naujo lapo priekyje (Word prireikus įdeda tuščią puslapį po pažymos).
  const firstSect = cocSect("rIdCocHeader", "rIdCocFooter", duplex);

  let imageCount = 0;
  items.forEach((item, index) => {
    // CoC lapai (priekis, galas…) – kiekvienas savame lape; be jų – tik pažyma.
    const images = item.images || (item.jpeg ? [item] : []);
    for (const [order, image] of images.entries()) {
      imageCount += 1;
      const relId = `rIdCoc${imageCount}`;
      files[`word/media/coc${imageCount}.jpeg`] = image.jpeg;
      addRel(relId, REL_IMAGE, `media/coc${imageCount}.jpeg`);
      const fragment = new DOMParser().parseFromString(imageParagraph(imageCount - 1, relId, image, order === 0 ? firstSect : sect), "application/xml");
      body.appendChild(doc.importNode(fragment.documentElement, true));
    }

    const filled = parse(unzipSync(fillTemplate(templateBytes, item.values).bytes)["word/document.xml"]);
    const { nodes, close } = pazymaContent(filled);
    const imported = nodes.map((node) => doc.importNode(node, true));
    imported.forEach((node) => body.appendChild(node));
    const last = index === items.length - 1;
    const pazymaPages = pageCount(nodes);
    const tail = imported[imported.length - 1];
    if (close) {
      const sectNode = doc.importNode(close, true);
      if (last) body.appendChild(sectNode);
      else if (tail && isW(tail, "p")) putSect(doc, tail, sectNode);
      else {
        const paragraph = doc.createElementNS(W, "w:p");
        body.appendChild(paragraph);
        putSect(doc, paragraph, sectNode);
      }
    } else if (last && tail && isW(tail, "p")) {
      // Paskutinio skirsnio nustatymai turi būti dokumento gale, ne pastraipoje.
      const own = paragraphSect(tail);
      if (own) { own.parentNode.removeChild(own); body.appendChild(own); }
    }
    // Dvipusiai: jei CoC lapų ir pažymos suma nelyginė – tuščias lapas, kad kitas CoC
    // prasidėtų naujo lapo priekyje.
    if (duplex && !last && images.length && (images.length + pazymaPages) % 2 === 1) {
      const blank = new DOMParser().parseFromString(`<w:p xmlns:w="${W}" xmlns:r="${R}"><w:pPr>${sect}</w:pPr></w:p>`, "application/xml");
      body.appendChild(doc.importNode(blank.documentElement, true));
    }
  });

  files["word/document.xml"] = serialise(doc);
  files["word/_rels/document.xml.rels"] = serialise(rels);
  files["[Content_Types].xml"] = serialise(types);
  return zipSync(files, { level: 6 });
}
