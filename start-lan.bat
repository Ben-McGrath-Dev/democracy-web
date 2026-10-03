@echo off
cd /d "%~dp0"
echo.
echo Democracy Web - LAN TEST MODE
echo ==============================
echo.
echo This uses plain HTTP. Secure cryptography and sealed ballots are intentionally disabled.
echo For full features, use GitHub Pages/HTTPS.
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  for /f "tokens=*" %%b in ("%%a") do echo Try: http://%%b:8000
)
echo Local: http://localhost:8000
echo.
py -m http.server 8000 --bind 0.0.0.0
if errorlevel 1 python -m http.server 8000 --bind 0.0.0.0
pause
