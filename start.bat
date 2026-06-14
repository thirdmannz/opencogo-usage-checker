@echo off
setlocal
set "ROOT=C:\Projects\ocwrapper"
set "NODE=C:\Program Files\nodejs\node.exe"
set "PORT=3333"
set "URL=http://127.0.0.1:%PORT%"
set "NODE_OPTS=--expose-gc --max-old-space-size=1024"

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

echo Starting ocwrapper...

:: Check if already running
curl.exe -fsS "%URL%/api/status" >nul 2>&1
if %errorlevel%==0 (
  echo Existing ocwrapper is already running on %URL%
  echo Opening browser...
  start "" "%URL%"
  echo.
  exit /b 0
)

:: Launch via start-bg.js (watchdog + health check)
start "" /min "%NODE%" %NODE_OPTS% "%ROOT%\start-bg.js" --port %PORT%

:: Wait for it to be ready (poll up to 15s)
set WAIT_COUNT=0
:waitloop
timeout /t 1 /nobreak >nul
curl.exe -fsS "%URL%/api/status" >nul 2>&1
if %errorlevel%==0 goto ready
set /a WAIT_COUNT+=1
if %WAIT_COUNT% lss 15 goto waitloop

echo ERROR: ocwrapper did not come up on %URL% after 15s
echo Check the console output for the real error.
echo.
pause
exit /b 1

:ready
echo ocwrapper started, opening browser...
start "" "%URL%"
echo.
echo Browser opened to %URL%
echo.
exit /b 0
