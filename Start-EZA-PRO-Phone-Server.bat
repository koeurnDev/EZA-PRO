@echo off
chcp 65001 >nul
title EZA PRO - Desktop & Phone Server (Port 3001)
cd /d "%~dp0"
echo ========================================================
echo   ⚡ EZA PRO - AI Dubbing ^& Subtitle Studio Server
echo   ដំណើរការសម្រាប់ទាំងកុំព្យូទ័រ (Desktop) និងទូរស័ព្ទ (Phone)
echo ========================================================
echo.
start "" "http://localhost:3001"
node server-dev.js
pause

