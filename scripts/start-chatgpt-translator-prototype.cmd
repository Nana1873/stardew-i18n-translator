@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-chatgpt-translator-prototype.ps1" %*
if errorlevel 1 pause
