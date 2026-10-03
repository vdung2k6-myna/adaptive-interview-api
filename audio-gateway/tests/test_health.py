"""Tests for the gateway's aggregated health and its voice relay.

No test here needs a running TTS service: the downstream calls are stubbed.
"""

import asyncio

import pytest
from fastapi.testclient import TestClient

import audio_gateway_main as main


class FakeResponse:
    def __init__(self, status_code: int, body, raise_on_json: bool = False):
        self.status_code = status_code
        self._body = body
        self._raise_on_json = raise_on_json

    def json(self):
        if self._raise_on_json:
            raise ValueError("body is not JSON")
        return self._body


class FakeClient:
    def __init__(self, response=None, error: Exception | None = None):
        self._response = response
        self._error = error

    async def get(self, *args, **kwargs):
        if self._error is not None:
            raise self._error
        return self._response


def use_client(monkeypatch, client: FakeClient) -> None:
    async def fake_get_client():
        return client

    monkeypatch.setattr(main, "_get_client", fake_get_client)


def healthy_others(monkeypatch, ok: bool = True) -> None:
    async def fake_check(url: str) -> bool:
        return ok

    monkeypatch.setattr(main, "_check_service", fake_check)


# ── The relayed list, as the endpoint reports it ───────────────────────


def test_voices_are_relayed_when_supertonic_answers(monkeypatch):
    healthy_others(monkeypatch)

    async def fake_status():
        return True, ["F1", "M2", "me"]

    monkeypatch.setattr(main, "_supertonic_status", fake_status)

    body = TestClient(main.app).get("/health").json()

    assert body["voices"] == ["F1", "M2", "me"]
    assert body["supertonic"] is True
    assert body["status"] == "ok"


def test_voices_are_absent_when_supertonic_is_unreachable(monkeypatch):
    healthy_others(monkeypatch)

    async def fake_status():
        return False, None

    monkeypatch.setattr(main, "_supertonic_status", fake_status)

    body = TestClient(main.app).get("/health").json()

    assert "voices" not in body
    assert body["supertonic"] is False
    assert body["status"] == "degraded"


def test_a_reachable_service_that_names_no_voices_is_not_an_error(monkeypatch):
    healthy_others(monkeypatch)

    async def fake_status():
        return True, None

    monkeypatch.setattr(main, "_supertonic_status", fake_status)

    body = TestClient(main.app).get("/health").json()

    assert "voices" not in body
    assert body["supertonic"] is True
    assert body["status"] == "ok"


# ── The helper itself ──────────────────────────────────────────────────


def test_status_reads_the_voice_list(monkeypatch):
    use_client(monkeypatch, FakeClient(FakeResponse(200, {"voices": ["F1", "me", 7]})))

    ok, voices = asyncio.run(main._supertonic_status())

    assert ok is True
    assert voices == ["F1", "me"]  # non-strings dropped


@pytest.mark.parametrize(
    "client, expected_ok",
    [
        (FakeClient(FakeResponse(503, {"voices": ["F1"]})), False),
        (FakeClient(FakeResponse(200, {"status": "ok"})), True),
        (FakeClient(FakeResponse(200, None, raise_on_json=True)), True),
        (FakeClient(error=RuntimeError("connection refused")), False),
    ],
    ids=["non-200", "no-voices-key", "unparseable-body", "unreachable"],
)
def test_status_degrades_to_nothing(monkeypatch, client, expected_ok):
    use_client(monkeypatch, client)

    ok, voices = asyncio.run(main._supertonic_status())

    assert voices is None
    assert ok is expected_ok
