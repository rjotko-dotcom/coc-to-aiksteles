"""eNEWS robotas: akumuliatoriaus testas, PDI, garantijos pradžia ir spausdinimas.

Kiekvienai nenuspalvintai Excel eilutei:
  1. eNEWS įveda VIN ir uždaro „Atidavimas klientui“ langelį;
  2. Akumuliatorius → Perdavimas klientui → Midtronics → 3 kodo dalys → Validate;
     jei ne „Good battery“ – eilutė nuspalvinama oranžine ir einama prie kitos;
  3. Automobilis → PDI → data → pažymimi visi veiksmai → Išsaugoti ir uždaryti;
  4. Update → Warranty Start Date, valst. numeris, rida 5 → Confirm → Save;
  5. WBMR → Drukāt (paprastai + lipniai) → Techninės priežiūros planas →
     Drukāt (lipniai);
  6. eilutė nuspalvinama žaliai.

Įprastai paleidžiamas per valdymo langą (langas.py). Be lango:
    python robotas.py [failas.xlsx] [--vienas] [--zingsniais]
    python robotas.py --diagnostika
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import logging
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import Locator, Page, TimeoutError as PWTimeout, sync_playwright

import nustatymai as N
from excel_eiles import Masina, Sarasas, uzrakintas

ARCH = Path(__file__).resolve().parent
PROFILIS = ARCH / "chrome_profilis"
SPAUSDINTI = ARCH / "spausdinti"
KLAIDOS = ARCH / "klaidos"
DIAGNOSTIKA = ARCH / "diagnostika"

log = logging.getLogger("robotas")


class Klaida(Exception):
    """Mašinos nepavyko apdoroti – eilutė pažymima raudonai."""


class BlogasAkumas(Exception):
    """Akumuliatoriaus testas ne „Good battery“ – eilutė pažymima oranžine."""


class Sustabdyta(Exception):
    """Naudotojas paspaudė „Stabdyti“."""


class Valdymas:
    """Ryšys su žmogumi: komandinėje eilutėje – input(), lange – mygtukas „Tęsti“."""

    def __init__(self, zingsniais: bool = False):
        self.zingsniais = zingsniais
        self.stabdyti = threading.Event()

    def klausti(self, tekstas: str) -> None:
        # input() laukiame atskiroje gijoje, o čia tuo metu aptarnaujame Chrome
        # (kitaip nauji skirtukai, pvz. ENEWS, lieka „Loading…“).
        ivesta = threading.Event()
        threading.Thread(target=lambda: (input(f"     {tekstas} [Enter] "), ivesta.set()), daemon=True).start()
        while not ivesta.is_set():
            snausti(0.2)

    def busena(self, m: Masina, tekstas: str) -> None:
        """Pranešimas, kad eilutės būsena pasikeitė (langas atnaujina lentelę)."""

    def zingsnis(self, tekstas: str) -> None:
        log.info("  → %s", tekstas)
        if self.stabdyti.is_set():
            raise Sustabdyta()
        if self.zingsniais:
            self.klausti(f"Toliau: {tekstas}")


KONTEKSTAS = None  # atidaryta naršyklė (kol robotas dirba)


def snausti(sek: float) -> None:
    """Palaukti, bet tuo metu aptarnauti Chrome. Playwright įvykius (naujus
    skirtukus, atsisiuntimus, pranešimus) apdoroja tik kol kviečiamas jis pats –
    paprastas time.sleep() palieka, pvz., naujai atidarytą ENEWS skirtuką
    amžinai „Loading… about:blank“."""
    if KONTEKSTAS is not None:
        for p in list(KONTEKSTAS.pages):
            try:
                if not p.is_closed():
                    p.wait_for_timeout(sek * 1000)
                    return
            except Exception:
                pass
    time.sleep(sek)


V = Valdymas()
BANDYMAS = False  # True – netikras eNEWS, niekas nespausdinama
PERZIURA = False  # True – tikras eNEWS, bet niekas neišsaugoma (žr. svarbus_mygtukas)


def svarbus_mygtukas(page: Page, raktas: str, laukti: float | None = None) -> bool:
    """Mygtukas, kuris eNEWS ką nors ĮRAŠO (Validate, Išsaugoti, Confirm, Save, Drukāt).
    Peržiūros režime jis tik surandamas ir parodomas (raudonu rėmeliu), bet
    nespaudžiamas. Grąžina True, jei paspausta."""
    if not PERZIURA:
        spausti(page, raktas, laukti)
        return True
    mygtukas = rasti(page, mygtuko_selektoriai(T(raktas)), " / ".join(T(raktas)), laukti)
    try:
        mygtukas.scroll_into_view_if_needed(timeout=3000)
        mygtukas.evaluate("el => { el.style.outline = '4px solid red'; el.style.outlineOffset = '2px'; }")
    except Exception:
        pass
    log.info("     (peržiūra) rastas „%s“ – NESPAUSTA", T1(raktas))
    snausti(1.5)
    return False


def zingsnis(tekstas: str) -> None:
    V.zingsnis(tekstas)


# --- eNEWS užrašai (keičiami valdymo lange „Nustatymai → eNEWS užrašai“) ------

def ascii_dalis(tekstas: str) -> str:
    """Ilgiausia teksto dalis be lietuviškų raidžių – jei puslapio koduotė jas
    sugadintų, ieškoma pagal ją („Išsaugoti ir uždaryti“ → „saugoti ir u“)."""
    dalys = [d for d in re.split(r"[^\x20-\x7e]", tekstas) if d.strip()]
    return max(dalys, key=len).strip() if dalys else tekstas


def T(raktas: str) -> list[str]:
    return N.tekstai(raktas)


def T1(raktas: str) -> str:
    return T(raktas)[0]


# --- Paieška puslapyje (eNEWS turi kadrų, todėl ieškome visuose) -------------

def rasti(page: Page, selektoriai: list[str], kas: str, laukti: float | None = None) -> Locator:
    pabaiga = time.time() + (N.LAUKTI_SEK if laukti is None else laukti)
    while True:
        for kadras in page.frames:
            for sel in selektoriai:
                try:
                    loc = kadras.locator(sel)
                    for i in range(loc.count()):
                        el = loc.nth(i)
                        if el.is_visible():
                            return el
                except Exception:
                    pass
        if time.time() > pabaiga:
            raise Klaida(f"nerasta: {kas}")
        snausti(0.3)


def rasti_visus(page: Page, selektorius: str, kiek: int, kas: str) -> list[Locator]:
    pabaiga = time.time() + N.LAUKTI_SEK
    while True:
        for kadras in page.frames:
            try:
                loc = kadras.locator(selektorius)
                matomi = [loc.nth(i) for i in range(loc.count()) if loc.nth(i).is_visible()]
                if len(matomi) >= kiek:
                    return matomi[:kiek]
            except Exception:
                pass
        if time.time() > pabaiga:
            raise Klaida(f"nerasta: {kas}")
        snausti(0.3)


def mygtuko_selektoriai(tekstai: list[str]) -> list[str]:
    sel = []
    for t in tekstai:
        sel += [
            f"input[type=submit][value='{t}']",
            f"input[type=button][value='{t}']",
            f"button:text-is('{t}')",
            f"a:text-is('{t}')",
            f"span:text-is('{t}')",
            f"td:text-is('{t}')",
            f"text='{t}'",
        ]
    for t in tekstai:
        d = ascii_dalis(t)
        if d != t and len(d) >= 3:
            sel += [f"input[value*='{d}']", f"a:has-text('{d}')", f"span:has-text('{d}')",
                    f"button:has-text('{d}')", f"td:has-text('{d}') >> nth=-1"]
    return sel


def laukti_ramybes(page: Page) -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=N.LAUKTI_SEK * 1000)
        page.wait_for_timeout(500)
    except PWTimeout:
        pass
    except Exception:
        if not page.is_closed():  # langas (pvz. PDI) gali užsidaryti pats – tai normalu
            raise


def spausti(page: Page, raktas: str, laukti: float | None = None) -> None:
    mygtukas = rasti(page, mygtuko_selektoriai(T(raktas)), " / ".join(T(raktas)), laukti)
    try:
        mygtukas.click()
    except Exception:
        if page.is_closed():  # mygtukas uždarė savo langą (pvz. PDI „Išsaugoti ir uždaryti“)
            return
        raise
    laukti_ramybes(page)


# Ir išjungti laukai: po „Update“ jie įsijungia ne iš karto – irasyti() palaukia.
TEKSTO_LAUKAS = "input[(@type='text' or not(@type))]"


def po(elementas: str, tikslas: str, pirmas: bool = True) -> str:
    """XPath: „tikslas“ elemento viduje arba po jo (pirmas pagal dokumento tvarką)."""
    x = f"({elementas}/descendant::{tikslas} | {elementas}/following::{tikslas})"
    return "xpath=" + (x + "[1]" if pirmas else x)


def su_tekstu(raktas: str, kelintas: str = "1", tiksliai: bool = False) -> str:
    """Teksto mazgas su užrašu (ne visas elementas – taip „po juo“ reiškia tikrai
    po šiuo užrašu, net jei keli užrašai viename langelyje)."""
    matomas = "not(ancestor::script) and not(ancestor::style) and not(ancestor::title)"
    # Visos galimybės iš nustatymų („VEIKIMAS | VEIKSMAS“) – tinka bet kuri.
    if tiksliai:
        salyga = " or ".join(f"normalize-space(.)='{t}'" for t in T(raktas))
    else:
        salyga = " or ".join(f"contains(normalize-space(.),'{ascii_dalis(t)}')" for t in T(raktas))
    return f"(//text()[{matomas} and ({salyga})])[{kelintas}]"


def lauka_po(raktas: str, kelintas: str = "last()") -> str:
    """Įvedimo laukas, einantis po užrašo (pvz. „Rida pristatant:“)."""
    return po(su_tekstu(raktas, kelintas), TEKSTO_LAUKAS)


def irasyti(laukas: Locator, tekstas: str, kas: str) -> None:
    pabaiga = time.time() + N.LAUKTI_SEK
    while not laukas.is_enabled():
        if time.time() > pabaiga:
            raise Klaida(f"laukas {kas} neaktyvus")
        snausti(0.3)
    try:
        if laukas.get_attribute("readonly") is not None:
            raise ValueError("tik skaitomas")
        laukas.fill(tekstas, timeout=3000)
    except Exception:
        # Datos laukai su kalendoriumi kartais „tik skaitomi“ – įrašome tiesiogiai.
        laukas.evaluate(
            """(el, v) => { el.removeAttribute('readonly'); el.value = v;
                 el.dispatchEvent(new Event('input', {bubbles: true}));
                 el.dispatchEvent(new Event('change', {bubbles: true})); }""",
            tekstas,
        )
    if laukas.input_value().strip() != tekstas:
        raise Klaida(f"nepavyko įrašyti „{tekstas}“ į {kas}")


def puslapio_tekstas(page: Page) -> str:
    dalys = []
    for kadras in page.frames:
        try:
            dalys.append(kadras.locator("body").inner_text(timeout=2000))
        except Exception:
            pass
    return "\n".join(dalys)


def nuotrauka(page: Page, vin: str) -> Path:
    KLAIDOS.mkdir(exist_ok=True)
    kelias = KLAIDOS / f"{vin}-{dt.datetime.now():%Y%m%d-%H%M%S}.png"
    try:
        page.screenshot(path=str(kelias), full_page=True)
    except Exception:
        pass
    return kelias


# --- Žingsniai ---------------------------------------------------------------

RODYKLE_DESINIAU_JS = """reg => {
    const r = reg.getBoundingClientRect(), cy = r.top + r.height / 2;
    let geriausias = null, atstumas = 1e9;
    for (const el of document.querySelectorAll('a,button,img,input,svg,span,div,i,[onclick]')) {
        if (el === reg || el.contains(reg)) continue;
        if (el.tagName === 'INPUT' && !['image', 'submit', 'button'].includes(el.type)) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 8 || b.width > 90 || b.height > 90) continue;
        if (Math.abs(b.top + b.height / 2 - cy) > 25) continue;   // toje pačioje eilutėje
        const dx = b.left - r.right;
        if (dx < -2 || dx > 160) continue;                        // iškart dešiniau
        // iš kelių vienas kitame esančių – imame išorinį (pvz. <a>, o ne jo <img>)
        if (dx < atstumas - 1 || (Math.abs(dx - atstumas) <= 1 && geriausias && el.contains(geriausias))) {
            geriausias = el; atstumas = dx;
        }
    }
    return geriausias;
}"""


def ieskoti_vin(page: Page, pradzia: str, vin: str) -> None:
    zingsnis(f"VIN paieška {vin}")
    page.goto(pradzia)
    laukti_ramybes(page)
    laukas = rasti(page, [lauka_po("kebulo_numeris", "1")], "VIN paieškos laukas")
    irasyti(laukas, vin, "VIN paieška")
    # Paieškos rodyklė ▶ – tai, kas ekrane yra tiesiai dešiniau REG. NUMERIS laukelio
    # (eNEWS ji nėra paprastas mygtukas, o „pirmas mygtukas po užrašu“ būtų
    # „Skaityti visus pranešimus“ žemiau).
    reg = rasti(page, [lauka_po("reg_numeris", "1")], "REG. NUMERIS laukas")
    rodykle = reg.evaluate_handle(RODYKLE_DESINIAU_JS).as_element()
    if rodykle is not None:
        rodykle.click()
    else:
        log.info("     (rodyklės nerasta – spaudžiamas Enter)")
        laukas.press("Enter")
    laukti_ramybes(page)

    zingsnis(f"uždaryti „{T1('atidavimas')}“ langelį")
    try:
        rasti(page, [
            ".ui-dialog-titlebar-close",
            f"xpath={su_tekstu('atidavimas')}/ancestor::*[3]"
            "//*[contains(@class,'close') or contains(@id,'close') or contains(@id,'Close')]",
            "[title='Close']", "[title='close']", "[title='Uždaryti']", "text='×'",
        ], "X mygtukas", laukti=8).click()
        laukti_ramybes(page)
    except Klaida:
        log.info("     (langelio nebuvo)")
    rasti(page, mygtuko_selektoriai(T("akumuliatorius")), "Akumuliatorius skirtukas")
    # Apsauga: ar tikrai atidaryta ta mašina, o ne ankstesnė / kita.
    if vin not in puslapio_tekstas(page):
        raise Klaida(f"eNEWS neatidarė mašinos {vin} – patikrinkite VIN")


def akumuliatorius(page: Page, m: Masina) -> None:
    zingsnis("Akumuliatorius skirtukas")
    spausti(page, "akumuliatorius")
    if m.kodas_tekstu in puslapio_tekstas(page):
        log.info("     kodas %s jau įvestas anksčiau – praleidžiama", m.kodas_tekstu)
        return

    zingsnis("Perdavimas klientui")
    rasti(page, [po(su_tekstu("perdavimas", "last()"), "input[@type='radio']")],
          "Perdavimas klientui pasirinkimas").check()
    laukti_ramybes(page)

    zingsnis("Midtronics")
    mid = T1("midtronics")
    rasti(page, [
        f"xpath=//label[normalize-space()='{mid}']//input[@type='checkbox']",
        f"xpath=(//label[normalize-space()='{mid}'])[1]/preceding::input[@type='checkbox'][1]",
        f"xpath={su_tekstu('midtronics', tiksliai=True)}/preceding::input[@type='checkbox'][1]",
    ], "Midtronics varnelė").check()
    laukti_ramybes(page)

    zingsnis(f"kodas {m.kodas_tekstu} → Validate")
    laukai = rasti_visus(page, po(su_tekstu("test_code"), TEKSTO_LAUKAS, pirmas=False),
                         3, "3 kodo laukeliai")
    for laukas, dalis in zip(laukai, m.kodas):
        irasyti(laukas, dalis, "kodo laukelis")
    if not svarbus_mygtukas(page, "validate"):
        return

    # Laukiame rezultato puslapio („Test Result: …“) ir tik tada vertiname, kad
    # nesupainiotume su ankstesnių testų lentele.
    geras, antraste = T1("good_battery"), T1("test_result")
    pabaiga = time.time() + N.LAUKTI_SEK
    tekstas = ""
    while time.time() < pabaiga:
        tekstas = puslapio_tekstas(page)
        if antraste in tekstas:
            break
        snausti(0.5)
    rezultatas = next((e.strip() for e in tekstas.splitlines() if antraste in e), "")
    if geras in rezultatas:
        if m.vin not in tekstas:
            raise Klaida("testo rezultate ne ta mašina")
        zingsnis(f"{geras} → OK")
        spausti(page, "ok")
        return
    if not rezultatas:
        rezultatas = next((e.strip() for e in tekstas.splitlines()
                           if any(z in e for z in ("rror", "used", "nvalid"))), "")
    raise BlogasAkumas(rezultatas or f"ne „{geras}“")


def pdi(page: Page, m: Masina) -> None:
    zingsnis("Automobilis skirtukas")
    spausti(page, "automobilis")

    zingsnis("PDI mygtukas")
    langu_pries = len(page.context.pages)
    spausti(page, "pdi")
    forma = page
    for _ in range(10):
        if len(page.context.pages) > langu_pries:
            forma = page.context.pages[-1]
            laukti_ramybes(forma)
            break
        if any(t in puslapio_tekstas(page) for t in T("veiksmas")):
            break
        snausti(0.5)

    zingsnis(f"PDI data {m.pdi_data:%Y-%m-%d}")
    irasyti(rasti(forma, [po(su_tekstu("pdi_data", tiksliai=True), "input[(@type='text' or not(@type))]")],
                  "PDI datos laukas"),
            m.pdi_data.strftime(N.DATOS_FORMATAS), "PDI data")

    zingsnis("varnelė prie VEIKSMAS (visi punktai)")
    rasti(forma, [f"xpath={su_tekstu('veiksmas')}/preceding::input[@type='checkbox'][1]"],
          "VEIKSMAS varnelė").check()

    zingsnis(T1("pdi_saugoti"))
    if not svarbus_mygtukas(forma, "pdi_saugoti"):
        if forma is not page:
            forma.close()
        else:  # forma tame pačiame skirtuke – grįžtame atidarę mašiną iš naujo (neišsaugota)
            ieskoti_vin(page, PRADZIA, m.vin)
        return
    if forma is not page and not forma.is_closed():
        try:
            forma.wait_for_event("close", timeout=N.LAUKTI_SEK * 1000)
        except PWTimeout:
            raise Klaida("PDI langas neužsidarė – gal neišsaugota?")
    laukti_ramybes(page)


def garantija(page: Page, m: Masina) -> None:
    try:
        rasti(page, mygtuko_selektoriai(T("update")), "Update", laukti=1)
    except Klaida:
        spausti(page, "automobilis")
    zingsnis("Update")
    spausti(page, "update")

    data = m.garantija.strftime(N.DATOS_FORMATAS)
    zingsnis(f"Warranty Start Date {data}, {m.numeris}, rida {N.RIDA}")
    irasyti(rasti(page, [lauka_po("warranty")], "Warranty Start Date"), data, "Warranty Start Date")
    irasyti(rasti(page, [lauka_po("registracija")], "Vehicle Registration"), m.numeris, "Vehicle Registration")
    irasyti(rasti(page, [lauka_po("rida")], "Rida pristatant"), str(N.RIDA), "Rida pristatant")

    zingsnis("Confirm")
    if not svarbus_mygtukas(page, "confirm"):
        try:
            svarbus_mygtukas(page, "save", laukti=3)
        except Klaida:
            log.info("     (atskiro Save mygtuko nesimato – gal atsiranda po Confirm)")
        return
    zingsnis("Save")
    try:
        spausti(page, "save", laukti=8)
    except Klaida:
        log.info("     (atskiro Save mygtuko nebuvo)")

    # Apsauga: ar eNEWS tikrai išsaugojo (palaukiame – serveris atsako ne iš karto).
    pabaiga = time.time() + N.LAUKTI_SEK
    while True:
        tekstas = puslapio_tekstas(page)
        if m.numeris in tekstas and data in tekstas:
            break
        if time.time() > pabaiga:
            if m.numeris not in tekstas:
                raise Klaida("po išsaugojimo nesimato valst. numerio – patikrinkite Automobilis skirtuką")
            raise Klaida(f"po išsaugojimo nesimato garantijos datos {data}")
        snausti(0.5)


# --- Failai ir spausdinimas ---------------------------------------------------

def _pdf_is_lango(langas: Page) -> bytes | None:
    """PDF turinys, jei lange atidarytas PDF (Chrome peržiūra, blob: ar tiesioginė
    nuoroda); kitaip None."""
    url = langas.url
    if not url or url.startswith(("about:", "chrome")):
        return None
    try:
        if url.startswith("blob:"):
            b64 = langas.evaluate("""async u => { const b = await (await fetch(u)).arrayBuffer();
                let s = ''; const a = new Uint8Array(b);
                for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
                return btoa(s); }""", url)
            turinys = base64.b64decode(b64)
        else:
            turinys = langas.context.request.get(url).body()
    except Exception:
        return None
    return turinys if turinys[:5].startswith(b"%PDF") else None


def gauti_faila(page: Page, kelias: Path) -> Path:
    """Paspaudžia „Drukāt“ ir išsaugo atsiradusį PDF: atsisiuntimą, naujame lange
    ar tame pačiame skirtuke atidarytą PDF. Laukia iki 60 s – kol tikrai bus PDF."""
    atsiuntimai: list = []
    langai: list[Page] = []
    pagauta: list[bytes] = []
    ctx = page.context
    def atsiuntimas(d): atsiuntimai.append(d)
    def langas(p):
        langai.append(p)
        p.on("download", atsiuntimas)

    def marsrutas(route):
        """PDF pagaunamas iš eNEWS atsakymo dar prieš Chrome: Chrome gauna „204 – nieko“,
        todėl nei siunčia, nei atidaro failo (eNEWS puslapis lieka vietoje). Taip
        apeinamas Chrome atsisiuntimas/peržiūra, kuri kai kur uždaro naršyklę."""
        if route.request.resource_type != "document":
            route.fallback()
            return
        try:
            ats = route.fetch(max_redirects=0)
        except Exception:
            route.fallback()
            return
        if ats.status in (401, 407):  # Windows/proxy prisijungimas – tegul daro pats Chrome
            route.continue_()
            return
        try:
            turinys_ = ats.body()
        except Exception:
            turinys_ = b""
        if "pdf" in ats.headers.get("content-type", "").lower() or turinys_[:5].startswith(b"%PDF"):
            pagauta.append(turinys_)
            route.fulfill(status=204, body="")
        else:
            route.fulfill(response=ats)

    page.on("download", atsiuntimas)
    ctx.on("page", langas)
    ctx.route("**/*", marsrutas)
    url_pries = page.url
    pradzia = time.time()
    turinys: bytes | None = None
    patikrinta: set[str] = set()
    try:
        spausti(page, "drukat")
        while time.time() < pradzia + 60:
            if pagauta and pagauta[0][:5].startswith(b"%PDF"):
                turinys = pagauta[0]
                break
            if atsiuntimai:
                break
            if time.time() > pradzia + 3:  # atsisiuntimui duodame pirmenybę
                for p in [*langai, page]:
                    if p.is_closed() or (p is page and p.url == url_pries) or p.url in patikrinta:
                        continue
                    patikrinta.add(p.url)
                    turinys = _pdf_is_lango(p)
                    if turinys:
                        break
                if turinys:
                    break
            snausti(0.3)
    finally:
        try:
            ctx.unroute("**/*", marsrutas)
        except Exception:
            pass
        page.remove_listener("download", atsiuntimas)
        ctx.remove_listener("page", langas)

    if turinys is not None and pagauta and turinys is pagauta[0]:
        kelias.write_bytes(turinys)
        log.info("     PDF pagautas iš eNEWS atsakymo")
    elif atsiuntimai:
        atsiuntimai[0].save_as(str(kelias))
        log.info("     failas atsisiųstas (%s)", atsiuntimai[0].suggested_filename)
    elif turinys:
        kelias.write_bytes(turinys)
        log.info("     failas paimtas iš atsidariusio lango")
    else:
        atsidare = ", ".join(p.url[:90] for p in langai if not p.is_closed()) or "nieko"
        if page.url != url_pries:
            atsidare += f"; eNEWS puslapis pasikeitė į {page.url[:90]}"
        raise Klaida(f"paspaudus Drukāt per 60 s PDF neatsirado. Atsidarė: {atsidare}")

    # PDF langus uždarome, eNEWS skirtukas lieka.
    for p in langai:
        if not p.is_closed():
            try:
                p.close()
            except Exception:
                pass
    if page.url != url_pries and not page.is_closed():
        page.go_back()
        laukti_ramybes(page)
    page.bring_to_front()
    if not kelias.read_bytes()[:5].startswith(b"%PDF"):
        raise Klaida(f"{kelias.name} nėra PDF")
    log.info("     išsaugota %s", kelias.name)
    return kelias


def spausdinti(failas: Path, rusis: str) -> None:
    """rusis: „paprastas“ (spalvotai) arba „lipnus“ (Labels, vienpusis) – žr. spausdinimas.py."""
    lipnus = rusis == "lipnus"
    spausdintuvas = N.SPAUSDINTUVAS_LIPNUS if lipnus else N.SPAUSDINTUVAS_PAPRASTAS
    if BANDYMAS:
        zingsnis(f"(bandymas) būtų spausdinama {failas.name} ({rusis}, "
                 f"{spausdintuvas or 'numatytasis'}) – failas aplanke spausdinti")
        return
    zingsnis(f"spausdinti {failas.name} ({rusis})")
    if lipnus and N.KLAUSTI_PRIES_LIPNU:
        V.klausti("Įdėkite LIPNŲ popierių")
    import spausdinimas
    try:
        spausdinimas.spausdinti(failas, rusis)
    except Exception as e:  # noqa: BLE001
        raise Klaida(f"nepavyko atspausdinti {failas.name} ({rusis}): {e}") from e


def wbmr(page: Page, m: Masina) -> None:
    SPAUSDINTI.mkdir(exist_ok=True)
    zingsnis("WBMR skirtukas")
    spausti(page, "wbmr")
    zingsnis("Drukāt (garantijos sertifikatas)")
    if PERZIURA:
        svarbus_mygtukas(page, "drukat")
        zingsnis(T1("tp_planas"))
        spausti(page, "tp_planas")
        svarbus_mygtukas(page, "drukat")
        return
    pirmas = gauti_faila(page, SPAUSDINTI / f"{m.numeris}-{m.vin}-1-sertifikatas.pdf")

    zingsnis(T1("tp_planas"))
    pries = puslapio_tekstas(page)
    try:
        spausti(page, "tp_planas", laukti=8)
    except Klaida:  # po pirmo failo puslapis galėjo persikrauti – grįžtame į WBMR
        log.info("     grįžtama į WBMR")
        spausti(page, "wbmr")
        spausti(page, "tp_planas")
    # Laukiame, kol skirtukas tikrai persijungs – kitaip Drukāt duotų vėl sertifikatą.
    pabaiga = time.time() + N.LAUKTI_SEK
    while puslapio_tekstas(page) == pries and time.time() < pabaiga:
        snausti(0.3)
    zingsnis("Drukāt (techninės priežiūros planas)")
    antras = gauti_faila(page, SPAUSDINTI / f"{m.numeris}-{m.vin}-2-tp-planas.pdf")
    if antras.read_bytes() == pirmas.read_bytes():
        raise Klaida("antras failas toks pat kaip pirmas – paspaustas ne to skirtuko Drukāt")

    import spausdinimas
    failai = {1: pirmas, 2: antras}
    for nr, rusis in spausdinimas.planas():
        if nr in failai:
            spausdinti(failai[nr], rusis)


PRADZIA = ""  # eNEWS pradžios puslapis (VIN paieška)


def apdoroti(page: Page, pradzia: str, m: Masina) -> None:
    global PRADZIA
    PRADZIA = pradzia
    ieskoti_vin(page, pradzia, m.vin)
    akumuliatorius(page, m)
    pdi(page, m)
    garantija(page, m)
    wbmr(page, m)


# --- Naršyklė ----------------------------------------------------------------

def paruosti_profili() -> None:
    """Kad Chrome PDF ne atidarytų, o atsisiųstų – tada jį lengva atspausdinti."""
    nust = PROFILIS / "Default" / "Preferences"
    nust.parent.mkdir(parents=True, exist_ok=True)
    try:
        duom = json.loads(nust.read_text(encoding="utf-8")) if nust.exists() else {}
    except ValueError:
        duom = {}
    # PDF pagaunamas pačio roboto (žr. gauti_faila), Chrome atsisiuntimo nereikia.
    duom.setdefault("plugins", {})["always_open_pdf_externally"] = False
    duom.setdefault("download", {})["prompt_for_download"] = False
    nust.write_text(json.dumps(duom), encoding="utf-8")


def atidaryti_narsykle(pw):
    global KONTEKSTAS
    paruosti_profili()
    KONTEKSTAS = pw.chromium.launch_persistent_context(
        str(PROFILIS), channel="chrome", headless=False, accept_downloads=True,
        no_viewport=True, args=["--start-maximized"],
    )
    return KONTEKSTAS


def uzdaryti_narsykle(ctx) -> None:
    """Uždaro Chrome; jei jis jau uždarytas (pvz. ranka) – tai ne klaida ir
    neturi uždengti tikrosios priežasties, kodėl robotas sustojo."""
    global KONTEKSTAS
    KONTEKSTAS = None
    try:
        ctx.close()
    except Exception:
        pass


def atidaryti_enews(ctx, adresas: str | None = None) -> tuple[Page, str]:
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    if adresas:  # bandymas – iškart netikras eNEWS
        page.goto(adresas)
    elif not page.url.startswith("http"):
        page.goto(N.PORTALO_ADRESAS)
    while True:
        V.klausti("BANDYMAS: atsidarė netikras eNEWS – spauskite „Tęsti“" if adresas else
                  "Prisijunkite prie Nissan B2B, atsidarykite ENEWS ir spauskite „Tęsti“")
        enews = [p for p in ctx.pages if "enews" in p.url.lower()]
        if enews:
            break
        log.warning("Neradau atidaryto eNEWS skirtuko – atsidarykite jį.")
    page = enews[-1]
    page.bring_to_front()

    def dialogas(d):
        log.info("     eNEWS pranešimas: %s", d.message)
        d.accept()
    page.on("dialog", dialogas)
    ctx.on("page", lambda p: p.on("dialog", dialogas))
    return page, page.url


def vykdyti(sarasas: Sarasas, masinos: list[Masina], vienas: bool = False,
            bandymas: bool = False, perziura: bool = False) -> tuple[int, int]:
    """Pagrindinis ciklas. Grąžina (atlikta, atidėta).
    bandymas=True – netikras eNEWS šiame kompiuteryje, niekas nespausdinama."""
    global BANDYMAS, PERZIURA
    BANDYMAS, PERZIURA = bandymas, perziura and not bandymas
    if PERZIURA:
        log.info("PERŽIŪRA: tikras eNEWS, bet nieko neišsaugoma, nespausdinama ir Excel nežymimas.")
        sarasas.pazymeti = lambda *a, **k: None  # Excel'yje nieko nekeičiame
        sarasas.issaugoti = lambda *a, **k: None
    serveris = adresas = None
    if bandymas:
        import netikras_enews
        serveris, adresas = netikras_enews.paleisti()
        log.info("BANDYMAS: netikras eNEWS %s, Excel kopija %s", adresas, sarasas.kelias.name)
    elif not PERZIURA:
        log.info("Atsarginė kopija: %s", sarasas.atsargine_kopija().name)
    atlikta = atideta = 0
    with sync_playwright() as pw:
        ctx = atidaryti_narsykle(pw)
        try:
            page, pradzia = atidaryti_enews(ctx, adresas)
            for m in masinos:
                if V.stabdyti.is_set():
                    log.info("Sustabdyta.")
                    break
                log.info("=== %d eil. %s (%s) ===", m.eilute, m.vin, m.numeris)
                V.busena(m, "dirbama…")
                try:
                    apdoroti(page, pradzia, m)
                    tekstas = ("Peržiūra: visi laukai ir mygtukai rasti" if PERZIURA
                               else f"Atlikta {dt.datetime.now():%Y-%m-%d %H:%M}")
                    sarasas.pazymeti(m.eilute, N.SPALVA_ATLIKTA, tekstas)
                    atlikta += 1
                    log.info("  ✔ atlikta")
                except Sustabdyta:
                    tekstas = "sustabdyta (nebaigta)"
                    log.info("Sustabdyta – ši mašina nebaigta, bus daroma kitą kartą.")
                except BlogasAkumas as e:
                    tekstas = f"Akumuliatorius: {e}"
                    sarasas.pazymeti(m.eilute, N.SPALVA_AKUMAS, tekstas)
                    nuotrauka(page, m.vin)
                    atideta += 1
                    log.warning("  ✖ akumuliatorius: %s", e)
                except Exception as e:  # noqa: BLE001 – viena mašina neturi sustabdyti visų
                    if page.is_closed():
                        log.error("Chrome langas uždarytas – robotas sustoja (%d eil. nebaigta).", m.eilute)
                        break
                    kelias = nuotrauka(page, m.vin)
                    tekstas = f"Klaida: {e}".splitlines()[0][:250]
                    sarasas.pazymeti(m.eilute, N.SPALVA_KLAIDA, tekstas)
                    atideta += 1
                    log.error("  ✖ %s (nuotrauka klaidos/%s)", tekstas, kelias.name)
                V.busena(m, tekstas)
                try:
                    sarasas.issaugoti()
                except PermissionError:
                    log.error("  Excel failas atidarytas – uždarykite jį, būsena įrašoma po kitos mašinos")
                if vienas or V.stabdyti.is_set():
                    break
            log.info("Baigta. Atlikta: %d, atidėta: %d.", atlikta, atideta)
            V.klausti("Baigta – naršyklė bus uždaryta")
        finally:
            uzdaryti_narsykle(ctx)
            if serveris:
                serveris.shutdown()
    return atlikta, atideta


def diagnostika() -> None:
    """Išsaugo atidarytų eNEWS puslapių HTML ir nuotraukas – jas atsiuntus
    galima tiksliai pataisyti robotą."""
    DIAGNOSTIKA.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        ctx = atidaryti_narsykle(pw)
        try:
            ctx.pages[0].goto(N.PORTALO_ADRESAS)
            nr = 0
            while not V.stabdyti.is_set():
                V.klausti("Atsidarykite eNEWS vietą, kurią išsaugoti, ir spauskite „Tęsti“ "
                          "(baigti – „Stabdyti“)")
                if V.stabdyti.is_set():
                    break
                for p in ctx.pages:
                    if "enews" not in p.url.lower():
                        continue
                    nr += 1
                    p.screenshot(path=str(DIAGNOSTIKA / f"{nr:02d}.png"), full_page=True)
                    for k, kadras in enumerate(p.frames):
                        try:
                            (DIAGNOSTIKA / f"{nr:02d}-kadras{k}.html").write_text(kadras.content(), encoding="utf-8")
                        except Exception:
                            pass
                    log.info("išsaugota %02d (%s)", nr, p.url[:80])
        finally:
            uzdaryti_narsykle(ctx)
    log.info("Suarchyvuokite aplanką %s ir atsiųskite.", DIAGNOSTIKA)


def nustatyti_zurnala(*papildomi: logging.Handler) -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S",
        handlers=[logging.FileHandler(ARCH / "robotas.log", encoding="utf-8"), *papildomi],
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="eNEWS robotas (be lango)")
    ap.add_argument("excel", nargs="?", default=N.EXCEL_FAILAS)
    ap.add_argument("--vienas", action="store_true", help="apdoroti tik vieną mašiną")
    ap.add_argument("--zingsniais", action="store_true", help="sustoti prieš kiekvieną veiksmą")
    ap.add_argument("--diagnostika", action="store_true", help="tik išsaugoti puslapių HTML")
    ap.add_argument("--perziura", action="store_true",
                    help="tikras eNEWS, bet niekas neišsaugoma (patikrinti, ar robotas viską randa)")
    ap.add_argument("--bandymas", action="store_true",
                    help="be B2B: netikras eNEWS, Excel kopija, niekas nespausdinama")
    args = ap.parse_args()
    V.zingsniais = args.zingsniais
    nustatyti_zurnala(logging.StreamHandler())

    if args.diagnostika:
        diagnostika()
        return
    from tikrinimas import KLAIDA, blokuojamos_eilutes, duomenys
    if args.bandymas:
        import netikras_enews
        args.excel = str(netikras_enews.paruosti_excel(args.excel))
    if not Path(args.excel).exists():
        sys.exit(f"Nerastas Excel failas: {args.excel}")
    if uzrakintas(args.excel):
        sys.exit("Excel failas atidarytas – uždarykite jį ir paleiskite iš naujo.")
    sarasas = Sarasas(args.excel, N)
    visos = sarasas.visos()
    pastabos = duomenys(visos)
    for p in pastabos:
        log.info("%s %d eil.: %s", "✖" if p.lygis == KLAIDA else "!", p.eilute, p.tekstas)
    blok = blokuojamos_eilutes(pastabos)
    masinos = [m for m in visos if not m.nuspalvinta and m.eilute not in blok]
    if not masinos:
        sys.exit("Nėra ką daryti (visos eilutės nuspalvintos arba su klaidomis).")
    log.info("Bus daroma mašinų: %d", len(masinos))
    vykdyti(sarasas, masinos, vienas=args.vienas, bandymas=args.bandymas, perziura=args.perziura)


if __name__ == "__main__":
    main()
