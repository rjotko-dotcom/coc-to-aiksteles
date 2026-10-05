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
from excel_eiles import Masina, Sarasas, menuo_diena, uzrakintas

PAVADINIMAS = "eNEWS robotas"


class LangoValdymas(robotas.Valdymas):
    """Robotas (atskiroje gijoje) kalbasi su langu per eilę."""

    def __init__(self, eile: queue.Queue):
        super().__init__()
        self.eile = eile
        self.testi = threading.Event()

    def klausti(self, tekstas: str) -> None:
        self.testi.clear()
        self.eile.put(("klausimas", tekstas))
        while not self.testi.wait(0.2):
            if self.stabdyti.is_set():
                raise robotas.Sustabdyta()
        self.eile.put(("klausimas", ""))

    def busena(self, m: Masina, tekstas: str) -> None:
        self.eile.put(("busena", (m.eilute, tekstas)))


class EilesZurnalas(logging.Handler):
    def __init__(self, eile: queue.Queue):
        super().__init__()
        self.eile = eile
        self.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))

    def emit(self, record):
        self.eile.put(("log", self.format(record)))


class Langas(tk.Tk):
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
        self._nustatymu_skirtukas(knyga)
        self._tekstu_skirtukas(knyga)
        self._pagalbos_skirtukas(knyga)

        self.after(100, self._skaityti_eile)
        self.after(200, self.perskaityti)

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

    def pasirinkti_excel(self):
        kelias = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx *.xlsm"), ("Visi", "*.*")])
        if kelias:
            self.excel_kelias.set(kelias)
            nauji = N.dabartines()
            nauji["EXCEL_FAILAS"] = kelias
            N.issaugoti(nauji)
            self.perskaityti()

    def atidaryti_excel(self):
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
        varneles = ttk.Frame(f)
        varneles.pack(fill="x", pady=(0, 4))
        self.zingsniais = tk.BooleanVar(value=False)
        self.tik_pazymetos = tk.BooleanVar(value=False)
        self.bandymas = tk.BooleanVar(value=False)
        self.rodyti_visas = tk.BooleanVar(value=False)
        ttk.Checkbutton(varneles, text="Žingsniais (laukti „Tęsti“ prieš kiekvieną veiksmą)",
                        variable=self.zingsniais).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(varneles, text="Tik pažymėtos eilutės", variable=self.tik_pazymetos).pack(side="left", padx=12)
        ttk.Checkbutton(varneles, text="Rodyti ir jau padarytas", variable=self.rodyti_visas,
                        command=self.rodyti).pack(side="left", padx=12)
        ttk.Checkbutton(varneles, text="BANDYMAS be B2B (namuose)", variable=self.bandymas,
                        command=self.perjungti_bandyma).pack(side="left", padx=12)

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
        meniu.add_command(label="Daryti iš naujo (nuimti spalvą)", command=self.is_naujo)
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
            kopija = netikras_enews.paruosti_excel(self.excel_kelias.get())
            self.log(f"BANDYMAS be B2B: netikras eNEWS, dirbama su Excel kopija {kopija.name} "
                     "(tikras failas nepaliečiamas), niekas nespausdinama.")
            self.bandymo_juosta.pack(fill="x", pady=(0, 4), before=self.dalys)
        else:
            self.bandymo_juosta.pack_forget()
            self.log("Bandymas išjungtas – dirbama su tikru Excel ir tikru eNEWS.")
        self.perskaityti()

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
            self.log("✔ Kompiuteris paruoštas (Excel, Chrome, SumatraPDF, spausdintuvai).", "gerai")
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

    def is_naujo(self):
        sel = self.medis.selection()
        if not sel or not self._galima_rasyti():
            return
        if not messagebox.askyesno(PAVADINIMAS, f"Nuimti spalvą nuo {len(sel)} eil.? Robotas jas darys iš naujo."):
            return
        s = Sarasas(self.aktyvus_excel(), N)
        for iid in sel:
            s.nuimti_spalva(int(iid))
        s.issaugoti()
        self.perskaityti()

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
        sarasas = Sarasas(self.aktyvus_excel(), N)
        self.valdymas.stabdyti.clear()
        self.valdymas.zingsniais = self.zingsniais.get()
        self._dirba(True)
        self.log(f"▶ Pradedama: {len(darbo)} mašinų.")
        self.gija = threading.Thread(target=self._vykdyti, args=(robotas.vykdyti, sarasas, darbo, False, self.bandymas.get()),
                                     daemon=True)
        self.gija.start()

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
                        zyma = ("dirbama" if tekstas.endswith("…") else "atlikta" if tekstas.startswith("Atlikta")
                                else "akumas" if tekstas.startswith("Akumuliatorius") else
                                "" if tekstas.startswith("sustabdyta") else "klaida")
                        self.medis.item(str(eil), tags=(zyma,))
                        self.medis.set(str(eil), "busena", tekstas)
                        self.medis.see(str(eil))
                elif rusis == "baigta":
                    self._dirba(False)
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
        eilute(en, 2, "DATOS_FORMATAS", "Datos formatas eNEWS", 12, pastaba="%d/%m/%Y → 22/09/2026")
        eilute(en, 3, "LAUKTI_SEK", "Kiek laukti mygtuko (s)", 8, pastaba="jei eNEWS lėtas – padidinkite")

        sp = ttk.LabelFrame(f, text="Spausdinimas", padding=8)
        sp.pack(fill="x", pady=4)
        spausd = tikrinimas.spausdintuvai() or []
        eilute(sp, 0, "SUMATRA", "SumatraPDF programa", 60, rinktis="exe")
        eilute(sp, 1, "SPAUSDINTUVAS_PAPRASTAS", "Paprastas popierius", 40, reiksmes=[""] + spausd,
               pastaba="tuščias – numatytasis")
        eilute(sp, 2, "NUSTATYMAI_PAPRASTAS", "  papildomai", 20, pastaba="pvz. bin=1")
        eilute(sp, 3, "SPAUSDINTUVAS_LIPNUS", "Lipnus popierius", 40, reiksmes=spausd)
        eilute(sp, 4, "NUSTATYMAI_LIPNUS", "  papildomai", 20, pastaba="pvz. bin=2")
        self.klausti_lipnu = tk.BooleanVar(value=bool(N.KLAUSTI_PRIES_LIPNU))
        ttk.Checkbutton(sp, text="Prieš lipnų spausdinimą sustoti ir paprašyti įdėti lipnų popierių",
                        variable=self.klausti_lipnu).grid(row=5, column=0, columnspan=4, sticky="w", pady=4)

        m = ttk.Frame(f)
        m.pack(fill="x", pady=8)
        ttk.Button(m, text="Išsaugoti nustatymus", style="Didelis.TButton",
                   command=self.issaugoti_nustatymus).pack(side="left")
        ttk.Button(m, text="Patikrinti", command=lambda: (self.issaugoti_nustatymus(), self.tikrinti(),
                                                         self.knyga.select(0))).pack(side="left", padx=6)

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
            elif k == "LAUKTI_SEK":
                nauji[k] = int(t)
            elif k.startswith("STULP_"):
                if not t.isalpha():
                    raise ValueError(f"Stulpelis turi būti raidė: {t!r}")
                nauji[k] = t.upper()
            else:
                nauji[k] = t
        nauji["KLAUSTI_PRIES_LIPNU"] = self.klausti_lipnu.get()
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

1. Excel failą pildykite kaip įprasta, IŠSAUGOKITE ir UŽDARYKITE.
2. Čia spauskite „Perskaityti“ – lentelėje matysite mašinas, kurias robotas darys.
     • raudonos (✖) – su klaida, robotas jų NEDARYS, kol nepataisysite;
     • geltonos (!) – robotas darys, bet verta pažiūrėti (pvz. numeris ne ABC123 formos);
     • baltos – paruoštos.
   Dukart spustelėjus eilutę galima pataisyti kodą, datas ar numerį – pakeitimas įrašomas į Excel.
3. „✔ Tikrinti“ – patikrina ir kompiuterį: ar uždarytas Excel, ar yra Chrome, SumatraPDF ir
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
