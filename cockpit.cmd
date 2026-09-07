@echo off
rem Startet das Cockpit und oeffnet den Browser.
rem Diese Datei MUSS CRLF-Zeilenenden haben -- mit reinen LF weigert sich
rem cmd.exe, sie auszufuehren, und zwar ohne brauchbare Meldung.
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js fehlt. Hol es von https://nodejs.org
  echo   und starte diese Datei danach noch einmal.
  echo.
  pause
  exit /b 1
)

node server.js

rem Faellt der Server aus, soll das Fenster offen bleiben, damit man den
rem Grund lesen kann.
if errorlevel 1 pause
