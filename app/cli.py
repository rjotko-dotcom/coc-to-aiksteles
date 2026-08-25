"""Komandinės eilutės įrankis: CoC PDF -> pažymos (aikštelės) .docx.

Pavyzdžiai:
    python -m app.cli CoC.pdf
    python -m app.cli *.pdf -o out --template data/template.docx
    python -m app.cli CoC.pdf --json          # tik ištraukti duomenys
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from .aikstele_docx import (
    analyse_template,
    build_document,
    build_values,
    fill_template,
    suggested_filename,
)
from .coc_extract import extract_from_pdf


def _check_template(path: str) -> int:
    """Parodo, ką programa atpažįsta pažymos šablone."""
    report = analyse_template(Path(path).read_bytes())
    print(f"Šablonas: {path}")
    print(f"Lentelių: {report['tables']}, reikšmių stulpelis: {report['value_column']}")
    print(f"Atpažintos eilutės ({len(report['recognised'])} iš 8):")
    for name, label in report["recognised"].items():
        print(f"  + {name}  <-  „{label}“")
    if report["placeholders"]:
        print("Žymekliai:", ", ".join(report["placeholders"]))
    if report["missing"]:
        print("Neatpažinta (teks pildyti ranka arba įdėti žymeklį):")
        for name in report["missing"]:
            print(f"  - {name}")
    print("Datos langeliai:", "rasta" if report["date_boxes"] else "nerasta")
    return 0 if not report["missing"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CoC PDF -> aikštelės .docx")
    parser.add_argument("pdfs", nargs="*", help="CoC PDF failai")
    parser.add_argument("-o", "--out", default=".", help="katalogas rezultatams")
    parser.add_argument("-t", "--template", help="pažymos .docx šablonas")
    parser.add_argument("-d", "--date", default=date.today().isoformat(), help="pažymos data")
    parser.add_argument("--company", default="", help="įmonės eilutė (be šablono)")
    parser.add_argument("--json", action="store_true", help="tik parodyti duomenis (JSON)")
    parser.add_argument(
        "--check-template",
        metavar="DOCX",
        help="patikrinti pažymos šabloną (ką programa jame atpažįsta)",
    )
    args = parser.parse_args(argv)

    if args.check_template:
        return _check_template(args.check_template)

    if not args.pdfs:
        parser.error("nurodykite bent vieną CoC PDF failą")

    template_bytes = Path(args.template).read_bytes() if args.template else None
    out_dir = Path(args.out)
    exit_code = 0

    for pdf in args.pdfs:
        try:
            data = extract_from_pdf(pdf)
        except Exception as exc:
            print(f"{pdf}: KLAIDA – {exc}", file=sys.stderr)
            exit_code = 1
            continue

        if args.json:
            print(json.dumps(data.to_dict(), ensure_ascii=False, indent=2))
            continue

        values = build_values(data.to_dict(), doc_date=args.date)
        if template_bytes is not None:
            content, warnings = fill_template(template_bytes, values)
        else:
            content, warnings = build_document(values, company_line=args.company), []

        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / suggested_filename(values)
        target.write_bytes(content)
        print(f"{pdf} -> {target}")
        for warning in list(data.warnings) + warnings:
            print(f"    ! {warning}")
            exit_code = max(exit_code, 0)

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
