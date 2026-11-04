@echo off
rem ASCII only: cmd.exe misparses CJK bytes in .bat/.cmd files.
rem All Chinese output lives in install.ps1.
setlocal
set "HERE=%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] powershell not found.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [ERROR] install failed with exit code %CODE%.
  pause
)

endlocal & exit /b %CODE%
