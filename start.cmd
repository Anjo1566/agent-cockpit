@echo off
rem Startet das Cockpit und oeffnet den Browser.
cd /d "%~dp0"
where node >nul 2>&1 || (
  echo Node.js fehlt. Hol es von https://nodejs.org und starte diese Datei danach neu.
  pause
  exit /b 1
)
node server.js
pause
