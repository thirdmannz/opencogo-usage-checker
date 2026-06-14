@echo off
setlocal
set "ROOT=C:\Projects\ocwrapper"
set "NODE=C:\Program Files\nodejs\node.exe"
set "SCRIPT=%ROOT%\start-bg.js"
set "TASK=ocwrapper"

cd /d "%ROOT%" || (
  echo Failed to change directory to %ROOT%
  pause
  exit /b 1
)

if not exist "%NODE%" (
  echo ERROR: Node.js not found at "%NODE%"
  pause
  exit /b 1
)

echo Registering ocwrapper scheduled task...

schtasks /Delete /TN "%TASK%" /F >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; ^
   $action = New-ScheduledTaskAction -Execute '%NODE%' -Argument '--expose-gc --max-old-space-size=1024 \"%SCRIPT%\" --port 3333' -WorkingDirectory '%ROOT%'; ^
   $trigger = New-ScheduledTaskTrigger -AtLogOn; ^
   $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; ^
   Register-ScheduledTask -TaskName '%TASK%' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null"

if errorlevel 1 (
  echo FAILED to create task. Run this script as Administrator.
  pause
  exit /b 1
)

echo.
echo Task "%TASK%" registered successfully.
echo   - Starts at every login
echo   - Runs start-bg.js directly via Node.js
echo   - Restarts on failure up to 3 times, every 1 minute
echo.
echo Manual controls:
echo   Start:   schtasks /Run /TN "%TASK%"
echo   Stop:    schtasks /End /TN "%TASK%"
echo   Remove:  schtasks /Delete /TN "%TASK%" /F
echo   Status:  schtasks /Query /TN "%TASK%"
pause
