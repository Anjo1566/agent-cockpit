@echo off
rem Macht das Zertifikat des Cockpits fuer diesen Benutzer vertrauenswuerdig.
rem Danach zeigt Chrome keine Warnung mehr fuer https://localhost:4173.
rem Braucht keine Administratorrechte -- es landet nur in DEINEM Speicher.
rem Windows fragt einmal nach; das ist die Bestaetigung, dass du es willst.
setlocal
cd /d "%~dp0"

if not exist ".zertifikat\zertifikat.pem" (
  echo.
  echo   Es gibt noch kein Zertifikat.
  echo   Starte zuerst einmal cockpit.cmd, dann diese Datei.
  echo.
  pause
  exit /b 1
)

certutil -user -addstore Root ".zertifikat\zertifikat.pem"
if errorlevel 1 (
  echo.
  echo   Das hat nicht geklappt.
  echo   Du kannst stattdessen im Browser einfach
  echo   "Erweitert" und dann "Weiter zu localhost" klicken.
) else (
  echo.
  echo   Erledigt. Chrome einmal neu starten, dann ist die Warnung weg.
)
echo.
pause
