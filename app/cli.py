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

from .aikstele_docx import build_document, build_values, fill_template, suggested_filename
from .coc_extract import extract_from_pdf


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CoC PDF -> aikštelės .docx")
    parser.add_argument("pdfs", nargs="+", help="CoC PDF failai")
    parser.add_argument("-o", "--out", default=".", help="katalogas rezultatams")
    parser.add_argument("-t", "--template", help="pažymos .docx šablonas")
    parser.add_argument("-n", "--number", default="", help="pažymos Nr.")
    parser.add_argument("-d", "--date", default=date.today().isoformat(), help="pažymos data")
    parser.add_argument("--company", default="", help="įmonės eilutė (be šablono)")
    parser.add_argument("--json", action="store_true", help="tik parodyti duomenis (JSON)")
    args = parser.parse_args(argv)

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

        values = build_values(data.to_dict(), doc_number=args.number, doc_date=args.date)
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
