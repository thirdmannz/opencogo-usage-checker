@echo off
setlocal
set "ROOT=C:\Projects\ocwrapper"
set "TASK=ocwrapper"
set "VBS=%ROOT%\launch.vbs"

echo Removing old task (if any)...
schtasks /Delete /TN "%TASK%" /F >nul 2>&1

echo Creating scheduled task "%TASK%"...
schtasks /Create /SC ONLOGON /TN "%TASK%" /TR "\"%%SystemRoot%%\System32\wscript.exe\" \"%VBS%\"" /DELAY 0000:15 /F /IT

echo.
echo Done.
echo   Start:    schtasks /Run /TN "%TASK%"
echo   Stop:     schtasks /End /TN "%TASK%"
echo   Status:   schtasks /Query /TN "%TASK%"
echo   Remove:   schtasks /Delete /TN "%TASK%" /F
pause
