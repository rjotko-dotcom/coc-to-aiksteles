"""eNEWS roboto nustatymai.

Čia – numatytosios reikšmės. Valdymo lange („Nustatymai“) pakeistos reikšmės
įrašomos į nustatymai.json ir naudojamos vietoj šių, todėl šio failo keisti
nereikia.
"""

import json
from pathlib import Path

JSON_FAILAS = Path(__file__).resolve().parent / "nustatymai.json"

NUMATYTIEJI = {
    # --- Excel ---
    "EXCEL_FAILAS": r"C:\Users\Rimvydas\Desktop\masinos.xlsx",
    "EXCEL_LAPAS": "",              # tuščias – pirmas lapas
    "STULP_VIN": "B",
    "STULP_KODAS": ["E", "G", "I"],  # Midtronics kodas: trys dalys
    "STULP_PDI_DATA": "K",          # MM.DD, pvz. 09.24
    "STULP_GARANTIJA": "L",         # tech. pradžia / Warranty Start Date
    "STULP_NUMERIS": "M",           # valstybinis numeris
    "STULP_BUSENA": "N",            # čia robotas rašo, kas padaryta ar kas nepavyko
    "SPALVA_ATLIKTA": "92D050",     # žalia
    "SPALVA_AKUMAS": "FFC000",      # oranžinė – akumuliatorius ne „Good battery“
    "SPALVA_KLAIDA": "FF7C80",      # raudona – kita klaida

    # --- eNEWS ---
    "PORTALO_ADRESAS": "https://eu.nissan.biz/wps/myportal/b2bdealerportal",
    "RIDA": "5",
    "DATOS_FORMATAS": "%d/%m/%Y",   # 22/09/2026
    "LAUKTI_SEK": 20,

    # --- Spausdinimas ---
    "SUMATRA": r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
    "SPAUSDINTUVAS_PAPRASTAS": "SHARP MX-3051 PCL6",  # tuščias – numatytasis Windows spausdintuvas
    "SPAUSDINTUVAS_LIPNUS": "SHARP MX-3051 PCL6",
    "LIPNUS_POPIERIUS": "Labels",   # Preferences → Paper Source → popieriaus tipas
    "PAPRASTAS_SPALVOTAI": True,
    # Kurį failą kaip spausdinti: 1 – garantijos sertifikatas, 2 – techninės priežiūros planas.
    "SPAUSDINIMO_PLANAS": "1:paprastas, 1:lipnus, 2:lipnus",
    "NUSTATYMAI_PAPRASTAS": "",     # SumatraPDF -print-settings, pvz. "bin=2"
    "NUSTATYMAI_LIPNUS": "",
    "KLAUSTI_PRIES_LIPNU": False,

    # --- eNEWS užrašai ir mygtukai. Kelios galimybės atskiriamos „ | “. ---
    "TEKSTAI": {
        "kebulo_numeris": "Kėbulo numeris",
        "reg_numeris": "REG. NUMERIS",
        "atidavimas": "Atidavimas klientui",
        "akumuliatorius": "Akumuliatorius",
        "perdavimas": "PERDAVIMAS KLIENTUI",
        "midtronics": "Midtronics",
        "test_code": "TEST Code",
        "validate": "Validate",
        "test_result": "Test Result",
        "good_battery": "Good battery",
        "ok": "OK",
        "automobilis": "Automobilis",
        "pdi": "PDI",
        "pdi_data": "Data:",
        "veiksmas": "VEIKIMAS | VEIKSMAS",
        "pdi_saugoti": "Išsaugoti ir uždaryti",
        "update": "Update",
        "warranty": "Warranty Start Date:",
        "registracija": "Vehicle Registration:",
        "rida": "Rida pristatant:",
        "confirm": "Confirm | Patvirtinti | Apstiprināt",
        "save": "Save | Išsaugoti | Saglabāt",
        "wbmr": "WBMR",
        "drukat": "Drukāt | Drukat | Print",
        "tp_planas": "Techninės priežiūros planas",
    },
}

TEKSTU_PAVADINIMAI = {
    "kebulo_numeris": "VIN paieškos laukelio užrašas",
    "reg_numeris": "Užrašas prieš paieškos rodyklę",
    "atidavimas": "Langelio, kurį uždaro X, pavadinimas",
    "akumuliatorius": "Akumuliatoriaus skirtukas",
    "perdavimas": "Testo etapas",
    "midtronics": "Testerio varnelė",
    "test_code": "Kodo laukelių užrašas",
    "validate": "Kodo tikrinimo mygtukas",
    "test_result": "Testo rezultato eilutės užrašas",
    "good_battery": "Gero akumuliatoriaus užrašas",
    "ok": "Patvirtinimo mygtukas po testo",
    "automobilis": "Automobilio skirtukas",
    "pdi": "PDI mygtukas",
    "pdi_data": "PDI formos datos užrašas",
    "veiksmas": "Stulpelis su „visi“ varnele",
    "pdi_saugoti": "PDI išsaugojimo mygtukas",
    "update": "Redagavimo mygtukas",
    "warranty": "Garantijos pradžios užrašas",
    "registracija": "Valst. numerio užrašas",
    "rida": "Ridos užrašas",
    "confirm": "Patvirtinimo mygtukas",
    "save": "Išsaugojimo mygtukas",
    "wbmr": "WBMR skirtukas",
    "drukat": "Spausdinimo mygtukas",
    "tp_planas": "Techninės priežiūros plano skirtukas",
}


def _ikelti() -> dict:
    reiksmes = json.loads(json.dumps(NUMATYTIEJI))  # gili kopija
    if JSON_FAILAS.exists():
        try:
            savi = json.loads(JSON_FAILAS.read_text(encoding="utf-8"))
        except ValueError:
            savi = {}
        for k, v in savi.items():
            if k == "TEKSTAI" and isinstance(v, dict):
                reiksmes["TEKSTAI"].update(v)
            elif k in reiksmes:
                reiksmes[k] = v
    return reiksmes


def perkrauti() -> None:
    globals().update(_ikelti())


def issaugoti(naujos: dict) -> None:
    """Įrašo tik tas reikšmes, kurios skiriasi nuo numatytųjų."""
    skirtumai = {}
    for k, v in naujos.items():
        if k == "TEKSTAI":
            t = {kk: vv for kk, vv in v.items() if NUMATYTIEJI["TEKSTAI"].get(kk) != vv}
            if t:
                skirtumai[k] = t
        elif NUMATYTIEJI.get(k) != v:
            skirtumai[k] = v
    JSON_FAILAS.write_text(json.dumps(skirtumai, ensure_ascii=False, indent=2), encoding="utf-8")
    perkrauti()


def dabartines() -> dict:
    return {k: globals()[k] for k in NUMATYTIEJI}


def tekstai(raktas: str) -> list[str]:
    return [t.strip() for t in globals()["TEKSTAI"][raktas].split("|") if t.strip()]


perkrauti()
