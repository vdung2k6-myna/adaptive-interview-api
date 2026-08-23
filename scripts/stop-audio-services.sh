#!/usr/bin/env bash
# Stop all audio services for voice interviews
# Usage: ./scripts/stop-audio-services.sh

set -euo pipefail

echo "=========================================="
echo "Stopping Audio Services Stack"
echo "=========================================="
echo

kill_by_pattern() {
    local pattern=$1
    local label=$2
    local pids

    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -z "$pids" ]; then
        return 1
    fi

    echo "Stopping $label..."
    for pid in $pids; do
        echo "  Sending SIGTERM to PID $pid..."
        kill "$pid" 2>/dev/null || true
    done

    # Wait up to 5 seconds for graceful shutdown
    local waited=0
    while [ "$waited" -lt 5 ]; do
        pids=$(pgrep -f "$pattern" 2>/dev/null || true)
        [ -z "$pids" ] && break
        sleep 1
        waited=$((waited + 1))
    done

    # Force-kill any stragglers
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "  Force-killing remaining $label processes..."
        for pid in $pids; do
            echo "  Sending SIGKILL to PID $pid..."
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
}

kill_python_by_cwd() {
    local dir=$1
    local label=$2
    local pids
    local cwd
    local found=0
    local project_dir

    project_dir=$(pwd)
    pids=$(pgrep -f "python.*main\\.py" 2>/dev/null || true)
    if [ -z "$pids" ]; then
        return
    fi

    for pid in $pids; do
        cwd=$(readlink /proc/$pid/cwd 2>/dev/null || true)
        if [ "$cwd" = "$project_dir/$dir" ] || [ "$cwd" = "$project_dir/$dir/" ]; then
            if [ "$found" -eq 0 ]; then
                echo "Stopping $label..."
                found=1
            fi
            echo "  Sending SIGTERM to PID $pid..."
            kill "$pid" 2>/dev/null || true
        fi
    done

    [ "$found" -eq 0 ] && return

    # Wait up to 5 seconds
    local waited=0
    while [ "$waited" -lt 5 ]; do
        local still_running=0
        for pid in $pids; do
            cwd=$(readlink /proc/$pid/cwd 2>/dev/null || true)
            if [ "$cwd" = "$project_dir/$dir" ] || [ "$cwd" = "$project_dir/$dir/" ]; then
                if kill -0 "$pid" 2>/dev/null; then
                    still_running=1
                    break
                fi
            fi
        done
        [ "$still_running" -eq 0 ] && break
        sleep 1
        waited=$((waited + 1))
    done

    # Force-kill
    for pid in $pids; do
        cwd=$(readlink /proc/$pid/cwd 2>/dev/null || true)
        if [ "$cwd" = "$project_dir/$dir" ] || [ "$cwd" = "$project_dir/$dir/" ]; then
            if kill -0 "$pid" 2>/dev/null; then
                echo "  Sending SIGKILL to PID $pid..."
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
    done
}

# Try pattern first (works when full paths are in cmdline), fallback to CWD
kill_by_pattern "audiocpp_server"           "audio.cpp STT" || true
kill_by_pattern "kokoro-service.*main\\.py" "Kokoro TTS"    || kill_python_by_cwd "kokoro-service" "Kokoro TTS"
kill_by_pattern "piper-service.*main\\.py"  "Piper TTS"     || kill_python_by_cwd "piper-service"  "Piper TTS"
kill_by_pattern "audio-gateway.*main\\.py"  "Audio Gateway" || kill_python_by_cwd "audio-gateway"  "Audio Gateway"

# Verify nothing is left running
echo
remaining=0
for pattern in "audiocpp_server" "kokoro-service.*main\\.py" "piper-service.*main\\.py" "audio-gateway.*main\\.py"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
        remaining=1
        break
    fi
done

# Also verify by CWD in case pattern-based pgrep missed them
if [ "$remaining" -eq 0 ]; then
    project_dir=$(pwd)
    for dir in kokoro-service piper-service audio-gateway; do
        for pid in $(pgrep -f "python.*main\\.py" 2>/dev/null || true); do
            cwd=$(readlink /proc/$pid/cwd 2>/dev/null || true)
            if [ "$cwd" = "$project_dir/$dir" ] || [ "$cwd" = "$project_dir/$dir/" ]; then
                remaining=1
                break 3
            fi
        done
    done
fi

if [ "$remaining" -eq 0 ]; then
    echo "All audio services stopped."
else
    echo "WARNING: Some audio services may still be running."
    exit 1
fi
