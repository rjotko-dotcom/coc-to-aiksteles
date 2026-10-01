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

Paleidimas:  python robotas.py [failas.xlsx] [--vienas] [--zingsniais]
             python robotas.py --diagnostika
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import logging
import subprocess
import sys
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


ZINGSNIAIS = False


def zingsnis(tekstas: str) -> None:
    log.info("  → %s", tekstas)
    if ZINGSNIAIS:
        input(f"     [Enter – daryti: {tekstas}] ")


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
        time.sleep(0.3)


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
        time.sleep(0.3)


def mygtuko_selektoriai(*tekstai: str) -> list[str]:
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


def spausti(page: Page, *tekstai: str, laukti: float | None = None, dalis: str | None = None) -> None:
    """Paspaudžia mygtuką/skirtuką pagal tikslų tekstą; „dalis“ – atsarginė teksto dalis
    be lietuviškų raidžių (jei puslapio koduotė jas sugadintų)."""
    sel = mygtuko_selektoriai(*tekstai)
    if dalis:
        sel += [f"input[value*='{dalis}']", f"a:has-text('{dalis}')", f"span:has-text('{dalis}')",
                f"button:has-text('{dalis}')", f"td:has-text('{dalis}') >> nth=-1"]
    rasti(page, sel, " / ".join(tekstai), laukti).click()
    laukti_ramybes(page)


TEKSTO_LAUKAS = "input[(@type='text' or not(@type)) and not(@disabled)]"


def po(elementas: str, tikslas: str, pirmas: bool = True) -> str:
    """XPath: „tikslas“ elemento viduje arba po jo (pirmas pagal dokumento tvarką)."""
    x = f"({elementas}/descendant::{tikslas} | {elementas}/following::{tikslas})"
    return "xpath=" + (x + "[1]" if pirmas else x)


def su_tekstu(tekstas: str, kelintas: str = "1") -> str:
    """Teksto mazgas, kuriame yra „tekstas“ (ne visas elementas – taip „po juo“
    reiškia tikrai po šiuo užrašu, net jei keli užrašai viename langelyje)."""
    return f"(//text()[contains(normalize-space(.),'{tekstas}')])[{kelintas}]"


def lauka_po(etikete: str, kelintas: str = "last()") -> str:
    """Įvedimo laukas, einantis po teksto „etikete“ (pvz. „Rida pristatant:“)."""
    return po(su_tekstu(etikete, kelintas), TEKSTO_LAUKAS)


def irasyti(laukas: Locator, tekstas: str, kas: str) -> None:
    try:
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


def irasyti_data(page: Page, etikete: str, data: dt.date, kas: str) -> None:
    irasyti(rasti(page, [lauka_po(etikete)], kas), data.strftime(N.DATOS_FORMATAS), kas)


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

def ieskoti_vin(page: Page, pradzia: str, vin: str) -> None:
    zingsnis(f"VIN paieška {vin}")
    page.goto(pradzia)
    laukti_ramybes(page)
    laukas = rasti(page, [lauka_po("bulo numeris", "1")], "Kėbulo numeris laukas")
    irasyti(laukas, vin, "Kėbulo numeris")
    try:
        rasti(page, [po(su_tekstu("REG. NUMERIS"),
                        "*[self::input[@type='image' or @type='submit' or @type='button']"
                        " or self::button or self::a or self::img]")],
              "paieškos rodyklė", laukti=3).click()
    except Klaida:
        laukas.press("Enter")
    laukti_ramybes(page)

    zingsnis("uždaryti „Atidavimas klientui“ langelį")
    try:
        rasti(page, [
            ".ui-dialog-titlebar-close",
            "xpath=//*[contains(text(),'Atidavimas klientui')]/ancestor::*[3]"
            "//*[contains(@class,'close') or contains(@id,'close') or contains(@id,'Close')]",
            "[title='Close']", "[title='close']", "[title='Uždaryti']", "text='×'",
        ], "X mygtukas", laukti=8).click()
        laukti_ramybes(page)
    except Klaida:
        log.info("     („Atidavimas klientui“ langelio nebuvo)")
    rasti(page, mygtuko_selektoriai("Akumuliatorius"), "Akumuliatorius skirtukas")


