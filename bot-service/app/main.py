"""
bot-service — FastAPI app.

HTTP (internal only — called by chat-server, never exposed to the internet):
  POST   /documents          upload a PDF/.txt/.md for RAG   (header X-User-Id)
  GET    /documents          list my documents
  DELETE /documents/{id}     delete one
  POST   /ask                ask a question directly (handy for testing without Kafka)
  GET    /health

Kafka (background task): answers every message sent to the ChatBot.
"""
from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import rag
from .agent import Agent
from .config import get_settings
from .db import Database
from .llm import make_llm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

MAX_UPLOAD = 15 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    db = Database()
    await db.open()
    llm = make_llm(s)
    agent = Agent(db, llm, s)
    await agent.load_schema()
    app.state.db, app.state.llm, app.state.agent = db, llm, agent

    worker = None
    if s.kafka_enabled:
        from .kafka_worker import BotWorker

        worker = BotWorker(agent, s)
        await worker.start()
    try:
        yield
    finally:
        if worker:
            await worker.stop()
        await db.close()


app = FastAPI(title="ChatBot service", lifespan=lifespan)


def _user(x_user_id: str | None) -> str:
    if not x_user_id:
        raise HTTPException(401, "Missing X-User-Id")
    return x_user_id


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/documents")
async def upload_document(file: UploadFile = File(...), x_user_id: str | None = Header(None)):
    user_id = _user(x_user_id)
    name = file.filename or "document"
    if not name.lower().endswith((".pdf", ".txt", ".md")):
        raise HTTPException(400, "Only .pdf, .txt and .md files are supported")
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 15 MB")
    s = get_settings()
    try:
        doc = await rag.ingest(app.state.db, app.state.llm, s, user_id, name, data)
    except rag.DocumentError as e:
        raise HTTPException(400, str(e)) from e
    log.info("Indexed %s for %s: %s chunks", name, user_id, doc["numChunks"])
    return doc


@app.get("/documents")
async def get_documents(x_user_id: str | None = Header(None)):
    return await rag.list_documents(app.state.db, _user(x_user_id))


@app.delete("/documents/{doc_id}")
async def remove_document(doc_id: uuid.UUID, x_user_id: str | None = Header(None)):
    if not await rag.delete_document(app.state.db, _user(x_user_id), str(doc_id)):
        raise HTTPException(404, "Document not found")
    return {"ok": True}


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    chat_id: uuid.UUID | None = None


@app.post("/ask")
async def ask(body: AskBody, x_user_id: str | None = Header(None)):
    user_id = _user(x_user_id)
    return await app.state.agent.answer(
        chat_id=str(body.chat_id or uuid.uuid4()),
        user_id=user_id,
        message_id=str(uuid.uuid4()),
        question=body.question,
    )
