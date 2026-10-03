@echo off
cd /d "%~dp0"
echo Starting Democracy Web at http://localhost:8000
where py >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000
  py -m http.server 8000
) else (
  start "" http://localhost:8000
  python -m http.server 8000
)
