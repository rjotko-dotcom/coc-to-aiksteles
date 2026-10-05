@echo off
REM eNEWS robotas. Be parametru atidaro valdymo langa; su parametrais (pvz. --bandymas) - dirba be lango.
REM Jei Python nera - pats parsisiuncia ir idiegia (tik siam vartotojui, be administratoriaus teisiu).
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

set PYVER=3.12.10
set PYDIR=%LOCALAPPDATA%\Programs\Python\Python312
set PY=

call :rasti_python
if not defined PY call :idiegti_python
if not defined PY goto nera_python

if not exist .venv\Scripts\python.exe (
    echo Pirmas paleidimas: diegiamos bibliotekos, palaukite apie minute...
    %PY% -m venv .venv || goto klaida
    .venv\Scripts\python -m pip install --disable-pip-version-check -r requirements.txt || goto klaida
)

if "%~1"=="" (
    REM Valdymo langas; juodas langas sumazinamas ir lieka tik jei ivyktu klaida.
    start "eNEWS robotas" /min cmd /c ".venv\Scripts\python langas.py || pause"
) else (
    .venv\Scripts\python robotas.py %*
    pause
)
exit /b 0


:rasti_python
if exist "%PYDIR%\python.exe" (set PY="%PYDIR%\python.exe"& exit /b 0)
where python >nul 2>nul && python -c "import tkinter" >nul 2>nul && (set PY=python& exit /b 0)
where py >nul 2>nul && py -3 -c "import tkinter" >nul 2>nul && (set PY=py -3& exit /b 0)
exit /b 0


:idiegti_python
echo.
echo  Python nerastas - parsisiunciamas Python %PYVER% is python.org ^(~25 MB^)...
set DIEGIMAS=%TEMP%\python-%PYVER%-amd64.exe
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe' -OutFile '%DIEGIMAS%'"
if not exist "%DIEGIMAS%" curl.exe -L -o "%DIEGIMAS%" "https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe"
if not exist "%DIEGIMAS%" exit /b 0
echo  Diegiama ^(tik siam vartotojui, be administratoriaus teisiu^), palaukite 1-2 min...
"%DIEGIMAS%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=0 Include_test=0 Include_doc=0 Shortcuts=0
del "%DIEGIMAS%" 2>nul
if exist "%PYDIR%\python.exe" (
    echo  Python idiegtas.
    set PY="%PYDIR%\python.exe"
)
exit /b 0


:nera_python
echo.
echo  Nepavyko automatiskai idiegti Python ^(gal imones tinklas ar taisykles blokuoja^).
echo  Idiekite ranka: https://www.python.org/downloads/
echo  Diegiant pazymekite "Add python.exe to PATH". Arba: Microsoft Store - "Python 3.12".
echo.
pause
exit /b 1

:klaida
echo.
echo  Nepavyko idiegti biblioteku. Dazniausia priezastis - imones internetas
echo  blokuoja pypi.org. Paklauskite IT arba pabandykite is kito tinklo.
rmdir /s /q .venv 2>nul
pause
exit /b 1
