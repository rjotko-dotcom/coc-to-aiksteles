# eNEWS robotas

Iš Excel sąrašo pats atlieka eNEWS (Nissan B2B) darbą kiekvienai naujai mašinai:

1. įveda VIN ir uždaro „Atidavimas klientui“ langelį (X);
2. **Akumuliatorius** → *Perdavimas klientui* → *Midtronics* → 3 kodo dalys → **Validate**;
   jei ne „Good battery“ (blogas akumuliatorius, panaudotas kodas ar kita klaida),
   eilutė nuspalvinama **oranžine**, o robotas eina prie kitos mašinos;
3. **Automobilis** → **PDI** → data → varnelė prie „VEIKSMAS“ → **Išsaugoti ir uždaryti**;
4. **Update** → Warranty Start Date, valstybinis numeris, rida 5 → **Confirm** → **Save**;
5. **WBMR** → **Drukāt** (sertifikatas: ant paprasto ir ant lipnaus popieriaus) →
   **Techninės priežiūros planas** → **Drukāt** (tik ant lipnaus);
6. eilutė nuspalvinama **žaliai**, o stulpelyje N įrašoma „Atlikta“ ir laikas.

Jau nuspalvintų eilučių (žalių, oranžinių) robotas neliečia.

## Excel

Robotas naudoja jūsų dabartinį failą tokį, koks jis yra:

| Stulpelis | Kas | Pvz. |
|---|---|---|
| B | VIN | SJNJ12TD0U2373741 |
| E, G, I | Midtronics kodo trys dalys | JRH36, 1Q9D77, TE204 |
| K | PDI data (mėnuo.diena) | 09.22 |
| L | Tech. pradžia / Warranty Start Date | 09.24 |
| M | Valstybinis numeris | OAU289 |
| N | **robotas įrašo būseną** | Atlikta 2026-10-01 15:47 |

Metai imami einamieji. Jei stulpeliai kada nors pasikeis, juos galite pakeisti
`nustatymai.py` faile.

## Pirmas paleidimas (vieną kartą)

1. Python jau turėtų būti įdiegtas (jo reikia ir CoC programai). Jei ne:
   https://www.python.org/downloads/, diegiant pažymėkite **„Add python.exe to PATH“**.