def akumuliatorius(page: Page, m: Masina) -> None:
    zingsnis("Akumuliatorius skirtukas")
    spausti(page, "Akumuliatorius")
    if m.kodas_tekstu in puslapio_tekstas(page):
        log.info("     kodas %s jau įvestas anksčiau – praleidžiama", m.kodas_tekstu)
        return

    zingsnis("Perdavimas klientui")
    rasti(page, [po(su_tekstu("PERDAVIMAS KLIENTUI", "last()"), "input[@type='radio']")],
          "Perdavimas klientui pasirinkimas").check()
    laukti_ramybes(page)

    zingsnis("Midtronics")
    rasti(page, [
        "xpath=//label[normalize-space()='Midtronics']//input[@type='checkbox']",
        "xpath=(//label[normalize-space()='Midtronics'])[1]/preceding::input[@type='checkbox'][1]",
        "xpath=(//text()[normalize-space(.)='Midtronics'])[1]/preceding::input[@type='checkbox'][1]",
    ], "Midtronics varnelė").check()
    laukti_ramybes(page)

    zingsnis(f"kodas {m.kodas_tekstu} → Validate")
    laukai = rasti_visus(
        page,
        po(su_tekstu("TEST Code"), TEKSTO_LAUKAS, pirmas=False),
        3, "3 TEST Code laukai")
    for laukas, dalis in zip(laukai, m.kodas):
        irasyti(laukas, dalis, "TEST Code")
    spausti(page, "Validate")

    pabaiga = time.time() + N.LAUKTI_SEK
    while time.time() < pabaiga:
        tekstas = puslapio_tekstas(page)
        if "Good battery" in tekstas:
            zingsnis("Good battery → OK")
            spausti(page, "OK")
            return
        if "Test Result" in tekstas:
            break
        time.sleep(0.5)
    tekstas = puslapio_tekstas(page)
    rezultatas = ""
    for eil in tekstas.splitlines():
        if eil.strip() and any(z in eil for z in ("Result", "Error", "rror", "used", "invalid", "Invalid")):
            rezultatas = eil.strip()
            break
    raise BlogasAkumas(rezultatas or "ne „Good battery“")


def pdi(page: Page, m: Masina) -> None:
    zingsnis("Automobilis skirtukas")
    spausti(page, "Automobilis")

    zingsnis("PDI mygtukas")
    langu_pries = len(page.context.pages)
    spausti(page, "PDI")
    forma = page
    for _ in range(10):
        if len(page.context.pages) > langu_pries:
            forma = page.context.pages[-1]
            laukti_ramybes(forma)
            break
        if "VEIKSMAS" in puslapio_tekstas(page):
            break
        time.sleep(0.5)

    zingsnis(f"PDI data {m.pdi_data:%Y-%m-%d}")
    irasyti(rasti(forma, [po("(//text()[normalize-space(.)='Data:'])[1]", "input[(@type='text' or not(@type))]")],
                  "PDI Data laukas"), m.pdi_data.strftime(N.DATOS_FORMATAS), "PDI data")

    zingsnis("varnelė prie VEIKSMAS (visi punktai)")
    rasti(forma, [
        "xpath=" + su_tekstu("VEIKSMAS") + "/preceding::input[@type='checkbox'][1]",
    ], "VEIKSMAS varnelė").check()

    zingsnis("Išsaugoti ir uždaryti")
    spausti(forma, "Išsaugoti ir uždaryti", dalis="saugoti ir u")
    if forma is not page and not forma.is_closed():
        try:
            forma.wait_for_event("close", timeout=N.LAUKTI_SEK * 1000)
        except PWTimeout:
            raise Klaida("PDI langas neužsidarė – gal neišsaugota?")
    laukti_ramybes(page)


