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
4. `nustatymai.py` faile pakeiskite `EXCEL_FAILAS` į savo Excel failo kelią.

## Kasdien

1. **Uždarykite Excel failą**, nes atidaryto robotas negali pakeisti.
2. Dukart spustelėkite **`paleisti.bat`**.
3. Atsidaro Chrome langas. Prisijunkite prie Nissan B2B (pirmą kartą, vėliau
   prisijungimą jis atsimins) ir atsidarykite **ENEWS**.
4. Juodame lange paspauskite **Enter**. Robotas pradeda dirbti, o jūs galite stebėti.
5. Pabaigoje atsidarykite Excel: žalios eilutės padarytos, oranžinės turi blogą
   akumuliatorių, raudonos turi kitą klaidą (priežastis parašyta stulpelyje N).
   Klaidų ekrano nuotraukos yra aplanke `klaidos`.

Prieš pradedant robotas pasidaro Excel atsarginę kopiją (`failas.atsargine-…xlsx`).

### Pirmą kartą: bandykite po vieną

Robotas parašytas pagal nuotraukas, o tikrame eNEWS kai kurie mygtukai gali
vadintis kiek kitaip. Todėl pirmą kartą paleiskite komandinėje eilutėje (atidarykite
aplanką, adreso juostoje įrašykite `cmd` ir spauskite Enter):

```
paleisti.bat --vienas --zingsniais
```

`--zingsniais`: prieš kiekvieną veiksmą robotas parašo, ką darys, ir laukia
Enter. Taip matysite, kur jis užstrigo.
`--vienas`: apdoroja tik vieną mašiną.

### Jei kur nors užstringa: diagnostika

```
paleisti.bat --diagnostika
```

Atsidariusiame Chrome prisijunkite ir eikite per tuos eNEWS langus, kur robotas
stringa (VIN paieška, Akumuliatorius, PDI, Automobilis po „Update“, WBMR).
Kiekviename lange juodame lange spauskite **Enter**, pabaigoje įveskite `q`.
Aplanką `diagnostika` suarchyvuokite ir atsiųskite, nes iš jo matosi tikri mygtukų
pavadinimai ir robotą galima tiksliai pataisyti.

## Failai

| Failas / aplankas | Kas tai |
|---|---|
| `paleisti.bat` | paleidimas (pirmą kartą pats įdiegia ko reikia) |
| `nustatymai.py` | Excel kelias, stulpeliai, spausdintuvai, rida |
| `robotas.py` | eNEWS žingsniai |
| `excel_eiles.py` | Excel skaitymas ir spalvinimas |
| `chrome_profilis/` | roboto Chrome profilis (prisijungimas), į git nededamas |
| `spausdinti/` | išsaugoti PDF |
| `klaidos/` | ekrano nuotraukos, kai nepavyko |
| `robotas.log` | visas darbo žurnalas |
