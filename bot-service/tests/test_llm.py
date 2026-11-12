"""
Tests for the Gemini safety nets (no network, no API key, no database):
  - a temporary error (503 "high demand", 429, timeout) on the main model → the fallback model is used
  - a real error (e.g. 400 bad request) is NOT hidden by falling back
  - streaming only switches model before the first word was sent
"""
import asyncio

import pytest
from google.genai import errors

from app.config import Settings
from app.llm import GeminiLLM, is_temporary_error


def overloaded():
    return errors.ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE", "message": "high demand"}})


def bad_request():
    return errors.ClientError(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "bad"}})


class Resp:
    def __init__(self, text):
        self.text = text


class FakeModels:
    """Stands in for client.aio.models. `plan` = {model_name: exception | list_of_chunks | exception_after_chunks}."""

    def __init__(self, plan):
        self.plan, self.calls = plan, []

    async def generate_content(self, model, contents, config):
        self.calls.append(model)
        out = self.plan[model]
        if isinstance(out, BaseException):
            raise out
        return Resp("".join(out))

    async def generate_content_stream(self, model, contents, config):
        self.calls.append(model)
        out = self.plan[model]
        if isinstance(out, BaseException):
            raise out

        async def gen():
            for piece in out:
                if isinstance(piece, BaseException):
                    raise piece
                yield Resp(piece)

        return gen()


def make_llm(plan, fallbacks="backup-model"):
    llm = GeminiLLM(Settings(gemini_api_key="test", gemini_model="main-model", gemini_fallback_models=fallbacks))
    fake = FakeModels(plan)
    llm._client = type("C", (), {"aio": type("A", (), {"models": fake})()})()
    return llm, fake


def collect(agen):
    async def run():
        return [x async for x in agen]

    return asyncio.run(run())


def test_temporary_error_detection():
    assert is_temporary_error(overloaded())
    assert is_temporary_error(errors.ClientError(429, {"error": {"code": 429}}))
    assert is_temporary_error(asyncio.TimeoutError())
    assert not is_temporary_error(bad_request())
    assert not is_temporary_error(ValueError("bug"))


def test_generate_falls_back_when_main_model_is_overloaded():
    llm, fake = make_llm({"main-model": overloaded(), "backup-model": ["SELECT 1"]})
    assert asyncio.run(llm.generate("q")) == "SELECT 1"
    assert fake.calls == ["main-model", "backup-model"]


def test_generate_does_not_hide_real_errors():
    llm, fake = make_llm({"main-model": bad_request(), "backup-model": ["never"]})
    with pytest.raises(errors.ClientError):
        asyncio.run(llm.generate("q"))
    assert fake.calls == ["main-model"]


def test_generate_raises_when_every_model_is_down():
    llm, _ = make_llm({"main-model": overloaded(), "backup-model": overloaded()})
    with pytest.raises(errors.ServerError):
        asyncio.run(llm.generate("q"))


def test_no_fallback_configured_means_one_try():
    llm, fake = make_llm({"main-model": overloaded()}, fallbacks="")
    with pytest.raises(errors.ServerError):
        asyncio.run(llm.generate("q"))
    assert fake.calls == ["main-model"]


def test_stream_falls_back_before_first_word():
    llm, fake = make_llm({"main-model": overloaded(), "backup-model": ["Hello ", "there"]})
    assert collect(llm.stream("q")) == ["Hello ", "there"]
    assert fake.calls == ["main-model", "backup-model"]


def test_stream_does_not_switch_model_mid_answer():
    llm, fake = make_llm({"main-model": ["Half an ", overloaded()], "backup-model": ["other answer"]})
    with pytest.raises(errors.ServerError):
        collect(llm.stream("q"))
    assert fake.calls == ["main-model"]  # the backup was NOT glued onto a half answer