def garantija(page: Page, m: Masina) -> None:
    if not _rodo_update(page):
        spausti(page, "Automobilis")
    zingsnis("Update")
    spausti(page, "Update")

    zingsnis(f"Warranty Start Date {m.garantija:%Y-%m-%d}, {m.numeris}, rida {N.RIDA}")
    irasyti_data(page, "Warranty Start Date:", m.garantija, "Warranty Start Date")
    irasyti(rasti(page, [lauka_po("Vehicle Registration:")], "Vehicle Registration"),
            m.numeris, "Vehicle Registration")
    irasyti(rasti(page, [lauka_po("Rida pristatant:")], "Rida pristatant"),
            N.RIDA, "Rida pristatant")

    zingsnis("Confirm")
    spausti(page, "Confirm", "Patvirtinti", "Apstiprināt", "Apstiprinat", dalis="Confirm")
    zingsnis("Save")
    try:
        spausti(page, "Save", "Išsaugoti", "Saglabāt", "Saglabat", laukti=8)
    except Klaida:
        log.info("     (atskiro Save mygtuko nebuvo)")

    if m.numeris not in puslapio_tekstas(page):
        raise Klaida("po išsaugojimo nesimato valst. numerio – patikrinkite Automobilis skirtuką")


def _rodo_update(page: Page) -> bool:
    try:
        rasti(page, mygtuko_selektoriai("Update"), "Update", laukti=1)
        return True
    except Klaida:
        return False


# --- Failai ir spausdinimas ---------------------------------------------------

def _issaugoti_is_lango(langas: Page, kelias: Path) -> None:
    """Išsaugo lange atidarytą PDF (Chrome PDF peržiūra arba blob: adresas)."""
    try:
        langas.wait_for_load_state(timeout=N.LAUKTI_SEK * 1000)
    except PWTimeout:
        pass
    url = langas.url
    if url.startswith("blob:"):
        b64 = langas.evaluate("""async u => { const b = await (await fetch(u)).arrayBuffer();
            let s = ''; const a = new Uint8Array(b);
            for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
            return btoa(s); }""", url)
        kelias.write_bytes(base64.b64decode(b64))
        return
    atsakas = langas.context.request.get(url)
    if "pdf" not in atsakas.headers.get("content-type", "") and not atsakas.body().startswith(b"%PDF"):
        raise Klaida(f"Drukāt atidarė ne PDF ({url[:80]}) – atspausdinkite ranka")
    kelias.write_bytes(atsakas.body())


def gauti_faila(page: Page, kelias: Path) -> Path:
    """Paspaudžia „Drukāt“ ir išsaugo atsiradusį PDF: atsisiuntimą, naują langą
    arba tame pačiame skirtuke atidarytą failą."""
    ivykiai: dict = {}
    ctx = page.context
    def atsiuntimas(d): ivykiai.setdefault("dl", d)
    def langas(p):
        ivykiai.setdefault("pg", p)
        p.on("download", atsiuntimas)
    page.on("download", atsiuntimas)
    ctx.on("page", langas)
    url_pries = page.url
    pradzia = time.time()
    try:
        spausti(page, "Drukāt", "Drukat", "Spausdinti", "Print", dalis="Druk")
        while time.time() < pradzia + 60 and "dl" not in ivykiai:
            if time.time() > pradzia + 10 and ("pg" in ivykiai or page.url != url_pries):
                break  # langas atsidarė ir nieko nesiuntė – skaitome jį patį
            time.sleep(0.3)
    finally:
        page.remove_listener("download", atsiuntimas)
        ctx.remove_listener("page", langas)

    if "dl" in ivykiai:
        ivykiai["dl"].save_as(str(kelias))
        if "pg" in ivykiai and not ivykiai["pg"].is_closed():
            ivykiai["pg"].close()
    elif "pg" in ivykiai:
        _issaugoti_is_lango(ivykiai["pg"], kelias)
        ivykiai["pg"].close()
    elif page.url != url_pries:
        _issaugoti_is_lango(page, kelias)
        page.go_back()
        laukti_ramybes(page)
    else:
        raise Klaida("paspaudus Drukāt failas neatsirado")
    log.info("     išsaugota %s", kelias.name)
    return kelias


