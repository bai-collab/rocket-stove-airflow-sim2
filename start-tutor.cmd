@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 找不到 Node.js，請先安裝 Node.js 22 以上。& pause & exit /b 1)
if not exist node_modules (
  echo 第一次使用：安裝相依套件中…
  call npm.cmd ci --no-audit --no-fund || (pause & exit /b 1)
)
echo 建置本機導師版網頁中…
call npm.cmd run tutor:build || (pause & exit /b 1)
node scripts\tutor\server.mjs
pause
