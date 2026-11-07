"""
LLM layer. The rest of the code only uses these three methods:
    embed(texts, task)   -> list of vectors
    generate(prompt)     -> full text answer (used for the SQL step)
    stream(prompt)       -> answer piece by piece (used for the final reply)

GeminiLLM talks to Google's Gemini API.
FakeLLM needs no internet or key — used in automated tests.
"""
from __future__ import annotations

import hashlib
import math
import re
from typing import AsyncIterator, Protocol

from .config import Settings


class LLM(Protocol):
    async def embed(self, texts: list[str], task: str) -> list[list[float]]: ...
    async def generate(self, prompt: str, system: str | None = None) -> str: ...
    def stream(self, prompt: str, system: str | None = None) -> AsyncIterator[str]: ...


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class GeminiLLM:
    def __init__(self, s: Settings) -> None:
        from google import genai
        from google.genai import types

        if not s.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        self._types = types
        self._client = genai.Client(api_key=s.gemini_api_key)
        self._model = s.gemini_model
        self._embed_model = s.embedding_model
        self._dim = s.embedding_dim

    async def embed(self, texts: list[str], task: str) -> list[list[float]]:
        """task = "RETRIEVAL_DOCUMENT" for chunks, "RETRIEVAL_QUERY" for questions."""
        out: list[list[float]] = []
        for i in range(0, len(texts), 100):  # API accepts batches
            resp = await self._client.aio.models.embed_content(
                model=self._embed_model,
                contents=texts[i : i + 100],
                config=self._types.EmbedContentConfig(task_type=task, output_dimensionality=self._dim),
            )
            # Smaller-than-full vectors must be normalised for cosine search
            out.extend(_normalize(list(e.values)) for e in resp.embeddings)
        return out

    def _config(self, system: str | None, temperature: float):
        return self._types.GenerateContentConfig(system_instruction=system, temperature=temperature)

    async def generate(self, prompt: str, system: str | None = None) -> str:
        resp = await self._client.aio.models.generate_content(
            model=self._model, contents=prompt, config=self._config(system, 0.0)
        )
        return resp.text or ""

    async def stream(self, prompt: str, system: str | None = None) -> AsyncIterator[str]:
        chunks = await self._client.aio.models.generate_content_stream(
            model=self._model, contents=prompt, config=self._config(system, 0.3)
        )
        async for chunk in chunks:
            if chunk.text:
                yield chunk.text


class FakeLLM:
    """Deterministic stand-in for tests. Embeddings = hashed bag of words."""

    def __init__(self, s: Settings) -> None:
        self._dim = s.embedding_dim

    async def embed(self, texts: list[str], task: str) -> list[list[float]]:
        vectors = []
        for t in texts:
            v = [0.0] * self._dim
            for word in re.findall(r"[a-z0-9]+", t.lower()):
                if len(word) > 2:
                    v[int(hashlib.md5(word.encode()).hexdigest(), 16) % self._dim] += 1.0
            vectors.append(_normalize(v) if any(v) else [1.0 / math.sqrt(self._dim)] * self._dim)
        return vectors

    async def generate(self, prompt: str, system: str | None = None) -> str:
        q = prompt.split("QUESTION:")[-1].lower()
        if "stock" in q:
            return "```sql\nSELECT name, stock FROM products ORDER BY stock ASC\n```"
        if "order" in q:
            return "SELECT status, count(*) AS n FROM orders GROUP BY status"
        if "drop" in q:
            return "DROP TABLE products"
        return "NONE"

    async def stream(self, prompt: str, system: str | None = None) -> AsyncIterator[str]:
        answer = "Fake answer. "
        if "[Source 1]" in prompt:
            first = prompt.split("[Source 1]", 1)[1].strip().splitlines()[1:2]
            answer += f"From your documents: {first[0][:120] if first else ''} [Source 1]. "
        if "LIVE DATA" in prompt:
            answer += "I also checked the live data."
        for word in answer.split(" "):
            yield word + " "


def make_llm(s: Settings) -> LLM:
    return FakeLLM(s) if s.llm_provider == "fake" else GeminiLLM(s)