2. Įdiekite **SumatraPDF** (https://www.sumatrapdfreader.org). Su ja robotas
   spausdina be jokių langų. Be jos PDF failai tik išsaugomi aplanke `spausdinti`.
3. **Lipnus popierius.** Windows'e tą patį spausdintuvą pridėkite dar kartą ir
   pavadinkite **„Lipnus“** (*Settings → Printers & scanners → Add device*).
   Tada *Lipnus → Printing preferences* nustatykite lipnų popierių ir stalčių,
   lygiai taip, kaip dabar darote ranka. Robotas spausdins į jį.
4. Paleiskite `paleisti.bat`, viršuje **Pasirinkti…** savo Excel failą, skirtuke
   **Nustatymai** pasirinkite spausdintuvus ir spauskite **Patikrinti**.

## Valdymo langas

Dukart spustelėjus **`paleisti.bat`** atsidaro valdymo langas (juodo lango nėra).

**Mašinos** – lentelė iš Excel:

* **balta** – paruošta, robotas darys;
* **geltona (!)** – darys, bet verta pažiūrėti (pvz. numeris ne ABC123 formos,
  PDI data vėlesnė už tech. pradžią, data senesnė nei 90 d.);
* **raudona (✖)** – robotas jos **nedarys**, kol nepataisysite: trūksta kodo dalies,
  neaiški data, VIN su klaida, tas pats Midtronics kodas / VIN / numeris dviejose
  eilutėse (ir su jau padaryta);
* žalia / oranžinė – jau padaryta / blogas akumuliatorius (rodoma pažymėjus
  „Rodyti ir jau padarytas“).

**Dukart spustelėjus eilutę** galima pataisyti kodą, datas, numerį ar VIN. Lange
iškart matosi, kas bus įvesta į eNEWS (pvz. „PDI 22/09/2026“), o pataisymas
įrašomas į Excel. Dešinys pelės mygtukas → **„Daryti iš naujo“** nuima spalvą
(pvz. pakeitus akumuliatorių ir įrašius naują kodą).

Mygtukai:

| Mygtukas | Ką daro |
|---|---|
| ✔ Tikrinti | patikrina duomenis **ir kompiuterį**: ar Excel uždarytas, ar yra Chrome, SumatraPDF, ar spausdintuvai su tokiais pavadinimais tikrai yra |
| ▶ Pradėti | paleidžia robotą (pirma dar kartą patikrina) |
| Tęsti ⏎ | kai robotas laukia jūsų (prisijungimas, „Žingsniais“ režimas, lipnus popierius) |
| ■ Stabdyti | sustabdo; nebaigta mašina lieka nenuspalvinta ir bus daroma kitą kartą |
| Diagnostika | išsaugo eNEWS puslapius, jei robotas kur nors neranda mygtuko |

Apačioje **„Ką daro robotas“** – kiekvienas veiksmas realiu laiku, o lentelėje
mėlynai pažymėta mašina, kurią daro dabar.

**Nustatymai** – Excel stulpeliai, rida, datos formatas, SumatraPDF, spausdintuvai
(išsirenkami iš sąrašo). **eNEWS užrašai** – mygtukų ir laukelių pavadinimai, pagal
kuriuos robotas juos randa; jei Nissan ką nors pervadins, pakeisite čia, kodo liesti
nereikia. Viskas išsaugoma `nustatymai.json`.

## Kasdien

1. Excel'yje suveskite mašinas, **išsaugokite ir uždarykite**.
2. `paleisti.bat` → **Perskaityti** → pataisykite raudonas eilutes → **▶ Pradėti**.
3. Atsidariusiame Chrome prisijunkite prie Nissan B2B (pirmą kartą; vėliau
   prisijungimą atsimins), atsidarykite **ENEWS** ir lange spauskite **Tęsti**.
4. Toliau robotas dirba pats. Klaidų nuotraukos – aplanke `klaidos`.

### Pirmą kartą – po vieną

Robotas parašytas pagal nuotraukas, tikrame eNEWS kai kas gali vadintis kitaip.
Pirmą kartą pažymėkite **„Žingsniais“** ir **„Tik pažymėtos eilutės“**, lentelėje
pažymėkite vieną mašiną ir spauskite **Pradėti**: prieš kiekvieną veiksmą robotas
parašys, ką darys, ir lauks **Tęsti**.

Jei kur nors užstringa – **Diagnostika**: Chrome'e eikite per eNEWS langus (VIN
paieška, Akumuliatorius, PDI, Automobilis po „Update“, WBMR), kiekviename spauskite
**Tęsti**, baigę – **Stabdyti**. Aplanką `diagnostika` suarchyvuokite ir atsiųskite.

### Apsaugos nuo klaidų

* prieš darbą – Excel atsarginė kopija (`failas.atsargine-…xlsx`);
* eilutės su klaidomis ar pasikartojančiu kodu / VIN / numeriu nedaromos;
* eNEWS tikrinama, ar atidaryta būtent ta mašina (VIN), ir ar testo rezultatas
  – tos pačios mašinos;
* po išsaugojimo tikrinama, ar eNEWS rodo įvestą numerį ir garantijos datą;
* jau įvestas akumuliatoriaus kodas antrą kartą nevedamas (galima saugiai kartoti);
* išsaugotas failas tikrinamas, ar tai tikrai PDF, prieš jį spausdinant.

### Be lango

`paleisti.bat --vienas --zingsniais` arba `paleisti.bat --diagnostika` – tas pats
komandinėje eilutėje.

## Failai

| Failas / aplankas | Kas tai |
|---|---|
| `paleisti.bat` | paleidimas (pirmą kartą pats įdiegia ko reikia) |
| `langas.py` | valdymo langas |
| `tikrinimas.py` | duomenų ir kompiuterio patikra |
| `nustatymai.py` | numatytieji nustatymai (pakeisti – `nustatymai.json`) |
| `robotas.py` | eNEWS žingsniai |
| `excel_eiles.py` | Excel skaitymas ir spalvinimas |
| `chrome_profilis/` | roboto Chrome profilis (prisijungimas), į git nededamas |
| `spausdinti/` | išsaugoti PDF |
| `klaidos/` | ekrano nuotraukos, kai nepavyko |
| `robotas.log` | visas darbo žurnalas |
