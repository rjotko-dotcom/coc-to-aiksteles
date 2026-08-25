"""FastAPI programa: CoC PDF -> pažyma (aikštelė) .docx.

Paleidimas:  uvicorn app.main:app --reload   (arba ./run.sh / run.bat)

Konfidencialumas: programa veikia tik Jūsų kompiuteryje. Įkelti CoC failai
apdorojami atmintyje ir į diską nerašomi, sugeneruota pažyma iškart
grąžinama atsisiuntimui ir serveryje nesaugoma. Į išorę nesikreipiama.
Diske laikomi tik du dalykai, kuriuos įrašote patys: `data/template.docx`
(tuščias Jūsų pažymos blankas) ir `data/settings.json` (įmonės eilutė).
"""

from __future__ import annotations

import io
import ipaddress
import json
import os
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from .aikstele_docx import (
    analyse_template,
    build_document,
    build_values,
    fill_template,
    suggested_filename,
)
from .coc_extract import extract_from_bytes

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR.parent / "data"
TEMPLATE_PATH = DATA_DIR / "template.docx"
SETTINGS_PATH = DATA_DIR / "settings.json"

app = FastAPI(title="CoC → aikštelė", version="1.0.0")

#: Priimame tik vietinius (loopback) prisijungimus, kad duomenys neišeitų iš
#: kompiuterio net ir netyčia paleidus serverį su `--host 0.0.0.0`.
#: Sąmoningam naudojimui tinkle: nustatykite COC_ALLOW_REMOTE=1.
ALLOW_REMOTE = os.environ.get("COC_ALLOW_REMOTE") == "1"


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@app.middleware("http")
async def only_local_clients(request, call_next):
    if not ALLOW_REMOTE and not _is_loopback(request.client.host if request.client else None):
        return JSONResponse(
            {"detail": "Leidžiami tik vietiniai prisijungimai (localhost)."},
            status_code=403,
        )
    return await call_next(request)


def _load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"company_line": ""}


def _save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Modeliai
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    items: list[dict]
    use_template: bool = True
    company_line: str = ""


class SettingsRequest(BaseModel):
    company_line: str = ""


# ---------------------------------------------------------------------------
# Maršrutai
# ---------------------------------------------------------------------------


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/settings")
def get_settings() -> dict:
    settings = _load_settings()
    settings["template_exists"] = TEMPLATE_PATH.exists()
    return settings


@app.post("/api/settings")
def set_settings(payload: SettingsRequest) -> dict:
    settings = _load_settings()
    settings["company_line"] = payload.company_line
    _save_settings(settings)
    return {"ok": True}


@app.post("/api/template")
async def upload_template(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith((".docx", ".dotx")):
        raise HTTPException(400, "Šablonas turi būti .docx arba .dotx failas.")
    content = await file.read()
    try:
        analysis = analyse_template(content)
    except Exception as exc:
        raise HTTPException(400, f"Nepavyko perskaityti šablono: {exc}") from exc

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TEMPLATE_PATH.write_bytes(content)
    return {"ok": True, "name": file.filename, "analysis": analysis}


@app.get("/api/template/check")
def check_template() -> dict:
    """Parodo, ką programa atpažįsta įkeltame šablone."""
    if not TEMPLATE_PATH.exists():
        raise HTTPException(404, "Šablonas neįkeltas.")
    return analyse_template(TEMPLATE_PATH.read_bytes())


@app.delete("/api/template")
def delete_template() -> dict:
    TEMPLATE_PATH.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/extract")
async def extract(files: list[UploadFile] = File(...)) -> JSONResponse:
    """Priima vieną ar kelis CoC PDF ir grąžina ištrauktus duomenis."""
    results = []
    for upload in files:
        name = upload.filename or "coc.pdf"
        if not name.lower().endswith(".pdf"):
            results.append({"source_file": name, "error": "Ne PDF failas."})
            continue
        payload = await upload.read()
        try:
            # Apdorojama tik atmintyje – PDF į diską nerašomas.
            data = extract_from_bytes(payload, source_file=name)
        except Exception as exc:  # netinkamas / apsaugotas / skenuotas PDF
            results.append({"source_file": name, "error": str(exc)})
            continue
        item = data.to_dict()
        item["source_file"] = name
        results.append(item)
    return JSONResponse({"results": results})


@app.post("/api/generate")
def generate(payload: GenerateRequest) -> Response:
    """Suformuoja .docx pažymą(-as). Kelioms – grąžinamas ZIP."""
    if not payload.items:
        raise HTTPException(400, "Nėra duomenų dokumentui.")

    settings = _load_settings()
    company_line = payload.company_line or settings.get("company_line", "")
    use_template = payload.use_template and TEMPLATE_PATH.exists()
    template_bytes = TEMPLATE_PATH.read_bytes() if use_template else None

    documents: list[tuple[str, bytes]] = []
    warnings: list[str] = []
    for item in payload.items:
        values = build_values(item, doc_date=str(item.get("doc_date", "")))
        if template_bytes is not None:
            content, warns = fill_template(template_bytes, values)
            warnings.extend(warns)
        else:
            content = build_document(values, company_line=company_line)
        documents.append((suggested_filename(values), content))

    if len(documents) == 1:
        filename, content = documents[0]
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        if warnings:
            headers["X-Aikstele-Warnings"] = "; ".join(warnings).encode(
                "ascii", "backslashreplace"
            ).decode()
        return Response(
            content,
            media_type=(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
            headers=headers,
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        used: set[str] = set()
        for filename, content in documents:
            unique, counter = filename, 2
            while unique in used:
                unique = filename.replace(".docx", f"_{counter}.docx")
                counter += 1
            used.add(unique)
            archive.writestr(unique, content)
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="aiksteles.zip"'},
    )
