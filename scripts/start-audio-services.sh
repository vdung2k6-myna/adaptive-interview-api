#!/usr/bin/env bash
# Start the audio tier as one compose project.
# Usage: ./scripts/start-audio-services.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f "docker-compose.audio.yml" ]; then
    echo "ERROR: docker-compose.audio.yml not found in $ROOT"
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is not on PATH. Install Docker and the NVIDIA container toolkit."
    exit 1
fi

BIND="${AUDIO_BIND_ADDR:-127.0.0.1}"

echo "=========================================="
echo "Starting Audio Services Stack"
echo "=========================================="
echo
echo "[1/2] Building and starting containers..."
docker compose -f docker-compose.audio.yml up -d --build

echo
echo "[2/2] Waiting for every service to report healthy..."
node scripts/audio-health.js --wait-seconds 240

echo
echo "=========================================="
echo "Audio tier up:"
echo "  STT proxy:  http://$BIND:8080"
echo "  Gateway:    http://$BIND:8082"
echo "=========================================="
echo
echo "Stop with: ./scripts/stop-audio-services.sh"
