@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" goto missing
if not exist "node_modules\electron\dist\electron.exe" goto missing
if not exist "node_modules\@opencode\cli\bin\opencode.exe" goto missing
if not exist "dist-electron\main.js" goto build
goto launch
:build
call npm run build
if errorlevel 1 goto failed
:launch
set "FORGE_DATA_DIR=%~dp0.runtime\desktop"
call node_modules\.bin\electron.cmd .
if errorlevel 1 goto failed
exit /b 0
:missing
echo Run npm ci and npm run setup in this folder first.
pause
exit /b 1
:failed
echo Rote Coding Fraktion failed to start. See the output above.
pause
exit /b 1
