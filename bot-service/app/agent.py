"""
The bot's "brain". For every question it:
  1. loads the last few chat messages      (memory)
  2. IN PARALLEL:
       a. searches the user's documents     (RAG)
       b. asks the LLM if live DB data is needed, and runs a safe SELECT
  3. streams the final answer, built only from that context
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Awaitable, Callable

from . import rag, sql_tool
from .config import Settings
from .db import Database
from .llm import LLM

log = logging.getLogger("bot.agent")

# emit(kind, text) → kind is "status" (e.g. "Searching your documents…") or "delta" (answer piece)
Emit = Callable[[str, str], Awaitable[None]]

SYSTEM_PROMPT = """You are ChatBot, a helpful assistant inside a chat app.
Answer using the CONTEXT you are given:
- DOCUMENTS are parts of files the user uploaded. Cite them like [Source 1].
- LIVE DATA is the result of a database query run just now — treat it as current truth.
If the context does not contain the answer, say so honestly, then help with general
knowledge if you can (and say that part is general knowledge).
Keep answers short and clear. Use Markdown (lists, bold, small tables) when it helps."""


class Agent:
    def __init__(self, db: Database, llm: LLM, settings: Settings) -> None:
        self.db, self.llm, self.s = db, llm, settings
        self.schema = ""  # filled by load_schema() at startup

    async def load_schema(self) -> None:
        self.schema = await sql_tool.describe_tables(self.db, self.s.sql_tables)
        log.info("Live tables for SQL tool:\n%s", self.schema or "(none)")

    async def _noop(self, kind: str, text: str) -> None:  # default emitter
        return None

    async def answer(self, *, chat_id: str, user_id: str, message_id: str, question: str,
                     emit: Emit | None = None) -> dict:
        """Returns the final bot message (same shape as a chat message)."""
        emit = emit or self._noop
        reply_id = str(uuid.uuid4())
        meta: dict = {"sources": [], "sql": None}

        try:
            history_rows = await self.db.recent_messages(chat_id, message_id, self.s.history_messages)
            history = "\n".join(
                f"{'ChatBot' if r['sender_id'] == self.s.bot_user_id else 'User'}: {r['text'][:500]}"
                for r in history_rows
            )

            await emit("status", "Thinking…")
            docs_task = asyncio.create_task(rag.search(self.db, self.llm, self.s, user_id, question))
            sql_task = asyncio.create_task(self._live_data(question, history, emit))
            sources, live = await asyncio.gather(docs_task, sql_task)

            meta["sources"] = [
                {"filename": s["filename"], "page": s["page"], "score": s["score"], "snippet": s["content"][:200]}
                for s in sources
            ]
            if live:
                meta["sql"] = live["sql"]
                if live.get("error"):
                    meta["sqlError"] = live["error"]

            if sources:
                await emit("status", f"Found {len(sources)} relevant part(s) in your documents…")

            prompt = build_prompt(question, history, sources, live)
            text = ""
            async for delta in self.llm.stream(prompt, system=SYSTEM_PROMPT):
                text += delta
                await emit("delta", delta)
            text = text.strip() or "Sorry, I couldn't come up with an answer."
        except Exception:
            log.exception("Bot failed to answer")
            text = "Sorry, I ran into a problem answering that. Please try again in a moment."

        return {
            "id": reply_id,
            "chatId": chat_id,
            "senderId": self.s.bot_user_id,
            "text": text,
            "imageUrl": None,
            "meta": meta,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

    async def _live_data(self, question: str, history: str, emit: Emit) -> dict | None:
        sql = await sql_tool.plan_sql(self.llm, self.schema, question, history)
        if not sql:
            return None
        await emit("status", "Checking live data…")
        try:
            safe_sql = sql_tool.validate_sql(sql, self.s.sql_tables)
            result = await sql_tool.run_sql(self.db, safe_sql)
            return {"sql": safe_sql, **result}
        except sql_tool.UnsafeSQL as e:
            log.warning("Rejected SQL %r: %s", sql, e)
            return {"sql": sql, "error": f"Query was blocked for safety: {e}"}
        except Exception as e:  # timeout, bad column name, ...
            log.warning("SQL failed %r: %s", sql, e)
            return {"sql": sql, "error": f"Query failed: {e}"}


def build_prompt(question: str, history: str, sources: list[dict], live: dict | None) -> str:
    parts = []
    if history:
        parts.append(f"CONVERSATION SO FAR:\n{history}")
    if sources:
        docs = "\n\n".join(
            f"[Source {i}] {s['filename']} (page {s['page']})\n{s['content']}"
            for i, s in enumerate(sources, 1)
        )
        parts.append(f"DOCUMENTS:\n{docs}")
    if live:
        if live.get("error"):
            parts.append(f"LIVE DATA: not available ({live['error']})")
        else:
            rows = json.dumps(live["rows"], ensure_ascii=False)[:6000]
            parts.append(f"LIVE DATA (query: {live['sql']}):\ncolumns={live['columns']}\nrows={rows}")
    if not sources and not live:
        parts.append("CONTEXT: (no documents or live data matched this question)")
    parts.append(f"USER QUESTION: {question}")
    return "\n\n".join(parts)
