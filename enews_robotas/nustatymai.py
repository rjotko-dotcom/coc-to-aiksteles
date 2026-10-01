"""eNEWS roboto nustatymai. Keiskite tik reikšmes po lygybės ženklo."""

# --- Excel failas -----------------------------------------------------------

# Kelias iki Excel failo su mašinų sąrašu. Paleidžiant galima nurodyti ir kitą:
#   paleisti.bat "C:\kelias\failas.xlsx"
EXCEL_FAILAS = r"C:\Users\Rimvydas\Desktop\masinos.xlsx"

# Lapo pavadinimas (None – pirmas lapas).
EXCEL_LAPAS = None

# Stulpeliai (raidės kaip Excel'yje).
STULP_VIN = "B"
STULP_KODAS = ("E", "G", "I")  # Midtronics kodas: trys dalys tarp brūkšnelių
STULP_PDI_DATA = "K"           # MM.DD, pvz. 09.24
STULP_GARANTIJA = "L"          # tech. pradžia / Warranty Start Date, MM.DD
STULP_NUMERIS = "M"            # valstybinis numeris
STULP_BUSENA = "N"             # čia robotas rašo, kas padaryta arba kas nepavyko

# Spalvos, kuriomis robotas nuspalvina eilutę (RGB, kaip Excel'yje).
SPALVA_ATLIKTA = "92D050"      # žalia – viskas padaryta
SPALVA_AKUMAS = "FFC000"       # oranžinė – akumuliatorius ne „Good battery“
SPALVA_KLAIDA = "FF7C80"       # raudona – kita klaida, reikia pažiūrėti

# --- eNEWS ------------------------------------------------------------------

# Nuo čia robotas pradeda. Prisijungiate ir atsidarote eNEWS patys.
PORTALO_ADRESAS = "https://eu.nissan.biz/wps/myportal/b2bdealerportal"

# Rida, kuri įrašoma į „Rida pristatant“.
RIDA = "5"

# Kokiu formatu eNEWS rodo datas (22/09/2026 → %d/%m/%Y).
DATOS_FORMATAS = "%d/%m/%Y"

# Kiek sekundžių laukti, kol atsiras mygtukas ar laukelis.
LAUKTI_SEK = 20

# --- Spausdinimas -----------------------------------------------------------

# SumatraPDF (nemokama programa, https://www.sumatrapdfreader.org) spausdina
# PDF be jokių langų. Jei kelias neteisingas, failai tik išsaugomi aplanke
# „spausdinti“ ir juos atsispausdinate patys.
SUMATRA = r"C:\Program Files\SumatraPDF\SumatraPDF.exe"

# Spausdintuvų pavadinimai, kaip jie matosi Windows „Printers & scanners“.
# Paprasčiausia: tą patį spausdintuvą pridėti du kartus ir antrajam
# („... Lipnus“) numatytuosius nustatymus pakeisti į lipnų popierių.
# Tuščias tekstas "" – numatytasis Windows spausdintuvas.
SPAUSDINTUVAS_PAPRASTAS = ""
SPAUSDINTUVAS_LIPNUS = "Lipnus"

# Papildomi SumatraPDF nustatymai, pvz. "bin=2" (antras stalčius) arba
# "paper=A4". Tuščias – spausdintuvo numatytieji.
NUSTATYMAI_PAPRASTAS = ""
NUSTATYMAI_LIPNUS = ""

# True – prieš kiekvieną spausdinimą ant lipnaus popieriaus robotas sustoja ir
# paprašo įdėti lipnų popierių (jei jį dedate ranka).
KLAUSTI_PRIES_LIPNU = False
