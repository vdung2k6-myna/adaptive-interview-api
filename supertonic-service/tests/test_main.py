"""Tests for the service's voice catalog.

Every test here runs against a temporary style directory and a stubbed TTS
engine, so nothing in this file reads the model weights or needs them cached.
"""

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import supertonic_service_main as main

TTL_DIMS = [1, 50, 256]
DP_DIMS = [1, 8, 16]


def write_style(path: Path) -> Path:
    """A style file that passes the package's own format check."""
    path.write_text(
        json.dumps(
            {
                "style_ttl": {"data": [0.0] * 12800, "dims": TTL_DIMS, "type": "float32"},
                "style_dp": {"data": [0.0] * 128, "dims": DP_DIMS, "type": "float32"},
                "metadata": {"source_file": "test"},  # extra keys are accepted
            }
        )
    )
    return path


class StubTTS:
    """Stands in for the engine so no test loads ONNX weights."""

    def __init__(self, styles: Path):
        self.styles = styles
        self.synthesized_with: list[str] = []

    def get_voice_style(self, name: str):
        if not (self.styles / f"{name}.json").exists():
            raise FileNotFoundError(name)
        return object()

    def synthesize(self, text: str, voice_style=None):
        self.synthesized_with.append(text)
        return np.zeros(64, dtype=np.float32)


