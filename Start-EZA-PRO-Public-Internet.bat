@echo off
chcp 65001 >nul
title EZA PRO - Cloudflare Public Internet Server (4G / 5G / Any Wi-Fi)
cd /d "%~dp0"
echo ================================================================
echo   🌍 EZA PRO - Cloudflare Public Internet Server (4G / 5G)
echo   បង្កើតតំណភ្ជាប់ HTTPS ល្បឿនលឿនរបស់ Cloudflare សម្រាប់ប្រើពីគ្រប់ទីកន្លែង
echo ================================================================
echo.
start "EZA PRO Backend" /min cmd /c "node server-dev.js"
timeout /t 2 /nobreak >nul
if exist "%~dp0tools\cloudflared.exe" (
  echo ⚡ កំពុងបើក Cloudflare Tunnel (https://....trycloudflare.com)...
  echo.
  "%~dp0tools\cloudflared.exe" tunnel --url http://127.0.0.1:3001 --no-autoupdate
) else (
  echo ⚡ កំពុងបើក SSH Public Tunnel (https://....lhr.life)...
  echo.
  "C:\Windows\System32\OpenSSH\ssh.exe" -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:127.0.0.1:3001 nokey@localhost.run
)
pause
