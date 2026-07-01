@echo off
chcp 65001 >nul
title 美股分析代理 - 請保持此視窗開著
echo ============================================
echo   美股分析 資料代理
echo   1. 馬上自動開啟分析網頁
echo   2. 這個黑色視窗就是代理，請「不要關閉」
echo      （要結束分析時再關它）
echo ============================================
echo.
rem 先開網頁（用預設瀏覽器）
start "" "%~dp0stock_analyzer.html"
rem 在「本視窗」直接執行代理（視窗會一直停留 = 代理運作中）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0proxy.ps1"
echo.
echo 代理已停止。要重新開始請再雙擊這個檔案。
pause
