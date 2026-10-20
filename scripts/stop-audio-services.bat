@echo off
setlocal
REM Stop the audio-tier compose project.
REM Usage: .\scripts\stop-audio-services.bat

set "ROOT=%~dp0.."
pushd "%ROOT%"

if not exist "docker-compose.audio.yml" (
    echo ERROR: docker-compose.audio.yml not found in "%ROOT%"
    popd
    exit /b 1
)

echo ==========================================
echo Stopping Audio Services Stack
echo ==========================================
echo.
docker compose -f docker-compose.audio.yml down --remove-orphans
if errorlevel 1 (
    echo [FAIL] docker compose down failed.
    popd
    exit /b 1
)

echo.
echo All audio services stopped. Models under AUDIO_MODELS_DIR are untouched.
popd
exit /b 0
