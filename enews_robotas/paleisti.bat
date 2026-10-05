@echo off
REM eNEWS robotas. Be parametru atidaro valdymo langa; su parametrais (pvz. --bandymas) - dirba be lango.
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

REM Python: "python" arba "py" (Windows paleidiklis).
set PY=
where python >nul 2>nul && python -c "import sys" >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py -3
if not defined PY (
    echo.
    echo  Nerastas Python.
    echo  Isidiekite is https://www.python.org/downloads/
    echo  Diegiant pazymekite "Add python.exe to PATH" ^(administratoriaus teisiu nereikia^).
    echo.
    pause
    exit /b 1
)

if not exist .venv\Scripts\python.exe (
    echo Pirmas paleidimas: diegiamos bibliotekos, palaukite...
    %PY% -m venv .venv || goto klaida
    .venv\Scripts\python -m pip install --disable-pip-version-check -r requirements.txt || goto klaida
)

if "%~1"=="" (
    REM Langas; juodas langas sumazinamas ir lieka tik jei ivyktu klaida.
    start "eNEWS robotas" /min cmd /c ".venv\Scripts\python langas.py || pause"
) else (
    .venv\Scripts\python robotas.py %*
    pause
)
exit /b 0

:klaida
echo.
echo  Nepavyko idiegti biblioteku. Dazniausia priezastis - imones internetas
echo  blokuoja pypi.org. Paklauskite IT arba pabandykite is kito tinklo.
rmdir /s /q .venv 2>nul
pause
exit /b 1
