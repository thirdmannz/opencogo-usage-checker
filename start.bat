@echo off
cd /d C:\Projects\ocwrapper

:: Kill any existing ocwrapper processes first
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq ocwrapper" >nul 2>&1
timeout /t 1 >nul

:: Launch headlessly via VBS (no window to close)
wscript.exe launch.vbs

echo OpenCode Go server started on port 3333 (headless, auto-restart via Task Scheduler).
echo To stop: taskkill /F /FI "WINDOWTITLE eq ocwrapper" /FI "IMAGENAME eq node.exe"
