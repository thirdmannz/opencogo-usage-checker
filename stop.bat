@echo off
:: stop.bat — Stop ocwrapper cleanly
cd /d C:\Projects\ocwrapper

echo Stopping ocwrapper...
taskkill /F /FI "WINDOWTITLE eq ocwrapper" >nul 2>&1
echo Done.
