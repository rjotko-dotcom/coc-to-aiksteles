@echo off
REM eNEWS robotas. Be parametru atidaro valdymo langa; su parametrais (pvz. --vienas) - dirba be lango.
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if not exist .venv (
    echo Pirmas paleidimas: diegiamos bibliotekos...
    python -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt
)
if "%~1"=="" (
    start "" .venv\Scripts\pythonw langas.py
) else (
    .venv\Scripts\python robotas.py %*
    pause
)
