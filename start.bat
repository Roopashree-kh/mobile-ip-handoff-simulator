@echo off
rem Starts the Mobile IPv4 handoff simulator on Windows. No administrator rights needed.
rem   start.bat          dashboard on http://localhost:5173 (Vite dev server)
rem   start.bat --prod   dashboard built once and served on http://localhost:8080
cd /d "%~dp0"
where python >nul 2>nul || (echo Python 3.10 or newer is required. & pause & exit /b 1)
where node >nul 2>nul || (echo Node.js 18 or newer is required. & pause & exit /b 1)
python run_all.py %*