def spausdinti(failas: Path, lipnus: bool) -> None:
    spausdintuvas = N.SPAUSDINTUVAS_LIPNUS if lipnus else N.SPAUSDINTUVAS_PAPRASTAS
    nust = N.NUSTATYMAI_LIPNUS if lipnus else N.NUSTATYMAI_PAPRASTAS
    rusis = "lipnus" if lipnus else "paprastas"
    if not Path(N.SUMATRA).exists():
        log.warning("     SumatraPDF nerastas – %s (%s) atsispausdinkite patys", failas.name, rusis)
        return
    if lipnus and N.KLAUSTI_PRIES_LIPNU:
        input("     Įdėkite LIPNŲ popierių ir spauskite Enter… ")
    komanda = [N.SUMATRA]
    komanda += ["-print-to", spausdintuvas] if spausdintuvas else ["-print-to-default"]
    if nust:
        komanda += ["-print-settings", nust]
    komanda += ["-silent", str(failas)]
    zingsnis(f"spausdinti {failas.name} ({rusis})")
    subprocess.run(komanda, check=True, timeout=180)


def wbmr(page: Page, m: Masina) -> None:
    SPAUSDINTI.mkdir(exist_ok=True)
    zingsnis("WBMR skirtukas")
    spausti(page, "WBMR")
    zingsnis("Drukāt (garantijos sertifikatas)")
    pirmas = gauti_faila(page, SPAUSDINTI / f"{m.numeris}-{m.vin}-1-sertifikatas.pdf")

    zingsnis("Techninės priežiūros planas")
    spausti(page, "Techninės priežiūros planas", dalis="ros planas")
    zingsnis("Drukāt (techninės priežiūros planas)")
    antras = gauti_faila(page, SPAUSDINTI / f"{m.numeris}-{m.vin}-2-tp-planas.pdf")

    spausdinti(pirmas, lipnus=False)
    spausdinti(pirmas, lipnus=True)
    spausdinti(antras, lipnus=True)


# --- Pagrindinis ciklas --------------------------------------------------------

def paruosti_profili() -> None:
    """Kad Chrome PDF ne atidarytų, o atsisiųstų – tada jį lengva atspausdinti."""
    nust = PROFILIS / "Default" / "Preferences"
    nust.parent.mkdir(parents=True, exist_ok=True)
    try:
        duom = json.loads(nust.read_text(encoding="utf-8")) if nust.exists() else {}
    except ValueError:
        duom = {}
    duom.setdefault("plugins", {})["always_open_pdf_externally"] = True
    duom.setdefault("download", {})["prompt_for_download"] = False
    nust.write_text(json.dumps(duom), encoding="utf-8")


def atidaryti_enews(ctx) -> tuple[Page, str]:
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    if not page.url.startswith("http"):
        page.goto(N.PORTALO_ADRESAS)
    input("\nPrisijunkite prie Nissan B2B, atsidarykite ENEWS ir spauskite čia Enter… ")
    enews = [p for p in ctx.pages if "enews" in p.url.lower()]
    if not enews:
        sys.exit("Neradau atidaryto eNEWS skirtuko. Atsidarykite eNEWS ir paleiskite iš naujo.")
    page = enews[-1]
    page.bring_to_front()
    page.on("dialog", lambda d: (log.info("     pranešimas: %s", d.message), d.accept()))
    ctx.on("page", lambda p: p.on("dialog", lambda d: (log.info("     pranešimas: %s", d.message), d.accept())))
    return page, page.url


def apdoroti(page: Page, pradzia: str, m: Masina) -> None:
    ieskoti_vin(page, pradzia, m.vin)
    akumuliatorius(page, m)
    pdi(page, m)
    garantija(page, m)
    wbmr(page, m)


def diagnostika(ctx) -> None:
    """Išsaugo atidaryto puslapio HTML – jį atsiuntus galima pataisyti robotą."""
    DIAGNOSTIKA.mkdir(exist_ok=True)
    nr = 0
    while True:
        ats = input("\nAtsidarykite reikiamą eNEWS vietą ir spauskite Enter (q – baigti): ")
        if ats.strip().lower() == "q":
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
            print(f"  išsaugota {nr:02d} ({p.url[:80]})")
    print(f"\nSuarchyvuokite aplanką {DIAGNOSTIKA} ir atsiųskite.")


