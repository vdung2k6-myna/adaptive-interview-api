#!/usr/bin/env bash
# Stop the audio-tier compose project.
# Usage: ./scripts/stop-audio-services.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f "docker-compose.audio.yml" ]; then
    echo "ERROR: docker-compose.audio.yml not found in $ROOT"
    exit 1
fi

echo "=========================================="
echo "Stopping Audio Services Stack"
echo "=========================================="
echo
docker compose -f docker-compose.audio.yml down --remove-orphans

echo
echo "All audio services stopped. Models under AUDIO_MODELS_DIR are untouched."
