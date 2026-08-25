# CoC → aikštelė

Įrankis, kuris iš atitikties liudijimo (**CoC – EC Certificate of Conformity**) PDF
failo išrenka transporto priemonės duomenis ir sudeda juos į **pažymą apie
transporto priemonės tapatumo duomenis** (M, N ir O kategorijų transporto
priemonei) – Word `.docx` dokumentą.

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

Datos suvienodinamos į `DD.MM.YYYY`, tipas/variantas/versija sujungiami per
pasvirąjį brūkšnį (`F16/A/A45`), spalva iš angliško CoC užrašo išverčiama į
lietuvišką (`SOLID WHITE (326)` → `BALTA`, žr. `app/colors.py`).

## Diegimas

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

## Naudojimas naršyklėje

1. Atidarykite <http://127.0.0.1:8000>.
2. Nuvilkite CoC PDF failus į lauką (galima kelis iš karto).
3. Patikrinkite užpildytus laukus – jie visi redaguojami. Geltona juosta rodo,
   ko rasti nepavyko.
4. Įrašykite pažymos Nr. (data pasiūloma šiandienos).
5. Spauskite **Generuoti pažymą (.docx)**.

Failas pavadinamas pagal VIN, pvz. `aikstele_SJNJ12TD3U2000001.docx`.

## Savo Word šablono naudojimas (rekomenduojama)

Kad dokumentas atrodytų lygiai taip, kaip Jūsų įmonėje naudojama pažyma,
skiltyje **Nustatymai** įkelkite savo `.docx` failą (tuščią pažymos blanką).
Tada visos pažymos formuojamos jo pagrindu – išlieka Jūsų antraštė, įmonės
rekvizitai, patvirtinimo tekstas ir formatavimas.

Šablone **nieko keisti nereikia**. Eilutės atpažįstamos pagal pavadinimus
lentelės pirmame stulpelyje („Gamybinė markė…“, „Tipas/Variantas/Versija“,
„Tipo patvirtinimo Nr.“ ir t. t.), o reikšmė įrašoma į tuščią reikšmių
stulpelį; „Skiltis RL“ stulpelis neliečiamas. Datos langeliai (po vieną
simbolį) ir eilutė „Nr.“ užpildomi automatiškai.

Jei norite tikslesnės kontrolės, šablone galite naudoti ir žymeklius:
`{{make}}`, `{{type_variant_version}}`, `{{commercial_name}}`, `{{vin}}`,
`{{approval_number}}`, `{{approval_date}}`, `{{national_approval_number}}`,
`{{colour}}`, `{{doc_number}}`, `{{doc_date}}`, `{{category}}`,
`{{manufacture_date}}`, `{{manufacturer}}`.

Neįkėlus šablono dokumentas sukuriamas nuo nulio pagal pažymos struktūrą.
Tokiu atveju patvirtinimo tekstas imamas iš `app/aikstele_docx.py`
(`PATVIRTINIMAS`) – **pasitikrinkite, ar jo redakcija sutampa su Jūsų
naudojama**.

## Komandinė eilutė

```bash
# viena pažyma šalia PDF
.venv/bin/python -m app.cli CoC.pdf -o out

# visas aplankas, naudojant šabloną ir pažymos numerį
.venv/bin/python -m app.cli /kelias/*.pdf -o out -t data/template.docx -n 17

# tik pažiūrėti, kas ištraukta (JSON, nieko negeneruojant)
.venv/bin/python -m app.cli CoC.pdf --json
```

## Ką verta pasitikrinti kiekvieną kartą

* **Spalva** – CoC 40 skirsnyje ji dažnai būna 2 puslapyje ir su gamintojo kodu;
  neatpažintą pavadinimą įrašykite ranka.
* **Nacionalinis patvirtinimo numeris** – CoC jo nėra, pildomas ranka.
* **Tipo patvirtinimo Nr.** – imamas iš sakinio „…described in approval …
  granted on …“. Jei CoC formatas kitoks, patikrinkite reikšmę.

Programa niekur nesiunčia duomenų – viskas vyksta Jūsų kompiuteryje.

## Skenuoti PDF

Jei CoC yra nuskenuotas paveikslėlis (be teksto sluoksnio), tekstas
automatiškai bandomas atpažinti OCR būdu, bet tam papildomai reikia įdiegti
`pytesseract`, `pdf2image` ir Tesseract. Iš B2B portalo atsisiųsti CoC paprastai
turi teksto sluoksnį, todėl OCR neprireikia.

## Testai

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

`samples/sample_coc.txt` – demonstracinio CoC tekstas (pagal Nissan Qashqai
liudijimą), `samples/sample_coc.pdf` – iš jo sugeneruotas PDF bandymams
(`python samples/make_sample_pdf.py`).

## Projekto struktūra

```
app/coc_extract.py    CoC PDF skaitymas ir laukų atpažinimas
app/colors.py         spalvų vertimas EN -> LT
app/aikstele_docx.py  pažymos kūrimas / šablono pildymas
app/main.py           FastAPI serveris (API)
app/static/index.html naršyklės sąsaja
app/cli.py            komandinės eilutės įrankis
tests/                testai
samples/              demonstracinis CoC
```
