#!/usr/bin/env bash
# Start all audio services for voice interviews
# Usage: ./scripts/start-audio-services.sh

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Starting Audio Services Stack"
echo "=========================================="
echo

# Check if we're in the project root
if [ ! -f "package.json" ]; then
    echo "ERROR: Please run this script from the project root directory."
    exit 1
fi

# Default ports (override via env vars)
AUDIOCPP_PORT="${AUDIOCPP_PORT:-8080}"
KOKORO_PORT="${KOKORO_PORT:-8081}"
PIPER_PORT="${PIPER_PORT:-8083}"
SUPERTONIC_PORT="${SUPERTONIC_PORT:-8084}"
GATEWAY_PORT="${GATEWAY_PORT:-8082}"

# Default URLs for gateway
KOKORO_URL="${KOKORO_URL:-http://localhost:$KOKORO_PORT}"
PIPER_URL="${PIPER_URL:-http://localhost:$PIPER_PORT}"
SUPERTONIC_URL="${SUPERTONIC_URL:-http://localhost:$SUPERTONIC_PORT}"

# ── STT: audio.cpp (primary) ─────────────────
echo "[1/5] Starting audio.cpp STT on port $AUDIOCPP_PORT..."

STT_STARTED=0
AUDIOCPP_FOUND=0
AUDIOCPP_PATH=""

# 1. Env var override (if explicitly set)
if [ -n "${AUDIOCPP_PATH:-}" ] && [ -f "$AUDIOCPP_PATH" ] && [ -x "$AUDIOCPP_PATH" ]; then
    echo "  Found binary via AUDIOCPP_PATH env var"
    AUDIOCPP_FOUND=1
fi

# 2. Common locations
if [ "$AUDIOCPP_FOUND" -eq 0 ]; then
    for cand in \
        "$HOME/audio.cpp/build/audiocpp_server" \
        "$HOME/audio.cpp/audiocpp_server" \
        "../audio.cpp/build/audiocpp_server" \
        "../audio.cpp/audiocpp_server" \
        "/usr/local/bin/audiocpp_server"
    do
        if [ -f "$cand" ] && [ -x "$cand" ]; then
            AUDIOCPP_PATH="$cand"
            echo "  Found binary at: $cand"
            AUDIOCPP_FOUND=1
            break
        fi
    done
fi

# Launch audio.cpp if found
if [ "$AUDIOCPP_FOUND" -eq 1 ]; then
    AUDIOCPP_DIR=$(dirname "$AUDIOCPP_PATH")
    echo "  Binary: $AUDIOCPP_PATH"
    echo "  Dir:    $AUDIOCPP_DIR"
    (cd "$AUDIOCPP_DIR" && ./"$(basename "$AUDIOCPP_PATH")" --config server.json &)
    AUDIOCPP_PID=$!
    STT_STARTED=1
    sleep 5
fi

if [ "$STT_STARTED" -eq 0 ]; then
    echo -e "  ${YELLOW}[SKIP]${NC} No STT service available."
    echo
    echo "  To enable voice interviews:"
    echo "    1. Build audio.cpp and set AUDIOCPP_PATH"
    echo
fi

# ── Kokoro TTS ──────────────────────────
echo "[2/5] Starting Kokoro TTS on port $KOKORO_PORT..."

if [ -f "kokoro-service/.venv/bin/python" ]; then
    echo "  Using kokoro-service via .venv"
    (cd kokoro-service && PORT=$KOKORO_PORT .venv/bin/python main.py &)
    KOKORO_PID=$!
elif [ -f "kokoro-service/main.py" ]; then
    echo "  Using kokoro-service via system Python"
    (cd kokoro-service && PORT=$KOKORO_PORT python main.py &)
    KOKORO_PID=$!
else
    echo -e "  ${YELLOW}[SKIP]${NC} kokoro-service not found."
fi

sleep 3

# ── Piper TTS ───────────────────────────
echo "[3/5] Starting Piper TTS on port $PIPER_PORT..."

