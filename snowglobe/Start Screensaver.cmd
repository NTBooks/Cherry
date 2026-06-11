@echo off
rem  Sakura Snow Globe - starts a tiny local server and opens the scene.
rem  Double-click the page (or press F11) for fullscreen.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
ping -n 2 127.0.0.1 >nul
start "" "http://localhost:8423/"
