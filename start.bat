@echo off
setlocal
set "ROOT=C:\Projects\ocwrapper"
set "NODE=C:\Program Files\nodejs\node.exe"
set "PORT=3333"
set "URL=http://127.0.0.1:%PORT%"

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

curl.exe -fsS "%URL%/api/status" >nul 2>&1
if %errorlevel%==0 (
  echo Existing ocwrapper is already running on %URL%
  echo Opening browser...
  start "" "%URL%"
  echo.
  pause
  exit /b 0
)

echo   "%NODE%" --expose-gc --max-old-space-size=1024 "%ROOT%\start-bg.js" --port %PORT%
echo.
start "" /min "%NODE%" --expose-gc --max-old-space-size=1024 "%ROOT%\start-bg.js" --port %PORT%
timeout /t 4 /nobreak >nul

curl.exe -fsS "%URL%/api/status" >nul 2>&1
if not %errorlevel%==0 (
  echo ERROR: ocwrapper did not come up on %URL%
  echo Check the console output for the real error.
  echo.
  pause
  exit /b 1
)

start "" "%URL%"
echo Browser opened to %URL%
echo.
pause
