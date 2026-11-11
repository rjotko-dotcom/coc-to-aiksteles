"""eNEWS roboto valdymo langas: mašinų sąrašas, taisymas, patikra, paleidimas ir žurnalas."""

from __future__ import annotations

import datetime as dt
import logging
import os
import queue
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import nustatymai as N
import robotas
import netikras_enews
import tikrinimas
from excel_eiles import Masina, Sarasas, menuo_diena, sukurti_sablona, uzrakintas

PAVADINIMAS = "eNEWS robotas"

try:  # failų tempimas pele į langą (nebūtina – be jo veikia mygtukai)
    from tkinterdnd2 import DND_FILES, TkinterDnD
    _Baze = TkinterDnD.Tk
except Exception:  # noqa: BLE001
    DND_FILES = None
    _Baze = tk.Tk


class LangoValdymas(robotas.Valdymas):
    """Robotas (atskiroje gijoje) kalbasi su langu per eilę."""

    def __init__(self, eile: queue.Queue):
        super().__init__()
        self.eile = eile
        self.testi = threading.Event()

    def klausti(self, tekstas: str) -> None:
        self.testi.clear()
        self.eile.put(("klausimas", tekstas))
        while not self.testi.is_set():
            if self.stabdyti.is_set():
                raise robotas.Sustabdyta()
            robotas.snausti(0.2)  # kol laukiame – aptarnaujame Chrome (nauji skirtukai ir pan.)
        self.eile.put(("klausimas", ""))

    def busena(self, m: Masina, tekstas: str) -> None:
        self.eile.put(("busena", (m.eilute, tekstas)))

    def ataskaita(self, tekstas: str) -> None:
        robotas.log.info(tekstas)
        self.eile.put(("ataskaita", tekstas))


class EilesZurnalas(logging.Handler):
    def __init__(self, eile: queue.Queue):
        super().__init__()
        self.eile = eile
        self.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))

    def emit(self, record):
        self.eile.put(("log", self.format(record)))


