@echo off
setlocal enabledelayedexpansion
REM Stop all audio services for voice interviews
REM Usage: .\scripts\stop-audio-services.bat

echo ==========================================
echo Stopping Audio Services Stack
echo ==========================================
echo.

REM Default ports (must match start-audio-services.bat)
if "%AUDIOCPP_PORT%"=="" set AUDIOCPP_PORT=8080
if "%KOKORO_PORT%"=="" set KOKORO_PORT=8081
if "%PIPER_PORT%"=="" set PIPER_PORT=8083
if "%SUPERTONIC_PORT%"=="" set SUPERTONIC_PORT=8084
if "%GATEWAY_PORT%"=="" set GATEWAY_PORT=8082

set "KILLED_ANY=0"

REM ---------------------------------------------------------------
REM Method 1: Stop by listening port (most reliable)
REM ---------------------------------------------------------------
echo [Port scan] Stopping services by listening port...

call :kill_by_port %AUDIOCPP_PORT% "audio.cpp STT"
call :kill_by_port %KOKORO_PORT%   "Kokoro TTS"
call :kill_by_port %PIPER_PORT%    "Piper TTS"
call :kill_by_port %GATEWAY_PORT%  "Audio Gateway"

REM ---------------------------------------------------------------
REM Method 1.5: Cleanup cmd.exe wrappers
REM audiocpp_server.exe is launched via cmd /k, so killing the
REM child leaves an empty console window behind. Kill any cmd.exe
REM whose command line contains audiocpp_server.
REM ---------------------------------------------------------------
echo [Wrapper cleanup] Checking for cmd.exe wrappers...

for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'audiocpp_server' } | ForEach-Object { $_.ProcessId }"`) do (
    if "%%a" neq "" (
        echo   Stopping cmd.exe wrapper [PID %%a]...
        taskkill /PID %%a /F /T >nul 2>nul
        set "KILLED_ANY=1"
    )
)

REM ---------------------------------------------------------------
REM Method 2: Fallback - by window title
REM ---------------------------------------------------------------
echo [Window title] Checking for services by window title...

for %%T in ("audio.cpp STT" "Kokoro TTS" "Piper TTS" "Supertonic TTS" "Audio Gateway") do (
    for /f "tokens=2 delims=," %%a in ('tasklist /fi "WINDOWTITLE eq %%~T" /fo csv /nh 2^>nul') do (
        if "%%~a" neq "" (
            echo   Stopping '%%~T' by window title [PID %%~a]...
            taskkill /PID %%~a /F /T >nul 2>nul
            set "KILLED_ANY=1"
        )
    )
)

REM ---------------------------------------------------------------
REM Method 3: Fallback - kill audiocpp_server.exe by image name
REM ---------------------------------------------------------------
echo [Image name] Checking for audiocpp_server.exe...

for /f "tokens=2 delims=," %%a in ('tasklist /fi "IMAGENAME eq audiocpp_server.exe" /fo csv /nh 2^>nul') do (
    if "%%~a" neq "" (
        echo   Stopping audiocpp_server.exe by image name [PID %%~a]...
        taskkill /PID %%~a /F /T >nul 2>nul
        set "KILLED_ANY=1"
    )
)

REM ---------------------------------------------------------------
REM Method 4: Fallback - PowerShell broad search for any Python
REM service still running with main.py in its command line.
REM This catches system-Python services missed by Method 1.
REM ---------------------------------------------------------------
echo [PowerShell] Checking for any remaining Python service processes...

for /f "usebackq tokens=*" %%a in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'main.py' } | ForEach-Object { $_.ProcessId }"`) do (
    if "%%a" neq "" (
        echo   Stopping Python service [PID %%a]...
        taskkill /PID %%a /F /T >nul 2>nul
        set "KILLED_ANY=1"
    )
)

if "!KILLED_ANY!"=="0" (
    echo.
    echo No running audio services found.
)

REM ---------------------------------------------------------------
REM Verification
REM ---------------------------------------------------------------
echo.
set "REMAINING=0"

for %%P in (%AUDIOCPP_PORT% %KOKORO_PORT% %PIPER_PORT% %SUPERTONIC_PORT% %GATEWAY_PORT%) do (
    netstat -ano | findstr ":%%P " | findstr /i "LISTENING" >nul
    if !errorlevel! equ 0 (
        echo   [WARN] Port %%P is still in use
        set "REMAINING=1"
    )
)

tasklist /fi "IMAGENAME eq audiocpp_server.exe" /fo csv /nh 2>nul | findstr /i "audiocpp_server" >nul
if !errorlevel! equ 0 (
    echo   [WARN] audiocpp_server.exe is still running
    set "REMAINING=1"
)

echo.
if "%REMAINING%"=="0" (
    echo All audio services stopped.
) else (
    echo WARNING: Some audio services may still be running.
)

pause
goto :eof

REM ---------------------------------------------------------------
REM Subroutine: kill_by_port
REM   %~1 = port number
REM   %~2 = friendly label
REM ---------------------------------------------------------------
:kill_by_port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%~1 " ^| findstr /i "LISTENING"') do (
    if "%%a" neq "" (
        if "%%a" neq "0" (
            echo   Stopping %~2 on port %~1 [PID %%a]...
            taskkill /PID %%a /F /T >nul 2>nul
            set "KILLED_ANY=1"
        )
    )
)
goto :eof
