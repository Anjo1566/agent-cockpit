@echo off
rem Nimmt das Vertrauen wieder zurueck.
setlocal
certutil -user -delstore Root localhost
echo.
pause
