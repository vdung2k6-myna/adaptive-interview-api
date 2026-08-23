#!/usr/bin/env python3
"""Test Piper TTS service directly."""

import sys
import requests

BASE_URL = "http://localhost:8083"

def test_health():
    r = requests.get(f"{BASE_URL}/health")
    print(f"Health: {r.status_code}")
    print(r.json())

def test_synthesize():
    text = "Xin chào, đây là bài kiểm tra giọng nói."
    payload = {"text": text, "voice": "vi_VN-vais1000-medium"}
    print(f"\nSynthesizing: {text}")
    r = requests.post(f"{BASE_URL}/v1/audio/speech", json=payload)
    print(f"Status: {r.status_code}")
    print(f"Content-Type: {r.headers.get('content-type')}")
    print(f"Content-Length: {r.headers.get('content-length')}")
    print(f"Body size: {len(r.content)} bytes")

    if r.status_code == 200 and len(r.content) > 100:
        with open("test_piper_output.wav", "wb") as f:
            f.write(r.content)
        print("Saved to test_piper_output.wav")
        # Check if it's a valid WAV
        if r.content[:4] == b"RIFF":
            print("✓ Valid WAV header (RIFF)")
        else:
            print("✗ Not a WAV file (missing RIFF header)")
    else:
        print(f"Error: {r.text}")

if __name__ == "__main__":
    test_health()
    test_synthesize()
