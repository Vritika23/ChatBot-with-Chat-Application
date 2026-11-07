"""
Kafka side of the bot.

  chat.messages ──► [bot-service consumer group "bot-service"] ──► Agent
                                                   │
                         bot.stream  ◄─────────────┤ (status + answer pieces, live)
                         bot.replies ◄─────────────┘ (final answer, also saved to DB)

Messages are read in small batches. Messages from DIFFERENT chats are answered
in parallel; messages from the SAME chat are answered one after another, in order.
Offsets are committed only after the batch is answered → if the bot crashes,
the questions are read again after restart (at-least-once delivery).
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from .agent import Agent
from .config import TOPIC_BOT_REPLIES, TOPIC_BOT_STREAM, TOPIC_CHAT_MESSAGES, Settings

log = logging.getLogger("bot.kafka")


def questions_by_chat(events: list[dict], bot_user_id: str) -> dict[str, list[dict]]:
    """Keeps only messages sent TO the bot (not by it), grouped per chat, in order."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        m = e.get("message") or {}
        if e.get("toBot") and m.get("senderId") != bot_user_id and m.get("chatId"):
            grouped[m["chatId"]].append(m)
    return grouped


class BotWorker:
    def __init__(self, agent: Agent, settings: Settings) -> None:
        self.agent, self.s = agent, settings
        self._sem = asyncio.Semaphore(settings.max_concurrent_chats)
        self._task: asyncio.Task | None = None
        self.consumer = AIOKafkaConsumer(
            TOPIC_CHAT_MESSAGES,
            bootstrap_servers=settings.kafka_brokers,
            group_id="bot-service",
            enable_auto_commit=False,
            auto_offset_reset="latest",  # brand-new bot: don't answer old history
        )
        self.producer = AIOKafkaProducer(
            bootstrap_servers=settings.kafka_brokers, enable_idempotence=True, acks="all"
        )

    async def start(self) -> None:
        await self.producer.start()
        await self.consumer.start()
        self._task = asyncio.create_task(self._run())
        log.info("🤖 bot worker listening on %s", TOPIC_CHAT_MESSAGES)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        await self.consumer.stop()
        await self.producer.stop()

    async def _send(self, topic: str, chat_id: str, value: dict) -> None:
        await self.producer.send_and_wait(topic, json.dumps(value).encode(), key=chat_id.encode())

    async def _run(self) -> None:
        while True:
            try:
                batch = await self.consumer.getmany(timeout_ms=1000, max_records=50)
                events = []
                for records in batch.values():
                    for r in records:
                        try:
                            events.append(json.loads(r.value))
                        except (TypeError, ValueError):
                            log.warning("Skipping bad event at offset %s", r.offset)
                grouped = questions_by_chat(events, self.s.bot_user_id)
                if grouped:
                    await asyncio.gather(*(self._answer_chat(msgs) for msgs in grouped.values()))
                if batch:
                    await self.consumer.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Bot worker loop error; retrying in 2s")
                await asyncio.sleep(2)

    async def _answer_chat(self, messages: list[dict]) -> None:
        async with self._sem:
            for m in messages:
                await self.handle_message(m)

    async def handle_message(self, m: dict) -> None:
        chat_id = m["chatId"]
        reply_marker = {"chatId": chat_id, "inReplyTo": m["id"]}

        async def emit(kind: str, text: str) -> None:
            await self._send(TOPIC_BOT_STREAM, chat_id, {**reply_marker, "kind": kind, "text": text})

        if not (m.get("text") or "").strip():
            reply = {
                "id": str(uuid.uuid4()), "chatId": chat_id, "senderId": self.s.bot_user_id,
                "text": "I can't look at pictures yet 🙂 — ask me a question, or upload a PDF "
                        "with the 📄 button and ask about it.",
                "imageUrl": None, "meta": {"sources": [], "sql": None},
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        else:
            reply = await self.agent.answer(
                chat_id=chat_id, user_id=m["senderId"], message_id=m["id"],
                question=m["text"], emit=emit,
            )
        reply["meta"]["inReplyTo"] = m["id"]
        await self._send(TOPIC_BOT_REPLIES, chat_id, {"message": reply})
