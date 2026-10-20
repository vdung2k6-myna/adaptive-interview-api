@echo off
setlocal
REM Start the audio tier as one compose project.
REM Usage: .\scripts\start-audio-services.bat
REM
REM The tier is: stt-proxy, audiocpp, gateway, kokoro, piper, supertonic.
REM Only 8080 (proxy) and 8082 (gateway) are published.

set "ROOT=%~dp0.."
pushd "%ROOT%"

if not exist "docker-compose.audio.yml" (
    echo ERROR: docker-compose.audio.yml not found in "%ROOT%"
    popd
    exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
    echo ERROR: docker is not on PATH. Install Docker and the NVIDIA container toolkit.
    popd
    exit /b 1
)

if "%AUDIO_BIND_ADDR%"=="" set "AUDIO_BIND_ADDR=127.0.0.1"

echo ==========================================
echo Starting Audio Services Stack
echo ==========================================
echo.
echo [1/2] Building and starting containers...
docker compose -f docker-compose.audio.yml up -d --build
if errorlevel 1 (
    echo.
    echo [FAIL] docker compose up failed.
    popd
    exit /b 1
)

echo.
echo [2/2] Waiting for every service to report healthy...
node scripts\audio-health.js --wait-seconds 240
if errorlevel 1 (
    echo.
    echo [FAIL] the audio tier did not come up healthy. Voice turns will fail.
    echo        Inspect with: docker compose -f docker-compose.audio.yml logs
    popd
    exit /b 1
)

echo.
echo ==========================================
echo Audio tier up:
echo   STT proxy:  http://%AUDIO_BIND_ADDR%:8080
echo   Gateway:    http://%AUDIO_BIND_ADDR%:8082
echo ==========================================
echo.
echo Press any key to exit this launcher (containers keep running)...
pause > nul
popd
exit /b 0