def main() -> None:
    global ZINGSNIAIS
    ap = argparse.ArgumentParser(description="eNEWS robotas")
    ap.add_argument("excel", nargs="?", default=N.EXCEL_FAILAS)
    ap.add_argument("--vienas", action="store_true", help="apdoroti tik vieną mašiną")
    ap.add_argument("--zingsniais", action="store_true", help="sustoti prieš kiekvieną veiksmą")
    ap.add_argument("--diagnostika", action="store_true", help="tik išsaugoti puslapių HTML")
    args = ap.parse_args()
    ZINGSNIAIS = args.zingsniais

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(), logging.FileHandler(ARCH / "robotas.log", encoding="utf-8")],
    )

    sarasas = None
    if not args.diagnostika:
        if not Path(args.excel).exists():
            sys.exit(f"Nerastas Excel failas: {args.excel}\nPataisykite EXCEL_FAILAS nustatymai.py faile.")
        if uzrakintas(args.excel):
            sys.exit("Excel failas atidarytas – uždarykite jį ir paleiskite iš naujo.")
        sarasas = Sarasas(args.excel, N)
        masinos = sarasas.neapdorotos()
        if not masinos:
            sys.exit("Nėra nenuspalvintų eilučių – nėra ką daryti.")
        log.info("Atsarginė kopija: %s", sarasas.atsargine_kopija().name)
        log.info("Rasta mašinų: %d", len(masinos))
        for m in masinos:
            log.info("  %d eil.: %s %s kodas %s PDI %s tech. %s%s", m.eilute, m.vin, m.numeris,
                     m.kodas_tekstu, m.pdi_data, m.garantija,
                     ("  ← " + ", ".join(m.klaidos)) if m.klaidos else "")

    paruosti_profili()
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            str(PROFILIS), channel="chrome", headless=False, accept_downloads=True,
            no_viewport=True, args=["--start-maximized"],
        )
        try:
            if args.diagnostika:
                ctx.pages[0].goto(N.PORTALO_ADRESAS)
                diagnostika(ctx)
                return
            page, pradzia = atidaryti_enews(ctx)
            atlikta = atideta = 0
            for m in masinos:
                log.info("=== %d eil. %s (%s) ===", m.eilute, m.vin, m.numeris)
                if m.klaidos:
                    sarasas.pazymeti(m.eilute, N.SPALVA_KLAIDA, "Excel: " + ", ".join(m.klaidos))
                    atideta += 1
                else:
                    try:
                        apdoroti(page, pradzia, m)
                        sarasas.pazymeti(m.eilute, N.SPALVA_ATLIKTA, f"Atlikta {dt.datetime.now():%Y-%m-%d %H:%M}")
                        atlikta += 1
                        log.info("  ✔ atlikta")
                    except BlogasAkumas as e:
                        sarasas.pazymeti(m.eilute, N.SPALVA_AKUMAS, f"Akumuliatorius: {e}")
                        nuotrauka(page, m.vin)
                        atideta += 1
                        log.warning("  ✖ akumuliatorius: %s", e)
                    except Exception as e:  # noqa: BLE001 – viena mašina neturi sustabdyti visų
                        kelias = nuotrauka(page, m.vin)
                        sarasas.pazymeti(m.eilute, N.SPALVA_KLAIDA, f"Klaida: {e}".splitlines()[0][:250])
                        atideta += 1
                        log.error("  ✖ klaida: %s (nuotrauka %s)", e, kelias.name)
                try:
                    sarasas.issaugoti()
                except PermissionError:
                    log.error("  Excel failas atidarytas – būsena bus įrašyta vėliau, uždarykite jį")
                if args.vienas:
                    break
            log.info("Baigta. Atlikta: %d, atidėta: %d. Žr. Excel stulpelį %s.", atlikta, atideta, N.STULP_BUSENA)
            input("Spauskite Enter, kad uždarytumėte naršyklę… ")
        finally:
            ctx.close()


if __name__ == "__main__":
    main()
