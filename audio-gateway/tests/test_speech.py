"""Tests for the OpenAI speech contract and the per-engine level.

Nothing here needs a running TTS service: the downstream call is stubbed and
the answer it gives is read back through the gateway.
"""

import io
import json
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


class ErrorResponse:
    def __init__(self, status_code: int, body: dict | str):
        self.status_code = status_code
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        if isinstance(self._body, str):
            raise ValueError("not json")
        return self._body


class ErrorClient:
    """A leaf engine that refuses — which is what a wrong voice name is."""

    def __init__(self, response: ErrorResponse):
        self.response = response
        self.calls: list[tuple[str, dict | None]] = []

    async def post(self, url, json=None, timeout=None):
        self.calls.append((url, json))
        return self.response


def use_client(monkeypatch, client) -> None:
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


def test_a_voice_the_engine_does_not_hold_stays_a_client_error(monkeypatch):
    # The engine's 4xx is the caller's mistake, and its body names the voices that
    # would have worked. Relaying it as 502 both lied about whose fault it was and
    # let a front that masks 5xx throw the list away.
    response = ErrorResponse(422, {"detail": "Voice 'af_heart' not found. Available: ['mai_linh']"})
    use_client(monkeypatch, ErrorClient(response))

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "kokoro", "input": "xin chào", "voice": "af_heart"},
    )

    assert answer.status_code == 422
    assert "mai_linh" in answer.text


def test_an_engine_failure_is_still_a_bad_gateway(monkeypatch):
    use_client(monkeypatch, ErrorClient(ErrorResponse(500, {"detail": "boom"})))

    answer = TestClient(main.app).post(
        "/v1/audio/speech",
        json={"model": "kokoro", "input": "xin chào", "voice": "vn"},
    )

    assert answer.status_code == 502


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
