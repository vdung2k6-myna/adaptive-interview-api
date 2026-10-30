"""Tests for the OpenAI speech contract and the per-engine level.

Nothing here needs a running TTS service: the downstream call is stubbed and
the answer it gives is read back through the gateway.
"""

import io
import sys
import wave
from array import array

from fastapi.testclient import TestClient

import audio_gateway_main as main

KOKORO = "http://localhost:8081"
PIPER = "http://localhost:8083"
SUPERTONIC = "http://localhost:8084"


class FakeResponse:
    def __init__(self, content: bytes, status_code: int = 200):
        self.status_code = status_code
        self.content = content
        self.text = ""


class RecordingClient:
    def __init__(self, content: bytes):
        self.content = content
        self.calls: list[tuple[str, dict | None]] = []

    async def post(self, url, json=None, timeout=None):
        self.calls.append((url, json))
        return FakeResponse(self.content)


def use_client(monkeypatch, client: RecordingClient) -> None:
    async def fake_get_client():
        return client

    monkeypatch.setattr(main, "_get_client", fake_get_client)


def wav_bytes(samples: list[int], rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        values = array("h", samples)
        if sys.byteorder == "big":
            values.byteswap()
        out.writeframes(values.tobytes())
    return buffer.getvalue()


def samples_of(wav: bytes) -> list[int]:
    with wave.open(io.BytesIO(wav), "rb") as source:
        values = array("h")
        values.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder == "big":
        values.byteswap()
    return list(values)


def test_model_names_the_engine_and_input_carries_the_text(monkeypatch):
    client = RecordingClient(wav_bytes([0, 0]))
    use_client(monkeypatch, client)
    monkeypatch.setitem(main.ENGINE_GAIN, "kokoro", 1.0)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "kokoro", "input": "xin chào", "voice": "vn"},
    )

    assert answer.status_code == 200
    url, payload = client.calls[0]
    assert url == f"{KOKORO}/v1/audio/speech"
    assert payload == {"input": "xin chào", "voice": "vn"}


def test_the_legacy_text_and_engine_fields_still_work(monkeypatch):
    client = RecordingClient(wav_bytes([0, 0]))
    use_client(monkeypatch, client)
    monkeypatch.setitem(main.ENGINE_GAIN, "piper", 1.0)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"text": "xin chào", "engine": "piper", "voice": "bryce"},
    )

    assert answer.status_code == 200
    url, payload = client.calls[0]
    assert url == f"{PIPER}/v1/audio/speech"
    assert payload == {"text": "xin chào", "voice": "bryce"}


def test_an_engine_named_by_model_reaches_its_service(monkeypatch):
    client = RecordingClient(wav_bytes([0, 0]))
    use_client(monkeypatch, client)
    monkeypatch.setitem(main.ENGINE_GAIN, "supertonic", 1.0)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "supertonic", "input": "xin chào", "voice": "F1"},
    )

    assert answer.status_code == 200
    assert client.calls[0][0] == f"{SUPERTONIC}/v1/audio/speech"


def test_a_model_that_names_no_engine_is_refused(monkeypatch):
    client = RecordingClient(wav_bytes([0, 0]))
    use_client(monkeypatch, client)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "gpt-4o-mini-tts", "input": "xin chào", "voice": "alloy"},
    )

    assert answer.status_code == 400
    assert client.calls == []


def test_a_format_other_than_wav_is_refused(monkeypatch):
    client = RecordingClient(wav_bytes([0, 0]))
    use_client(monkeypatch, client)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "kokoro", "input": "xin chào", "voice": "vn", "response_format": "mp3"},
    )

    assert answer.status_code == 400
    assert client.calls == []


def test_the_engine_volume_is_applied_by_the_gateway(monkeypatch):
    client = RecordingClient(wav_bytes([1000, -2000]))
    use_client(monkeypatch, client)
    monkeypatch.setitem(main.ENGINE_GAIN, "kokoro", 0.5)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "kokoro", "input": "xin chào", "voice": "vn"},
    )

    assert answer.status_code == 200
    assert samples_of(answer.content) == [500, -1000]


def test_a_clamped_sample_is_still_levelled_to_the_ceiling(monkeypatch):
    client = RecordingClient(wav_bytes([30000, -30000]))
    use_client(monkeypatch, client)
    monkeypatch.setitem(main.ENGINE_GAIN, "supertonic", 1.2)

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "supertonic", "input": "xin chào", "voice": "F1"},
    )

    assert answer.status_code == 200
    assert samples_of(answer.content) == [32767, -32768]
