@echo off
setlocal enabledelayedexpansion
rem Restart DeepSeek Harness with --remote-debugging-port so the real renderer
rem can be inspected over CDP (127.0.0.1:9223). ASCII-only on purpose:
rem a CJK byte sequence here would be mangled by the codepage.
set "PORT=9223"
set "PROC=DeepSeek Harness.exe"
set "LOG=%~dp0restart-cdp.log"

for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`) do set "EXE=%%A"

if not defined EXE (
  >>"%LOG%" echo [%DATE% %TIME%] ERROR DSH is not running; start it once, then rerun
  echo [ERROR] DSH is not running. Start it normally once, then rerun this script.
  pause
  exit /b 1
)

if /I "%~1"=="--check" (
  echo EXE  = !EXE!
  echo PORT = %PORT%
  echo LOG  = %LOG%
  exit /b 0
)

>>"%LOG%" echo [%DATE% %TIME%] closing
taskkill /IM "%PROC%" /T /F >nul 2>&1

set /a tries=0
:wait
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | find /I "%PROC%" >nul || goto closed
ping -n 2 127.0.0.1 >nul
set /a tries+=1
if !tries! GEQ 3 (
  taskkill /IM "%PROC%" /T /F >nul 2>&1
  goto wait
)
goto wait

:closed
>>"%LOG%" echo [%DATE% %TIME%] closed

powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '!EXE!' -ArgumentList '--remote-debugging-port=%PORT%' -RedirectStandardOutput '%~dp0dsh-out.log' -RedirectStandardError '%~dp0dsh-err.log'"
>>"%LOG%" echo [%DATE% %TIME%] started with --remote-debugging-port=%PORT%

rem give the renderer time to come up, then show what CDP is serving
powershell -NoProfile -Command "Start-Sleep -Seconds 8; try { $r = Invoke-RestMethod 'http://127.0.0.1:%PORT%/json/list' -TimeoutSec 5; $r | ForEach-Object { \"  {0}  {1}\" -f $_.type, $_.url } } catch { 'CDP not reachable: ' + $_.Exception.Message }"

echo.
echo DSH restarted with CDP on 127.0.0.1:%PORT%
echo Close this window when done. DSH keeps running.
exit /b 0