class Langas(_Baze):
    STULPELIAI = [("eil", "Eil.", 45), ("vin", "VIN", 160), ("kodas", "Midtronics kodas", 200),
                  ("pdi", "PDI", 85), ("tech", "Tech. pradžia", 95), ("numeris", "Numeris", 80),
                  ("busena", "Būsena / pastabos", 420)]

    def __init__(self):
        super().__init__()
        self.title(PAVADINIMAS)
        self.geometry("1250x780")
        self.minsize(900, 600)
        self.eile: queue.Queue = queue.Queue()
        self.valdymas = LangoValdymas(self.eile)
        robotas.V = self.valdymas
        robotas.nustatyti_zurnala(EilesZurnalas(self.eile))
        self.gija: threading.Thread | None = None
        self.masinos: list[Masina] = []
        self.pastabos: list[tikrinimas.Pastaba] = []

        stilius = ttk.Style(self)
        if "vista" in stilius.theme_names():
            stilius.theme_use("vista")
        stilius.configure("Didelis.TButton", font=("Segoe UI", 11, "bold"), padding=6)
        stilius.configure("Klausimas.TLabel", font=("Segoe UI", 11, "bold"), foreground="#1f4e8c")

        self._virsus()
        knyga = ttk.Notebook(self)
        knyga.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.knyga = knyga
        self._masinu_skirtukas(knyga)
        self._dokumentu_skirtukas(knyga)
        self._pdi_skirtukas(knyga)
        self._nustatymu_skirtukas(knyga)
        self._tekstu_skirtukas(knyga)
        self._pagalbos_skirtukas(knyga)

        self.after(100, self._skaityti_eile)
        self.after(200, self.perskaityti)
        self.after(400, self._valyti_senus)

    # --- Viršus ---------------------------------------------------------------

    def _virsus(self):
        f = ttk.Frame(self, padding=8)
        f.pack(fill="x")
        ttk.Label(f, text="Excel:").pack(side="left")
        self.excel_kelias = tk.StringVar(value=N.EXCEL_FAILAS)
        ttk.Entry(f, textvariable=self.excel_kelias).pack(side="left", fill="x", expand=True, padx=4)
        ttk.Button(f, text="Pasirinkti…", command=self.pasirinkti_excel).pack(side="left")
        ttk.Button(f, text="Perskaityti", command=self.perskaityti).pack(side="left", padx=4)
        ttk.Button(f, text="Atidaryti Excel", command=self.atidaryti_excel).pack(side="left")

    def _valyti_senus(self):
        try:
            kiek = robotas.valyti_senus(int(N.SAUGOTI_DIENU))
        except Exception:  # noqa: BLE001
            return
        if kiek:
            self.log(f"Ištrinta senų failų (senesnių nei {N.SAUGOTI_DIENU} d.): {kiek}")

    def eiga(self):
        import eiga
        aplankas = netikras_enews.ARCH if self.bandymas.get() else robotas.ARCH
        return eiga.Eiga(aplankas / "eiga.json")

    def pasirinkti_excel(self):
        kelias = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx *.xlsm"), ("Visi", "*.*")])
        if kelias:
            self.excel_kelias.set(kelias)
            nauji = N.dabartines()
            nauji["EXCEL_FAILAS"] = kelias
            N.issaugoti(nauji)
            self.perskaityti()

    def atidaryti_excel(self):
        kelias = Path(self.aktyvus_excel())
        if not kelias.is_file():
            if not messagebox.askyesno(PAVADINIMAS, f"Failo {kelias} nėra.\n\nSukurti tuščią Excel šabloną "
                                                    "šioje vietoje? (Jei jau turite savo failą – spauskite "
                                                    "„Ne“ ir „Pasirinkti…“.)"):
                return
            try:
                sukurti_sablona(kelias, N)
            except OSError as e:
                messagebox.showerror(PAVADINIMAS, f"Nepavyko sukurti: {e}")
                return
            self.log(f"Sukurtas šablonas {kelias}. Antrame lape „Pavyzdys“ – kaip pildyti.")
        if sys.platform == "win32":
            os.startfile(self.aktyvus_excel())  # noqa: S606
        messagebox.showinfo(PAVADINIMAS, "Pataisę Excel'yje, jį išsaugokite ir UŽDARYKITE, "
                                         "tada spauskite „Perskaityti“.")

    # --- Mašinų skirtukas ---------------------------------------------------------

    def _masinu_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=6)
        knyga.add(f, text="  Mašinos  ")

        mygt = ttk.Frame(f)
        mygt.pack(fill="x", pady=(0, 6))
        self.b_tikrinti = ttk.Button(mygt, text="✔ Tikrinti", command=self.tikrinti)
        self.b_pradeti = ttk.Button(mygt, text="▶ Pradėti", style="Didelis.TButton", command=self.pradeti)
        self.b_testi = ttk.Button(mygt, text="Tęsti ▶", style="Didelis.TButton", command=self.testi, state="disabled")
        self.b_stabdyti = ttk.Button(mygt, text="■ Stabdyti", command=self.stabdyti, state="disabled")
        for b in (self.b_tikrinti, self.b_pradeti, self.b_testi, self.b_stabdyti):
            b.pack(side="left", padx=(0, 6))
        ttk.Button(mygt, text="Diagnostika", command=self.diagnostika).pack(side="right")
        ttk.Button(mygt, text="↻ Pakartoti raudonas", command=self.pakartoti_raudonas).pack(side="right", padx=6)
        ttk.Button(mygt, text="⟳ Atnaujinti robotą", command=self.atnaujinti).pack(side="right", padx=6)
        varneles = ttk.Frame(f)
        varneles.pack(fill="x", pady=(0, 4))
        self.zingsniais = tk.BooleanVar(value=False)
        self.tik_pazymetos = tk.BooleanVar(value=False)
        self.bandymas = tk.BooleanVar(value=False)
        self.perziura = tk.BooleanVar(value=False)
        self.rodyti_visas = tk.BooleanVar(value=False)
        ttk.Checkbutton(varneles, text="Žingsniais (laukti „Tęsti“ prieš kiekvieną veiksmą)",
                        variable=self.zingsniais).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(varneles, text="Tik pažymėtos eilutės", variable=self.tik_pazymetos).pack(side="left", padx=12)
        ttk.Checkbutton(varneles, text="Rodyti ir jau padarytas", variable=self.rodyti_visas,
                        command=self.rodyti).pack(side="left", padx=12)
        ttk.Checkbutton(varneles, text="BANDYMAS be B2B (namuose)", variable=self.bandymas,
                        command=self.perjungti_bandyma).pack(side="left", padx=12)
        ttk.Checkbutton(varneles, text="PERŽIŪRA tikrame B2B (nieko neišsaugo)", variable=self.perziura,
                        command=self.perjungti_perziura).pack(side="left", padx=12)

        self.klausimas = tk.StringVar(value="")
        ttk.Label(f, textvariable=self.klausimas, style="Klausimas.TLabel").pack(fill="x", pady=(0, 4))

        self.bandymo_juosta = tk.Frame(f, background="#fff2b3")
        tk.Label(self.bandymo_juosta, background="#fff2b3", font=("Segoe UI", 10, "bold"),
                 text="BANDYMAS: netikras eNEWS šiame kompiuteryje, Excel kopija, niekas nespausdinama. "
                      "Kodas „BAD…“ – blogas akumuliatorius.").pack(side="left", padx=6, pady=3)
        ttk.Button(self.bandymo_juosta, text="Nauja kopija", command=self.nauja_bandymo_kopija).pack(side="right")

        dalys = ttk.PanedWindow(f, orient="vertical")
        dalys.pack(fill="both", expand=True)
        self.dalys = dalys

        lent = ttk.Frame(dalys)
        self.medis = ttk.Treeview(lent, columns=[k for k, *_ in self.STULPELIAI], show="headings",
                                  selectmode="extended")
        for k, pav, plotis in self.STULPELIAI:
            self.medis.heading(k, text=pav)
            self.medis.column(k, width=plotis, stretch=(k == "busena"),
                              anchor="w" if k in ("vin", "busena", "kodas") else "center")
        sl = ttk.Scrollbar(lent, orient="vertical", command=self.medis.yview)
        self.medis.configure(yscrollcommand=sl.set)
        self.medis.pack(side="left", fill="both", expand=True)
        sl.pack(side="right", fill="y")
        for zyma, spalva in (("atlikta", "#c6efce"), ("akumas", "#ffe0a0"), ("klaida", "#ffc7ce"),
                             ("blokuota", "#ffc7ce"), ("perspejimas", "#fff2b3"), ("dirbama", "#cfe2ff"),
                             ("nuspalvinta", "#e8e8e8")):
            self.medis.tag_configure(zyma, background=spalva)
        self.medis.bind("<Double-1>", lambda e: self.taisyti())
        meniu = tk.Menu(self, tearoff=0)
        meniu.add_command(label="Taisyti…", command=self.taisyti)
        meniu.add_command(label="Tęsti nuo ten, kur sustojo (nuimti spalvą)", command=self.testi_eilutes)
        meniu.add_command(label="Daryti iš naujo – visus žingsnius (nuimti spalvą)", command=self.is_naujo)
        meniu.add_command(label="Atspausdinti dar kartą (failai jau aplanke)", command=self.spausdinti_is_naujo)
        self.medis.bind("<Button-3>", lambda e: (self.medis.selection_set(self.medis.identify_row(e.y)),
                                                 meniu.tk_popup(e.x_root, e.y_root)))
        dalys.add(lent, weight=3)

        zurn = ttk.LabelFrame(dalys, text="Ką daro robotas", padding=4)
        self.zurnalas = tk.Text(zurn, height=10, wrap="word", font=("Consolas", 9), state="disabled")
        sz = ttk.Scrollbar(zurn, orient="vertical", command=self.zurnalas.yview)
        self.zurnalas.configure(yscrollcommand=sz.set)
        self.zurnalas.pack(side="left", fill="both", expand=True)
        sz.pack(side="right", fill="y")
        self.zurnalas.tag_configure("klaida", foreground="#c00000")
        self.zurnalas.tag_configure("gerai", foreground="#2e7d32")
        dalys.add(zurn, weight=2)

        self.suvestine = tk.StringVar()
        ttk.Label(f, textvariable=self.suvestine).pack(fill="x", pady=(4, 0))

    def aktyvus_excel(self) -> str:
        """Bandymo režime – Excel kopija, kad tikras failas liktų nepaliestas."""
        if self.bandymas.get():
            return str(netikras_enews.ARCH / "bandymui.xlsx")
        return self.excel_kelias.get()

    def perjungti_bandyma(self):
        if self.gija and self.gija.is_alive():
            self.bandymas.set(not self.bandymas.get())
            return
        if self.bandymas.get():
            self.perziura.set(False)
            kopija = netikras_enews.paruosti_excel(self.excel_kelias.get())
            self.log(f"BANDYMAS be B2B: netikras eNEWS, dirbama su Excel kopija {kopija.name} "
                     "(tikras failas nepaliečiamas), niekas nespausdinama.")
            self.bandymo_juosta.pack(fill="x", pady=(0, 4), before=self.dalys)
        else:
            self.bandymo_juosta.pack_forget()
            self.log("Bandymas išjungtas – dirbama su tikru Excel ir tikru eNEWS.")
        self.perskaityti()

    def perjungti_perziura(self):
        if self.perziura.get():
            if self.bandymas.get():
                self.bandymas.set(False)
                self.perjungti_bandyma()
            self.log("PERŽIŪRA: robotas eis per tikrą eNEWS ir pildys laukus, bet mygtukų, kurie "
                     "įrašo (Validate, Išsaugoti, Confirm, Save, Drukāt), NESPAUS – tik apves raudonai. "
                     "Excel nežymimas, niekas nespausdinama. Galima naudoti ir jau padarytas mašinas.")
        else:
            self.log("Peržiūra išjungta – robotas dirbs iš tikrųjų.")

    def nauja_bandymo_kopija(self):
        if self.gija and self.gija.is_alive():
            return
        netikras_enews.paruosti_excel(self.excel_kelias.get())
        self.log("Bandymui padaryta nauja Excel kopija.")
        self.perskaityti()

    def perskaityti(self):
        kelias = self.aktyvus_excel()
        self.masinos, self.pastabos = [], []
        if not Path(kelias).is_file():
            self.rodyti()
            self.suvestine.set(f"✖ Nerastas Excel failas: {kelias} – spauskite „Pasirinkti…“ viršuje.")
            self.log(f"✖ Nerastas Excel failas {kelias}. Spauskite „Pasirinkti…“ ir nurodykite savo failą.")
            return
        try:
            self.masinos = Sarasas(kelias, N).visos()
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(PAVADINIMAS, f"Nepavyko perskaityti Excel:\n{e}")
            return
        self.pastabos = tikrinimas.duomenys(self.masinos)
        self.rodyti()

    def _zyma(self, m: Masina, pastabos: list[tikrinimas.Pastaba]) -> str:
        if m.nuspalvinta:
            b = m.busena.lower()
            if b.startswith("atlikta"):
                return "atlikta"
            if b.startswith("akumuliatorius"):
                return "akumas"
            if b.startswith("klaida"):
                return "klaida"
            return "nuspalvinta"
        if any(p.lygis == tikrinimas.KLAIDA for p in pastabos):
            return "blokuota"
        if pastabos:
            return "perspejimas"
        return ""

    def rodyti(self):
        self.medis.delete(*self.medis.get_children())
        pagal_eil: dict[int, list[tikrinimas.Pastaba]] = {}
        for p in self.pastabos:
            pagal_eil.setdefault(p.eilute, []).append(p)
        darbo = blok = persp = 0
        eiga_ = self.eiga()
        for m in self.masinos:
            past = pagal_eil.get(m.eilute, [])
            if m.nuspalvinta and not self.rodyti_visas.get():
                continue
            zyma = self._zyma(m, past)
            if not m.nuspalvinta:
                darbo += 1
                blok += zyma == "blokuota"
                persp += zyma == "perspejimas"
            tekstas = m.busena if m.nuspalvinta else "; ".join(
                ("✖ " if p.lygis == tikrinimas.KLAIDA else "! ") + p.tekstas for p in past)
            if not m.nuspalvinta:
                padaryta = eiga_.santrauka(m.vin)
                if padaryta:
                    tekstas = "; ".join(x for x in (tekstas, padaryta + " – bus tęsiama") if x)
            self.medis.insert("", "end", iid=str(m.eilute), tags=(zyma,), values=(
                m.eilute, m.vin, " - ".join(m.kodas),
                m.pdi_data.strftime("%m.%d") if m.pdi_data else "?",
                m.garantija.strftime("%m.%d") if m.garantija else "?",
                m.numeris, tekstas or "paruošta"))
        padaryta = sum(1 for m in self.masinos if m.nuspalvinta)
        self.suvestine.set(f"Darbui: {darbo}   ✖ su klaidomis (nebus daromos): {blok}   "
                           f"! verta pažiūrėti: {persp}   Jau nuspalvintų: {padaryta}   "
                           "(Dukart spustelėkite eilutę – taisyti)")

    def tikrinti(self) -> bool:
        """Patikrina kompiuterį ir duomenis. Grąžina True, jei galima pradėti."""
        self.perskaityti()
        aplinka = tikrinimas.aplinka(N, robotas.PROFILIS, self.aktyvus_excel(), self.bandymas.get())
        self.log("— Patikra —")
        for p in aplinka:
            self.log(("✖ " if p.lygis == tikrinimas.KLAIDA else "! ") + p.tekstas,
                     "klaida" if p.lygis == tikrinimas.KLAIDA else None)
        blok = tikrinimas.blokuojamos_eilutes(self.pastabos)
        darbo = [m for m in self.masinos if not m.nuspalvinta and m.eilute not in blok]
        if not aplinka:
            self.log("✔ Kompiuteris paruoštas (Excel, Chrome, spausdintuvai).", "gerai")
        self.log(f"Excel: paruoštų mašinų {len(darbo)}, su klaidomis {len(blok)}.",
                 "gerai" if darbo and not blok else None)
        return not any(p.lygis == tikrinimas.KLAIDA for p in aplinka) and bool(darbo)

    # --- Taisymas ----------------------------------------------------------------

    def _pazymeta(self) -> Masina | None:
        sel = self.medis.selection()
        if not sel:
            return None
        return next((m for m in self.masinos if str(m.eilute) == sel[0]), None)

    def _galima_rasyti(self) -> bool:
        if self.gija and self.gija.is_alive():
            messagebox.showwarning(PAVADINIMAS, "Robotas dirba – taisyti galėsite jam baigus.")
            return False
        if uzrakintas(self.aktyvus_excel()):
            messagebox.showwarning(PAVADINIMAS, "Excel failas atidarytas – uždarykite jį ir bandykite dar kartą.")
            return False
        return True

    def taisyti(self):
        m = self._pazymeta()
        if m is None or not self._galima_rasyti():
            return
        TaisymoLangas(self, m)

    def testi_eilutes(self, eilutes: list[str] | None = None):
        """Nuima spalvą, bet palieka įsimintus žingsnius – robotas darys tik tai, ko trūksta."""
        sel = eilutes if eilutes is not None else list(self.medis.selection())
        if not sel or not self._galima_rasyti():
            return
        s = Sarasas(self.aktyvus_excel(), N)
        for iid in sel:
            s.nuimti_spalva(int(iid))
        s.issaugoti()
        self.log(f"{len(sel)} eil. bus tęsiamos nuo ten, kur sustojo.")
        self.perskaityti()

    def pakartoti_raudonas(self):
        raudonos = [str(m.eilute) for m in self.masinos
                    if m.nuspalvinta and m.busena.lower().startswith("klaida")]
        if not raudonos:
            messagebox.showinfo(PAVADINIMAS, "Raudonų (klaida) eilučių nėra.")
            return
        if messagebox.askyesno(PAVADINIMAS, f"Raudonų eilučių: {len(raudonos)}. Nuimti spalvą, kad robotas jas "
                                            "tęstų nuo ten, kur sustojo?\n\n(Oranžinės – blogas akumuliatorius – "
                                            "lieka; joms reikia naujo testo.)"):
            self.testi_eilutes(raudonos)

    def is_naujo(self):
        sel = self.medis.selection()
        if not sel or not self._galima_rasyti():
            return
        if not messagebox.askyesno(PAVADINIMAS, f"Nuimti spalvą nuo {len(sel)} eil.? Robotas jas darys iš naujo."):
            return
        s = Sarasas(self.aktyvus_excel(), N)
        e = self.eiga()
        for iid in sel:
            s.nuimti_spalva(int(iid))
            m = next((x for x in self.masinos if str(x.eilute) == iid), None)
            if m:
                e.isvalyti(m.vin)  # „iš naujo“ – visi žingsniai, ne tik trūkstami
        s.issaugoti()
        self.perskaityti()

    def spausdinti_is_naujo(self):
        """Atspausdina pažymėtų mašinų jau išsaugotus PDF (pvz. kai sustota ties spausdinimu)."""
        if self.gija and self.gija.is_alive():
            messagebox.showwarning(PAVADINIMAS, "Robotas dirba – pabandykite jam baigus.")
            return
        import spausdinimas
        darbai = []
        for iid in self.medis.selection():
            m = next((x for x in self.masinos if str(x.eilute) == iid), None)
            if m is None:
                continue
            failai = {1: sorted(robotas.SPAUSDINTI.glob(f"*{m.vin}-1-*.pdf")),
                      2: sorted(robotas.SPAUSDINTI.glob(f"*{m.vin}-2-*.pdf"))}
            if not failai[1] or not failai[2]:
                self.log(f"✖ {m.eilute} eil. ({m.numeris}): aplanke „spausdinti“ nėra abiejų failų")
                continue
            darbai += [(failai[nr][-1], rusis) for nr, rusis in spausdinimas.planas()]
        if not darbai or not messagebox.askyesno(
                PAVADINIMAS, f"Atspausdinti {len(darbai)} lap. (pagal planą {N.SPAUSDINIMO_PLANAS})?"):
            return

        def darbas():
            for failas, rusis in darbai:
                try:
                    spausdinimas.spausdinti(failas, rusis)
                    self.eile.put(("log", f"✔ atspausdinta {failas.name} ({rusis})"))
                except Exception as e:  # noqa: BLE001
                    self.eile.put(("log", f"✖ nepavyko {failas.name} ({rusis}): {e}"))
        threading.Thread(target=darbas, daemon=True).start()

    def irasyti_pataisyma(self, m: Masina, reiksmes: dict[str, str]):
        s = Sarasas(self.aktyvus_excel(), N)
        stulp = {"vin": N.STULP_VIN, "kodas1": N.STULP_KODAS[0], "kodas2": N.STULP_KODAS[1],
                 "kodas3": N.STULP_KODAS[2], "pdi": N.STULP_PDI_DATA, "tech": N.STULP_GARANTIJA,
                 "numeris": N.STULP_NUMERIS}
        for k, v in reiksmes.items():
            s.irasyti(m.eilute, stulp[k], v)
        try:
            s.issaugoti()
        except PermissionError:
            messagebox.showerror(PAVADINIMAS, "Excel failas atidarytas – neišsaugota.")
            return
        self.log(f"Pataisyta {m.eilute} eil.")
        self.perskaityti()
        self.medis.selection_set(str(m.eilute)) if self.medis.exists(str(m.eilute)) else None

    # --- Paleidimas -----------------------------------------------------------------

    def pradeti(self):
        if self.gija and self.gija.is_alive():
            return
        if not self.tikrinti():
            messagebox.showwarning(PAVADINIMAS, "Yra klaidų (žr. žurnalą apačioje) arba nėra paruoštų mašinų.")
            return
        blok = tikrinimas.blokuojamos_eilutes(self.pastabos)
        darbo = [m for m in self.masinos if not m.nuspalvinta and m.eilute not in blok]
        if self.tik_pazymetos.get():
            pazym = set(self.medis.selection())
            darbo = [m for m in darbo if str(m.eilute) in pazym]
            if not darbo:
                messagebox.showinfo(PAVADINIMAS, "Pažymėkite eilutes (be klaidų), kurias daryti.")
                return
        if blok and not messagebox.askyesno(
                PAVADINIMAS, f"{len(blok)} eil. su klaidomis bus praleistos. Daryti likusias {len(darbo)}?"):
            return
        if not self.bandymas.get() and not self.perziura.get() and not messagebox.askyesno(
                PAVADINIMAS, f"Robotas dirbs TIKRAME eNEWS: {len(darbo)} mašin. bus įvesta ir atspausdinta.\n\n"
                             "Tęsti?\n\n(Jei norite tik pasitikrinti – pažymėkite „PERŽIŪRA“.)"):
            return
        sarasas = Sarasas(self.aktyvus_excel(), N)
        self.valdymas.stabdyti.clear()
        self.valdymas.zingsniais = self.zingsniais.get()
        self._dirba(True)
        self.log(f"▶ Pradedama: {len(darbo)} mašinų.")
        self.gija = threading.Thread(target=self._vykdyti, args=(robotas.vykdyti, sarasas, darbo, False, self.bandymas.get(), self.perziura.get()),
                                     daemon=True)
        self.gija.start()

    def atnaujinti(self):
        if self.gija and self.gija.is_alive():
            messagebox.showwarning(PAVADINIMAS, "Robotas dirba – atnaujinsite jam baigus.")
            return
        import atnaujinimas
        self.log("Atnaujinama iš GitHub…")
        self.update_idletasks()
        try:
            pakeisti = atnaujinimas.atnaujinti()
        except Exception as e:  # noqa: BLE001
            self.log(f"✖ Nepavyko atnaujinti: {e}")
            messagebox.showerror(PAVADINIMAS, f"Nepavyko atnaujinti (gal nėra interneto?):\n{e}")
            return
        if not pakeisti:
            self.log("✔ Jau naujausia versija.")
            messagebox.showinfo(PAVADINIMAS, "Jau naujausia versija.")
            return
        self.log("✔ Atnaujinta: " + ", ".join(pakeisti))
        if messagebox.askyesno(PAVADINIMAS, "Robotas atnaujintas. Paleisti iš naujo dabar?"):
            import subprocess
            subprocess.Popen([sys.executable, str(Path(__file__).resolve())], cwd=str(Path(__file__).parent))
            self.destroy()

    def diagnostika(self):
        if self.gija and self.gija.is_alive():
            return
        self.valdymas.stabdyti.clear()
        self._dirba(True)
        self.log("Diagnostika: eikite per eNEWS langus ir kiekviename spauskite „Tęsti“.")
        self.gija = threading.Thread(target=self._vykdyti, args=(robotas.diagnostika,), daemon=True)
        self.gija.start()

    def _vykdyti(self, funkcija, *args):
        try:
            funkcija(*args)
        except robotas.Sustabdyta:
            self.eile.put(("log", "■ Sustabdyta."))
        except Exception as e:  # noqa: BLE001
            logging.getLogger("robotas").exception("Robotas sustojo: %s", e)
        finally:
            self.eile.put(("baigta", None))

    def testi(self):
        self.valdymas.testi.set()

    def stabdyti(self):
        self.valdymas.stabdyti.set()
        self.log("■ Stabdoma… (dabartinė mašina nebus baigta ir liks nenuspalvinta)")

    def _dirba(self, taip: bool):
        self.b_pradeti.configure(state="disabled" if taip else "normal")
        self.b_tikrinti.configure(state="disabled" if taip else "normal")
        self.b_stabdyti.configure(state="normal" if taip else "disabled")
        if not taip:
            self.b_testi.configure(state="disabled")
            self.klausimas.set("")

    # --- Įvykiai iš roboto ------------------------------------------------------------

    def log(self, tekstas: str, zyma: str | None = None):
        if zyma is None:
            zyma = "klaida" if "✖" in tekstas or "Klaida" in tekstas else ("gerai" if "✔" in tekstas else None)
        self.zurnalas.configure(state="normal")
        self.zurnalas.insert("end", tekstas + "\n", (zyma,) if zyma else ())
        self.zurnalas.see("end")
        self.zurnalas.configure(state="disabled")

    def _skaityti_eile(self):
        try:
            while True:
                rusis, duom = self.eile.get_nowait()
                if rusis == "log":
                    self.log(duom)
                elif rusis == "klausimas":
                    self.klausimas.set(duom)
                    self.b_testi.configure(state="normal" if duom else "disabled")
                    if duom:
                        self.bell()
                        self.lift()
                elif rusis == "busena":
                    eil, tekstas = duom
                    if self.medis.exists(str(eil)):
                        zyma = ("dirbama" if tekstas.endswith("…") else "atlikta" if tekstas.startswith(("Atlikta", "Peržiūra"))
                                else "akumas" if tekstas.startswith("Akumuliatorius") else
                                "" if tekstas.startswith("sustabdyta") else "klaida")
                        self.medis.item(str(eil), tags=(zyma,))
                        self.medis.set(str(eil), "busena", tekstas)
                        self.medis.see(str(eil))
                elif rusis == "ataskaita":
                    self.bell()
                    self.lift()
                    messagebox.showinfo(PAVADINIMAS, duom)
                elif rusis == "dok_progresas":
                    self.dok_info.set(duom)
                elif rusis == "dok_idiegta":
                    self._dok_idiegta(*duom)
                elif rusis == "dok_baigta":
                    self._dok_baigta(*duom)
                elif rusis == "baigta":
                    self._dirba(False)
                    self.b_pdi.configure(state="normal")
                    self.perskaityti()
        except queue.Empty:
            pass
        self.after(100, self._skaityti_eile)

    # --- Nustatymai ------------------------------------------------------------------------

    def _nustatymu_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=10)
        knyga.add(f, text="  Nustatymai  ")
        self.nust_kint: dict[str, tk.Variable] = {}

        def eilute(tevas, r, raktas, pav, plotis=50, rinktis=None, reiksmes=None, pastaba=""):
            ttk.Label(tevas, text=pav).grid(row=r, column=0, sticky="w", pady=2)
            v = tk.StringVar(value=self._i_teksta(getattr(N, raktas)))
            self.nust_kint[raktas] = v
            if reiksmes is not None:
                w = ttk.Combobox(tevas, textvariable=v, values=reiksmes, width=plotis)
            else:
                w = ttk.Entry(tevas, textvariable=v, width=plotis)
            w.grid(row=r, column=1, sticky="w", padx=6)
            if rinktis:
                ttk.Button(tevas, text="…", width=3, command=lambda: self._rinktis(v, rinktis)).grid(row=r, column=2)
            if pastaba:
                ttk.Label(tevas, text=pastaba, foreground="#666").grid(row=r, column=3, sticky="w", padx=6)
            return w

        ex = ttk.LabelFrame(f, text="Excel stulpeliai", padding=8)
        ex.pack(fill="x", pady=4)
        eilute(ex, 0, "EXCEL_LAPAS", "Lapas", 20, pastaba="tuščias – pirmas lapas")
        eilute(ex, 1, "STULP_VIN", "VIN", 5)
        eilute(ex, 2, "STULP_KODAS", "Midtronics kodas (3 dalys)", 12, pastaba="pvz. E, G, I")
        eilute(ex, 3, "STULP_PDI_DATA", "PDI data", 5)
        eilute(ex, 4, "STULP_GARANTIJA", "Tech. pradžia", 5)
        eilute(ex, 5, "STULP_NUMERIS", "Valst. numeris", 5)
        eilute(ex, 6, "STULP_BUSENA", "Būsena (rašo robotas)", 5)

        en = ttk.LabelFrame(f, text="eNEWS", padding=8)
        en.pack(fill="x", pady=4)
        eilute(en, 0, "PORTALO_ADRESAS", "B2B adresas", 60)
        eilute(en, 1, "RIDA", "Rida pristatant", 8)
        eilute(en, 5, "NARSYKLE", "Naršyklė", 12, reiksmes=["auto", "chrome", "brave", "edge"],
               pastaba="auto – Chrome, jei nėra – Brave, tada Edge")
        ttk.Button(en, text="Pamiršti B2B prisijungimą (kita paskyra)", command=self.pamirsti_prisijungima).grid(
            row=6, column=0, columnspan=2, sticky="w", pady=(6, 0))
        eilute(en, 2, "DATOS_FORMATAS", "Datos formatas eNEWS", 12, pastaba="%d/%m/%Y → 22/09/2026")
        eilute(en, 3, "LAUKTI_SEK", "Kiek laukti mygtuko (s)", 8, pastaba="jei eNEWS lėtas – padidinkite")
        eilute(en, 4, "SAUGOTI_DIENU", "Kiek dienų saugoti PDF ir klaidų nuotraukas", 8,
               pastaba="senesni ištrinami paleidus robotą; 0 – netrinti")

        sp = ttk.LabelFrame(f, text="Spausdinimas", padding=8)
        sp.pack(fill="x", pady=4)
        spausd = tikrinimas.spausdintuvai() or []
        eilute(sp, 0, "SPAUSDINTUVAS_PAPRASTAS", "Paprasto popieriaus spausdintuvas", 40, reiksmes=[""] + spausd,
               pastaba="tuščias – numatytasis")
        eilute(sp, 1, "SPAUSDINTUVAS_LIPNUS", "Lipnaus popieriaus spausdintuvas", 40, reiksmes=spausd)
        eilute(sp, 3, "SPAUSDINIMO_PLANAS", "Ką kaip spausdinti", 40,
               pastaba="1 – sertifikatas, 2 – TP planas; pvz. 1:paprastas, 1:lipnus, 2:lipnus")
        self.spalvotai = tk.BooleanVar(value=bool(N.PAPRASTAS_SPALVOTAI))
        ttk.Checkbutton(sp, text="Paprastą spausdinti spalvotai", variable=self.spalvotai).grid(
            row=4, column=0, columnspan=2, sticky="w", pady=2)
        self.klausti_lipnu = tk.BooleanVar(value=bool(N.KLAUSTI_PRIES_LIPNU))
        ttk.Checkbutton(sp, text="Prieš lipnų spausdinimą sustoti ir paprašyti įdėti lipnų popierių",
                        variable=self.klausti_lipnu).grid(row=5, column=0, columnspan=4, sticky="w", pady=2)
        self.nuostatu_busena: dict[str, tk.StringVar] = {}
        for r, (rusis, tekstas) in enumerate((
                ("lipnus", "Nustatyti lipnų spausdinimą…"),
                ("paprastas", "Nustatyti paprastą spausdinimą… (nebūtina)")), start=6):
            ttk.Button(sp, text=tekstas, command=lambda r_=rusis: self.nustatyti_spausdinima(r_)).grid(
                row=r, column=0, sticky="w", pady=2)
            v = tk.StringVar(value=self._spausdinimo_busena(rusis))
            self.nuostatu_busena[rusis] = v
            ttk.Label(sp, textvariable=v).grid(row=r, column=1, columnspan=3, sticky="w", padx=6)
        ttk.Label(sp, foreground="#666", text="Atsidarys spausdintuvo Preferences langas – lipniam pasirinkite "
                  "2-Sided Printing: None ir Paper Source: Labels, tada OK. Robotas įsimins.").grid(
            row=8, column=0, columnspan=4, sticky="w")
        bandym = ttk.Frame(sp)
        bandym.grid(row=9, column=0, columnspan=4, sticky="w", pady=(6, 0))
        ttk.Label(bandym, text="Bandomasis lapas:").pack(side="left")
        ttk.Button(bandym, text="Paprastas", command=lambda: self.bandomasis_spausdinimas("paprastas")).pack(
            side="left", padx=4)
        ttk.Button(bandym, text="Lipnus", command=lambda: self.bandomasis_spausdinimas("lipnus")).pack(
            side="left", padx=4)

        m = ttk.Frame(f)
        m.pack(fill="x", pady=8)
        ttk.Button(m, text="Išsaugoti nustatymus", style="Didelis.TButton",
                   command=self.issaugoti_nustatymus).pack(side="left")
        ttk.Button(m, text="Patikrinti", command=lambda: (self.issaugoti_nustatymus(), self.tikrinti(),
                                                         self.knyga.select(0))).pack(side="left", padx=6)

    @staticmethod
    def _spausdinimo_busena(rusis: str) -> str:
        try:
            import spausdinimas
            b = spausdinimas.busena(rusis)
        except Exception:  # noqa: BLE001
            return ""
        if b == "nenustatyta":
            return "✖ dar nenustatyta" if rusis == "lipnus" else "spausdintuvo numatytosios + spalvotai"
        return b

    def nustatyti_spausdinima(self, rusis: str):
        self.issaugoti_nustatymus()
        import spausdinimas
        try:
            langas = int(self.wm_frame(), 16)
        except Exception:  # noqa: BLE001
            langas = 0
        try:
            if spausdinimas.nustatyti_langu(rusis, langas):
                self.log(f"✔ {rusis} spausdinimo nuostatos įsimintos.")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(PAVADINIMAS, f"Nepavyko atidaryti spausdintuvo nuostatų:\n{e}")
        self.nuostatu_busena[rusis].set(self._spausdinimo_busena(rusis))

    def pamirsti_prisijungima(self):
        """Ištrina roboto naršyklės profilius – kitą kartą B2B prisijungsite iš naujo (kita paskyra)."""
        if self.gija and self.gija.is_alive():
            messagebox.showwarning(PAVADINIMAS, "Robotas dirba – sustabdykite jį ir uždarykite jo naršyklę.")
            return
        if not messagebox.askyesno(PAVADINIMAS, "Robotas pamirš B2B prisijungimą (ir įsimintus slaptažodžius "
                                                "roboto naršyklėje). Kitą kartą reikės prisijungti iš naujo – "
                                                "galėsite kita paskyra. Tęsti?"):
            return
        import shutil
        istrinta = 0
        for aplankas in robotas.ARCH.glob("*_profilis"):
            try:
                shutil.rmtree(aplankas)
                istrinta += 1
            except OSError as e:
                messagebox.showerror(PAVADINIMAS, f"Nepavyko ištrinti {aplankas.name} – ar uždaryta roboto "
                                                  f"naršyklė?\n{e}")
                return
        self.log(f"✔ B2B prisijungimas pamirštas ({istrinta} prof.). Kitą kartą prisijunkite norima paskyra.")

    def bandomasis_spausdinimas(self, rusis: str):
        if self.gija and self.gija.is_alive():
            messagebox.showwarning(PAVADINIMAS, "Robotas dirba – pabandykite jam baigus.")
            return
        self.issaugoti_nustatymus()
        if rusis == "lipnus" and not messagebox.askyesno(
                PAVADINIMAS, "Bus atspausdintas vienas lapas ant LIPNAUS popieriaus (Labels). Tęsti?"):
            return
        kelias = robotas.SPAUSDINTI / f"bandomasis-{rusis}.pdf"
        kelias.parent.mkdir(exist_ok=True)
        kelias.write_bytes(netikras_enews.pdf([f"BANDOMASIS LAPAS - {rusis.upper()}", "",
                                               f"Spausdintuvas: {N.SPAUSDINTUVAS_LIPNUS if rusis == 'lipnus' else N.SPAUSDINTUVAS_PAPRASTAS}",
                                               f"Popierius: {'lipnus' if rusis == 'lipnus' else 'paprastas'}",
                                               f"{dt.datetime.now():%Y-%m-%d %H:%M}"]))

        def darbas():
            import spausdinimas
            try:
                spausdinimas.spausdinti(kelias, rusis)
                self.eile.put(("log", f"✔ Bandomasis lapas ({rusis}) nusiųstas spausdintuvui."))
            except Exception as e:  # noqa: BLE001
                self.eile.put(("log", f"✖ Nepavyko atspausdinti ({rusis}): {e}"))
        self.log(f"Spausdinamas bandomasis lapas ({rusis})…")
        threading.Thread(target=darbas, daemon=True).start()

    @staticmethod
    def _i_teksta(v) -> str:
        return ", ".join(v) if isinstance(v, list) else str(v)

    def _rinktis(self, v: tk.StringVar, rusis: str):
        kelias = filedialog.askopenfilename(filetypes=[("Programa", "*.exe")] if rusis == "exe" else [])
        if kelias:
            v.set(kelias)

    def _surinkti(self) -> dict:
        nauji = N.dabartines()
        for k, v in self.nust_kint.items():
            t = v.get().strip()
            if k == "STULP_KODAS":
                dalys = [d.strip().upper() for d in t.replace(";", ",").split(",") if d.strip()]
                if len(dalys) != 3:
                    raise ValueError("Midtronics kodui reikia 3 stulpelių, pvz. E, G, I")
                nauji[k] = dalys
            elif k in ("LAUKTI_SEK", "SAUGOTI_DIENU"):
                if not t.isdigit():
                    raise ValueError(f"Turi būti skaičius: {t!r}")
                nauji[k] = int(t)
            elif k.startswith("STULP_"):
                if not t.isalpha():
                    raise ValueError(f"Stulpelis turi būti raidė: {t!r}")
                nauji[k] = t.upper()
            else:
                nauji[k] = t
        nauji["KLAUSTI_PRIES_LIPNU"] = self.klausti_lipnu.get()
        nauji["PAPRASTAS_SPALVOTAI"] = self.spalvotai.get()
        nauji["NARSYKLE"] = nauji["NARSYKLE"].strip().lower() or "auto"
        if nauji["NARSYKLE"] not in ("auto", "chrome", "brave", "edge"):
            raise ValueError("Naršyklė turi būti: auto, chrome, brave arba edge")
        import re
        if not re.fullmatch(r"\s*[12]\s*:\s*(paprastas|lipnus)\s*(,\s*[12]\s*:\s*(paprastas|lipnus)\s*)*",
                            nauji["SPAUSDINIMO_PLANAS"].lower()):
            raise ValueError("„Ką kaip spausdinti“ turi būti pvz.: 1:paprastas, 1:lipnus, 2:lipnus")
        nauji["EXCEL_FAILAS"] = self.excel_kelias.get()
        nauji["TEKSTAI"] = {k: v.get().strip() for k, v in self.tekstu_kint.items()}
        try:
            dt.date(2026, 9, 22).strftime(nauji["DATOS_FORMATAS"])
        except ValueError:
            raise ValueError("Neteisingas datos formatas")
        return nauji

    def issaugoti_nustatymus(self):
        try:
            N.issaugoti(self._surinkti())
        except ValueError as e:
            messagebox.showerror(PAVADINIMAS, str(e))
            return
        self.log("✔ Nustatymai išsaugoti.")
        self.perskaityti()

    # --- eNEWS užrašai --------------------------------------------------------------------

    # --- Dokumentai → Excel -------------------------------------------------------------------

    DOK_STULPELIAI = [("failas", "Failas", 150), ("vin", "VIN", 150), ("numeris", "Numeris", 70),
                      ("kodas", "Testo kodas", 170), ("pdi", "PDI data", 85), ("tech", "Tech. (B)", 85),
                      ("pastabos", "Pastabos", 420)]

    def _dokumentu_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=10)
        knyga.add(f, text="  Dokumentai → Excel  ")
        self.dok_failai: list[Path] = []
        self.dok_eilutes: list = []
        self.dok_be_qa: list = []
        ttk.Label(f, wraplength=1150, justify="left", text=(
            "Sumeskite iš el. laiško gautus PDF: QA lapus (PDI + akumuliatoriaus testas) ir technikos pasų "
            "PDF – nesvarbu kokia tvarka, robotas pats atpažins, kuris yra kuris. Tekstas skaitomas šiame "
            "kompiuteryje (be interneto, be DI). Ranka rašytą PDI datą patikrinkite / įveskite: dukart "
            "spustelėkite eilutę. Sukurtame Excel šalia kiekvienos mašinos įdėtos iškarpos iš dokumentų – "
            "galėsite akimis palyginti.")).pack(fill="x")
        mygt = ttk.Frame(f)
        mygt.pack(fill="x", pady=6)
        ttk.Button(mygt, text="Pridėti PDF…", command=self.dok_prideti).pack(side="left")
        ttk.Button(mygt, text="Visi PDF iš aplanko…", command=self.dok_is_aplanko).pack(side="left", padx=6)
        ttk.Button(mygt, text="Išvalyti", command=self.dok_isvalyti).pack(side="left")
        self.b_dok_skaityti = ttk.Button(mygt, text="① Skaityti dokumentus", command=self.dok_skaityti)
        self.b_dok_skaityti.pack(side="left", padx=12)
        self.b_dok_excel = ttk.Button(mygt, text="② Sukurti Excel ir naudoti robotui", style="Didelis.TButton",
                                      command=self.dok_sukurti_excel, state="disabled")
        self.b_dok_excel.pack(side="right")

        self.dok_sarasas = tk.Listbox(f, height=5)
        self.dok_sarasas.pack(fill="x")
        if DND_FILES:
            self.dok_sarasas.insert("end", "  ⇩ Nutempkite PDF failus čia (arba „Pridėti PDF…“)")
        else:
            self.dok_sarasas.insert("end", "  Failų tempimas pele dar neįdiegtas – spauskite „Pridėti PDF…“ "
                                           "arba „① Skaityti dokumentus“ (pasiūlys įdiegti).")
        self.dok_tempimo_vieta = f
        self.dok_info = tk.StringVar(value="Failų: 0")
        ttk.Label(f, textvariable=self.dok_info).pack(fill="x", pady=4)

        lent = ttk.Frame(f)
        lent.pack(fill="both", expand=True)
        self.dok_lent = lent
        self.dok_medis = ttk.Treeview(lent, columns=[c for c, _, _ in self.DOK_STULPELIAI], show="headings")
        for c, pav, w in self.DOK_STULPELIAI:
            self.dok_medis.heading(c, text=pav)
            self.dok_medis.column(c, width=w, stretch=(c == "pastabos"))
        self.dok_medis.tag_configure("klaida", background="#f8d0d0")
        self.dok_medis.tag_configure("ispejimas", background="#fff3c4")
        sb = ttk.Scrollbar(lent, command=self.dok_medis.yview)
        self.dok_medis.configure(yscrollcommand=sb.set)
        self.dok_medis.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.dok_medis.bind("<Double-1>", lambda e: self.dok_taisyti())
        if DND_FILES:
            for w in (f, self.dok_sarasas, self.dok_medis):
                try:
                    w.drop_target_register(DND_FILES)
                    w.dnd_bind("<<Drop>>", lambda e: self.dok_prideti_kelius(self.tk.splitlist(e.data)))
                except Exception as e:  # noqa: BLE001
                    logging.getLogger("robotas").warning("Tempimas neveikia: %s", e)

    def dok_prideti_kelius(self, keliai):
        if not self.dok_failai:
            self.dok_sarasas.delete(0, "end")
        for k in keliai:
            k = Path(k)
            kandidatai = sorted(k.glob("*.pdf")) + sorted(k.glob("*.PDF")) if k.is_dir() else [k]
            for kk in kandidatai:
                if kk.suffix.lower() == ".pdf" and kk not in self.dok_failai:
                    self.dok_failai.append(kk)
                    self.dok_sarasas.insert("end", str(kk))
        self.dok_info.set(f"Failų: {len(self.dok_failai)}")

    def dok_prideti(self):
        keliai = filedialog.askopenfilenames(filetypes=[("PDF", "*.pdf"), ("Visi", "*.*")])
        if keliai:
            self.dok_prideti_kelius(keliai)

    def dok_is_aplanko(self):
        kelias = filedialog.askdirectory()
        if kelias:
            self.dok_prideti_kelius([kelias])

    def dok_isvalyti(self):
        self.dok_failai.clear()
        self.dok_eilutes = []
        self.dok_sarasas.delete(0, "end")
        self.dok_medis.delete(*self.dok_medis.get_children())
        self.b_dok_excel.configure(state="disabled")
        self.dok_info.set("Failų: 0")

    def dok_skaityti(self):
        if not self.dok_failai:
            messagebox.showinfo(PAVADINIMAS, "Pirma pridėkite PDF failus.")
            return
        try:
            import dokumentai  # noqa: F401
            import fitz  # noqa: F401
            import rapidocr_onnxruntime  # noqa: F401
        except Exception as e:  # noqa: BLE001 – ir DLL klaidos (ImportError / OSError)
            if not Path(__file__).with_name("dokumentai.py").exists():
                messagebox.showerror(PAVADINIMAS, "Trūksta failo dokumentai.py – skirtuke „Mašinos“ spauskite "
                                                  "„⟳ Atnaujinti robotą“ dar kartą.")
                return
            if messagebox.askyesno(PAVADINIMAS, "Teksto atpažinimo programa dar neįdiegta "
                                                f"({type(e).__name__}: {e}).\n\nĮdiegti dabar? Reikia interneto, "
                                                "užtruks 1–3 min. (~150 MB)."):
                self.idiegti_bibliotekas()
            return
        self.b_dok_skaityti.configure(state="disabled")
        self.b_dok_excel.configure(state="disabled")
        failai = list(self.dok_failai)

        def darbas():
            import dokumentai
            try:
                qa, pasai = dokumentai.skaityti_failus(failai, lambda t: self.eile.put(("dok_progresas", t)))
                self.eile.put(("dok_baigta", (qa, pasai, None)))
            except Exception as e:  # noqa: BLE001
                logging.getLogger("robotas").exception("Dokumentų skaitymas: %s", e)
                self.eile.put(("dok_baigta", ([], [], str(e))))

        self.dok_info.set("Skaitoma… (vienas puslapis ~2–3 s)")
        threading.Thread(target=darbas, daemon=True).start()

    def idiegti_bibliotekas(self):
        """pip install -r requirements.txt – eiga rodoma žurnale (skirtukas „Mašinos“)."""
        import subprocess
        self.b_dok_skaityti.configure(state="disabled")
        self.dok_info.set("Diegiama… (eiga – skirtuko „Mašinos“ žurnale apačioje)")
        self.log("Diegiamos bibliotekos (pip install -r requirements.txt)…")

        def darbas():
            kom = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                   "-r", str(Path(__file__).with_name("requirements.txt"))]
            try:
                p = subprocess.Popen(kom, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     encoding="utf-8", errors="replace",
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                paskutines = []
                for eil in p.stdout:
                    eil = eil.rstrip()
                    if eil:
                        paskutines = (paskutines + [eil])[-15:]
                        if eil.startswith(("Collecting", "Successfully", "ERROR", "error")):
                            self.eile.put(("log", "   " + eil))
                kodas = p.wait()
            except Exception as e:  # noqa: BLE001
                kodas, paskutines = -1, [str(e)]
            self.eile.put(("dok_idiegta", (kodas, "\n".join(paskutines))))

        threading.Thread(target=darbas, daemon=True).start()

    def _dok_idiegta(self, kodas: int, isvestis: str):
        self.b_dok_skaityti.configure(state="normal")
        if kodas != 0:
            self.dok_info.set("✖ Nepavyko įdiegti – žr. žurnalą.")
            self.log("✖ Diegimas nepavyko:\n" + isvestis)
            messagebox.showerror(PAVADINIMAS, "Nepavyko įdiegti bibliotekų (gal įmonės tinklas blokuoja "
                                              "pypi.org?). Paskutinės eilutės:\n\n" + isvestis[-1200:])
            return
        self.log("✔ Bibliotekos įdiegtos.")
        self.dok_info.set("✔ Įdiegta. Uždarykite ir vėl paleiskite robotą (kad veiktų ir tempimas pele).")
        if messagebox.askyesno(PAVADINIMAS, "Įdiegta. Paleisti robotą iš naujo dabar?\n"
                                            "(Kad veiktų failų tempimas pele.)"):
            import subprocess
            subprocess.Popen([sys.executable, str(Path(__file__).resolve())], cwd=str(Path(__file__).parent))
            self.destroy()

    def _dok_baigta(self, qa, pasai, klaida):
        import dokumentai
        self.b_dok_skaityti.configure(state="normal")
        if klaida:
            self.dok_info.set(f"✖ Klaida: {klaida}")
            return
        self.dok_eilutes = dokumentai.sujungti(qa, pasai)
        self.dok_be_qa = dokumentai.be_qa(qa, pasai)
        self._dok_rodyti()
        self.b_dok_excel.configure(state="normal" if self.dok_eilutes else "disabled")

    def _dok_rodyti(self):
        self.dok_medis.delete(*self.dok_medis.get_children())
        for i, e in enumerate(self.dok_eilutes):
            p = e.pasas
            pastabos = e.qa.pastabos + e.pastabos
            zyma = "klaida" if e.blokuota else ("ispejimas" if pastabos else "")
            self.dok_medis.insert("", "end", iid=str(i), tags=(zyma,), values=(
                e.qa.failas, e.qa.vin, p.numeris if p else "", "-".join(e.qa.kodas).strip("-"),
                e.qa.pdi_data.isoformat() if e.qa.pdi_data else "?",
                p.b_data.isoformat() if p and p.b_data else "?", "; ".join(pastabos)))
        truksta = sum(1 for e in self.dok_eilutes if e.blokuota)
        self.dok_info.set(f"QA lapų: {len(self.dok_eilutes)}, iš jų trūksta duomenų: {truksta}.  "
                          f"Technikos pasų be QA lapo: {len(self.dok_be_qa)}"
                          + ("  – dukart spustelėkite raudoną / geltoną eilutę" if truksta else ""))

    def dok_taisyti(self):
        sel = self.dok_medis.selection()
        if sel:
            DokumentoLangas(self, self.dok_eilutes[int(sel[0])])

    def dok_sukurti_excel(self):
        import dokumentai
        aplankas = robotas.darbalaukis() / "eNEWS partijos"
        aplankas.mkdir(parents=True, exist_ok=True)
        kelias = aplankas / f"partija_{dt.datetime.now():%Y-%m-%d_%H%M}.xlsx"
        try:
            dokumentai.sukurti_excel(self.dok_eilutes, kelias, N, self.dok_be_qa)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(PAVADINIMAS, f"Nepavyko sukurti Excel:\n{e}")
            return
        self.log(f"Sukurtas partijos Excel: {kelias}")
        truksta = sum(1 for e in self.dok_eilutes if e.blokuota)
        if messagebox.askyesno(PAVADINIMAS, f"Sukurta:\n{kelias}\n\n"
                               + (f"Dar trūksta duomenų {truksta} mašinoms (geltoni langeliai) – robotas jų "
                                  "nedarys, kol neįrašysite.\n\n" if truksta else "")
                               + "Naudoti šį Excel robotui dabar?"):
            self.excel_kelias.set(str(kelias))
            nauji = N.dabartines()
            nauji["EXCEL_FAILAS"] = str(kelias)
            N.issaugoti(nauji)
            self.perskaityti()
            self.knyga.select(0)
        if messagebox.askyesno(PAVADINIMAS, "Atidaryti Excel ir peržiūrėti iškarpas?\n\n"
                                            "(Pataisę – išsaugokite, UŽDARYKITE ir spauskite „Perskaityti“.)"):
            if sys.platform == "win32":
                os.startfile(kelias)  # noqa: S606

    # --- PDI lapai ------------------------------------------------------------------------

    def _pdi_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=10)
        knyga.add(f, text="  PDI lapai  ")
        ttk.Label(f, wraplength=1100, justify="left", text=(
            "Atsisiunčia tik PDI lapus: kiekvienam VIN – Automobilis → PDI → varnelė prie VEIKIMAS → "
            "„Išsaugoti ir spausdinti“, PDF išsaugomas aplanke pagal šios dienos datą. "
            "VIN įklijuokite žemiau (bet kaip – po vieną eilutėje, per kablelį, kartu su kitu tekstu) "
            "arba paimkite iš Excel failo.")).pack(fill="x")
        mygt = ttk.Frame(f)
        mygt.pack(fill="x", pady=6)
        ttk.Button(mygt, text="Iš Excel failo…", command=self.pdi_is_excel).pack(side="left")
        ttk.Button(mygt, text="Iš pažymėtų eilučių (Mašinos)", command=self.pdi_is_pazymetu).pack(side="left", padx=6)
        ttk.Button(mygt, text="Išvalyti", command=lambda: (self.pdi_vinai.delete("1.0", "end"),
                                                          self.pdi_skaiciuoti())).pack(side="left")
        self.b_pdi = ttk.Button(mygt, text="▶ Atsisiųsti PDI lapus", style="Didelis.TButton",
                                command=self.pdi_pradeti)
        self.b_pdi.pack(side="right")
        ttk.Button(mygt, text="Atidaryti aplanką", command=self.pdi_atidaryti_aplanka).pack(side="right", padx=6)
        self.pdi_vinai = tk.Text(f, height=16, font=("Consolas", 10), wrap="word")
        self.pdi_vinai.pack(fill="both", expand=True)
        self.pdi_vinai.bind("<<Modified>>", lambda e: (self.pdi_skaiciuoti(), self.pdi_vinai.edit_modified(False)))
        self.pdi_info = tk.StringVar()
        ttk.Label(f, textvariable=self.pdi_info).pack(fill="x", pady=(6, 0))
        self.pdi_skaiciuoti()

    def _pdi_vinai(self) -> list[str]:
        return robotas.vinai_is_teksto(self.pdi_vinai.get("1.0", "end"))

    def pdi_skaiciuoti(self):
        vinai = self._pdi_vinai()
        kur = (netikras_enews.ARCH / "pdi_lapai") if self.bandymas.get() else robotas.pdi_aplankas().parent
        self.pdi_info.set(f"Rasta VIN: {len(vinai)}   →   {kur}\\{dt.date.today():%Y-%m-%d}"
                          + ("   (BANDYMAS – netikras eNEWS)" if self.bandymas.get() else ""))

    def pdi_is_excel(self):
        kelias = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx *.xlsm"), ("Visi", "*.*")])
        if not kelias:
            return
        try:
            vinai = robotas.vinai_is_excel(kelias)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(PAVADINIMAS, f"Nepavyko perskaityti Excel (ar jis uždarytas?):\n{e}")
            return
        self.pdi_vinai.insert("end", ("\n" if self._pdi_vinai() else "") + "\n".join(vinai))
        self.log(f"Iš {Path(kelias).name} paimta VIN: {len(vinai)}")

    def pdi_is_pazymetu(self):
        vinai = [m.vin for m in self.masinos if str(m.eilute) in set(self.medis.selection())]
        if not vinai:
            messagebox.showinfo(PAVADINIMAS, "Skirtuke „Mašinos“ pažymėkite eilutes (Ctrl/Shift + pelė).")
            return
        self.pdi_vinai.insert("end", ("\n" if self._pdi_vinai() else "") + "\n".join(vinai))

    def pdi_atidaryti_aplanka(self):
        kur = robotas.pdi_aplankas()
        kur.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(kur)  # noqa: S606

    def pdi_pradeti(self):
        if self.gija and self.gija.is_alive():
            return
        vinai = self._pdi_vinai()
        if not vinai:
            messagebox.showinfo(PAVADINIMAS, "Įklijuokite VIN arba paimkite juos iš Excel.")
            return
        if self.perziura.get():
            messagebox.showinfo(PAVADINIMAS, "PDI lapams peržiūros režimo nėra – nuimkite „PERŽIŪRA“.")
            return
        if not self.bandymas.get() and not messagebox.askyesno(
                PAVADINIMAS, f"Atsisiųsti {len(vinai)} PDI lap. iš TIKRO eNEWS?\n\n"
                             "Robotas kiekvienam pažymės VEIKIMAS ir paspaus „Išsaugoti ir spausdinti“."):
            return
        self.valdymas.stabdyti.clear()
        self.valdymas.zingsniais = self.zingsniais.get()
        self._dirba(True)
        self.b_pdi.configure(state="disabled")
        self.knyga.select(0)  # „Mašinos“ – ten „Tęsti“, „Stabdyti“ ir žurnalas
        self.log(f"▶ PDI lapai: {len(vinai)} VIN.")
        self.gija = threading.Thread(target=self._vykdyti,
                                     args=(robotas.vykdyti_pdi_lapus, vinai, self.bandymas.get()), daemon=True)
        self.gija.start()

    def _tekstu_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=10)
        knyga.add(f, text="  eNEWS užrašai  ")
        ttk.Label(f, wraplength=1000, justify="left", text=(
            "Pagal šiuos užrašus robotas eNEWS randa mygtukus ir laukelius. Jei Nissan pakeis pavadinimą "
            "(pvz. „Validate“ → „Patvirtinti“), pakeiskite jį čia. Kelias galimybes atskirkite „ | “.")
        ).pack(fill="x", pady=(0, 8))
        tinklas = ttk.Frame(f)
        tinklas.pack(fill="x")
        self.tekstu_kint: dict[str, tk.StringVar] = {}
        for r, (k, pav) in enumerate(N.TEKSTU_PAVADINIMAI.items()):
            ttk.Label(tinklas, text=pav).grid(row=r // 2, column=(r % 2) * 2, sticky="w", pady=2, padx=(0, 6))
            v = tk.StringVar(value=N.TEKSTAI[k])
            self.tekstu_kint[k] = v
            ttk.Entry(tinklas, textvariable=v, width=38).grid(row=r // 2, column=(r % 2) * 2 + 1,
                                                              sticky="w", padx=(0, 20))
        m = ttk.Frame(f)
        m.pack(fill="x", pady=10)
        ttk.Button(m, text="Išsaugoti", style="Didelis.TButton", command=self.issaugoti_nustatymus).pack(side="left")
        ttk.Button(m, text="Atstatyti numatytuosius", command=self.atstatyti_tekstus).pack(side="left", padx=6)

    def atstatyti_tekstus(self):
        for k, v in self.tekstu_kint.items():
            v.set(N.NUMATYTIEJI["TEKSTAI"][k])

    # --- Pagalba ---------------------------------------------------------------------------

    def _pagalbos_skirtukas(self, knyga):
        f = ttk.Frame(knyga, padding=12)
        knyga.add(f, text="  Pagalba  ")
        t = tk.Text(f, wrap="word", font=("Segoe UI", 10), relief="flat")
        t.pack(fill="both", expand=True)
        t.insert("end", PAGALBA)
        t.configure(state="disabled")


def _paveikslelis(png: bytes, max_plotis: int = 560):
    """PNG baitai → Tk paveikslėlis (sumažintas, jei per platus)."""
    import io
    from PIL import Image, ImageTk
    img = Image.open(io.BytesIO(png))
    if img.width > max_plotis:
        img = img.resize((max_plotis, int(img.height * max_plotis / img.width)))
    return ImageTk.PhotoImage(img)


class DokumentoLangas(tk.Toplevel):
    """Iškarpos + PDI datos (ir kitų laukų) įvedimas vienai mašinai."""

    def __init__(self, tevas: Langas, e):
        super().__init__(tevas)
        self.tevas, self.e = tevas, e
        self.title(f"{e.qa.failas} – patikrinimas")
        self.transient(tevas)
        self.vaizdai = []
        f = ttk.Frame(self, padding=12)
        f.pack(fill="both", expand=True)
        for r, (pav, png) in enumerate((("PDI data (ranka):", e.qa.pdi_iskarpa),
                                        ("Akumuliatoriaus testas:", e.qa.kodo_iskarpa),
                                        ("Technikos pasas:", e.pasas.iskarpa if e.pasas else b""))):
            ttk.Label(f, text=pav).grid(row=r, column=0, sticky="nw", padx=(0, 8), pady=4)
            if png:
                v = _paveikslelis(png)
                self.vaizdai.append(v)
                tk.Label(f, image=v, relief="solid", borderwidth=1).grid(row=r, column=1, sticky="w", pady=4)
            else:
                ttk.Label(f, text="(nerasta)").grid(row=r, column=1, sticky="w")
        p = e.pasas
        self.lauk = {}
        for r, (k, pav, v) in enumerate((
                ("pdi", "PDI data (pvz. 261103 arba 2026-11-03):", e.qa.pdi_data.isoformat() if e.qa.pdi_data else ""),
                ("kodas", "Testo kodas:", "-".join(e.qa.kodas).strip("-")),
                ("vin", "VIN:", e.qa.vin),
                ("numeris", "Numeris:", p.numeris if p else ""),
                ("tech", "Tech. pradžia (B):", p.b_data.isoformat() if p and p.b_data else "")), start=3):
            ttk.Label(f, text=pav).grid(row=r, column=0, sticky="w", pady=2)
            sv = tk.StringVar(value=v)
            ent = ttk.Entry(f, textvariable=sv, width=30, font=("Consolas", 11))
            ent.grid(row=r, column=1, sticky="w", pady=2)
            self.lauk[k] = sv
            if k == "pdi":
                ent.focus_set()
                ent.select_range(0, "end")
        if p is None:
            ttk.Label(f, foreground="#b00", text="Technikos pasas nerastas – numerį ir B datą įrašykite patys.").grid(
                row=8, column=0, columnspan=2, sticky="w")
        m = ttk.Frame(f)
        m.grid(row=9, column=0, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Button(m, text="Gerai", style="Didelis.TButton", command=self.issaugoti).pack(side="left")
        ttk.Button(m, text="Atšaukti", command=self.destroy).pack(side="left", padx=6)
        self.bind("<Return>", lambda ev: self.issaugoti())
        self.bind("<Escape>", lambda ev: self.destroy())

    def issaugoti(self):
        import dokumentai
        e = self.e
        pdi = dokumentai.ivesta_data(self.lauk["pdi"].get()) if self.lauk["pdi"].get().strip() else None
        if self.lauk["pdi"].get().strip() and pdi is None:
            messagebox.showerror(PAVADINIMAS, "Neatpažinta PDI data. Rašykite pvz. 261103 arba 2026-11-03.",
                                 parent=self)
            return
        tech = dokumentai.ivesta_data(self.lauk["tech"].get()) if self.lauk["tech"].get().strip() else None
        kodas = dokumentai.KODAS_RE.search(self.lauk["kodas"].get().replace(" ", "").upper())
        if self.lauk["kodas"].get().strip() and not kodas:
            messagebox.showerror(PAVADINIMAS, "Kodas turi būti trijų dalių, pvz. AB12C-1D23E4-F5G67.", parent=self)
            return
        if pdi:
            dokumentai.ivesti_pdi(e.qa, pdi)
        if kodas:
            e.qa.kodas = (kodas.group(1), kodas.group(2), kodas.group(3))
        e.qa.vin = self.lauk["vin"].get().strip().upper()
        numeris = self.lauk["numeris"].get().strip().upper().replace(" ", "")
        if e.pasas is None and (numeris or tech):
            e.pasas = dokumentai.Pasas(failas="(įvesta ranka)", puslapis=0, vin=e.qa.vin)
            e.pastabos = [x for x in e.pastabos if "nerastas" not in x]
        if e.pasas:
            e.pasas.numeris = numeris
            e.pasas.b_data = tech
        self.tevas._dok_rodyti()
        self.destroy()


class TaisymoLangas(tk.Toplevel):
    def __init__(self, tevas: Langas, m: Masina):
        super().__init__(tevas)
        self.tevas, self.m = tevas, m
        self.title(f"{m.eilute} eil. taisymas")
        self.resizable(False, False)
        self.transient(tevas)
        f = ttk.Frame(self, padding=12)
        f.pack()
        self.v = {
            "vin": tk.StringVar(value=m.vin),
            "kodas1": tk.StringVar(value=m.kodas[0]), "kodas2": tk.StringVar(value=m.kodas[1]),
            "kodas3": tk.StringVar(value=m.kodas[2]),
            "pdi": tk.StringVar(value=m.pdi_data.strftime("%m.%d") if m.pdi_data else ""),
            "tech": tk.StringVar(value=m.garantija.strftime("%m.%d") if m.garantija else ""),
            "numeris": tk.StringVar(value=m.numeris),
        }
        ttk.Label(f, text="VIN").grid(row=0, column=0, sticky="w")
        ttk.Entry(f, textvariable=self.v["vin"], width=24).grid(row=0, column=1, columnspan=5, sticky="w", pady=3)
        ttk.Label(f, text="Midtronics kodas").grid(row=1, column=0, sticky="w")
        for i in range(3):
            ttk.Entry(f, textvariable=self.v[f"kodas{i+1}"], width=9).grid(row=1, column=1 + i * 2, pady=3)
            if i < 2:
                ttk.Label(f, text="-").grid(row=1, column=2 + i * 2)
        for r, (k, pav) in enumerate((("pdi", "PDI data (MM.DD)"), ("tech", "Tech. pradžia (MM.DD)"),
                                      ("numeris", "Valst. numeris")), start=2):
            ttk.Label(f, text=pav).grid(row=r, column=0, sticky="w")
            ttk.Entry(f, textvariable=self.v[k], width=12).grid(row=r, column=1, columnspan=2, sticky="w", pady=3)
        self.perziura = tk.StringVar()
        ttk.Label(f, textvariable=self.perziura, foreground="#1f4e8c").grid(row=5, column=0, columnspan=6,
                                                                            sticky="w", pady=6)
        for v in self.v.values():
            v.trace_add("write", lambda *a: self.atnaujinti())
        self.atnaujinti()
        m_ = ttk.Frame(f)
        m_.grid(row=6, column=0, columnspan=6, sticky="e")
        ttk.Button(m_, text="Atšaukti", command=self.destroy).pack(side="right")
        ttk.Button(m_, text="Išsaugoti į Excel", command=self.issaugoti).pack(side="right", padx=6)
        self.grab_set()

    def atnaujinti(self):
        pdi = menuo_diena(self.v["pdi"].get(), dt.date.today())
        tech = menuo_diena(self.v["tech"].get(), dt.date.today())
        kodas = "-".join(self.v[f"kodas{i}"].get().strip().upper() for i in (1, 2, 3))
        f = N.DATOS_FORMATAS
        self.perziura.set(f"eNEWS bus įvesta: kodas {kodas},  PDI {pdi.strftime(f) if pdi else '✖ neaiški'},  "
                          f"garantija {tech.strftime(f) if tech else '✖ neaiški'}")

    def issaugoti(self):
        reiksmes = {k: v.get().strip().upper() for k, v in self.v.items()}
        for k in ("pdi", "tech"):
            if reiksmes[k] and menuo_diena(reiksmes[k], dt.date.today()) is None:
                messagebox.showerror(PAVADINIMAS, "Data turi būti MM.DD, pvz. 09.24", parent=self)
                return
        senos = {"vin": self.m.vin, "kodas1": self.m.kodas[0], "kodas2": self.m.kodas[1],
                 "kodas3": self.m.kodas[2], "numeris": self.m.numeris,
                 "pdi": self.m.pdi_data.strftime("%m.%d") if self.m.pdi_data else "",
                 "tech": self.m.garantija.strftime("%m.%d") if self.m.garantija else ""}
        pakeista = {k: v for k, v in reiksmes.items() if v != senos[k]}
        self.destroy()
        if pakeista:
            self.tevas.irasyti_pataisyma(self.m, pakeista)


PAGALBA = """KAIP NAUDOTIS

DOKUMENTAI → EXCEL (kad nereiktų perrašinėti ranka)
   Skirtuke „Dokumentai → Excel“ sumeskite iš el. laiško išsaugotus PDF: QA lapus ir technikos
   pasų PDF. „① Skaityti dokumentus“ – robotas pats atpažins VIN, testo kodą, testo rezultatą,
   numerį (A) ir tech. pradžią (B). Ranka rašytą PDI datą patikrinkite / įveskite (dukart
   spustelėkite eilutę – matysite iškarpą). „② Sukurti Excel ir naudoti robotui“ – nauja partijos
   Excel darbalaukyje, aplanke „eNEWS partijos“; dešinėje – iškarpos iš dokumentų patikrai,
   geltoni langeliai – trūksta arba spėta, patikrinkite.

1. Excel failą pildykite kaip įprasta, IŠSAUGOKITE ir UŽDARYKITE.
2. Čia spauskite „Perskaityti“ – lentelėje matysite mašinas, kurias robotas darys.
     • raudonos (✖) – su klaida, robotas jų NEDARYS, kol nepataisysite;
     • geltonos (!) – robotas darys, bet verta pažiūrėti (pvz. numeris ne ABC123 / EA1234 formos);
     • baltos – paruoštos.
   Dukart spustelėjus eilutę galima pataisyti kodą, datas ar numerį – pakeitimas įrašomas į Excel.
3. „✔ Tikrinti“ – patikrina ir kompiuterį: ar uždarytas Excel, ar yra Chrome ir
   spausdintuvai („Lipnus“).
4. „▶ Pradėti“. Atsidarys Chrome – prisijunkite prie Nissan B2B, atsidarykite ENEWS ir
   spauskite „Tęsti“. Toliau robotas dirba pats; lentelėje matosi, kurią mašiną daro, apačioje –
   kiekvienas veiksmas.
5. „■ Stabdyti“ – sustabdo; nebaigta mašina lieka nenuspalvinta ir bus daroma kitą kartą.

PIRMĄ KARTĄ: pažymėkite „Žingsniais“ ir vieną eilutę su „Tik pažymėtos eilutės“. Robotas prieš
kiekvieną veiksmą lauks „Tęsti“, todėl matysite, ar viskas eina teisingai.

JEI ROBOTAS NERANDA MYGTUKO: „eNEWS užrašai“ skirtuke patikrinkite pavadinimą. Jei nepadeda –
„Diagnostika“: eikite per eNEWS langus, kiekviename spauskite „Tęsti“, baigę „Stabdyti“.
Aplanką „diagnostika“ suarchyvuokite ir atsiųskite.

SPALVOS EXCEL'YJE
     žalia – atlikta;  oranžinė – akumuliatorius ne „Good battery“ / kodas netinka;
     raudona – kita klaida (priežastis stulpelyje „Būsena“, nuotrauka aplanke „klaidos“).
Pakeitus akumuliatorių: įrašykite naują kodą, eilutei – dešinys pelės mygtukas →
„Daryti iš naujo“.

APSAUGOS
     • Prieš darbą – Excel atsarginė kopija (failas.atsargine-….xlsx).
     • Eilutės su klaidomis ar pasikartojančiu kodu / VIN / numeriu nedaromos.
     • eNEWS tikrinama, ar atidaryta būtent ta mašina, ir ar po išsaugojimo matosi numeris ir data.
     • Jau įvestas akumuliatoriaus kodas antrą kartą nevedamas.
"""


def main():
    Langas().mainloop()


if __name__ == "__main__":
    main()
