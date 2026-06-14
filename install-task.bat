@echo off
:: install-task.bat — Register ocwrapper as a Scheduled Task with auto-restart.
:: Run this once as Admin. The task starts at login and restarts on failure.
:: 
:: To remove:  schtasks /Delete /TN "ocwrapper" /F

cd /d C:\Projects\ocwrapper

echo Registering ocwrapper scheduled task...

schtasks /Delete /TN "ocwrapper" /F >nul 2>&1

schtasks /Create ^
  /TN "ocwrapper" ^
  /TR "wscript.exe \"C:\Projects\ocwrapper\launch.vbs\"" ^
  /SC ONLOGON ^
  /RL HIGHEST ^
  /F

if %ERRORLEVEL% NEQ 0 (
  echo FAILED to create task. Run this script as Administrator.
  pause
  exit /b 1
)

echo.
echo Task "ocwrapper" registered successfully.
echo   - Starts at every login
echo   - Runs headless (no window)
echo.
echo To configure restart-on-failure, open Task Scheduler:
echo   1. Win+R ^> taskschd.msc
echo   2. Find "ocwrapper" in Task Scheduler Library
echo   3. Properties ^> Settings tab:
echo      [x] Run task as soon as possible after a scheduled start is missed
echo      [x] If the task fails, restart every: 1 minute
echo      Attempt to restart: 3 times
echo      [x] Stop the task if it runs longer than: (leave unchecked)
echo.
echo Manual controls:
echo   Start:   schtasks /Run /TN "ocwrapper"
echo   Stop:    schtasks /End /TN "ocwrapper"
echo   Remove:  schtasks /Delete /TN "ocwrapper" /F
echo   Status:  schtasks /Query /TN "ocwrapper"
pause
