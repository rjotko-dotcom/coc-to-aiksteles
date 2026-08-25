# CoC → aikštelė

Įrankis, kuris iš atitikties liudijimo (**CoC – EC Certificate of Conformity**) PDF
failo išrenka transporto priemonės duomenis ir sudeda juos į **pažymą apie
transporto priemonės tapatumo duomenis** (M, N ir O kategorijų transporto
priemonei) – Word `.docx` dokumentą.

Veikia su skirtingų gamintojų liudijimais: Nissan (vieno stulpelio, skenuotas),
Hyundai (dviejų pusių, trijų stulpelių forma), Citroën / Stellantis (prancūziška
forma) ir kitais. Skirsnių numeriai (0.1, 0.2, 0.10, 40) yra vienodi visose
kalbose, todėl jais remiamasi pirmiausia, o pavadinimai atpažįstami angliškai,
prancūziškai, vokiškai, itališkai ir ispaniškai.

Galima naudoti dviem būdais:

* **naršyklėje** – įkeliate vieną ar kelis CoC PDF, peržiūrite/pataisote laukus,
  spaudžiate „Generuoti“ ir gaunate parsisiųsti `.docx` (kelioms – ZIP);
* **komandinėje eilutėje** – patogu, kai reikia apdoroti visą aplanką iš karto.

## Kokie laukai perkeliami

| Pažymos eilutė | CoC skirsnis | RL skiltis |
| --- | --- | --- |
| Gamybinė markė (gamintojo prekės pavadinimas) | 0.1 Make | D.1 |
| Tipas/Variantas/Versija | 0.2 Type / Variant / Version | D.2 |
| Komercinis pavadinimas | 0.2.1 Commercial name | D.3 |
| Transporto priemonės identifikavimo numeris (VIN) | 0.10 | E |
| Tipo patvirtinimo Nr. | „…in approval **e9\*2018/858\*11042\*16**…“ | K |
| Tipo patvirtinimo numerio suteikimo data | „…granted on **03/03/2026**“ | – |
| Nacionalinis patvirtinimo numeris | CoC nėra – pildoma ranka | K1 |
| Transporto priemonės spalva | 40 Colour of the vehicle | R |

Papildomai parodoma (į pažymą nerašoma, bet padeda pasitikrinti): kategorija
(0.4), pagaminimo data (0.11), gamintojas (0.5) ir originalus spalvos užrašas.

