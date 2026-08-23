@echo off
setlocal
REM Start all audio services for voice interviews
REM Usage: .\scripts\start-audio-services.bat

echo ==========================================
echo Starting Audio Services Stack
echo ==========================================
echo.

REM Check if we're in the project root
if not exist "package.json" (
    echo ERROR: Please run this script from the project root directory.
    exit /b 1
)

REM Default ports (override via env vars)
if "%AUDIOCPP_PORT%"=="" set AUDIOCPP_PORT=8080
if "%KOKORO_PORT%"=="" set KOKORO_PORT=8081
if "%PIPER_PORT%"=="" set PIPER_PORT=8083
if "%GATEWAY_PORT%"=="" set GATEWAY_PORT=8082

REM Default URLs for gateway
if "%KOKORO_URL%"=="" set KOKORO_URL=http://localhost:%KOKORO_PORT%
if "%PIPER_URL%"=="" set PIPER_URL=http://localhost:%PIPER_PORT%

REM ---------------------------------------------------------------
REM STT: audio.cpp (primary)
REM ---------------------------------------------------------------
echo [1/4] Starting audio.cpp STT on port %AUDIOCPP_PORT%...

set "STT_STARTED=0"
set "AUDIOCPP_FOUND=0"

REM 1. Env var override (highest priority)
if not "%AUDIOCPP_PATH%"=="" (
    if exist "%AUDIOCPP_PATH%" goto :found_audiocpp
    echo   [WARN] AUDIOCPP_PATH env var points to missing file: %AUDIOCPP_PATH%
)

REM 2. Common fallback paths
set "AUDIOCPP_PATH=\Working\Projects\audiocpp\audiocpp_server.exe"
if exist "%AUDIOCPP_PATH%" goto :found_audiocpp

REM Nothing found
goto :audiocpp_not_found

:found_audiocpp
for %%F in ("%AUDIOCPP_PATH%") do set "AUDIOCPP_DIR=%%~dpF"
if "%AUDIOCPP_DIR:~-1%"=="\" set "AUDIOCPP_DIR=%AUDIOCPP_DIR:~0,-1%"

echo   Found:  %AUDIOCPP_PATH%
start "audio.cpp STT" /d "%AUDIOCPP_DIR%" cmd /k "audiocpp_server.exe --config server.json"
set "STT_STARTED=1"
goto :stt_done

:audiocpp_not_found
echo   [SKIP] No STT service available.
echo.
echo   To enable voice interviews:
echo     1. Build audio.cpp and set AUDIOCPP_PATH to your audiocpp_server.exe path
echo     2. Or set AUDIOCPP_PATH to your audiocpp_server.exe path
echo.

:stt_done
timeout /t 5 /nobreak > nul

REM ---------------------------------------------------------------
REM Kokoro TTS
REM ---------------------------------------------------------------
echo [2/4] Starting Kokoro TTS on port %KOKORO_PORT%...

if exist "kokoro-service\.venv\Scripts\python.exe" goto :kokoro_via_venv
if exist "kokoro-service\main.py" goto :kokoro_via_system

echo   [SKIP] kokoro-service not found.
goto :kokoro_done

:kokoro_via_venv
echo   Using kokoro-service via .venv
start "Kokoro TTS" /d kokoro-service .venv\Scripts\python main.py
goto :kokoro_done

:kokoro_via_system
echo   Using kokoro-service via system Python
start "Kokoro TTS" /d kokoro-service python main.py

:kokoro_done
timeout /t 3 /nobreak > nul

REM ---------------------------------------------------------------
REM Piper TTS
REM ---------------------------------------------------------------
echo [3/4] Starting Piper TTS on port %PIPER_PORT%...

if exist "piper-service\main.py" goto :piper_exists
echo   [SKIP] piper-service not found.
goto :piper_done

:piper_exists
if exist "piper-service\.venv\Scripts\python.exe" (
    echo   Using piper-service via .venv
    start "Piper TTS" /d piper-service .venv\Scripts\python main.py
) else (
    echo   Using piper-service via system Python
    start "Piper TTS" /d piper-service python main.py
)

:piper_done
timeout /t 5 /nobreak > nul

REM ---------------------------------------------------------------
REM Audio Gateway
REM ---------------------------------------------------------------
echo [4/4] Starting Audio Gateway on port %GATEWAY_PORT%...

if exist "audio-gateway\main.py" goto :gateway_exists
echo   [SKIP] audio-gateway not found.
goto :gateway_done

:gateway_exists
if exist "audio-gateway\.venv\Scripts\python.exe" (
    echo   Using audio-gateway via .venv
    start "Audio Gateway" /d audio-gateway .venv\Scripts\python main.py
) else (
    echo   Using audio-gateway via system Python
    start "Audio Gateway" /d audio-gateway python main.py
)

:gateway_done

echo.
echo ==========================================
echo Audio services started in separate windows:
if "%STT_STARTED%"=="1" echo   STT:     http://localhost:%AUDIOCPP_PORT%
echo   Kokoro:  http://localhost:%KOKORO_PORT%
echo   Piper:   http://localhost:%PIPER_PORT%
echo   Gateway: http://localhost:%GATEWAY_PORT%
echo ==========================================
echo.
echo Press any key to exit this launcher (services keep running)...
pause > nul
goto :eof
