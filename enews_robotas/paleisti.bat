@echo off
REM eNEWS robotas. Pirma karta paleidus idiegiamos reikalingos bibliotekos.
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist .venv (
    python -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python robotas.py %*
pause
