@echo off
cd /d C:\Projects\ocwrapper
start /B /MIN "ocwrapper" node start-bg.js --port 3333
echo OpenCode Go server started on port 3333 (auto-restart enabled).
echo Use "taskkill /F /IM node.exe /FI "WINDOWTITLE eq ocwrapper"" to stop.
