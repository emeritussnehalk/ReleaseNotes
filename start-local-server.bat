@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8000
echo Starting local server on http://localhost:%PORT%/
echo Press Ctrl+C to stop the server.
node server.js
