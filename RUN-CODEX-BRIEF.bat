@echo off
title Codex Brief Runner (Hermes semi-auto)
color 0E
echo.
echo   ===========================================
echo    CODEX BRIEF RUNNER  ^|  Hermes semi-auto
echo   ===========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AI\Hermes\scripts\run-codex-brief.ps1" %*
echo.
pause