Liudijimai iš B2B portalo yra skenuoti, todėl tekstas atpažįstamas
automatiškai – žr. [Skenuoti CoC (OCR)](#skenuoti-coc-ocr).

Datos suvienodinamos į `DD.MM.YYYY`, tipas/variantas/versija sujungiami per
pasvirąjį brūkšnį (`F16/A/A45`), spalva iš angliško CoC užrašo išverčiama į
lietuvišką (`SOLID WHITE (326)` → `BALTA`, žr. `app/colors.py`).

## Svetainė (naršyklėje, be serverio)

`web/` kataloge yra ta pati programa, veikianti **vien naršyklėje**: PDF
skaitymas, skenuotų liudijimų atpažinimas ir Word failo pildymas vyksta Jūsų
įrenginyje. Serverio nėra – liudijimai niekur nesiunčiami.

**Ką ji duoda:**

* atidaroma iš bet kurio įrenginio adresu, kurį galima įsidėti į žymes;
* naršyklės meniu → **Įdiegti** – atsiranda ikona ir atskiras langas;
* įdiegus **veikia be interneto** (visi failai, įskaitant atpažinimo variklį,
  įrašomi į įrenginį – apie 12 MB);
* Jūsų pažymos blankas išsaugomas įrenginyje (IndexedDB), ne serveryje.

### Paskelbimas

Kartu su kodu yra `.github/workflows/pages.yml` – kiekvienas pakeitimas
automatiškai paskelbiamas per GitHub Pages. Vieną kartą reikia įjungti:
repozitorijos **Settings → Pages → Source: GitHub Actions**. Po to adresas
matomas ten pat ir darbo eigos („Actions“) rezultate.

Norint patikrinti vietoje:

```bash
cd web && python3 -m http.server 8080     # http://127.0.0.1:8080
```

(Failą tiesiog atidaryti dukart spustelėjus negalima – naršyklė tokiu atveju
neleidžia įkelti modulių ir neįdiegia programos.)

### Kaip veikia atpažinimas naršyklėje

* **pdf.js** paverčia puslapį vaizdu 300 dpi ir nuskaito teksto sluoksnį, jei
  toks yra;
* vaizdas paverčiamas juodu-baltu (Otsu slenkstis) – be to smulkūs ženklai
  susilieja;
* **Tesseract** (WebAssembly) atpažįsta tekstą su koordinatėmis, iš jų
  atkuriamos eilutės ir stulpeliai – kaip ir Python versijoje;
* svarbiausios reikšmės (tipas, variantas, versija, VIN, patvirtinimo Nr.)
  perskaitomos **antrą kartą**: iškarpa padidinama ir skaitoma tik
  didžiosiomis raidėmis bei skaitmenimis. Taip pataisomas prie reikšmės
  prilipęs dvitaškis („PJl2“ → `J12`);
* VIN klaidos taisomos kontroliniu skaitmeniu: `SINJ12TD3U2000001` →
  `SJNJ12TD3U2000001` (VIN abėcėlėje nėra I, O ir Q, o pataisymas priimamas
  tik jei sutampa kontrolinis skaitmuo).

Patikrinta su tikru skenuotu Nissan Qashqai liudijimu: visi 8 pažymos laukai
teisingi, trukmė ~20 s dviem puslapiams. Taip pat patikrinta **atjungus
tinklą**: puslapis atsidaro, liudijimas nuskaitomas, pažyma parsisiunčiama.

### Testai

```bash
node --test web/tests/logic.test.mjs
```

## Vietinė versija (Python)

### Diegimas

Reikia Python 3.10 ar naujesnio.

### Windows

```bat
run.bat
```

Pirmą kartą paleidus bus sukurta virtuali aplinka, įdiegtos bibliotekos ir
atidaryta naršyklė adresu <http://127.0.0.1:8000>. Kitus kartus tiesiog
paleiskite `run.bat` dar kartą.

### Linux / macOS

```bash
./run.sh
```

### Rankinis diegimas

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8000
```

### Naudojimas naršyklėje

1. Atidarykite <http://127.0.0.1:8000>.
2. Nuvilkite CoC PDF failus į lauką (galima kelis iš karto).
3. Patikrinkite užpildytus laukus – jie visi redaguojami. Geltona juosta rodo,
   ko rasti nepavyko.
4. Jei reikia, pakeiskite pažymos datą (pasiūloma šiandienos).
5. Spauskite **Generuoti pažymą (.docx)**. Numerį prie „Nr.“ įrašote pats.

Failas pavadinamas pagal VIN, pvz. `aikstele_SJNJ12TD3U2000001.docx`.

### Savo Word šablono naudojimas (rekomenduojama)

Kad dokumentas atrodytų lygiai taip, kaip Jūsų įmonėje naudojama pažyma,
skiltyje **Nustatymai** įkelkite savo `.docx` failą (tuščią pažymos blanką).
Tada visos pažymos formuojamos jo pagrindu – išlieka Jūsų antraštė, įmonės
rekvizitai, patvirtinimo tekstas ir formatavimas.

Šablone **nieko keisti nereikia**. Eilutės atpažįstamos pagal pavadinimus
lentelės pirmame stulpelyje („Gamybinė markė…“, „Tipas/Variantas/Versija“,
„Tipo patvirtinimo Nr.“ ir t. t.), o reikšmė įrašoma į tuščią reikšmių
stulpelį; „Skiltis RL“ stulpelis neliečiamas. Datos langeliai (po vieną
simbolį) ir eilutė „Nr.“ užpildomi automatiškai.

**Blankas gali būti ankstesnės pažymos kopija.** Taip dažniausiai ir būna –
darbinis failas su praeitos mašinos duomenimis. Programa tai palaiko: visos
atpažintos eilutės **perrašomos**, o tuščias laukas (pvz. nacionalinis
patvirtinimo numeris) – **išvalomas**, kad ankstesnės transporto priemonės
duomenys jokiu būdu neliktų naujoje pažymoje. Reikšmių stulpelis atpažįstamas
ne pagal tuščius langelius, o pagal tai, kuriame stulpelyje surašyti CoC
skirsniai (0.1, 0.2, 40…) ir RL kodai (D.1, E, K, R…) – jie neliečiami.

**Data atnaujinama kiekvieną kartą, „Nr.“ – neliečiamas.** Datos langeliuose
įrašoma pažymos data (pagal nutylėjimą – šiandienos, sąsajoje redaguojama),
išsaugant blanke esančius brūkšnelius. Eilutė „Nr.“ paliekama tokia, kokia yra –
numerį rašote pats.

**Šablono patikra.** Vos įkėlus šabloną (arba paspaudus **Patikrinti**)
parodoma, ką programa jame atpažino: kurios eilutės bus užpildytos, į kurį
stulpelį bus rašoma, ar rasti datos langeliai. Jei kurios nors
eilutės pavadinimas skiriasi ir neatpažįstamas, jis bus išvardytas – tada
pakanka į tą langelį įrašyti žymeklį (pvz. `{{colour}}`). Tą patį galima
padaryti ir be naršyklės:

```bash
.venv/bin/python -m app.cli --check-template data/template.docx
```

Jei norite tikslesnės kontrolės, šablone galite naudoti ir žymeklius:
`{{make}}`, `{{type_variant_version}}`, `{{commercial_name}}`, `{{vin}}`,
`{{approval_number}}`, `{{approval_date}}`, `{{national_approval_number}}`,
`{{colour}}`, `{{doc_date}}`, `{{category}}`,
`{{manufacture_date}}`, `{{manufacturer}}`.

Neįkėlus šablono dokumentas sukuriamas nuo nulio pagal pažymos struktūrą.
Tokiu atveju patvirtinimo tekstas imamas iš `app/aikstele_docx.py`
(`PATVIRTINIMAS`) – **pasitikrinkite, ar jo redakcija sutampa su Jūsų
naudojama**.

### Komandinė eilutė

```bash
# viena pažyma šalia PDF
.venv/bin/python -m app.cli CoC.pdf -o out

# visas aplankas, naudojant šabloną
.venv/bin/python -m app.cli /kelias/*.pdf -o out -t data/template.docx

# tik pažiūrėti, kas ištraukta (JSON, nieko negeneruojant)
.venv/bin/python -m app.cli CoC.pdf --json
```

### Ką verta pasitikrinti kiekvieną kartą

* **Spalva** – CoC 40 skirsnyje ji dažnai būna 2 puslapyje ir su gamintojo kodu.
  Dvispalvės mašinos užrašomos abiem spalvomis (`GREY/BLACK` → `PILKA/JUODA`);
  neatpažintą pavadinimą įrašykite ranka.
* **Nacionalinis patvirtinimo numeris** – CoC jo nėra, pildomas ranka.
* **Tipo patvirtinimo Nr.** – imamas iš sakinio „…described in approval …
  granted on …“. Jei CoC formatas kitoks, patikrinkite reikšmę.

### Konfidencialumas

Programa sukurta taip, kad transporto priemonių duomenys neišeitų iš Jūsų
kompiuterio ir niekur nebūtų kaupiami.

**Kas vyksta su įkeltu CoC:** naršyklė jį perduoda vietiniam serveriui
(`127.0.0.1`), tekstas nuskaitomas **atmintyje** ir iškart grąžinami laukai.
PDF į diską **neįrašomas** – net ne į laikinųjų failų katalogą. Sugeneruota
pažyma taip pat suformuojama atmintyje ir atiduodama naršyklei; serveryje ji
nesaugoma. Vienintelis diske atsirandantis failas – tas, kurį parsisiunčiate
patys (arba nurodote per `-o` komandinėje eilutėje).

**Nėra jokios istorijos:** nėra duomenų bazės, nėra apdorotų failų sąrašo,
nėra žurnalo su VIN ar klientų duomenimis. Konsolėje uvicorn rodo tik
`POST /api/extract 200` – be failų vardų ir be turinio. Uždarius arba
atnaujinus puslapį, laukai iš naršyklės dingsta (galima ir mygtuku
**Išvalyti duomenis**); slapukai ir `localStorage` nenaudojami, laukuose
išjungtas naršyklės automatinis pildymas.

**Nesikreipia į internetą:** sąsajoje nėra išorinių šriftų, skriptų ar
paveikslėlių, nėra jokios analitikos ar telemetrijos. Ir teksto atpažinimas
(OCR) vyksta Jūsų kompiuteryje – modeliai atsisiunčiami vieną kartą kartu su
biblioteka diegimo metu, o vėliau programa veikia ir visiškai atjungus tinklą.
Puslapių vaizdai OCR'ui piešiami atmintyje ir į diską nepatenka.

**Tik vietiniai prisijungimai:** serveris klauso `127.0.0.1`, o papildomai
kiekvienas ne loopback adreso užklausas atmeta su klaida 403 – net jei kas
nors paleistų jį su `--host 0.0.0.0`, kiti tinklo kompiuteriai duomenų
nepasieks. Sąmoningam naudojimui tinkle reikėtų nustatyti aplinkos kintamąjį
`COC_ALLOW_REMOTE=1`.

**Kas lieka diske:** tik `data/` kataloge ir tik tai, ką įkeliate patys –
`template.docx` (tuščias pažymos blankas, be transporto priemonių duomenų) ir
`settings.json` (įmonės eilutė). Šabloną bet kada galima pašalinti mygtuku
**Pašalinti** arba tiesiog ištrinti `data/` katalogą. `data/`, `in/`, `out/`
ir šakniniame kataloge esantys `*.pdf` / `*.docx` yra `.gitignore` sąraše, kad
realūs CoC ar pažymos netyčia nepatektų į git.

Šios garantijos padengtos testais (`tests/test_privacy.py`): tikrinama, kad
kode nėra išorinio tinklo bibliotekų, kad sąsaja nesikreipia į išorinius
adresus, kad apdorojant CoC diske neatsiranda naujų failų ir kad priimami tik
vietiniai prisijungimai.

**Dalykai, kurių programa nekontroliuoja** (verta turėti galvoje darbo
kompiuteryje):

* parsisiųstas `.docx` lieka „Atsisiuntimų“ kataloge – tvarkykite kaip bet kurį
  kitą dokumentą su klientų duomenimis;
* nelaikykite programos aplanko OneDrive / Google Drive kataloge, jei įmonės
  politika neleidžia sinchronizuoti tokių duomenų į debesį;
* įmonės atsarginės kopijos, DLP ar antivirusas gali skenuoti failus
  nepriklausomai nuo šios programos;
* nenaudokite bendrame ar viešame kompiuteryje.

### Kelių stulpelių ir kitų kalbų liudijimai

Hyundai liudijimas atspausdintas ant abiejų lapo pusių ir kiekvienoje pusėje
turi **tris stulpelius**, Citroën – dviejų dalių prancūzišką formą. Skaitant
tokį puslapį eilutėmis, gretimų stulpelių tekstas sulimpa į vieną eilutę ir
reikšmės susimaišo, todėl puslapis pirmiausia padalijamas į stulpelius.

Stulpelio riba pripažįstama ne tiesiog pagal tarpą (tarpas yra ir tarp
pavadinimų bei reikšmių skilties), o pagal tai, ar **abiejose** pusėse yra
savarankiškų „pavadinimas : reikšmė“ eilučių: reikšmių skiltyje jų nėra (vien
reikšmės), pavadinimų skiltyje – irgi ne (vien pavadinimai).

Tipo patvirtinimo data imama iš karto po patvirtinimo numerio, nesvarbu, kaip
ji įvardyta – `granted on`, `issued on`, `délivrée le`, `erteilt am`.

### Skenuoti CoC (OCR)

Nissan B2B portalo atitikties liudijimai yra **paveikslėliai PDF viduje** –
teksto sluoksnio juose nėra, todėl duomenys atpažįstami automatiškai (OCR).
Viskas įdiegiama kartu su kitomis bibliotekomis (`pymupdf` ir
`rapidocr-onnxruntime`) – tai įprasti Python paketai, todėl **nereikia nei
administratoriaus teisių, nei atskirai diegiamos programos**, o įdiegus OCR
veikia be interneto. Jei kompiuteryje jau yra Tesseract, naudojamas jis.

Vieno liudijimo atpažinimas trunka apie 15 sekundžių (du puslapiai). Rezultate
toks įrašas pažymimas „nuskaityta OCR“ ir prie jo rodomas priminimas sulyginti
duomenis su liudijimu.

Patikrinta su tikru Nissan Qashqai liudijimu: visi aštuoni pažymos laukai
nuskaityti teisingai, įskaitant spalvą (`Black` → `JUODA`) ir tipo
patvirtinimo numerį `e9*2018/858*11042*16`.

Papildoma apsauga nuo OCR klaidų: tikrinamas **VIN kontrolinis skaitmuo**
(9-as ženklas pagal ISO 3779). Jei jis nesutampa, prie įrašo atsiranda
įspėjimas – tada VIN verta sulyginti raidė po raidės.

### Testai

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

`samples/sample_coc.txt` – demonstracinio CoC tekstas (pagal Nissan Qashqai
liudijimą), `samples/sample_coc.pdf` – iš jo sugeneruotas PDF bandymams
(`python samples/make_sample_pdf.py`).

## Projekto struktūra

```
web/                  svetainė (veikia vien naršyklėje, be serverio)
web/js/layout.js      eilučių ir stulpelių atkūrimas
web/js/coc.js         laukų atpažinimas
web/js/refine.js      tikslinantis kodų perskaitymas
web/js/docx.js        pažymos pildymas naršyklėje
app/coc_extract.py    CoC PDF skaitymas ir laukų atpažinimas
app/ocr.py            skenuotų CoC atpažinimas (OCR)
app/colors.py         spalvų vertimas EN -> LT
app/aikstele_docx.py  pažymos kūrimas / šablono pildymas
app/main.py           FastAPI serveris (API)
app/static/index.html naršyklės sąsaja
app/cli.py            komandinės eilutės įrankis
tests/                testai
samples/              demonstracinis CoC
```