if [ -f "piper-service/main.py" ]; then
    if [ -f "piper-service/.venv/bin/python" ]; then
        echo "  Using piper-service via .venv"
        (cd piper-service && PORT=$PIPER_PORT .venv/bin/python main.py &)
        PIPER_PID=$!
    else
        echo "  Using piper-service via system Python"
        (cd piper-service && PORT=$PIPER_PORT python main.py &)
        PIPER_PID=$!
    fi
else
    echo -e "  ${YELLOW}[SKIP]${NC} piper-service not found."
fi

sleep 5

# ── Supertonic TTS ──────────────────────
echo "[4/5] Starting Supertonic TTS on port $SUPERTONIC_PORT..."

if [ -f "supertonic-service/main.py" ]; then
    if [ -f "supertonic-service/.venv/bin/python" ]; then
        echo "  Using supertonic-service via .venv"
        (cd supertonic-service && PORT=$SUPERTONIC_PORT .venv/bin/python main.py &)
        SUPERTONIC_PID=$!
    else
        echo "  Using supertonic-service via system Python"
        (cd supertonic-service && PORT=$SUPERTONIC_PORT python main.py &)
        SUPERTONIC_PID=$!
    fi
else
    echo -e "  ${YELLOW}[SKIP]${NC} supertonic-service not found."
fi

sleep 5

# ── Audio Gateway ─────────────────────
echo "[5/5] Starting Audio Gateway on port $GATEWAY_PORT..."

if [ -f "audio-gateway/main.py" ]; then
    if [ -f "audio-gateway/.venv/bin/python" ]; then
        echo "  Using audio-gateway via .venv"
        (cd audio-gateway && PORT=$GATEWAY_PORT KOKORO_URL=$KOKORO_URL PIPER_URL=$PIPER_URL SUPERTONIC_URL=$SUPERTONIC_URL .venv/bin/python main.py &)
        GATEWAY_PID=$!
    else
        echo "  Using audio-gateway via system Python"
        (cd audio-gateway && PORT=$GATEWAY_PORT KOKORO_URL=$KOKORO_URL PIPER_URL=$PIPER_URL SUPERTONIC_URL=$SUPERTONIC_URL python main.py &)
        GATEWAY_PID=$!
    fi
else
    echo -e "  ${YELLOW}[SKIP]${NC} audio-gateway not found."
fi

echo
echo "=========================================="
echo -e "${GREEN}Audio services startup complete${NC}"
if [ "$STT_STARTED" -eq 1 ]; then
    echo "  STT:        http://localhost:$AUDIOCPP_PORT"
fi
echo "  Kokoro:     http://localhost:$KOKORO_PORT"
echo "  Piper:      http://localhost:$PIPER_PORT"
echo "  Supertonic: http://localhost:$SUPERTONIC_PORT"
echo "  Gateway:    http://localhost:$GATEWAY_PORT"
echo "=========================================="
echo
echo "Press Ctrl+C to stop all services..."

# Trap SIGINT to kill all child processes
cleanup() {
    echo
    echo "Stopping audio services..."
    if [ -n "${AUDIOCPP_PID:-}" ]; then
        kill "$AUDIOCPP_PID" 2>/dev/null || true
    fi
    if [ -n "${STT_PID:-}" ]; then
        kill "$STT_PID" 2>/dev/null || true
    fi
    if [ -n "${GATEWAY_PID:-}" ]; then
        kill "$GATEWAY_PID" 2>/dev/null || true
    fi
    if [ -n "${PIPER_PID:-}" ]; then
        kill "$PIPER_PID" 2>/dev/null || true
    fi
    if [ -n "${KOKORO_PID:-}" ]; then
        kill "$KOKORO_PID" 2>/dev/null || true
    fi
    if [ -n "${SUPERTONIC_PID:-}" ]; then
        kill "$SUPERTONIC_PID" 2>/dev/null || true
    fi
    wait
    echo "All services stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# Wait forever
wait