@pytest.fixture
def styles(tmp_path, monkeypatch) -> Path:
    """A style directory the service will read, and no prior discovery state."""
    directory = tmp_path / "voice_styles"
    directory.mkdir()
    monkeypatch.setenv("SUPERTONIC_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(main, "_discovered", False)
    main._VOICE_STYLES.clear()
    return directory


@pytest.fixture
def stub(styles) -> StubTTS:
    return StubTTS(styles)


@pytest.fixture
def client(styles, stub, monkeypatch) -> TestClient:
    monkeypatch.setattr(main, "get_tts", lambda: stub)
    with TestClient(main.app) as test_client:
        yield test_client


def speak(client: TestClient, voice: str | None = None):
    body = {"input": "hello"}
    if voice is not None:
        body["voice"] = voice
    return client.post("/v1/audio/speech", json=body)


# ── Discovery ──────────────────────────────────────────────────────────


def test_discovers_every_readable_style(styles):
    write_style(styles / "me.json")
    write_style(styles / "F1.json")

    held, unreadable = main.discover_styles()

    assert held == ["F1", "me"]
    assert unreadable == []


def test_reports_a_malformed_style_without_raising(styles):
    write_style(styles / "me.json")
    (styles / "broken.json").write_text('{"style_ttl": {"dims": [1, 50, 256], "data": [0.1')

    held, unreadable = main.discover_styles()

    assert held == ["me"]
    assert [Path(problem["path"]).name for problem in unreadable] == ["broken.json"]
    assert unreadable[0]["reason"]


def test_reports_a_missing_style_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERTONIC_CACHE_DIR", str(tmp_path / "absent"))
    monkeypatch.setattr(main, "_discovered", False)

    held, unreadable = main.discover_styles()

    assert held == []
    assert len(unreadable) == 1


# ── Readiness ──────────────────────────────────────────────────────────


def test_health_names_the_voices_it_holds(client, styles):
    write_style(styles / "me.json")
    main.refresh_styles()

    body = client.get("/health").json()

    assert body["voices"] == ["me"]
    assert body["default_voice"] == main._DEFAULT_VOICE
    assert body["sample_rate"] == main._SAMPLE_RATE
    assert body["unreadable_voices"] == []


def test_health_is_degraded_when_a_style_is_unreadable(client, styles):
    write_style(styles / "me.json")
    (styles / "broken.json").write_text("{ not json")
    main.refresh_styles()

    body = client.get("/health").json()

    assert body["status"] == "degraded"
    assert body["voices"] == ["me"]
    assert [Path(p).name for p in body["unreadable_voices"]] == ["broken.json"]


# ── Synthesis ──────────────────────────────────────────────────────────


def test_a_held_voice_is_synthesized(client, styles):
    write_style(styles / "me.json")
    main.refresh_styles()

    response = speak(client, "me")

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"


def test_an_unheld_voice_is_refused_and_never_substituted(client, styles, stub):
    write_style(styles / "me.json")
    main.refresh_styles()

    response = speak(client, "nope")

    assert response.status_code == 400
    assert "nope" in response.json()["detail"]
    # The whole point: no audio was produced in the default voice instead.
    assert stub.synthesized_with == []


def test_an_empty_voice_takes_the_default(client, styles, stub):
    write_style(styles / f"{main._DEFAULT_VOICE}.json")
    main.refresh_styles()

    response = speak(client, "")

    assert response.status_code == 200
    assert stub.synthesized_with == ["hello"]


def test_an_absent_voice_takes_the_default(client, styles):
    write_style(styles / f"{main._DEFAULT_VOICE}.json")
    main.refresh_styles()

    response = speak(client)

    assert response.status_code == 200


def test_a_removed_style_stops_being_a_voice(client, styles):
    write_style(styles / "me.json")
    main.refresh_styles()
    assert speak(client, "me").status_code == 200

    (styles / "me.json").unlink()
    main.refresh_styles()

    response = speak(client, "me")

    assert response.status_code == 400


# ── Rendering what the model cannot speak ──────────────────────────────


class FakeProcessor:
    """Stands in for the model's character-set predicate.

    Reports as unsupported exactly the characters the deployed model refuses —
    the set measured against the corpus — so the tests below exercise the
    rendering without the weights or the indexer.
    """

    REFUSED = {"\u2265", "\u2264", "\u2030", "\u2194", "\u20ab", "\u2021", "\u00a4"}

    def validate_text(self, text: str):
        unsupported = sorted({character for character in text if character in self.REFUSED})
        return (not unsupported, unsupported)


@pytest.fixture
def processor() -> FakeProcessor:
    return FakeProcessor()


def test_a_character_the_model_refuses_gets_a_reading(processor):
    rendered = main.speakable("Huyết áp \u2265140mmHg", processor)

    assert rendered == "Huyết áp lớn hơn hoặc bằng 140mmHg"


def test_every_measured_character_has_a_reading(processor):
    rendered = main.speakable("\u2265\u2264\u2030\u2194\u20ab", processor)

    assert rendered == "lớn hơn hoặc bằng nhỏ hơn hoặc bằng phần nghìn đến đồng"


def test_a_character_with_no_reading_is_dropped_rather_than_refused(processor, capsys):
    rendered = main.speakable("trị giá 5\u2021", processor)

    assert rendered == "trị giá 5"
    assert "\u2021" in capsys.readouterr().out


def test_text_the_model_speaks_is_left_alone(processor):
    text = "Huyết áp tâm thu và tâm trương."

    assert main.speakable(text, processor) == text


def test_the_set_is_asked_of_the_model_not_listed_here(processor):
    # A character this code has never recorded still goes through the same path.
    unknown = "\u2603"  # snowman
    processor.REFUSED = {unknown}

    assert main.speakable(f"a{unknown}b", processor) == "ab"


def test_the_character_set_is_absent_without_an_indexer(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERTONIC_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(main, "_processor_read", False)
    monkeypatch.setattr(main, "_text_processor", None)

    assert main.text_processor() is None


def test_the_real_set_refuses_the_measured_characters(monkeypatch):
    """The claim the readings table rests on, checked against the real model.

    Skipped where no indexer is installed: the point is to keep the measured set
    honest, not to require the weights in a test run.
    """
    monkeypatch.setattr(main, "_processor_read", False)
    monkeypatch.setattr(main, "_text_processor", None)
    real = main.text_processor()
    if real is None:
        pytest.skip("no model indexer on this machine")

    ok, unsupported = real.validate_text("Huyết áp \u2265140mmHg")
    assert not ok
    assert "\u2265" in unsupported

    ok, unsupported = real.validate_text("Huyết áp tâm thu và tâm trương.")
    assert ok
    assert unsupported == []


def test_a_refused_character_no_longer_costs_the_utterance(client, styles, stub, monkeypatch):
    write_style(styles / "me.json")
    main.refresh_styles()
    monkeypatch.setattr(main, "text_processor", lambda: FakeProcessor())

    response = client.post(
        "/v1/audio/speech", json={"input": "Huyết áp \u2265140mmHg", "voice": "me"}
    )

    assert response.status_code == 200
    assert stub.synthesized_with == ["Huyết áp lớn hơn hoặc bằng 140mmHg"]
