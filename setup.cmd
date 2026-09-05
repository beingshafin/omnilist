@echo off
setlocal
set OMNILIST_SETUP_CMD=1
node "%~dp0src\omnilist.js" setup %*
pause
endlocal

